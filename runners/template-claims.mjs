#!/usr/bin/env node
/**
 * template-claims.mjs — A/B the froggeric fixed chat-template against the built-in
 * GGUF template on the CLAIMS the core suite can't reach: multi-turn KV-cache
 * stability, token waste, empty-think poisoning, robustness edge cases, and
 * agentic error-recovery. Most probes are DETERMINISTIC — they test the template
 * by RENDERING (/apply-template) + tokenizing, not by generating — so they cost
 * ~nothing and don't depend on model speed.
 *
 * Probes:
 *   P1 prefix-stability   render(history) must stay an exact prefix of render(history+turn);
 *                         a template that mutates past turns invalidates KV cache. Counts
 *                         tokens invalidated per turn (real prefill waste over a conversation).
 *   P2 token-footprint    tokens in the rendered prompt for identical conversations.
 *   P3 empty-think        stray <think></think> shells + think tokens carried in history.
 *   P4 mid-convo system    system message at index>0 — does the template raise/500?
 *   P5 oversized-tool      huge tool response — render tokens + does a completion overflow ctx?
 *   P6 agentic-recovery   tools that error → recovery vs stall/repeat (real generation).
 *   P7 real-cache-reuse   drive the multi-turn convo for real; read timings.prompt_n
 *                         (tokens actually re-prefilled) per turn — confirms P1 in practice.
 *
 * Usage:
 *   node runners/template-claims.mjs                       # all 4 Qwen3.6, both arms
 *   node runners/template-claims.mjs --models Qwen3.6-35B
 *   node runners/template-claims.mjs --probe-url http://192.168.1.120:8090 --probe-model <id>
 *                                                          # render-probes only vs an existing server
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadHostConfig } from '../shared/hosts-config.mjs';
import { loadModelsConfig } from '../shared/models-config.mjs';
import { extraFlagsToString, llamacppServer } from './llamacpp-server.mjs';
import { FIXTURES, makeErrorExecutor, RECOVERY_TASKS, TOOLS } from './template-claims-fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.FROGGERIC_TEMPLATE || '/home/demonkoryu/froggeric-qwen-chat_template.jinja';
const { values: flags } = parseArgs({
   options: {
      models: { type: 'string', default: 'Qwen3.6' },
      target: { type: 'string', default: 'rose' },
      ctx: { type: 'string', default: '32768' },
      out: { type: 'string', default: join(ROOT, 'results', 'template-claims.json') },
      'probe-url': { type: 'string' },
      'probe-model': { type: 'string' },
   },
});

// ── tiny endpoint helpers ────────────────────────────────────────────────────
async function applyTemplate(baseUrl, model, messages, tools, addGen = true) {
   const body = { model, messages, add_generation_prompt: addGen };
   if (tools) { body.tools = tools; }
   const r = await fetch(`${baseUrl}/apply-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
   });
   const j = await r.json();
   if (j.error) {
      const e = new Error(j.error.message || JSON.stringify(j.error));
      e.status = r.status;
      throw e;
   }
   return j.prompt;
}
async function tokLen(baseUrl, model, content) {
   const r = await fetch(`${baseUrl}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, content }),
   });
   const j = await r.json();
   return Array.isArray(j.tokens) ? j.tokens.length : null;
}
const commonPrefixLen = (a, b) => {
   let i = 0;
   const n = Math.min(a.length, b.length);
   while (i < n && a[i] === b[i]) { i++; }
   return i;
};
const countMatches = (s, re) => (s.match(re) || []).length;

// ── deterministic render probes ──────────────────────────────────────────────
async function renderProbes(baseUrl, model) {
   const out = {};
   // P1 prefix stability + P7 setup: growing agentic transcript
   {
      const { messages, cutsHistory, tools } = FIXTURES.agentic;
      const renders = [];
      for (const c of cutsHistory) { renders.push(await applyTemplate(baseUrl, model, messages.slice(0, c), tools, false)); }
      const turns = [];
      let invalidatedTotal = 0,
         stable = true;
      for (let i = 1; i < renders.length; i++) {
         const prev = renders[i - 1],
            cur = renders[i];
         const isPrefix = cur.startsWith(prev);
         if (!isPrefix) { stable = false; }
         const common = commonPrefixLen(prev, cur);
         const survived = await tokLen(baseUrl, model, prev.slice(0, common));
         const prevTok = await tokLen(baseUrl, model, prev);
         const invalidated = prevTok - survived; // KV tokens destroyed when this turn is appended
         invalidatedTotal += invalidated;
         turns.push({ turn: i, isPrefix, prevTokens: prevTok, survivedTokens: survived, invalidatedTokens: invalidated });
      }
      out.p1_prefix_stability = { stable, invalidatedTotal, turns };
   }
   // P2 token footprint across representative conversations
   {
      const foot = {};
      for (const [name, fx] of Object.entries(FIXTURES.footprint)) {
         const p = await applyTemplate(baseUrl, model, fx.messages, fx.tools);
         foot[name] = await tokLen(baseUrl, model, p);
      }
      out.p2_token_footprint = foot;
   }
   // P3 empty-think poisoning: count stray think shells + think tokens in history
   {
      const fx = FIXTURES.thinkHistory;
      const p = await applyTemplate(baseUrl, model, fx.messages, fx.tools);
      const emptyShells = countMatches(p, /<think>\s*<\/think>/g);
      const thinkBlocks = countMatches(p, /<think>/g);
      out.p3_empty_think = { renderTokens: await tokLen(baseUrl, model, p), thinkBlocks, emptyShells };
   }
   try {
      const p = await applyTemplate(baseUrl, model, FIXTURES.midSystem.messages, null);
      out.p4_mid_system = { ok: true, renderTokens: await tokLen(baseUrl, model, p) };
   } catch (e) {
      out.p4_mid_system = { ok: false, error: (e.message || '').slice(0, 120), status: e.status || null };
   }
   try {
      const fx = FIXTURES.oversized;
      const p = await applyTemplate(baseUrl, model, fx.messages, fx.tools);
      out.p5_oversized = { ok: true, renderTokens: await tokLen(baseUrl, model, p), rawChars: fx.rawChars };
   } catch (e) {
      out.p5_oversized = { ok: false, error: (e.message || '').slice(0, 120) };
   }
   return out;
}

// ── behavioral probes (real generation) ──────────────────────────────────────
async function behavioralProbes(client, baseUrl, model) {
   const out = {};
   // P6 agentic error-recovery / stall
   {
      const tasks = [];
      for (const task of RECOVERY_TASKS) {
         const exec = makeErrorExecutor(task);
         let res = { content: '', steps: 0, allToolCalls: [] };
         try {
            res = await client.toolsLoop(
               [
                  {
                     role: 'system',
                     content:
                        'You are an agent. Use tools; if a tool errors, adapt — do not repeat the identical failing call. Stop when done.',
                  },
                  { role: 'user', content: task.prompt },
               ],
               TOOLS,
               exec,
               { maxSteps: 10, think: false, temperature: 0.0, max_tokens: 512 },
            );
         } catch (e) {
            res.error = (e.message || '').slice(0, 80);
         }
         const calls = res.allToolCalls || [];
         // stall = repeated identical failing call
         const sigs = calls.map((c) => `${c.name}:${JSON.stringify(c.arguments)}`);
         const repeats = sigs.length - new Set(sigs).size;
         const pass = task.grade(res);
         tasks.push({
            id: task.id,
            pass,
            steps: res.steps,
            calls: calls.length,
            repeatedCalls: repeats,
            recovered: task.needsRecovery ? pass : null,
         });
      }
      const passed = tasks.filter((t) => t.pass).length;
      out.p6_agentic_recovery = { passed, total: tasks.length, tasks };
   }
   // P7 real cache reuse: send the agentic turns in order, read prompt_n each turn
   {
      const { messages, cutsRequests, tools } = FIXTURES.agentic;
      const perTurn = [];
      let prefillTotal = 0;
      for (const c of cutsRequests) {
         const msgs = messages.slice(0, c);
         let timings = null;
         try {
            const r = await client.chat(msgs, { tools, temperature: 0.0, max_tokens: 1 });
            timings = r.timings;
         } catch (e) {
            perTurn.push({ upto: c, error: (e.message || '').slice(0, 80) });
            continue;
         }
         const promptN = timings?.prompt_n ?? null; // tokens actually prefilled (non-cached)
         const cachedN = timings?.cache_n ?? null;
         prefillTotal += promptN || 0;
         perTurn.push({ upto: c, prefilledTokens: promptN, cachedTokens: cachedN });
      }
      out.p7_real_cache = { prefillTotal, perTurn };
   }
   return out;
}

// ── probe-only mode (render probes vs an existing server) ─────────────────────
if (flags['probe-url']) {
   const url = flags['probe-url'];
   let model = flags['probe-model'];
   if (!model) {
      const j = await (await fetch(`${url}/v1/models`)).json();
      model = j.data[0].id;
   }
   console.error(`[probe-only] ${url}  model=${model}`);
   const r = await renderProbes(url, model);
   console.log(JSON.stringify(r, null, 2));
   process.exit(0);
}

// ── full A/B: manage servers, both arms, all models ───────────────────────────
const {
   llamaUrl: LLAMA_URL,
   sshHost: SSH_HOST,
   backend: BACKEND,
   gpu: GPU,
} = loadHostConfig(join(ROOT, 'config/hosts.yaml'), flags.target);
const modelsCfg = loadModelsConfig(join(ROOT, 'config/models.yaml'), { includeDisabled: true });
const filter = flags.models.split(',').map((s) => s.trim());
const wanted = modelsCfg.models.filter(
   (m) => (m.family || '').startsWith('qwen3.6') && filter.some((f) => (m.label || '').includes(f) || m.hf_file.includes(f)),
);
const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: BACKEND, debug: !!process.env.BENCH_DEBUG });
const client = srv.client;
const CTX = Number(flags.ctx);

console.error(`\n[template-claims] ${wanted.length} models × 2 arms · ctx=${CTX} · ${LLAMA_URL}\n`);
const results = {};
for (const m of wanted) {
   const id = m.hf_file.replace(/\.gguf$/, '');
   results[id] = { label: m.label, arch: m.type };
   const baseFlags = extraFlagsToString(m.extra_flags);
   for (const arm of ['baseline', 'treatment']) {
      const extraFlags = arm === 'treatment' ? `${baseFlags} --chat-template-file ${TEMPLATE}` : baseFlags;
      console.error(`\n══ ${m.label} · ${arm}`);
      await srv.killAll();
      await srv.waitVramClear?.(30_000).catch?.(() => {});
      try {
         await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, ctx: CTX, extraFlags });
         await srv.waitHealthy(360_000);
      } catch (e) {
         console.error(`  load failed: ${(e.message || '').slice(0, 80)} — skipping`);
         results[id][arm] = { error: 'load-failed' };
         continue;
      }
      const sm = await (await fetch(`${LLAMA_URL}/v1/models`)).json();
      const modelId = sm.data[0].id;
      const rp = await renderProbes(LLAMA_URL, modelId);
      const bp = await behavioralProbes(client, LLAMA_URL, modelId);
      results[id][arm] = { ...rp, ...bp };
      console.error(
         `  P1 stable=${rp.p1_prefix_stability.stable} invalidated=${rp.p1_prefix_stability.invalidatedTotal}  P7 prefill=${bp.p7_real_cache.prefillTotal}  P6 ${bp.p6_agentic_recovery.passed}/${bp.p6_agentic_recovery.total}`,
      );
   }
}
await srv.killAll();
writeFileSync(flags.out, JSON.stringify({ ts: new Date().toISOString(), template: TEMPLATE, ctx: CTX, results }, null, 2));
console.error(`\n[template-claims] wrote ${flags.out}`);
