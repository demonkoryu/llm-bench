#!/usr/bin/env node
/**
 * Serial benchmark orchestrator — restart-minimizing loop order.
 *
 * Ollama side (3 service restarts total):
 *   for kv in [f16, q8_0, q4_0]:          ← OUTER: 1 systemd restart per KV type
 *     restart Ollama with that KV type
 *     for model in fittingModels:          ← INNER: hot-swap, no restart
 *       unloadAll(); warmup()
 *       run: triage, reasoning, toolcalling, toolcalling_decay, summarization, speed
 *
 * llama.cpp side (1 server start per model×kv combo):
 *   for model in llamacppModels:
 *     for kv in kvConfigs:
 *       start llama-server(model, ctk, ctv, ctxMax)
 *       run: longctx passkey + multifact + maxctx probe
 *       stop server
 *
 * Usage:
 *   node runners/run-suite.mjs [options]
 *
 * Options:
 *   --target rose|m1          Host target (default: rose)
 *   --models <tag,...>        Comma-separated model tags to restrict run
 *   --benches <name,...>      Comma-separated bench names to restrict run
 *   --kv <type,...>           KV types to sweep (default: all from models.yaml)
 *   --dry-run                 Print planned matrix and restart count, exit without running
 *   --no-llamacpp             Skip the llama.cpp phase
 *   --no-ollama               Skip the Ollama phase
 *   --resume                  Skip combos already present in results/results.tsv
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

// ── CLI args ───────────────────────────────────────────────────────────────────
const { values: flags } = parseArgs({
   options: {
      target:       { type: 'string', default: 'rose' },
      models:       { type: 'string', default: '' },
      benches:      { type: 'string', default: '' },
      kv:           { type: 'string', default: '' },
      'dry-run':    { type: 'boolean', default: false },
      'no-llamacpp':{ type: 'boolean', default: false },
      'no-ollama':  { type: 'boolean', default: false },
      resume:       { type: 'boolean', default: false },
   },
});

const DRY_RUN = flags['dry-run'];
const TARGET = flags.target;
const FILTER_MODELS = flags.models ? flags.models.split(',') : [];
const FILTER_BENCHES = flags.benches ? flags.benches.split(',') : [];
const FILTER_KV = flags.kv ? flags.kv.split(',') : [];

// ── Config loading (YAML parsed via simple regex — avoid adding yaml dep) ──────
// Full YAML parsing would need a dep; models.yaml is regular enough to parse with
// js-yaml if needed. For now load via dynamic import of a JS re-export, or ship
// a minimal YAML reader. Using js-yaml from promptfoo's transitive deps if available.

let yaml;
try {
   yaml = (await import('js-yaml')).default;
} catch {
   // Minimal fallback — only used for dry-run matrix print if js-yaml not installed
   yaml = { load: () => { throw new Error('js-yaml not available; run npm install first'); } };
}

const modelsConfig = yaml.load(readFileSync(join(ROOT, 'config/models.yaml'), 'utf8'));
const hostsConfig  = yaml.load(readFileSync(join(ROOT, 'config/hosts.yaml'),  'utf8'));

const host = hostsConfig[TARGET];
if (!host) throw new Error(`Unknown target: ${TARGET}. Available: ${Object.keys(hostsConfig).join(', ')}`);

const OLLAMA_HOST = resolveEnvTemplate(host.ollama);
const LLAMA_URL   = host.llamacpp ? resolveEnvTemplate(host.llamacpp) : null;
const SSH_HOST    = resolveEnvTemplate(host.ssh_host);

/** Expand ${VAR:-default} shell-style env templates. */
function resolveEnvTemplate(s) {
   return String(s ?? '').replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const [varName, def] = expr.split(':-');
      return process.env[varName] ?? def ?? '';
   });
}

// ── Model filtering ────────────────────────────────────────────────────────────
const allModels = modelsConfig.models ?? [];

function filterModels(models) {
   return models.filter((m) => {
      if (FILTER_MODELS.length && !FILTER_MODELS.some((f) => m.tag.includes(f))) return false;
      if (m.fit_rose === 'oom') return false;
      return true;
   });
}

// ── Results TSV ───────────────────────────────────────────────────────────────
const RESULTS_DIR = join(ROOT, 'results');
const RESULTS_TSV = join(RESULTS_DIR, 'results.tsv');
mkdirSync(RESULTS_DIR, { recursive: true });

