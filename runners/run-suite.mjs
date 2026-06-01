#!/usr/bin/env node
/**
 * Serial benchmark orchestrator — restart-minimizing loop order.
 *
 * Ollama side (3 service restarts total):
 *   for kv in [f16, q8_0, q4_0]:          ← OUTER: 1 systemd restart per KV type
 *     restart Ollama with that KV type
 *     for model in fittingModels:          ← INNER: hot-swap, no restart
 *       unloadAll(); warmup()
 *       run: triage, reasoning, toolcalling, toolcalling_decay, summarization, speed, maxctx
 *
 * llama.cpp side (1 server start per model×kv combo):
 *   for model in llamacppModels:
 *     for kv in kvConfigs:
 *       start llama-server; run longctx passkey + multifact; stop server
 *
 * Usage:
 *   node runners/run-suite.mjs [options]
 *
 * Options:
 *   --target rose|m1       Host target (default: rose)
 *   --models <tag,...>     Restrict to these model tags
 *   --benches <name,...>   Restrict to these bench names
 *   --kv <type,...>        KV types to sweep
 *   --dry-run              Print matrix and exit
 *   --no-llamacpp          Skip llama.cpp phase
 *   --no-ollama            Skip Ollama phase
 *   --resume               Skip combos already in results/results.tsv
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const execP = promisify(execFile);

// ── CLI args ───────────────────────────────────────────────────────────────────
const { values: flags } = parseArgs({
   options: {
      target:        { type: 'string',  default: 'rose' },
      models:        { type: 'string',  default: '' },
      benches:       { type: 'string',  default: '' },
      kv:            { type: 'string',  default: '' },
      'dry-run':     { type: 'boolean', default: false },
      'no-llamacpp': { type: 'boolean', default: false },
      'no-ollama':   { type: 'boolean', default: false },
      resume:        { type: 'boolean', default: false },
   },
});

const DRY_RUN      = flags['dry-run'];
const TARGET       = flags.target;
const FILTER_MODELS  = flags.models  ? flags.models.split(',').map((s) => s.trim())  : [];
const FILTER_BENCHES = flags.benches ? flags.benches.split(',').map((s) => s.trim()) : [];
const FILTER_KV      = flags.kv      ? flags.kv.split(',').map((s) => s.trim())      : [];

// ── Config ─────────────────────────────────────────────────────────────────────
let yaml;
try {
   yaml = (await import('js-yaml')).default;
} catch {
   yaml = { load: () => { throw new Error('js-yaml not available; run npm install'); } };
}

const modelsConfig = yaml.load(readFileSync(join(ROOT, 'config/models.yaml'), 'utf8'));
const hostsConfig  = yaml.load(readFileSync(join(ROOT, 'config/hosts.yaml'),  'utf8'));

const host = hostsConfig[TARGET];
if (!host) throw new Error(`Unknown target: ${TARGET}`);

function resolveEnvTemplate(s) {
   return String(s ?? '').replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const [varName, def] = expr.split(':-');
      return process.env[varName] ?? def ?? '';
   });
}

const OLLAMA_HOST = resolveEnvTemplate(host.ollama);
const LLAMA_URL   = host.llamacpp ? resolveEnvTemplate(host.llamacpp) : null;
const SSH_HOST    = resolveEnvTemplate(host.ssh_host);

// ── Model helpers ──────────────────────────────────────────────────────────────
const allModels = modelsConfig.models ?? [];

function filterModels(models) {
   return models.filter((m) => {
      if (m.fit_rose === 'oom') return false;
      if (FILTER_MODELS.length && !FILTER_MODELS.some((f) => m.tag.includes(f))) return false;
      return true;
   });
}

// Sampling options per model + bench context, mirroring modelOptions() from grade-triage.mjs
function samplingOpts(model, think, bench) {
   if (bench === 'reasoning') return { temperature: 0.6, top_p: 0.95, top_k: 20, num_ctx: 8192 };
   if (bench === 'toolcalling' || bench === 'toolcalling_decay') return { temperature: 0.4, top_p: 0.9, num_ctx: 8192 };
   // triage / summarization — family-specific
   const f = model.family ?? '';
   if (f.startsWith('qwen3.5') || f.startsWith('qwen3.6')) {
      return think
         ? { temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0.0 }
         : { temperature: 0.7, top_p: 0.8,  top_k: 20, presence_penalty: 1.5 };
   }
   if (f.startsWith('deepseek')) {
      return model.tag.includes('0528')
         ? { temperature: 0.6, top_p: 0.95, min_p: 0.01 }
         : { temperature: 0.6, top_p: 0.95, min_p: 0.05 };
   }
   if (f === 'gpt-oss') return { temperature: 0.6 };
   return { temperature: 0.1 };
}

// ── Results TSV ────────────────────────────────────────────────────────────────
const RESULTS_DIR = join(ROOT, 'results');
const RESULTS_TSV = join(RESULTS_DIR, 'results.tsv');
mkdirSync(RESULTS_DIR, { recursive: true });

const TSV_HEADER = 'target\tkv\tmodel\tthink\tbench\tscore\thalls\tjson_fail\ttok_s\tvram_mib\tstatus\twall_s\tnotes\n';
if (!existsSync(RESULTS_TSV)) appendFileSync(RESULTS_TSV, TSV_HEADER);

function tsvKey(target, kv, model, think, bench) {
   return `${target}\t${kv}\t${model}\t${think}\t${bench}`;
}

function loadDoneKeys() {
   if (!existsSync(RESULTS_TSV)) return new Set();
   return new Set(
      readFileSync(RESULTS_TSV, 'utf8').split('\n').slice(1).filter(Boolean)
         .map((l) => l.split('\t').slice(0, 5).join('\t'))
   );
}

function appendResult(row) {
   appendFileSync(RESULTS_TSV, Object.values(row).join('\t') + '\n');
}

// ── promptfoo runner ───────────────────────────────────────────────────────────
const PROMPTFOO_BIN = join(ROOT, 'node_modules/promptfoo/dist/src/main.js');

async function runPromptfoo(benchDir, benchName, model, think) {
   const opts = samplingOpts(model, think, benchName);
   const thinkStr = think === null ? '' : think ? 'true' : 'false';
   // Use a temp output file (promptfoo requires a path, not format-name)
   const outFile = join(ROOT, `results/.pf-${benchName}-${Date.now()}.json`);
   const env = {
      ...process.env,
      OLLAMA_HOST,
      BENCH_MODEL: model.tag,
      BENCH_BENCH: benchName,
      BENCH_THINK: thinkStr,
      BENCH_OPTS_JSON: JSON.stringify(opts),
      PROMPTFOO_DISABLE_CACHE: '1',
   };
   const { stderr } = await execP(
      'node', [PROMPTFOO_BIN, 'eval', '--no-cache', '--output', outFile],
      { cwd: benchDir, env, timeout: 3_600_000 }
   ).catch((e) => ({ stdout: '', stderr: e.stderr ?? e.message }));

   try {
      const raw = readFileSync(outFile, 'utf8');
      unlinkSync(outFile);
      return JSON.parse(raw);
   } catch {
      console.error(`[promptfoo] ${benchName} failed: ${(stderr ?? '').slice(0, 300)}`);
      try { unlinkSync(outFile); } catch {}
      return null;
   }
}

// Extract aggregate metrics from a promptfoo result
function summarizePromptfooResult(result, benchName) {
   if (!result) return { score: '?', halls: '?', json_fail: '?', tok_s: '?' };

   const results = result.results?.results ?? [];
   if (!results.length) return { score: '?', halls: '?', json_fail: '?', tok_s: '?' };

   const scores = results.map((r) => r.score ?? 0);
   const avgScore = (scores.reduce((a, b) => a + b, 0) / scores.length * 100).toFixed(1);

   let halls = '-', jsonFail = '-';
   if (benchName === 'triage') {
      halls = results.filter((r) => r.gradingResult?.reason?.includes('ANCHOR_HALL')).length;
      jsonFail = results.filter((r) => r.gradingResult?.reason?.includes('JSON_FAIL')).length;
   }

   // tok/s from provider metadata if available
   const tokRates = results.flatMap((r) => {
      const meta = r.response?.metadata;
      return meta?.tok_per_sec ? [parseFloat(meta.tok_per_sec)] : [];
   });
   const tokS = tokRates.length ? (tokRates.reduce((a, b) => a + b) / tokRates.length).toFixed(1) : '?';

   return { score: avgScore, halls, json_fail: jsonFail, tok_s: tokS };
}

// ── Speed measurement ─────────────────────────────────────────────────────────
async function measureSpeed(tag, think, numCtx = 4096) {
   const body = {
      model: tag, stream: false,
      options: { temperature: 0.7, num_ctx: numCtx, num_predict: 150 },
      messages: [{ role: 'user', content: 'Describe the water cycle in detail.' }],
   };
   if (think !== null) body.think = think;
   try {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         signal: AbortSignal.timeout(120_000),
         body: JSON.stringify(body),
      });
      const resp = await res.json();
      const tps = resp.eval_count && resp.eval_duration
         ? (resp.eval_count / (resp.eval_duration / 1e9)).toFixed(1) : null;
      return { tps };
   } catch {
      return { tps: null };
   }
}

// ── Max-context binary search ─────────────────────────────────────────────────
async function probeMaxCtx(tag) {
   const CTX_POINTS = modelsConfig.ctx_probe_points ?? [4096, 16384, 32768, 65536];
   let lo = 0, hi = CTX_POINTS.length - 1, best = CTX_POINTS[0];
   while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const ctx = CTX_POINTS[mid];
      const ok = await canLoadCtx(tag, ctx);
      if (ok) { best = ctx; lo = mid + 1; } else { hi = mid - 1; }
   }
   return best;
}

async function canLoadCtx(tag, numCtx) {
   try {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         signal: AbortSignal.timeout(60_000),
         body: JSON.stringify({ model: tag, stream: false, options: { num_ctx: numCtx, num_predict: 1 }, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const b = await res.json();
      return !b.error;
   } catch {
      return false;
   }
}

// ── VRAM snapshot ─────────────────────────────────────────────────────────────
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

// ── Ollama unload/warmup via direct fetch (no SSH needed) ─────────────────────
async function unloadAll() {
   try {
      const res = await fetch(`${OLLAMA_HOST}/api/ps`, { signal: AbortSignal.timeout(5000) });
      const models = (await res.json()).models ?? [];
      for (const m of models) {
         await fetch(`${OLLAMA_HOST}/api/generate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m.name, keep_alive: 0 }),
            signal: AbortSignal.timeout(15_000),
         }).catch(() => {});
      }
   } catch {}
}

async function warmup(tag, supportsThink) {
   try {
      await fetch(`${OLLAMA_HOST}/api/chat`, {
         method: 'POST', headers: { 'Content-Type': 'application/json' },
         signal: AbortSignal.timeout(120_000),
         body: JSON.stringify({
            model: tag, stream: false,
            think: supportsThink ? false : undefined,
            options: { num_predict: 1 },
            messages: [{ role: 'user', content: supportsThink ? 'hi /no_think' : 'hi' }],
         }),
      });
   } catch {}
}

// ── Dry-run ───────────────────────────────────────────────────────────────────
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
            console.log(`  ${m.tag.padEnd(52)} KV=${kv}`);
         }
      }
   }
   console.log(`\nTotal Ollama restarts: ${kvOllama.length}`);
   console.log(`Total llama.cpp server starts: ${flags['no-llamacpp'] ? 0 : llamaModels.length * kvLlama.length}`);
}

if (DRY_RUN) { dryRun(); process.exit(0); }

// ── Main ──────────────────────────────────────────────────────────────────────
const doneKeys = flags.resume ? loadDoneKeys() : new Set();

// ══════════════════════════════════════════════════════════════════════════════
// OLLAMA PHASE
// ══════════════════════════════════════════════════════════════════════════════
if (!flags['no-ollama']) {
   const kvTypes    = FILTER_KV.length ? FILTER_KV : (modelsConfig.kv_configs?.ollama ?? ['f16','q8_0','q4_0']);
   const models     = filterModels(allModels).filter((m) => m.benches?.some((b) => b !== 'longctx'));

   let kvMgr = null;
   if (host.ollama_service) {
      const { ollamaKvManager } = await import('./ollama-kv.mjs');
      kvMgr = ollamaKvManager({ sshHost: SSH_HOST, service: host.ollama_service, ollamaHost: OLLAMA_HOST });
   }

   for (const kv of kvTypes) {
      console.log(`\n${'═'.repeat(70)}`);
      console.log(`  OLLAMA PHASE — KV=${kv}${kvMgr ? '  (restarting service)' : ''}`);
      console.log('═'.repeat(70));

      if (kvMgr) await kvMgr.setKvType(kv);

      for (const model of models) {
         const { tag, label } = model;
         const supportsThink = model.think === 'optional' || model.think === 'required';
         const hasTools = model.tools === true;

         await unloadAll();
         await warmup(tag, supportsThink);

         const benches = (model.benches ?? []).filter(
            (b) => b !== 'longctx' && (!FILTER_BENCHES.length || FILTER_BENCHES.includes(b))
         );
         console.log(`\n  ── ${label} (${tag})  benches: ${benches.join(', ')}`);

         const thinkModes = supportsThink ? [false, true] : [null];

         for (const think of thinkModes) {
            const thinkLabel = think === null ? 'n/a' : think ? 'think' : 'no_think';

            // triage
            if (benches.includes('triage')) {
               const key = tsvKey(TARGET, kv, tag, thinkLabel, 'triage');
               if (flags.resume && doneKeys.has(key)) { console.log(`    [triage ${thinkLabel}] skip`); continue; }
               console.log(`    [triage ${thinkLabel}] ...`);
               const t0 = Date.now();
               const pfResult = await runPromptfoo(join(ROOT, 'benchmarks/triage'), 'triage', model, think);
               const { score, halls, json_fail, tok_s } = summarizePromptfooResult(pfResult, 'triage');
               const vram = await snapshotVram();
               const wall = ((Date.now() - t0) / 1000).toFixed(0);
               const status = pfResult ? 'ok' : 'error';
               console.log(`      score=${score}  halls=${halls}  json_fail=${json_fail}  tok/s=${tok_s}  vram=${vram}MiB`);
               appendResult({ target: TARGET, kv, model: tag, think: thinkLabel, bench: 'triage', score, halls, json_fail, tok_s, vram_mib: vram ?? '?', status, wall_s: wall, notes: '' });
            }

            // reasoning
            if (benches.includes('reasoning')) {
               const key = tsvKey(TARGET, kv, tag, thinkLabel, 'reasoning');
               if (flags.resume && doneKeys.has(key)) { console.log(`    [reasoning ${thinkLabel}] skip`); continue; }
               console.log(`    [reasoning ${thinkLabel}] ...`);
               const t0 = Date.now();
               const pfResult = await runPromptfoo(join(ROOT, 'benchmarks/reasoning'), 'reasoning', model, think);
               const { score, tok_s } = summarizePromptfooResult(pfResult, 'reasoning');
               const vram = await snapshotVram();
               const wall = ((Date.now() - t0) / 1000).toFixed(0);
               console.log(`      accuracy=${score}  tok/s=${tok_s}`);
               appendResult({ target: TARGET, kv, model: tag, think: thinkLabel, bench: 'reasoning', score, halls: '-', json_fail: '-', tok_s, vram_mib: vram ?? '?', status: pfResult ? 'ok' : 'error', wall_s: wall, notes: '' });
            }

            // toolcalling (no_think only)
            if (benches.includes('toolcalling') && hasTools && think !== true) {
               const key = tsvKey(TARGET, kv, tag, thinkLabel, 'toolcalling');
               if (flags.resume && doneKeys.has(key)) { console.log(`    [toolcalling] skip`); continue; }
               console.log(`    [toolcalling] ...`);
               const t0 = Date.now();
               const pfResult = await runPromptfoo(join(ROOT, 'benchmarks/toolcalling'), 'toolcalling', model, false);
               const { score, tok_s } = summarizePromptfooResult(pfResult, 'toolcalling');
               const vram = await snapshotVram();
               const wall = ((Date.now() - t0) / 1000).toFixed(0);
               console.log(`      accuracy=${score}  tok/s=${tok_s}`);
               appendResult({ target: TARGET, kv, model: tag, think: thinkLabel, bench: 'toolcalling', score, halls: '-', json_fail: '-', tok_s, vram_mib: vram ?? '?', status: pfResult ? 'ok' : 'error', wall_s: wall, notes: '' });
            }

            // toolcalling_decay (no_think, first KV pass only — result independent of KV type)
            if (benches.includes('toolcalling_decay') && hasTools && think !== true && kv === kvTypes[0]) {
               const key = tsvKey(TARGET, kvTypes[0], tag, thinkLabel, 'toolcalling_decay');
               if (flags.resume && doneKeys.has(key)) { console.log(`    [toolcalling_decay] skip`); continue; }
               console.log(`    [toolcalling_decay] ...`);
               const t0 = Date.now();
               const { stdout } = await execP(
                  'node', [join(ROOT, 'benchmarks/toolcalling/decay-bench.mjs'), tag],
                  { env: { ...process.env, OLLAMA_HOST }, timeout: 3_600_000 }
               ).catch((e) => ({ stdout: '', stderr: e.message }));
               // Parse DECAY SUMMARY from stdout: last accuracy row per round
               const decayRows = [...stdout.matchAll(/^\s+(\d+)\s+\d+\s+([\d.]+)%/gm)].map((m) => `r${m[1]}=${m[2]}%`);
               const wall = ((Date.now() - t0) / 1000).toFixed(0);
               appendResult({ target: TARGET, kv: kvTypes[0], model: tag, think: thinkLabel, bench: 'toolcalling_decay', score: '-', halls: '-', json_fail: '-', tok_s: '-', vram_mib: '?', status: 'ok', wall_s: wall, notes: decayRows.join(' ') });
            }

            // summarization (no_think)
            if (benches.includes('summarization') && think !== true) {
               const key = tsvKey(TARGET, kv, tag, thinkLabel, 'summarization');
               if (flags.resume && doneKeys.has(key)) { console.log(`    [summarization] skip`); continue; }
               console.log(`    [summarization] ...`);
               const t0 = Date.now();
               const pfResult = await runPromptfoo(join(ROOT, 'benchmarks/summarization'), 'summarization', model, think === null ? null : false);
               const { score, tok_s } = summarizePromptfooResult(pfResult, 'summarization');
               const vram = await snapshotVram();
               const wall = ((Date.now() - t0) / 1000).toFixed(0);
               console.log(`      score=${score}`);
               appendResult({ target: TARGET, kv, model: tag, think: thinkLabel, bench: 'summarization', score, halls: '-', json_fail: '-', tok_s, vram_mib: vram ?? '?', status: pfResult ? 'ok' : 'error', wall_s: wall, notes: '' });
            }
         }

         // speed (no_think; all KV passes)
         if (benches.includes('speed')) {
            const key = tsvKey(TARGET, kv, tag, 'no_think', 'speed');
            if (flags.resume && doneKeys.has(key)) { console.log(`    [speed] skip`); }
            else {
               console.log(`    [speed] measuring...`);
               const t0 = Date.now();
               const { tps } = await measureSpeed(tag, supportsThink ? false : null, 4096);
               const vram = await snapshotVram();
               const wall = ((Date.now() - t0) / 1000).toFixed(0);
               console.log(`      ${tps ?? '?'} tok/s`);
               appendResult({ target: TARGET, kv, model: tag, think: 'no_think', bench: 'speed', score: tps ?? '?', halls: '-', json_fail: '-', tok_s: tps ?? '?', vram_mib: vram ?? '?', status: tps ? 'ok' : 'error', wall_s: wall, notes: '' });
            }
         }

         // maxctx (first KV pass only)
         if (benches.includes('maxctx') && kv === kvTypes[0]) {
            const key = tsvKey(TARGET, kv, tag, '-', 'maxctx');
            if (flags.resume && doneKeys.has(key)) { console.log(`    [maxctx] skip`); }
            else {
               console.log(`    [maxctx] binary search...`);
               const t0 = Date.now();
               const maxCtx = await probeMaxCtx(tag);
               const vram = await snapshotVram();
               const wall = ((Date.now() - t0) / 1000).toFixed(0);
               console.log(`      max_ctx=${maxCtx} (${(maxCtx * 4).toLocaleString()} chars)`);
               appendResult({ target: TARGET, kv, model: tag, think: '-', bench: 'maxctx', score: maxCtx, halls: '-', json_fail: '-', tok_s: '-', vram_mib: vram ?? '?', status: 'ok', wall_s: wall, notes: '' });
            }
         }
      }
   }

   if (kvMgr) await kvMgr.restore();
   console.log('\n[run-suite] Ollama phase complete.');
}

// ══════════════════════════════════════════════════════════════════════════════
// LLAMA.CPP PHASE
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
         if (flags.resume && doneKeys.has(key)) { console.log(`  [${model.tag} KV=${kv}] skip`); continue; }

         console.log(`\n  ── ${model.label} KV=${kv} (ctk=${ctk} ctv=${ctv})`);

         // Resolve GGUF path on rose via ollama modelfile
         const modelPath = `$(ollama show '${model.tag}' --modelfile 2>/dev/null | awk '/^FROM/{print $2}')`;

         let vramMib = null;
         try {
            const res = await srv.start({ modelPath, ctxSize: 65536, ctk, ctv, ngl: 99 });
            vramMib = res.vramMib;

            const t0 = Date.now();
            const llamaEnv = { ...process.env, LLAMA_URL };

            const [pkOut, mfOut] = await Promise.all([
               execP('node', [join(ROOT, 'benchmarks/longctx/passkey-bench.mjs'), '24000', kv, model.tag], { env: llamaEnv, timeout: 600_000 }).catch((e) => ({ stdout: '', stderr: e.message })),
               execP('node', [join(ROOT, 'benchmarks/longctx/multifact-bench.mjs'), '24000', kv, model.tag], { env: llamaEnv, timeout: 600_000 }).catch((e) => ({ stdout: '', stderr: e.message })),
            ]);

            const pkLine = pkOut.stdout.split('\n').find((l) => l.startsWith('RESULT\t'));
            const mfLine = mfOut.stdout.split('\n').find((l) => l.startsWith('RESULT_MULTIFACT\t'));
            const pkScore = pkLine ? pkLine.split('\t')[4] : '?';
            const mfScore = mfLine ? mfLine.split('\t')[4] : '?';
            const wall = ((Date.now() - t0) / 1000).toFixed(0);

            console.log(`    passkey=${pkScore}  multifact=${mfScore}  vram=${vramMib}MiB`);
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
