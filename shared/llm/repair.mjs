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
