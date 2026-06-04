#!/usr/bin/env node
/**
 * Structured-output reliability — how often a model emits valid, schema-conformant
 * JSON when asked (unconstrained, no grammar). Agents depend on parseable output;
 * with llama.cpp grammar enforcement most models hit ~100% by construction, so the
 * differentiating signal is the model's *natural* adherence without the grammar
 * crutch (and whether it errors at all — e.g. mamba models under schema bugs).
 *
 * Runs N varied JSON tasks per model, grades each: extracts JSON, parses it, and
 * checks the required keys/types. Writes a struct_output row (validity rate %).
 *
 * Usage: node runners/struct-output.mjs [--input results/<csv>] [--models a,b]
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { appendRow, ensureHeader, latestResultsFile } from '../shared/results-csv.mjs';
import { extraFlagsToString, llamacppServer } from './llamacpp-server.mjs';

const execP = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: flags } = parseArgs({
   options: { input: { type: 'string' }, models: { type: 'string', default: '' }, target: { type: 'string', default: 'rose' } },
});

const yaml = (await import('js-yaml')).default;
const modelsCfg = yaml.load(readFileSync(join(ROOT, 'config/models.yaml'), 'utf8'));
const hostsCfg = yaml.load(readFileSync(join(ROOT, 'config/hosts.yaml'), 'utf8'));
const host = hostsCfg[flags.target];
const resolveEnv = (s) => String(s ?? '').replace(/\$\{([^}]+)\}/g, (_, e) => process.env[e.split(':-')[0]] ?? e.split(':-')[1] ?? '');
const LLAMA_URL = resolveEnv(host.llamacpp);
const SSH_HOST = resolveEnv(host.ssh_host);

const input = flags.input ?? latestResultsFile(join(ROOT, 'results'));
if (!existsSync(input)) {
   console.error(`Input not found: ${input}`);
   process.exit(1);
}
ensureHeader(input);

// Each task: prompt + required {key: type}. type ∈ string|number|boolean|array|object.
const isType = (v, t) =>
   t === 'array' ? Array.isArray(v) : t === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === t;
const TASKS = [
   { p: 'Extract the person as JSON with keys name (string), age (number), email (string): "Dana Lee, 34, dana@x.io".', req: { name: 'string', age: 'number', email: 'string' } },
   { p: 'Classify the sentiment of "this update is fantastic" as JSON with keys sentiment (string) and confidence (number 0-1).', req: { sentiment: 'string', confidence: 'number' } },
   { p: 'Parse this address into JSON {street, city, zip}: "221B Baker Street, London, NW1 6XE".', req: { street: 'string', city: 'string', zip: 'string' } },
   { p: 'Emit a tool call as JSON with keys function (string) and arguments (object) to get weather for Tokyo in celsius.', req: { function: 'string', arguments: 'object' } },
   { p: 'Return JSON {items: [...]} listing the three primary colors as strings.', req: { items: 'array' } },
   { p: 'Return JSON describing a user: {user: {id (number), name (string)}, active (boolean)} for id 7, name Mia, active.', req: { user: 'object', active: 'boolean' } },
   { p: 'Convert to JSON {title, year, genres[]}: the film Inception, 2010, sci-fi and thriller.', req: { title: 'string', year: 'number', genres: 'array' } },
   { p: 'Return JSON {steps: [{n, action}]} for making tea in two steps.', req: { steps: 'array' } },
   { p: 'Return JSON {ok (boolean), code (number), message (string)} for a successful request, code 200.', req: { ok: 'boolean', code: 'number', message: 'string' } },
   { p: 'Extract amounts as JSON {currency (string), total (number), items (number)}: "3 items, total $42.50 USD".', req: { currency: 'string', total: 'number', items: 'number' } },
   { p: 'Return JSON {query (string), filters: {min_price (number), in_stock (boolean)}} for searching laptops under 1000 in stock.', req: { query: 'string', filters: 'object' } },
   { p: 'Return JSON {name, coords: {lat (number), lon (number)}} for Paris (48.85, 2.35).', req: { name: 'string', coords: 'object' } },
];

/** Pull the first balanced {...} object out of the text (tolerates prose / ``` fences). */
function extractJson(text) {
   const s = text.replace(/```(json)?/gi, '');
   const start = s.indexOf('{');
   if (start < 0) return null;
   let depth = 0;
   for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && --depth === 0) {
         try {
            return JSON.parse(s.slice(start, i + 1));
         } catch {
            return null;
         }
      }
   }
   return null;
}

const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: 'vulkan', debug: !!process.env.BENCH_DEBUG });
const client = srv.client;
const SYS = 'You output only valid JSON. No prose, no markdown fences — just the JSON object.';

/** Board power (W) via lm-sensors PPT/power1_average — reads under load on the 7900 XT. */
async function readPowerW() {
   try {
      const { stdout } = await execP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', SSH_HOST, 'sensors -j 2>/dev/null'], { timeout: 9000 });
      const j = JSON.parse(stdout);
      for (const chip of Object.values(j)) {
         if (chip && typeof chip === 'object') {
            for (const feat of Object.values(chip)) {
               if (feat && typeof feat === 'object' && 'power1_average' in feat) return feat.power1_average;
            }
         }
      }
   } catch {
      /* idle power-gates to N/A; under load it reads fine */
   }
   return null;
}

const filter = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const wanted = modelsCfg.models.filter((m) => {
   const id = m.hf_file.replace(/\.gguf$/, '');
   return !filter.length || filter.some((f) => id.includes(f) || (m.label ?? '').includes(f));
});

console.log(`\n[struct-output] ${wanted.length} models · ${TASKS.length} JSON tasks (unconstrained) · ${LLAMA_URL}\n`);
for (const m of wanted) {
   const id = m.hf_file.replace(/\.gguf$/, '');
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
   // Disable thinking on hybrid models (else reasoning eats the budget → no JSON).
   const probeThink = m.think === 'optional' ? false : null;
   const thinkControl = m.think_control ?? 'enable_thinking';
   // Power efficiency: sustained decode while sampling board power (tok/s ÷ W).
   const pw = [];
   let sampling = true;
   const poller = (async () => {
      while (sampling) {
         const w = await readPowerW();
         if (w) pw.push(w);
      }
   })();
   let decodeTps = null;
   try {
      const { timings } = await client.chat([{ role: 'user', content: 'Write a long, detailed essay about the history of computing.' }], { think: probeThink, thinkControl, max_tokens: 768, temperature: 0.7 }, 120_000);
      decodeTps = timings?.predicted_per_second ?? null;
   } catch {
      /* skip */
   }
   sampling = false;
   await poller;
   const avgW = pw.length ? pw.reduce((a, b) => a + b, 0) / pw.length : null;
   const tokPerW = decodeTps && avgW ? decodeTps / avgW : null;
   console.log(`  power: ${avgW ? avgW.toFixed(0) : '?'}W · ${decodeTps ? decodeTps.toFixed(0) : '?'} tok/s → ${tokPerW ? tokPerW.toFixed(2) : '?'} tok/s/W  (${pw.length} samples)`);
   if (tokPerW != null)
      appendRow(input, { target: flags.target, backend: 'vulkan', model: id, think: 'n/a', bench: 'power_eff', score: tokPerW.toFixed(3), tok_s: decodeTps.toFixed(1), status: 'ok', notes: `W=${avgW.toFixed(0)} tps=${decodeTps.toFixed(1)} n=${pw.length}` });

   let parseOk = 0;
   let schemaOk = 0;
   for (const t of TASKS) {
      let text = '';
      try {
         const { completion } = await client.chat([{ role: 'system', content: SYS }, { role: 'user', content: t.p }], { think: probeThink, thinkControl, max_tokens: 256, temperature: 0.0 }, 120_000);
         text = completion?.choices?.[0]?.message?.content ?? '';
      } catch {
         /* request error → counts as failure */
      }
      const obj = extractJson(text);
      if (obj) {
         parseOk++;
         if (Object.entries(t.req).every(([k, ty]) => k in obj && isType(obj[k], ty))) schemaOk++;
      }
   }
   const parsePct = (parseOk / TASKS.length) * 100;
   const schemaPct = (schemaOk / TASKS.length) * 100;
   console.log(`  valid JSON ${parseOk}/${TASKS.length} (${parsePct.toFixed(0)}%) · schema-conformant ${schemaOk}/${TASKS.length} (${schemaPct.toFixed(0)}%)`);
   appendRow(input, { target: flags.target, backend: 'vulkan', model: id, think: 'n/a', bench: 'struct_output', score: schemaPct.toFixed(1), json_fail: TASKS.length - parseOk, status: 'ok', notes: `parse=${parsePct.toFixed(0)}% schema=${schemaPct.toFixed(0)}%` });
}
await srv.stopServer();
await srv.waitVramClear(20_000);
console.log(`\n[struct-output] done → rows appended to ${input}`);
