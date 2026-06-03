/**
 * Long-context multi-fact synthesis benchmark.
 *
 * Unlike the passkey test (which is quant-robust — always 5/5), this task
 * requires synthesizing several scattered facts to find WHERE q4/k8v4 KV
 * actually degrades quality.
 *
 * Task: 8 facts are hidden at varied depths in a haystack. The model must
 * answer questions that require combining 2-3 facts. Graded as exact match
 * on the composite answer.
 *
 * Usage:
 *   LLAMA_URL=http://host:8090 node benchmarks/longctx/multifact-bench.mjs <ctxTokens> <kvLabel> [modelTag]
 */

import { createClient } from '../../shared/llm/index.mjs';

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://127.0.0.1:8090';
const CTX = parseInt(process.argv[2] ?? '24000', 10);
const LABEL = process.argv[3] ?? 'unknown';
const MODEL_TAG = process.argv[4] ?? 'unknown';
const TIMEOUT = 600_000;

const llm = createClient(LLAMA_URL);
const FILLER = 'The grass is green and the sky is blue. The river flows quietly to the sea. ';

// Facts hidden at different depths; some questions require combining multiple facts.
const FACTS = [
   { depth: 0.05, text: 'The capital city of Zorland is Brentara.' },
   { depth: 0.15, text: 'The population of Brentara is exactly 847,200.' },
   { depth: 0.28, text: "Zorland's national currency is the Draken." },
   { depth: 0.42, text: 'One Draken is worth exactly 2.35 US dollars.' },
   { depth: 0.55, text: 'The official language of Zorland is Kelvish.' },
   { depth: 0.68, text: 'Zorland was founded in the year 1347.' },
   { depth: 0.8, text: 'The current president of Zorland is Mira Ostfeld.' },
   { depth: 0.93, text: "Mira Ostfeld took office exactly 7 years after Zorland's 600th anniversary." },
];

// Questions requiring fact synthesis; expected = exact answer string (normalized)
const QUESTIONS = [
   {
      id: 'capital-pop',
      q: 'What is the population of the capital city of Zorland? Give just the number.',
      // requires facts 0+1: Brentara is capital; pop = 847200
      expected: ['847200', '847,200'],
   },
   {
      id: 'currency-usd',
      q: 'If someone has 100 Draken, how many US dollars is that? Give just the number.',
      // requires facts 2+3: 1 Draken = 2.35 USD → 100 × 2.35 = 235
      expected: ['235', '235.0', '235.00'],
   },
   {
      id: 'president-year',
      q: 'What year did Mira Ostfeld take office? Give just the year.',
      // requires facts 5+7: founded 1347, 600th anniv = 1947, +7 = 1954
      expected: ['1954'],
   },
   {
      id: 'language',
      q: 'What is the official language of Zorland?',
      // single fact 4
      expected: ['kelvish'],
   },
];

function norm(s) {
   return String(s ?? '')
      .toLowerCase()
      .replace(/[,\s]/g, '')
      .trim();
}

function buildHaystack(approxTokens) {
   const targetChars = approxTokens * 4;
   const lineCount = Math.ceil(targetChars / FILLER.length);
   const lines = new Array(lineCount).fill(FILLER);
   for (const f of FACTS) {
      lines[Math.floor(lineCount * f.depth)] = `${f.text} `;
   }
   return lines.join('');
}

console.log(`\n${'═'.repeat(64)}`);
console.log(`  Multi-fact synthesis  KV=${LABEL}  ctx≈${CTX} tok  model=${MODEL_TAG}`);
console.log('═'.repeat(64));

const haystack = buildHaystack(CTX);
let correct = 0;
let promptTokens = null;

for (const q of QUESTIONS) {
   const prompt = `${haystack}\n\nQuestion: ${q.q}\nAnswer concisely. Do NOT explain.`;
   process.stdout.write(`  ${q.id.padEnd(18)} `);
   try {
      const { completion: body } = await llm.chat([{ role: 'user', content: prompt }], { temperature: 0.0, max_tokens: 30 }, TIMEOUT);
      promptTokens = body.usage?.prompt_tokens ?? promptTokens;
      const txt = (body.choices?.[0]?.message?.content ?? '').trim();
      const got = norm(txt);
      const ok = q.expected.some((e) => norm(e) === got || got.includes(norm(e)));
      if (ok) {
         correct++;
      }
      console.log(`${ok ? 'ok' : 'FAIL'}  got="${txt.slice(0, 30)}"  want=[${q.expected.join('/')}]`);
   } catch (e) {
      console.log(`ERROR: ${e.message}`);
   }
}

console.log(`  ${'─'.repeat(62)}`);
console.log(`  SYNTHESIS: ${correct}/${QUESTIONS.length}  prompt_tokens=${promptTokens ?? '?'}  KV=${LABEL}`);
console.log(`RESULT_MULTIFACT\t${LABEL}\t${MODEL_TAG}\t${CTX}\t${correct}/${QUESTIONS.length}\t${promptTokens ?? '?'}`);
