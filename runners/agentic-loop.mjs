#!/usr/bin/env node
/**
 * Multi-turn agentic tool loop (ReAct-style).
 *
 * The toolcalling bench scores ONE tool call in isolation; this scores a whole
 * loop: chain 3–5 dependent calls (output of one feeds the next), recover from a
 * tool error, and know when to STOP (answer directly instead of looping). Cases +
 * the deterministic world live in benchmarks/agentic/agentic-cases.mjs; the loop is
 * driven by client.toolsLoop() so the model decides each step.
 *
 * Grading is deterministic — each case's grade() reads the final content and the
 * recorded tool calls. The headline is task completion %; we also report mean steps
 * (efficiency vs the optimal path) and the error-recovery outcome in notes.
 *
 * Writes per base model:
 *   agentic_loop   score = task completion %   (notes carry mean steps + recovery)
 *
 * Hybrids run no-think (tool use lands in tool_calls, not reasoning); reasoner/
 * required models get a large budget so reasoning_content doesn't starve the call
 * (see reasoner-token-budget). Report-only — NOT in the composite score.
 *
 * Usage: node runners/agentic-loop.mjs [--input results/<runId>] [--models a,b]
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CASES, makeExecutor, TOOLS } from '../benchmarks/agentic/agentic-cases.mjs';
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
   kind: 'agentic-loop',
   inputFlag: flags.input,
});

const filter = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const wanted = modelsCfg.models.filter((m) => {
   const id = m.hf_file.replace(/\.gguf$/, '');
   return !filter.length || filter.some((f) => id.includes(f) || (m.label ?? '').includes(f));
});

const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: BACKEND, debug: !!process.env.BENCH_DEBUG });
const client = srv.client;

const SYSTEM =
   'You are a helpful assistant with access to tools. To answer questions about users, accounts and currencies, ' +
   'call the tools step by step — feed the result of one call into the next. When you have enough information, ' +
   'stop calling tools and reply with the final answer only. Do not call tools you do not need.';

console.log(`\n[agentic-loop] ${wanted.length} models · ${CASES.length} tasks · ${LLAMA_URL}\n`);
for (const m of wanted) {
   const id = m.hf_file.replace(/\.gguf$/, '');
   const probeThink = m.think === 'optional' ? false : null;
   const thinkControl = m.think_control ?? 'enable_thinking';
   const reasons = m.think === 'reasoning' || m.think === 'required';
   const maxTokens = reasons ? 4096 : 1024;
   console.log(`\n══ ${m.label ?? id}`);
   await srv.killAll();
   await srv.waitVramClear(30_000);
   try {
      await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, ctx: 16384, extraFlags: extraFlagsToString(m.extra_flags) });
      await srv.waitHealthy(360_000);
   } catch (e) {
      console.log(`  load failed: ${e.message.slice(0, 70)} — skipping`);
      continue;
   }

   let passed = 0;
   let stepsSum = 0;
   let stepsN = 0;
   let recoveryTasks = 0;
   let recoveredOk = 0;
   for (const c of CASES) {
      const messages = [
         { role: 'system', content: SYSTEM },
         { role: 'user', content: c.prompt },
      ];
      let res = { content: '', steps: 0, allToolCalls: [] };
      try {
         res = await client.toolsLoop(messages, TOOLS, makeExecutor(), {
            maxSteps: 12,
            think: probeThink,
            thinkControl,
            max_tokens: maxTokens,
            temperature: 0.0,
         });
      } catch (e) {
         console.log(`  ${c.id}: error ${e.message.slice(0, 50)}`);
      }
      let g = { pass: false };
      try {
         g = c.grade(res);
      } catch {
         g = { pass: false };
      }
      if (g.pass) passed++;
      stepsSum += res.steps;
      stepsN++;
      if ('recovered' in g) {
         recoveryTasks++;
         if (g.recovered) recoveredOk++;
      }
      const eff = g.optimalSteps ? ` [opt ${g.optimalSteps}]` : '';
      console.log(
         `  ${c.id.padEnd(20)} ${g.pass ? 'PASS' : 'FAIL'}  steps ${res.steps}${eff}  calls ${res.allToolCalls.length}` +
            ('recovered' in g ? `  recovered ${g.recovered ? 'yes' : 'no'}` : ''),
      );
   }
   const score = CASES.length ? (passed / CASES.length) * 100 : 0;
   const meanSteps = stepsN ? stepsSum / stepsN : 0;
   const recNote = recoveryTasks ? ` recovery ${recoveredOk}/${recoveryTasks}` : '';
   console.log(`  → ${score.toFixed(1)}%  (${passed}/${CASES.length} tasks · mean steps ${meanSteps.toFixed(1)}${recNote})`);
   run.append({
      target: flags.target,
      backend: BACKEND,
      model: id,
      think: 'n/a',
      bench: 'agentic_loop',
      score: score.toFixed(1),
      status: 'ok',
      notes: `${passed}/${CASES.length} tasks · steps ${meanSteps.toFixed(1)}${recNote}`,
   });
}
await srv.stopServer();
await srv.waitVramClear(20_000);
run.finalize('complete');
console.log(`\n[agentic-loop] done → ${run.dir}`);
