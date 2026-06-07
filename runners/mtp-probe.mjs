/**
 * MTP / speculative-decode probe for Qwen3.6-35B-A3B (our only MTP model).
 *
 * We ship `--spec-type draft-mtp --spec-draft-n-max 4` for this model but had
 * never actually measured whether that helps on THIS host, nor tuned the draft
 * depth. This probe answers both, per backend:
 *
 *   1. MTP on vs off  — is the embedded MTP draft head a net decode win, or does
 *      the draft/verify overhead cancel it on our workloads?
 *   2. spec-draft-n-max sweep (4 → 6 → 8) — higher depth wins when acceptance is
 *      high, loses when it's low. Find the knee.
 *
 * Method (mirrors the warmup-confound rule, results/int-dot-impact.md):
 *   - greedy decoding (temp 0) so the draft acceptance rate is deterministic and
 *     output is identical across configs (spec-decode is exact);
 *   - two workloads — code (high structure → high acceptance) and prose (lower) —
 *     to expose acceptance variance;
 *   - one discarded warmup generation per (config, prompt), then REPS measured;
 *   - decode t/s and draft acceptance read from the llama.cpp `timings` block.
 *
 * Usage:
 *   node runners/mtp-probe.mjs [--backend vulkan|rocm|both] [--reps 3]
 *                              [--max-tokens 512] [--out results/mtp-probe.json]
 *
 * Ensure NO llama-server is running (VRAM conflict) — the runner kills orphans
 * itself, but a concurrent suite run would collide.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHostConfig } from '../shared/hosts-config.mjs';
import { loadModelsConfig } from '../shared/models-config.mjs';
import { llamacppServer } from './llamacpp-server.mjs';

const ROOT = join(import.meta.dirname, '..');

function arg(name, def) {
   const i = process.argv.indexOf(`--${name}`);
   return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const TARGET = arg('target', process.env.BENCH_TARGET || 'rose');
const BACKEND_ARG = arg('backend', 'both');
const REPS = Number(arg('reps', '3'));
const MAX_TOKENS = Number(arg('max-tokens', '512'));
const CTX = Number(arg('ctx', '8192'));
const OUT = arg('out', join(ROOT, 'results/mtp-probe.json'));
const MODEL_LABEL = arg('model', 'Qwen3.6-35B IQ4_XS');

const backends = BACKEND_ARG === 'both' ? ['vulkan', 'rocm'] : [BACKEND_ARG];

// Configs to compare. `off` drops spec entirely (the MTP head is ignored); the
// rest run draft-mtp at increasing draft depth.
const CONFIGS = [
   { tag: 'off', specType: null, nMax: null },
   { tag: 'mtp-n4', specType: 'draft-mtp', nMax: 4 },
   { tag: 'mtp-n6', specType: 'draft-mtp', nMax: 6 },
   { tag: 'mtp-n8', specType: 'draft-mtp', nMax: 8 },
];

const PROMPTS = [
   {
      tag: 'code',
      text: 'Write a complete, well-commented Python implementation of an LRU cache class with O(1) get and put, using a doubly linked list plus a dict. Include a one-line docstring on each method. Output only the code.',
   },
   {
      tag: 'prose',
      text: 'Explain in detail how TCP congestion control works: the three-way handshake, slow start, congestion avoidance, fast retransmit and fast recovery. Write several paragraphs.',
   },
];

// Production batch sizing (so prefill matches; decode is ubatch-independent but
// we keep it faithful). int-dot stays off via start-server.sh on vulkan.
const BATCH_FLAGS = '-b 2048 -ub 2048';

function buildExtraFlags(cfg) {
   const parts = [BATCH_FLAGS];
   if (cfg.specType) {
      parts.push(`--spec-type ${cfg.specType}`);
      if (cfg.nMax != null) {
         parts.push(`--spec-draft-n-max ${cfg.nMax}`);
      }
   }
   return parts.join(' ');
}

// Pull draft-acceptance fields out of the llama.cpp timings block. Key names have
// drifted across llama.cpp versions, so match defensively on anything draft-ish.
function readDraft(timings) {
   if (!timings) {
      return { drafted: null, accepted: null, accept: null };
   }
   const get = (...keys) => {
      for (const k of keys) {
         if (typeof timings[k] === 'number') {
            return timings[k];
         }
      }
      return null;
   };
   const drafted = get('draft_n', 'n_draft', 'n_drafted', 'draftn');
   const accepted = get('draft_n_accepted', 'n_draft_accepted', 'n_accept', 'n_accepted');
   const accept = drafted && accepted != null ? accepted / drafted : null;
   return { drafted, accepted, accept };
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

async function main() {
   const host = loadHostConfig(join(ROOT, 'config/hosts.yaml'), TARGET, {});
   const { models } = loadModelsConfig(join(ROOT, 'config/models.yaml'));
   const model = models.find((m) => m.label === MODEL_LABEL);
   if (!model) {
      throw new Error(`model '${MODEL_LABEL}' not found in models.yaml`);
   }
   const think = model.think === 'optional' ? false : null;
   const thinkControl = model.think_control ?? 'enable_thinking';

   console.log(`MTP probe · ${model.label} · ${model.hf_file}`);
   console.log(`backends=${backends.join(',')} configs=${CONFIGS.map((c) => c.tag).join(',')} reps=${REPS} max_tokens=${MAX_TOKENS}`);
   console.log(`(greedy / temp 0 · 1 warmup discarded · ${BATCH_FLAGS} · vulkan int-dot off)\n`);

   const report = { model: model.label, hf_file: model.hf_file, ctx: CTX, reps: REPS, max_tokens: MAX_TOKENS, byBackend: {} };
   let draftKeysSeen = null;

   for (const backend of backends) {
      const srv = llamacppServer({ sshHost: host.sshHost, llamaUrl: host.llamaUrl, backend });
      report.byBackend[backend] = {};
      console.log(`\n===== backend: ${backend} =====`);

      for (const cfg of CONFIGS) {
         const extraFlags = buildExtraFlags(cfg);
         console.log(`\n--- ${backend} / ${cfg.tag}  (${extraFlags})`);
         await srv.killAll();
         await srv.waitVramClear(30_000);

         try {
            await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx: CTX, extraFlags });
            await srv.waitHealthy(360_000);
         } catch (e) {
            console.log(`    load FAILED: ${e.message.slice(0, 160)}`);
            report.byBackend[backend][cfg.tag] = { error: e.message.slice(0, 200) };
            await srv.killAll();
            continue;
         }

         const byPrompt = {};
         for (const p of PROMPTS) {
            const msgs = [{ role: 'user', content: p.text }];
            const tps = [];
            const accepts = [];
            let lastDraft = null;
            // warmup + measured reps; rep -1 is the discarded warmup
            for (let rep = -1; rep < REPS; rep++) {
               let r;
               try {
                  r = await srv.client.chat(msgs, { think, thinkControl, temperature: 0.0, max_tokens: MAX_TOKENS }, 180_000);
               } catch (e) {
                  console.log(`    ${p.tag} rep ${rep}: chat error ${e.message.slice(0, 100)}`);
                  continue;
               }
               const t = r.timings;
               if (t) {
                  const ks = Object.keys(t).filter((k) => /draft|accept/i.test(k));
                  if (ks.length && !draftKeysSeen) {
                     draftKeysSeen = ks; // capture from a spec-on config, not the MTP-off warmup
                  }
               }
               if (rep < 0) {
                  continue; // discard warmup
               }
               if (t?.predicted_per_second) {
                  tps.push(t.predicted_per_second);
               }
               const d = readDraft(t);
               lastDraft = d;
               if (d.accept != null) {
                  accepts.push(d.accept);
               }
            }
            const tpsAvg = mean(tps);
            const accAvg = mean(accepts);
            byPrompt[p.tag] = {
               tg: tpsAvg,
               accept: accAvg,
               drafted: lastDraft?.drafted ?? null,
            };
            const accStr = accAvg != null ? `${(accAvg * 100).toFixed(1)}% accept` : 'no-draft';
            console.log(`    ${p.tag}: ${tpsAvg ? tpsAvg.toFixed(1) : '??'} t/s  (${accStr})`);
         }
         report.byBackend[backend][cfg.tag] = byPrompt;
      }
      await srv.killAll();
   }

   if (draftKeysSeen) {
      report.draftTimingKeys = draftKeysSeen;
      console.log(`\n[timings] draft-related keys observed: ${draftKeysSeen.join(', ') || '(none — server reports no draft fields)'}`);
   }

   writeFileSync(OUT, JSON.stringify(report, null, 2));
   console.log(`\nWrote ${OUT}`);

   // Compact summary table
   console.log('\n=== decode t/s (avg of code+prose) ===');
   for (const backend of backends) {
      const row = report.byBackend[backend];
      if (!row) {
         continue;
      }
      const cells = CONFIGS.map((c) => {
         const e = row[c.tag];
         if (!e || e.error) {
            return `${c.tag}=ERR`;
         }
         const vals = PROMPTS.map((p) => e[p.tag]?.tg).filter((x) => x != null);
         const avg = mean(vals);
         return `${c.tag}=${avg ? avg.toFixed(0) : '?'}`;
      });
      console.log(`  ${backend}: ${cells.join('  ')}`);
   }
}

main().catch((e) => {
   console.error(e);
   process.exit(1);
});
