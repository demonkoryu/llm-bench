#!/usr/bin/env node
/**
 * Instruction-following (IFEval-lite).
 *
 * struct_output asks "can the model emit schema-valid JSON"; this asks the broader
 * question "does the model obey literal prose constraints" — length limits, exact
 * bullet/sentence counts, keyword include/exclude, casing, wrapping, format. Each
 * case (benchmarks/instruction-following/ifcases.mjs) carries DETERMINISTIC checks
 * that read only the raw response, so the grade is a programmatic structure match,
 * never an LLM judge.
 *
 * Per case we score the fraction of its checks satisfied; the bench score is the
 * mean across cases × 100. Reporting partial credit (not all-or-nothing per case)
 * keeps the signal smooth on a ~20-case set.
 *
 * Writes one row per model:
 *   instruction_following   score = mean check-pass rate (%)
 *
 * Think is disabled on hybrids (constraints land in `content`, not reasoning);
 * always-reasoning/required models get a large budget so reasoning_content doesn't
 * eat the answer (see reasoner-token-budget). Report-only — does NOT enter the
 * multiplicative composite score.
 *
 * Usage: node runners/instruction-following.mjs [--input results/<runId>] [--models a,b]
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CASES } from '../benchmarks/instruction-following/ifcases.mjs';
import { loadHostConfig } from '../shared/hosts-config.mjs';
import { loadModelsConfig } from '../shared/models-config.mjs';
import { openSecondaryRun } from '../shared/results-store.mjs';
import { extraFlagsToString, llamacppServer } from './llamacpp-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: flags } = parseArgs({
   options: {
      input: { type: 'string' },
      models: { type: 'string', default: '' },
      target: { type: 'string', default: 'rose' },
   },
});

const modelsCfg = loadModelsConfig(join(ROOT, 'config/models.yaml'));
const {
   llamaUrl: LLAMA_URL,
   sshHost: SSH_HOST,
   backend: BACKEND,
   gpu: GPU,
} = loadHostConfig(join(ROOT, 'config/hosts.yaml'), flags.target);

const { run } = openSecondaryRun(join(ROOT, 'results'), {
   target: flags.target,
   gpu: GPU,
   backend: BACKEND,
   kind: 'instruction-following',
   inputFlag: flags.input,
});

const filter = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const wanted = modelsCfg.models.filter((m) => {
   const id = m.hf_file.replace(/\.gguf$/, '');
   return !filter.length || filter.some((f) => id.includes(f) || (m.label ?? '').includes(f));
});

const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: BACKEND, debug: !!process.env.BENCH_DEBUG });
const client = srv.client;

console.log(`\n[instruction-following] ${wanted.length} models · ${CASES.length} cases · ${LLAMA_URL}\n`);
for (const m of wanted) {
   const id = m.hf_file.replace(/\.gguf$/, '');
   const probeThink = m.think === 'optional' ? false : null;
   const thinkControl = m.think_control ?? 'enable_thinking';
   // Reasoner/required models can't toggle thinking off; give them headroom so
   // reasoning_content doesn't consume the whole budget before the answer.
   const reasons = m.think === 'reasoning' || m.think === 'required';
   const maxTokens = reasons ? 2048 : 800;
   console.log(`\n══ ${m.label ?? id}`);
   await srv.killAll();
   await srv.waitVramClear(30_000);
   try {
      await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, ctx: 8192, extraFlags: extraFlagsToString(m.extra_flags) });
      await srv.waitHealthy(360_000);
   } catch (e) {
      console.log(`  load failed: ${e.message.slice(0, 70)} — skipping`);
      continue;
   }

   let totalChecks = 0;
   let passedChecks = 0;
   let fullCases = 0;
   for (const c of CASES) {
      const messages = [
         { role: 'system', content: 'Follow the user instruction exactly. Obey every formatting and length constraint literally.' },
         { role: 'user', content: c.prompt },
      ];
      let text = '';
      try {
         const { completion } = await client.chat(
            messages,
            { think: probeThink, thinkControl, max_tokens: maxTokens, temperature: 0.0 },
            300_000,
         );
         text = completion?.choices?.[0]?.message?.content ?? '';
      } catch (e) {
         console.log(`  ${c.id}: error ${e.message.slice(0, 50)}`);
      }
      let casePass = 0;
      for (const chk of c.checks) {
         let ok = false;
         try {
            ok = !!chk.test(text);
         } catch {
            ok = false;
         }
         if (ok) casePass++;
      }
      totalChecks += c.checks.length;
      passedChecks += casePass;
      if (casePass === c.checks.length) fullCases++;
      if (process.env.BENCH_DEBUG) console.log(`  ${c.id}: ${casePass}/${c.checks.length}`);
   }
   const score = totalChecks ? (passedChecks / totalChecks) * 100 : 0;
   console.log(`  → ${score.toFixed(1)}%  (${passedChecks}/${totalChecks} checks · ${fullCases}/${CASES.length} cases fully obeyed)`);
   run.append({
      target: flags.target,
      backend: BACKEND,
      model: id,
      think: 'n/a',
      bench: 'instruction_following',
      score: score.toFixed(1),
      status: 'ok',
      notes: `${passedChecks}/${totalChecks} checks · ${fullCases}/${CASES.length} full`,
   });
}
await srv.stopServer();
await srv.waitVramClear(20_000);
run.finalize('complete');
console.log(`\n[instruction-following] done → ${run.dir}`);