const TSV_HEADER = 'target\tkv\tmodel\tthink\tbench\tscore\thalls\tjson_fail\ttok_s\tvram_mib\tstatus\twall_s\tnotes\n';
if (!existsSync(RESULTS_TSV)) {
   appendFileSync(RESULTS_TSV, TSV_HEADER);
}

function tsvKey(target, kv, model, think, bench) {
   return `${target}\t${kv}\t${model}\t${think}\t${bench}`;
}

function loadDoneKeys() {
   if (!existsSync(RESULTS_TSV)) return new Set();
   return new Set(
      readFileSync(RESULTS_TSV, 'utf8')
         .split('\n')
         .slice(1)
         .filter(Boolean)
         .map((l) => l.split('\t').slice(0, 5).join('\t'))
   );
}

function appendResult(row) {
   appendFileSync(RESULTS_TSV, Object.values(row).join('\t') + '\n');
}

// ── promptfoo runner helper ────────────────────────────────────────────────────
const execP = promisify(execFile);

export async function runPromptfoo(benchDir, providerOverride) {
   const env = {
      ...process.env,
      OLLAMA_HOST,
      PROMPTFOO_PROVIDER_OVERRIDE: JSON.stringify(providerOverride),
   };
   const { stdout, stderr } = await execP(
      'npx', ['promptfoo', 'eval', '--no-cache', '--output', 'json'],
      { cwd: benchDir, env, timeout: 3_600_000 }
   );
   try {
      return JSON.parse(stdout);
   } catch {
      console.error('[promptfoo] parse failed:', stderr.slice(0, 500));
      return null;
   }
}

// ── Speed measurement helper (Ollama) ─────────────────────────────────────────
async function measureSpeed(model, think, numCtx) {
   // Send a ~200-token generation request, measure eval tok/s
   const body = {
      model, think: think ?? null, stream: false,
      options: { temperature: 0.7, num_ctx: numCtx, num_predict: 150 },
      messages: [{ role: 'user', content: 'Describe the water cycle in detail.' }],
   };
   const t0 = Date.now();
   const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify(body),
   });
   const resp = await res.json();
   const wallMs = Date.now() - t0;
   const tps = resp.eval_count && resp.eval_duration
      ? (resp.eval_count / (resp.eval_duration / 1e9)).toFixed(1)
      : null;
   return { tps, wallMs };
}

// ── Max-context binary search (Ollama) ────────────────────────────────────────
// Finds the largest num_ctx that loads without OOM, in O(log N) Ollama calls.
async function probeMaxCtx(model) {
   const CTX_POINTS = modelsConfig.ctx_probe_points ?? [4096, 16384, 32768, 65536];
   let lo = 0, hi = CTX_POINTS.length - 1, best = CTX_POINTS[0];
   while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const ctx = CTX_POINTS[mid];
      const ok = await canLoadCtx(model, ctx);
      if (ok) { best = ctx; lo = mid + 1; }
      else { hi = mid - 1; }
   }
   return best;
}

async function canLoadCtx(model, numCtx) {
   try {
      await fetch(`${OLLAMA_HOST}/api/chat`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         signal: AbortSignal.timeout(60_000),
         body: JSON.stringify({
            model, stream: false,
            options: { num_ctx: numCtx, num_predict: 1 },
            messages: [{ role: 'user', content: 'hi' }],
         }),
      }).then((r) => r.json());
      return true;
   } catch {
      return false;
   }
}

// ── VRAM snapshot via SSH ──────────────────────────────────────────────────────
async function snapshotVram() {
   try {
      const { stdout } = await execP('ssh', [SSH_HOST, 'rocm-smi --showmemuse --json'], { timeout: 10_000 });
      const parsed = JSON.parse(stdout.trim());
      const card = Object.values(parsed)[0] ?? {};
      return Math.round(parseInt(card['VRAM Total Used Memory (B)'] ?? '0', 10) / (1024 * 1024));
   } catch {
      return null;
   }
}

