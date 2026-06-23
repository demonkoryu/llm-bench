/**
 * Tolerant JSON extraction and sanitization.
 *
 * Handles the JSON-repair needs discovered during benchmarking:
 *   - Models that wrap JSON in ```json ... ``` markdown fences
 *   - Python-style float literals: .9  →  0.9
 *   - Python-style inline comments: trailing # ... stripped
 *   - Think-tag stripping before parse attempts
 *   - jsonrepair as last-resort (handles trailing commas, single-quotes, etc.)
 */

import { jsonrepair } from 'jsonrepair';

/**
 * Strip reasoning/thinking blocks from a model output string.
 *
 * Handles three formats:
 *   <think>…</think>          Qwen3, Qwen3.6, Nemotron, DeepSeek-R1 — standard tag
 *   <|channel>thought…<channel|>  Gemma4 (E4B + 26B-A4B) — channel marker format
 *   <think>… (no close tag)   Truncated/partial think at end of string
 *   <|channel>thought…        Truncated/partial Gemma4 channel at end of string
 */
export function stripThink(s) {
   return (
      (s ?? '')
         // Standard <think> block (closed)
         .replace(/<think>[\s\S]*?<\/think>/g, '')
         // Gemma4 channel block (closed): <|channel>thought … <channel|>
         .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '')
         // Unclosed <think> at end of string
         .replace(/<think>[\s\S]*$/, '')
         // Unclosed Gemma4 channel at end of string
         .replace(/<\|channel>thought[\s\S]*$/, '')
         .trim()
   );
}

/**
 * Sanitize Python-style JSON artifacts so JSON.parse can handle the string:
 *   - Leading decimal  :  .9   →  0.9
 *   - Inline hash comments stripped (outside of strings — best-effort)
 */
