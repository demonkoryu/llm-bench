/**
 * Synthetic codebase builder for long-context comprehension testing.
 * Ported from wisp-vault-mcp-ts scripts/bench-ts/data/codebase.ts.
 *
 * Generates a synthetic Python codebase of a target character count,
 * planting "needle" probe modules at specific depth percentages.
 * Each probe has a deterministic question and answer derived from an LCG.
 *
 * IMPORTANT: Uses BigInt throughout the LCG to match Python's arbitrary-precision
 * integers mod 2^64. JavaScript Number overflows at 2^53.
 *
 * Exports:
 *   buildCodebase(targetChars)       — generate codebase text + probe records
 *   buildQuestionBlock(probes)       — format questions for the model
 *   makeFillPrompt(ctxSizeTokens)    — convenience: make a full prompt for max-ctx coherence test
 *   verifyLcgParity()                — offline check that the LCG matches the original
 */

import { createHash } from 'node:crypto';

export const PROBE_DEPTHS = [0.08, 0.27, 0.46, 0.64, 0.83, 0.90];

const STEMS = ['net', 'geom', 'auth', 'cache', 'flow', 'parse', 'store', 'sched', 'math', 'io'];

// LCG constants — must match Python exactly
const LCG_MUL = 6364136223846793005n;
const LCG_ADD = 1442695040888963407n;
const MOD = 2n ** 64n;

// Approx chars per token (Python source is ASCII-heavy)
const CHARS_PER_TOKEN = 3.8;

function rng(seed) {
   const hex = createHash('md5').update(seed).digest('hex');
   return BigInt('0x' + hex);
}

function lcgNext(h) {
   return (h * LCG_MUL + LCG_ADD) % MOD;
}

function fillerModule(idx, targetChars) {
   const stem = STEMS[idx % STEMS.length];
   const name = `${stem}_${String(idx).padStart(2, '0')}`;
   let h = rng(`filler-${idx}`);
   const lines = [
      `# ---- module ${name} ` + '-'.repeat(40),
      `import os, sys, json  # ${name}`,
      '',
      `_CONFIG_${idx} = {'enabled': ${Boolean(h & 1n)}, 'workers': ${Number(h % 8n) + 1}}`,
      '',
   ];
   let fn = 0;
   while (lines.reduce((s, l) => s + l.length + 1, 0) < targetChars) {
      const a = Number(h % 97n);
      const b = Number((h >> 7n) % 53n) + 1;
      lines.push(
         `def ${stem}_helper_${idx}_${fn}(x):`,
         `   # routine bookkeeping for ${name}`,
         `   total = x + ${a}`,
         `   total = total % ${b}`,
         `   return total`,
         '',
      );
      fn++;
      h = lcgNext(h);
   }
   const body = lines.join('\n');
   return body.length > targetChars ? body.slice(0, targetChars) : body;
}

function probeModule(idx, kind, depthPct) {
   const stem = STEMS[idx % STEMS.length];
   const name = `${stem}_${String(idx).padStart(2, '0')}`;
   const h = rng(`probe-${kind}-${idx}`);

   let src, q, ans, detail;

   if (kind === 'const') {
      const constName = `${stem.toUpperCase()}_RETRY_LIMIT_${idx}`;
      const value = Number(h % 90n) + 10;
      src = `# ---- module ${name} (config) ` + '-'.repeat(28) + '\n' +
         `import time\n\n` +
         `${constName} = ${value}\n` +
         `BACKOFF_BASE = 2\n\n` +
         `def ${stem}_retry(op):\n` +
         `   for attempt in range(${constName}):\n` +
         `      if op(attempt):\n` +
         `         return attempt\n` +
         `   return -1\n`;
      q = `In module ${name}, what integer value is the constant ${constName} assigned?`;
      ans = String(value);
      detail = constName;
   } else if (kind === 'compute') {
      const factor = Number(h % 8n) + 2;
      const offset = Number((h >> 5n) % 20n);
      const arg = Number((h >> 9n) % 12n) + 3;
      const fn = `${stem}_scale_${idx}`;
      const result = arg * factor + offset;
      src = `# ---- module ${name} (compute) ` + '-'.repeat(27) + '\n' +
         `def ${fn}(x):\n` +
         `   return x * ${factor} + ${offset}\n\n` +
         `DEFAULT_SCALE = ${factor}\n`;
      q = `In module ${name}, what does ${fn}(${arg}) return?`;
      ans = String(result);
      detail = `${fn}(${arg})`;
   } else {
      // chain
      const add = Number(h % 20n) + 1;
      const mul = Number((h >> 4n) % 7n) + 2;
      const arg = Number((h >> 9n) % 10n) + 1;
      const result = (arg + add) * mul;
      src = `# ---- module ${name} (pipeline) ` + '-'.repeat(26) + '\n' +
         `def ${stem}_step_a(x):\n` +
         `   return x + ${add}\n\n` +
         `def ${stem}_step_b(x):\n` +
         `   return x * ${mul}\n\n` +
         `def ${stem}_pipeline(x):\n` +
         `   return ${stem}_step_b(${stem}_step_a(x))\n`;
      q = `In module ${name}, what does ${stem}_pipeline(${arg}) return?`;
      ans = String(result);
      detail = `${stem}_pipeline(${arg})`;
   }

   const record = { depth: depthPct / 100, kind, module: name, question: q, answer: ans, detail, char_offset: 0 };
   return [src + '\n', record];
}