// ── Dry-run: print planned matrix ─────────────────────────────────────────────
function dryRun() {
   const ollamaModels = filterModels(allModels).filter((m) => m.benches?.some((b) => b !== 'longctx'));
   const llamaModels  = filterModels(allModels).filter((m) => m.benches?.includes('longctx'));
   const kvOllama = FILTER_KV.length ? FILTER_KV : (modelsConfig.kv_configs?.ollama ?? ['f16','q8_0','q4_0']);
   const kvLlama  = FILTER_KV.length ? FILTER_KV : (modelsConfig.kv_configs?.llamacpp ?? ['f16','q8_0','q4_0','k8v4']);

   console.log(`\nDry-run — target=${TARGET}  OLLAMA_HOST=${OLLAMA_HOST}\n`);
   console.log(`── Ollama phase ──  (${kvOllama.length} KV types × ${ollamaModels.length} models = ${kvOllama.length} restarts)`);
   for (const kv of kvOllama) {
      console.log(`  KV=${kv}:`);
      for (const m of ollamaModels) {
         const b = (m.benches ?? []).filter((x) => x !== 'longctx' && (!FILTER_BENCHES.length || FILTER_BENCHES.includes(x)));
         console.log(`    ${m.tag.padEnd(52)} benches=[${b.join(',')}]`);
      }
   }

   if (!flags['no-llamacpp'] && LLAMA_URL) {
      console.log(`\n── llama.cpp phase ──  (${llamaModels.length} models × ${kvLlama.length} KV = ${llamaModels.length * kvLlama.length} server starts)`);
      for (const m of llamaModels) {
         for (const kv of kvLlama) {
            console.log(`  ${m.tag.padEnd(52)} KV=${kv}  benches=[longctx,maxctx]`);
         }
      }
   }

   console.log(`\nTotal Ollama restarts: ${kvOllama.length}`);
   console.log(`Total llama.cpp server starts: ${flags['no-llamacpp'] ? 0 : llamaModels.length * kvLlama.length}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
if (DRY_RUN) {
   dryRun();
   process.exit(0);
}

const doneKeys = flags.resume ? loadDoneKeys() : new Set();

// Lazy-load KV manager and client only when actually running
const { ollamaKvManager } = await import('./ollama-kv.mjs');
const { ollamaClient }    = await import('../shared/ollama.mjs');
const ollama = ollamaClient(OLLAMA_HOST);
const kvMgr = !flags['no-ollama'] && host.ssh_host
   ? ollamaKvManager({ sshHost: SSH_HOST, service: host.ollama_service ?? 'ollama', ollamaHost: OLLAMA_HOST })
   : null;

// ══════════════════════════════════════════════════════════════════════════════
// OLLAMA PHASE
// ══════════════════════════════════════════════════════════════════════════════
if (!flags['no-ollama']) {
   const kvTypes = FILTER_KV.length ? FILTER_KV : (modelsConfig.kv_configs?.ollama ?? ['f16','q8_0','q4_0']);
   const models  = filterModels(allModels).filter((m) => m.benches?.some((b) => b !== 'longctx'));

   for (const kv of kvTypes) {
      console.log(`\n${'═'.repeat(70)}`);
      console.log(`  OLLAMA PHASE — KV=${kv}  (restarting service)`);
      console.log('═'.repeat(70));

      if (kvMgr) await kvMgr.setKvType(kv);

      for (const model of models) {
         const tag = model.tag;
         const label = model.label;
         const supportsThink = model.think === 'optional' || model.think === 'required';
         const hasTools = model.tools === true;

         await ollama.unloadAll();
         await ollama.warmup(tag, supportsThink);

         const benches = (model.benches ?? []).filter(
            (b) => b !== 'longctx' && (!FILTER_BENCHES.length || FILTER_BENCHES.includes(b))
         );

         console.log(`\n  ── ${label} (${tag}) — benches: ${benches.join(', ')}`);

         // Think modes to iterate
         const thinkModes = supportsThink ? [false, true] : [null];

         for (const think of thinkModes) {
            const thinkLabel = think === null ? 'n/a' : think ? 'think' : 'no_think';

            // ── triage ────────────────────────────────────────────────────────
            if (benches.includes('triage')) {
               const key = tsvKey(TARGET, kv, tag, thinkLabel, 'triage');
               if (flags.resume && doneKeys.has(key)) {
                  console.log(`    [triage ${thinkLabel}] skipped (already done)`);
               } else {
                  const t0 = Date.now();
                  console.log(`    [triage ${thinkLabel}] running...`);
                  // TODO: wire promptfoo run; placeholder records timing
                  const wall = ((Date.now() - t0) / 1000).toFixed(0);
                  const vram = await snapshotVram();
                  appendResult({ target: TARGET, kv, model: tag, think: thinkLabel, bench: 'triage', score: '?', halls: '?', json_fail: '?', tok_s: '?', vram_mib: vram ?? '?', status: 'todo', wall_s: wall, notes: '' });
               }
            }

            // ── reasoning ────────────────────────────────────────────────────
            if (benches.includes('reasoning')) {
               const key = tsvKey(TARGET, kv, tag, thinkLabel, 'reasoning');
               if (flags.resume && doneKeys.has(key)) {
                  console.log(`    [reasoning ${thinkLabel}] skipped`);
               } else {
                  console.log(`    [reasoning ${thinkLabel}] running...`);
                  const t0 = Date.now();
                  const vram = await snapshotVram();
                  const wall = ((Date.now() - t0) / 1000).toFixed(0);
                  appendResult({ target: TARGET, kv, model: tag, think: thinkLabel, bench: 'reasoning', score: '?', halls: '-', json_fail: '?', tok_s: '?', vram_mib: vram ?? '?', status: 'todo', wall_s: wall, notes: '' });
               }
            }

            // ── toolcalling (skip think=true — no_think is the correct mode) ─
            if (benches.includes('toolcalling') && hasTools && think !== true) {
               const key = tsvKey(TARGET, kv, tag, thinkLabel, 'toolcalling');
               if (flags.resume && doneKeys.has(key)) {
                  console.log(`    [toolcalling] skipped`);
               } else {
                  console.log(`    [toolcalling] running...`);
                  const t0 = Date.now();
                  const vram = await snapshotVram();
                  const wall = ((Date.now() - t0) / 1000).toFixed(0);
                  appendResult({ target: TARGET, kv, model: tag, think: thinkLabel, bench: 'toolcalling', score: '?', halls: '-', json_fail: '-', tok_s: '?', vram_mib: vram ?? '?', status: 'todo', wall_s: wall, notes: '' });
               }
            }

            // ── toolcalling_decay (no_think only, first KV pass only) ─────────
            if (benches.includes('toolcalling_decay') && hasTools && think !== true && kv === kvTypes[0]) {
               const key = tsvKey(TARGET, kv, tag, thinkLabel, 'toolcalling_decay');
               if (flags.resume && doneKeys.has(key)) {
                  console.log(`    [toolcalling_decay] skipped`);
               } else {
                  console.log(`    [toolcalling_decay] running...`);
                  const t0 = Date.now();
                  const wall = ((Date.now() - t0) / 1000).toFixed(0);
                  appendResult({ target: TARGET, kv, model: tag, think: thinkLabel, bench: 'toolcalling_decay', score: '?', halls: '-', json_fail: '-', tok_s: '?', vram_mib: '?', status: 'todo', wall_s: wall, notes: 'rounds:0/5/20/50' });
               }
            }

            // ── summarization ─────────────────────────────────────────────────
            if (benches.includes('summarization') && think !== true) {
               const key = tsvKey(TARGET, kv, tag, thinkLabel, 'summarization');
               if (flags.resume && doneKeys.has(key)) {
                  console.log(`    [summarization] skipped`);
               } else {
                  console.log(`    [summarization] running...`);
                  const t0 = Date.now();
                  const vram = await snapshotVram();
                  const wall = ((Date.now() - t0) / 1000).toFixed(0);
                  appendResult({ target: TARGET, kv, model: tag, think: thinkLabel, bench: 'summarization', score: '?', halls: '-', json_fail: '?', tok_s: '?', vram_mib: vram ?? '?', status: 'todo', wall_s: wall, notes: '' });
               }
            }
         }

         // ── speed (no_think; all KV passes) ───────────────────────────────
         if (benches.includes('speed')) {
            const key = tsvKey(TARGET, kv, tag, 'no_think', 'speed');
            if (flags.resume && doneKeys.has(key)) {
               console.log(`    [speed] skipped`);
            } else {
               console.log(`    [speed] measuring...`);
               const t0 = Date.now();
               const { tps } = await measureSpeed(tag, supportsThink ? false : null, 4096).catch(() => ({ tps: null }));
               const vram = await snapshotVram();
               const wall = ((Date.now() - t0) / 1000).toFixed(0);
               appendResult({ target: TARGET, kv, model: tag, think: 'no_think', bench: 'speed', score: tps ?? '?', halls: '-', json_fail: '-', tok_s: tps ?? '?', vram_mib: vram ?? '?', status: tps ? 'ok' : 'error', wall_s: wall, notes: '' });
            }
         }

         // ── maxctx (first KV pass only to establish baseline) ──────────────
         if (benches.includes('maxctx') && kv === kvTypes[0]) {
            const key = tsvKey(TARGET, kv, tag, '-', 'maxctx');
            if (flags.resume && doneKeys.has(key)) {
               console.log(`    [maxctx] skipped`);
            } else {
               console.log(`    [maxctx] binary search...`);
               const t0 = Date.now();
               const maxCtx = await probeMaxCtx(tag);
               const vram = await snapshotVram();
               const wall = ((Date.now() - t0) / 1000).toFixed(0);
               appendResult({ target: TARGET, kv, model: tag, think: '-', bench: 'maxctx', score: maxCtx, halls: '-', json_fail: '-', tok_s: '-', vram_mib: vram ?? '?', status: 'ok', wall_s: wall, notes: '' });
            }
         }
      }
   }

   if (kvMgr) await kvMgr.restore();
   console.log('\n[run-suite] Ollama phase complete.');
}

// ══════════════════════════════════════════════════════════════════════════════
// LLAMA.CPP PHASE (long-context KV sweep)
// ══════════════════════════════════════════════════════════════════════════════
if (!flags['no-llamacpp'] && LLAMA_URL) {
   const { llamacppServer } = await import('./llamacpp-server.mjs');
   const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL });

   const kvTypes = FILTER_KV.length ? FILTER_KV : (modelsConfig.kv_configs?.llamacpp ?? ['f16','q8_0','q4_0','k8v4']);
   const models  = filterModels(allModels).filter((m) => m.benches?.includes('longctx'));

   console.log(`\n${'═'.repeat(70)}`);
   console.log(`  LLAMA.CPP PHASE — ${models.length} models × ${kvTypes.length} KV configs`);
   console.log('═'.repeat(70));

   for (const model of models) {
      for (const kv of kvTypes) {
         const [ctk, ctv] = kv === 'k8v4' ? ['q8_0', 'q4_0'] : [kv, kv];
         const key = tsvKey(TARGET, kv, model.tag, '-', 'longctx');
         if (flags.resume && doneKeys.has(key)) {
            console.log(`  [${model.tag} KV=${kv}] skipped`);
            continue;
         }

         console.log(`\n  ── ${model.label} KV=${kv} (ctk=${ctk} ctv=${ctv})`);

         // Model path on rose — Ollama blobs dir; needs resolving on remote
         // run-suite passes a known GGUF path; for Ollama-managed models resolve via SSH
         const modelPath = process.env[`GGUF_PATH_${model.tag.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`]
            ?? `$(ollama show ${model.tag} --modelfile 2>/dev/null | grep '^FROM' | awk '{print $2}')`;

         let vramMib = null;
         try {
            const res = await srv.start({ modelPath, ctxSize: 65536, ctk, ctv, ngl: 99 });
            vramMib = res.vramMib;

            // Run all llama.cpp benches with this server instance
            const t0 = Date.now();
            const { stdout: passkey } = await execP(
               'node', [join(ROOT, 'benchmarks/longctx/passkey-bench.mjs'), '24000', kv, model.tag],
               { env: { ...process.env, LLAMA_URL }, timeout: 600_000 }
            );
            const pkLine = passkey.split('\n').find((l) => l.startsWith('RESULT\t'));
            const pkScore = pkLine ? pkLine.split('\t')[4] : '?';

            const { stdout: multifact } = await execP(
               'node', [join(ROOT, 'benchmarks/longctx/multifact-bench.mjs'), '24000', kv, model.tag],
               { env: { ...process.env, LLAMA_URL }, timeout: 600_000 }
            );
            const mfLine = multifact.split('\n').find((l) => l.startsWith('RESULT_MULTIFACT\t'));
            const mfScore = mfLine ? mfLine.split('\t')[4] : '?';

            const wall = ((Date.now() - t0) / 1000).toFixed(0);
            appendResult({ target: TARGET, kv, model: model.tag, think: '-', bench: 'longctx', score: pkScore, halls: '-', json_fail: '-', tok_s: '-', vram_mib: vramMib ?? '?', status: 'ok', wall_s: wall, notes: `multifact=${mfScore}` });
         } catch (e) {
            console.error(`  ERROR: ${e.message}`);
            appendResult({ target: TARGET, kv, model: model.tag, think: '-', bench: 'longctx', score: '?', halls: '-', json_fail: '-', tok_s: '-', vram_mib: vramMib ?? '?', status: `error:${e.message.slice(0, 60)}`, wall_s: '-', notes: '' });
         } finally {
            await srv.stop().catch(() => {});
         }
      }
   }

   console.log('\n[run-suite] llama.cpp phase complete.');
}

console.log(`\n[run-suite] Done. Results: ${RESULTS_TSV}`);
