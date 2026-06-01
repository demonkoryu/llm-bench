/**
 * Long-context passkey retrieval benchmark (needle-in-haystack).
 * Port of wisp-vault-mcp-ts/scripts/longctx-kv-bench.mjs.
 *
 * Runs against a live llama-server (OpenAI-compat endpoint).
 * The caller (llamacpp-server.mjs or run-suite.mjs) starts the server
 * with the desired --ctx-size / -ctk / -ctv flags before invoking this.
 *
 * Usage:
 *   LLAMA_URL=http://host:8090 node benchmarks/longctx/passkey-bench.mjs <ctxTokens> <kvLabel>
 *   Defaults: ctxTokens=24000, kvLabel=unknown
 *
 * Prints a machine-parseable summary line:
 *   RESULT\t<kvLabel>\t<model>\t<ctxTokens>\t<correct>/5\t<promptTokens>
 */

import { openaiCompatClient } from '../../shared/openai-compat.mjs';

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://127.0.0.1:8090';
const CTX = parseInt(process.argv[2] ?? '24000', 10);
const LABEL = process.argv[3] ?? 'unknown';
const MODEL_TAG = process.argv[4] ?? 'unknown';
const TIMEOUT = 600_000;

const client = openaiCompatClient(LLAMA_URL);

const FILLER = 'The grass is green and the sky is blue. The river flows quietly to the sea. ';

const NEEDLES = [
   { depth: 0.10, key: '481027', tag: 'alpha' },
   { depth: 0.30, key: '739154', tag: 'bravo' },
   { depth: 0.50, key: '602938', tag: 'charlie' },
   { depth: 0.72, key: '155847', tag: 'delta' },
   { depth: 0.90, key: '928461', tag: 'echo' },
];

function buildHaystack(approxTokens) {
   const targetChars = approxTokens * 4;
   const lineCount = Math.ceil(targetChars / FILLER.length);
   const lines = new Array(lineCount).fill(FILLER);
   for (const n of NEEDLES) {
      const idx = Math.floor(lineCount * n.depth);
      lines[idx] = `IMPORTANT: The ${n.tag} passkey is ${n.key}. Remember it. `;
   }
   return lines.join('');
}

console.log(`\n${'═'.repeat(64)}`);
console.log(`  Long-ctx passkey  KV=${LABEL}  ctx≈${CTX} tok  model=${MODEL_TAG}`);
console.log(`  endpoint: ${LLAMA_URL}`);
console.log('═'.repeat(64));

const haystack = buildHaystack(CTX);
let correct = 0;
let promptTokens = null;
const results = [];

for (const n of NEEDLES) {
   const prompt = `${haystack}\n\nQuestion: What is the ${n.tag} passkey? Reply with ONLY the 6-digit number, nothing else.`;
   process.stdout.write(`  ${n.tag.padEnd(8)} depth=${(n.depth * 100).toFixed(0).padStart(3)}%  `);
   try {
      const t0 = Date.now();
      const body = await client.chat(
         [{ role: 'user', content: prompt }],
         { temperature: 0.0, max_tokens: 20 },
         TIMEOUT,
      );
      const wallMs = Date.now() - t0;
      promptTokens = body.usage?.prompt_tokens ?? promptTokens;
      if (body.error) {
         console.log(`ERROR: ${JSON.stringify(body.error).slice(0, 120)}`);
         results.push({ tag: n.tag, ok: false });
         continue;
      }
      const txt = body.choices?.[0]?.message?.content ?? '';
      const m = txt.match(/\d{6}/);
      const answer = m ? m[0] : txt.trim().slice(0, 20);
      const ok = answer === n.key;
      if (ok) correct++;
      console.log(`${ok ? 'ok' : 'FAIL'}  got=${String(answer).padEnd(8)} want=${n.key}  ${(wallMs / 1000).toFixed(1)}s`);
      results.push({ tag: n.tag, depth: n.depth, ok, got: answer });
   } catch (e) {
      console.log(`FAIL: ${e.message}`);
      results.push({ tag: n.tag, ok: false });
   }
}

console.log(`  ${'─'.repeat(62)}`);
console.log(`  RETRIEVAL: ${correct}/${NEEDLES.length}  prompt_tokens=${promptTokens ?? '?'}  KV=${LABEL}`);
// Machine-parseable result line for run-suite.mjs to capture
console.log(`RESULT\t${LABEL}\t${MODEL_TAG}\t${CTX}\t${correct}/${NEEDLES.length}\t${promptTokens ?? '?'}`);