export function sanitizeJson(s) {
   // Leading decimal digits: [: ,([{]\s*.X  →  0.X
   s = s.replace(/([:\s,([{])\s*\.([\d])/g, (_, pre, digits) => `${pre} 0.${digits}`);
   // Trailing hash comments (crude: only if line doesn't have # inside a string)
   s = s.replace(/,?\s*#[^\n"']*/g, '');
   return s;
}

/**
 * Extract the first complete JSON object or array from a string.
 * Handles markdown fences and think-blocks before attempting to parse.
 *
 * Returns the parsed value, or null if no valid JSON found.
 */
export function extractJson(s) {
   if (!s) {
      return null;
   }

   // 1. Strip think block
   const cleaned = stripThink(s);

   // 2. Try the whole string first (common case for models that output raw JSON)
   try {
      return JSON.parse(cleaned.trim());
   } catch {}

   // 3. Strip markdown code fences
   const fenced = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
   try {
      return JSON.parse(fenced.trim());
   } catch {}

   // 4. Find first { or [ and match its closing bracket
   const start = cleaned.search(/[{[]/);
   if (start < 0) {
      return null;
   }
   const opener = cleaned[start];
   const closer = opener === '{' ? '}' : ']';
   let depth = 0;
   let inString = false;
   let escaped = false;
   for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (escaped) {
         escaped = false;
         continue;
      }
      if (c === '\\' && inString) {
         escaped = true;
         continue;
      }
      if (c === '"') {
         inString = !inString;
         continue;
      }
      if (inString) {
         continue;
      }
      if (c === opener) {
         depth++;
      } else if (c === closer) {
         depth--;
         if (depth === 0) {
            const span = cleaned.slice(start, i + 1);
            try {
               return JSON.parse(span);
            } catch {}
            try {
               return JSON.parse(sanitizeJson(span));
            } catch {}
            try {
               return JSON.parse(jsonrepair(span));
            } catch {}
            return null;
         }
      }
   }

   // 5. jsonrepair on the whole cleaned string as last resort
   try {
      return JSON.parse(jsonrepair(cleaned));
   } catch {}
   return null;
}

/**
 * Extract a source-code block from a model response — the code analogue of
 * extractJson. Reusable across products that ask a model for code and then run
 * or inspect it.
 *
 * Strategy (think/channel blocks stripped first via stripThink):
 *   1. Fenced ```lang … ``` blocks — pick the longest (the full implementation,
 *      not an inline mention). If a `lang` hint is given, matching tags win.
 *   2. An opened-but-unclosed fence (truncated output) — take body to end.
 *   3. No fence — recover from the first top-level declaration
 *      (function/class/const/let/var, optionally export/async) to the end. NOTE
 *      `class` is included: smaller models often emit an unfenced bare class.
 *   4. Whole cleaned text.
 *
 * @param {string} s            raw model output
 * @param {object} [opts]
 * @param {string} [opts.lang]  language hint matched against the fence tag (e.g. 'js')
 * @returns {{code: string, fenced: boolean}}  fenced=false ⇒ recovered heuristically
 */
export function extractCode(s, { lang, preferLast = false } = {}) {
   const cleaned = stripThink(s ?? '');
   if (!cleaned) {
      return { code: '', fenced: false };
   }

   // 1. Closed fenced blocks. Optional language tag, then a newline, then body.
   const fences = [...cleaned.matchAll(/```([a-zA-Z0-9_+-]+)?[ \t]*\r?\n([\s\S]*?)```/g)]
      .map((m) => ({ tag: (m[1] ?? '').toLowerCase(), body: m[2].trim() }))
      .filter((b) => b.body);
   if (fences.length) {
      const preferred = lang ? fences.filter((b) => b.tag.includes(lang)) : [];
      const pool = preferred.length ? preferred : fences;
      // preferLast: take the final block — models write original-then-fixed or
      // naive-then-optimal, so the last block is always the intended answer.
      // Default: longest block (works best for single-block responses).
      if (preferLast) {
         return { code: pool[pool.length - 1].body, fenced: true };
      }
      pool.sort((a, b) => b.body.length - a.body.length);
      return { code: pool[0].body, fenced: true };
   }

   // 2. Fallback: if stripping think/channel blocks removed all fenced code (e.g. Gemma4
   //    puts code inside <|channel>thought…<channel|>), retry on the raw unstripped string.
   //    Always pick the last block here — it's either inside-think (the reasoning answer)
   //    or after think (the actual response), and last = intended answer in both layouts.
   const rawFences = [...(s ?? '').matchAll(/```([a-zA-Z0-9_+-]+)?[ \t]*\r?\n([\s\S]*?)```/g)]
      .map((m) => ({ tag: (m[1] ?? '').toLowerCase(), body: m[2].trim() }))
      .filter((b) => b.body);
   if (rawFences.length) {
      const rawPreferred = lang ? rawFences.filter((b) => b.tag.includes(lang)) : [];
      const rawPool = rawPreferred.length ? rawPreferred : rawFences;
      return { code: rawPool[rawPool.length - 1].body, fenced: true };
   }

   // 3. Opened-but-unclosed fence (truncated generation): take from after it.
   const open = cleaned.match(/```([a-zA-Z0-9_+-]+)?[ \t]*\r?\n([\s\S]*)$/);
   if (open?.[2]?.trim()) {
      return { code: open[2].trim(), fenced: true };
   }

   // 3. No fence — recover from the first top-level declaration to the end.
   const decl = cleaned.search(/\b(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\b/);
   if (decl !== -1) {
      return { code: cleaned.slice(decl).trim(), fenced: false };
   }

   // 4. Whole cleaned text.
   return { code: cleaned, fenced: false };
}

/**
 * Parse tool-call arguments string, tolerating Python artifacts.
 * Returns parsed object, or {} on failure.
 */
export function parseToolArgs(raw) {
   if (typeof raw !== 'string') {
      // Already an object (some llama.cpp builds return parsed args)
      if (raw && typeof raw === 'object') {
         return raw;
      }
      return {};
   }
   try {
      return JSON.parse(raw);
   } catch {}
   try {
      return JSON.parse(sanitizeJson(raw));
   } catch {}
   try {
      return JSON.parse(jsonrepair(raw));
   } catch {}
   return {};
}