/**
 * Build a synthetic codebase of approximately targetChars characters.
 * Returns [codebaseText, probeRecords].
 */
export function buildCodebase(targetChars) {
   const kinds = ['const', 'compute', 'chain', 'compute', 'const', 'chain'];
   const segments = [];
   const probes = [];
   let prev = 0;
   let fillerIdx = 100;

   const header = '# Project: dataflow-engine\n' +
      '# Auto-generated module index. Each module is self-contained.\n' +
      '# Answer questions strictly from the code below.\n\n';
   segments.push(header);
   prev = header.length;

   for (let i = 0; i < PROBE_DEPTHS.length; i++) {
      const depth = PROBE_DEPTHS[i];
      const kind = kinds[i];
      const targetOff = Math.floor(targetChars * depth);
      let gap = targetOff - prev;
      while (gap > 400) {
         const chunkSize = Math.min(gap, 1800);
         const seg = fillerModule(fillerIdx, chunkSize);
         segments.push(seg + '\n\n');
         prev += seg.length + 2;
         fillerIdx++;
         gap = targetOff - prev;
      }
      const [probeSrc, record] = probeModule(i, kind, Math.round(depth * 100));
      segments.push(probeSrc);
      record.char_offset = prev;
      probes.push(record);
      prev += probeSrc.length;
   }

   // Tail filler
   while (targetChars - prev > 400) {
      const seg = fillerModule(fillerIdx, Math.min(targetChars - prev, 1800));
      segments.push(seg + '\n\n');
      prev += seg.length + 2;
      fillerIdx++;
   }

   return [segments.join(''), probes];
}

/**
 * Format probe questions for the model (one question per probe).
 */
export function buildQuestionBlock(probes) {
   const lines = [
      'Above is the full source of a project. Answer the following questions ' +
      'using ONLY the code above. Each answer is a single integer. ' +
      'Respond in exactly this format, one per line, nothing else:\n',
   ];
   for (let i = 0; i < probes.length; i++) {
      lines.push(`Q${i + 1}: ${probes[i].question}`);
   }
   lines.push('\nFormat:');
   for (let i = 1; i <= probes.length; i++) {
      lines.push(`A${i}: <integer>`);
   }
   return lines.join('\n');
}

/**
 * Create a chat-completions prompt for the max-ctx coherence check.
 * Uses only the DEEPEST probe (90% depth) — hardest needle to retrieve.
 *
 * @param {number} ctxSizeTokens  target context size in tokens
 * @returns {{ messages, expectedAnswer, fillRate }}
 *   messages        — for client.chat()
 *   expectedAnswer  — correct integer answer to check against
 *   fillRate        — actual fill ratio (warn < 0.93)
 */
export function makeFillPrompt(ctxSizeTokens) {
   const targetChars = Math.floor(ctxSizeTokens * CHARS_PER_TOKEN * 0.90);  // leave 10% for question + answer
   const [codeText, probes] = buildCodebase(targetChars);

   // Use only the deepest probe (90%) for the coherence check
   const deepest = probes[probes.length - 1];
   const question = deepest.question;
   const expectedAnswer = deepest.answer;

   // Estimate fill rate (code + question as fraction of total ctx)
   const totalChars = codeText.length + question.length + 100;  // ~100 for system + format
   const fillRate = (totalChars / CHARS_PER_TOKEN) / ctxSizeTokens;

   const messages = [
      { role: 'system', content: 'You are a code analyzer. Answer questions about the provided code. Each answer is a single integer.' },
      { role: 'user',   content: `${codeText}\n\n${question}\n\nAnswer with just the integer:` },
   ];

   return { messages, expectedAnswer, fillRate };
}

/**
 * LCG parity verification — call once to detect drift vs Python version.
 * Returns { ok, probe0 }.
 */
export function verifyLcgParity() {
   const [, probes] = buildCodebase(10000);
   const p = probes[0];
   const h = rng('probe-const-0');
   const expected = String(Number(h % 90n) + 10);
   return { ok: p.answer === expected, probe0: p };
}
