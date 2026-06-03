/**
 * Shared triage grading rubric — single source of truth.
 *
 * Copied from wisp-vault-mcp-ts/scripts/triage-grade-core.mjs and extended
 * with a promptfoo-compatible scriptPath export.
 *
 * Exports:
 *   gradeOne(item, rawContent, thinkChars?, opts?) → { scores, parsedOk, anchorHallucination, detail }
 *   computeScore(itemResults)                      → { total, perRule }
 *   WEIGHTS, REQUIRED_FIELDS, VALID_ACTIONS, VALID_AREAS
 *   pct(v), printIntermittent(label, itemResults, totalMs), printFinalSummary(allResults)
 *
 *   promptfooAssert(output, context)               → promptfoo scriptPath evaluator entry point
 */

import { AREA_ANCHORS } from './triage-prompt.mjs';

// ── Grading rubric ─────────────────────────────────────────────────────────────
// Weights must sum to 100.
export const WEIGHTS = {
   R1: 10,  // valid JSON + required fields
   R2: 8,   // action enum valid
   R3: 8,   // area enum valid
   R4: 20,  // anchor integrity (the key rule)
   R5: 16,  // no-anchor-area rule (music/work)
   R6: 8,   // tag prefix discipline
   R7: 5,   // confidence in [0,1]
   C1: 15,  // action matches expected
   C2: 10,  // area matches expected
};

export const REQUIRED_FIELDS = ['proposed_action', 'suggested_type', 'suggested_title',
   'suggested_summary', 'suggested_tags', 'target_area', 'target_anchor', 'confidence', 'reasoning'];
export const VALID_ACTIONS = ['promote_resource', 'promote_project', 'spawn_task', 'dismiss', 'skip'];
export const VALID_AREAS = ['craft', 'finance', 'music', 'work', null];

function stripThink(content) {
   return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Acceptance normalization — mirrors src/server/wispTools.ts so grading reflects
 * what production actually accepts. Handles summary/tags/content_type aliases
 * emitted by unconstrained runners (MLX, llama.cpp) that don't enforce `format`.
 */
function normalizeAcceptance(parsed, item) {
   if (parsed.suggested_summary == null && typeof parsed.summary === 'string') {
      parsed.suggested_summary = parsed.summary;
   }
   if (parsed.suggested_tags == null && Array.isArray(parsed.tags)) {
      parsed.suggested_tags = parsed.tags;
   }
   if (parsed.suggested_type === undefined) {
      const a = parsed.proposed_action;
      parsed.suggested_type =
         a === 'promote_resource' ? 'resource' : a === 'promote_project' ? 'project' : a === 'spawn_task' ? 'task' : null;
   }
   if (parsed.suggested_title == null && item?.title) {
      parsed.suggested_title = item.title;
   }
   if (parsed.reasoning == null) {
      parsed.reasoning = '';
   }
   return parsed;
}

/**
 * Grade one LLM response against one golden item.
 * opts.acceptance — apply production alias normalization before scoring.
 * Returns { scores: {R1..C2: 0|1}, parsedOk, anchorHallucination, detail }
 */
export function gradeOne(item, rawContent, _thinkChars, opts = {}) {
   const sc = { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0, R7: 0, C1: 0, C2: 0 };
   let parsed = null;
   let parsedOk = false;
   let anchorHallucination = false;

   const clean = stripThink(rawContent);
   try {
      parsed = JSON.parse(clean);
      parsedOk = true;
   } catch {
      // Tolerant fallback: extract the first {...} span in case the model emitted a
      // trailing token, a preamble, or a code-fence wrapper after the JSON object.
      // A harness must not over-fail the model for minor formatting artifacts.
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) {
         try {
            parsed = JSON.parse(m[0]);
            parsedOk = true;
         } catch { /* fall through to hard fail below */ }
      }
      if (!parsedOk) {
         return { scores: sc, parsedOk, anchorHallucination, detail: 'JSON parse failed' };
      }
   }

   if (opts.acceptance) {
      normalizeAcceptance(parsed, item);
   }

   // R1: all required fields present
   const missing = REQUIRED_FIELDS.filter((f) => !(f in parsed));
   sc.R1 = missing.length === 0 ? 1 : 0;

   // R2: action enum
   sc.R2 = VALID_ACTIONS.includes(parsed.proposed_action) ? 1 : 0;

   // R3: area enum
   sc.R3 = VALID_AREAS.includes(parsed.target_area ?? null) ? 1 : 0;

   // R4: anchor integrity
   {
      const anchor = parsed.target_anchor ?? null;
      const proposeNew = parsed.propose_new_anchor ?? null;
      const area = parsed.target_area ?? null;
      const knownAnchors = area ? (AREA_ANCHORS[area] ?? []) : [];

      if (anchor === null) {
         sc.R4 = 1;
      } else if (knownAnchors.includes(anchor)) {
         sc.R4 = 1;
      } else if (proposeNew && proposeNew.filename && proposeNew.title && proposeNew.description) {
         sc.R4 = 1;
      } else {
         sc.R4 = 0;
         anchorHallucination = true;
      }
   }

   // R5: no-anchor-area rule (music/work must not use a bare invented anchor)
   {
      const area = parsed.target_area ?? null;
      const anchor = parsed.target_anchor ?? null;
      const proposeNew = parsed.propose_new_anchor ?? null;
      const noAnchorAreas = ['music', 'work'];

      if (!noAnchorAreas.includes(area)) {
         sc.R5 = 1;
      } else if (anchor === null) {
         sc.R5 = 1;
      } else if (proposeNew && proposeNew.filename && proposeNew.title && proposeNew.description) {
         sc.R5 = 1;
      } else {
         sc.R5 = 0;
      }
   }

   // R6: tag prefix discipline
   {
      const tags = parsed.suggested_tags ?? [];
      const area = parsed.target_area ?? null;
      if (!area || tags.length === 0) {
         sc.R6 = tags.every((t) => typeof t === 'string') ? 1 : 0;
      } else {
         sc.R6 = tags.every((t) => typeof t === 'string' && t.startsWith(`${area}/`)) ? 1 : 0;
      }
   }

   // R7: confidence in [0, 1]
   {
      const conf = parsed.confidence;
      sc.R7 = (typeof conf === 'number' && conf >= 0 && conf <= 1) ? 1 : 0;
   }

   // C1: action match (ambiguous item: skip or promote both acceptable)
   {
      const actual = parsed.proposed_action;
      const exp = item.expected.action;
      if (item.id === 'ambiguous-url') {
         sc.C1 = (actual === 'skip' || actual === 'promote_resource') ? 1 : 0;
      } else {
         sc.C1 = actual === exp ? 1 : 0;
      }
   }

   // C2: area match
   {
      const actual = parsed.target_area ?? null;
      const exp = item.expected.area;
      sc.C2 = actual === exp ? 1 : 0;
   }

   return { scores: sc, parsedOk, anchorHallucination, detail: null };
}

/** Compute weighted score 0-100 from per-item grading results. */
export function computeScore(itemResults) {
   const n = itemResults.length;
   if (!n) {
      return { total: 0, perRule: {} };
   }
   const perRule = {};
   for (const key of Object.keys(WEIGHTS)) {
      const avg = itemResults.reduce((s, r) => s + (r.grade.scores[key] ?? 0), 0) / n;
      perRule[key] = avg;
   }
   const total = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + perRule[k] * w, 0);
   return { total, perRule };
}

export function pct(v) {
   return (v * 100).toFixed(0).padStart(3) + '%';
}

export function printIntermittent(label, itemResults, totalMs) {
   const { total, perRule } = computeScore(itemResults);
   const anchorHalls = itemResults.filter((r) => r.grade.anchorHallucination).length;
   const parseFailures = itemResults.filter((r) => !r.grade.parsedOk).length;
   const avgTok = itemResults.filter((r) => r.tokPerSec).map((r) => parseFloat(r.tokPerSec));
   const avgTokStr = avgTok.length ? (avgTok.reduce((a, b) => a + b, 0) / avgTok.length).toFixed(1) : '?';
   const avgThink = itemResults.filter((r) => r.thinkChars).map((r) => r.thinkChars);
   const avgThinkStr = avgThink.length ? Math.round(avgThink.reduce((a, b) => a + b, 0) / avgThink.length) : 0;

   console.log(`\n${'─'.repeat(65)}`);
   console.log(`  RESULT: ${label}`);
   console.log(`${'─'.repeat(65)}`);
   console.log(`  Score: ${total.toFixed(1)}/100`);
   console.log(`  Rules:  R1=${pct(perRule.R1)} R2=${pct(perRule.R2)} R3=${pct(perRule.R3)} R4=${pct(perRule.R4)} R5=${pct(perRule.R5)} R6=${pct(perRule.R6)} R7=${pct(perRule.R7)}`);
   console.log(`  Correct: C1=${pct(perRule.C1)} C2=${pct(perRule.C2)}`);
   console.log(`  Anchor hallucinations: ${anchorHalls}/${itemResults.length}  |  JSON failures: ${parseFailures}/${itemResults.length}`);
   console.log(`  Avg tok/s: ${avgTokStr}  |  Avg thinking: ${avgThinkStr} chars  |  Total wall: ${(totalMs / 1000).toFixed(1)}s`);

   for (const r of itemResults) {
      const { scores, parsedOk, anchorHallucination } = r.grade;
      const flags = [
         !parsedOk && 'JSON_FAIL',
         anchorHallucination && 'ANCHOR_HALL',
         scores.C1 === 0 && parsedOk && 'bad_action',
         scores.C2 === 0 && parsedOk && 'bad_area',
         scores.R6 === 0 && parsedOk && 'bad_tags',
      ].filter(Boolean).join(' ');
      console.log(`    [${r.item.id.padEnd(22)}] ${flags || 'ok'}`);
   }
}

export function printFinalSummary(allResults) {
   const rows = allResults.filter(Boolean).map((r) => {
      const { total, perRule } = computeScore(r.itemResults);
      const halls = r.itemResults.filter((x) => x.grade.anchorHallucination).length;
      const avgTok = r.itemResults.filter((x) => x.tokPerSec).map((x) => parseFloat(x.tokPerSec));
      const avgTokStr = avgTok.length ? (avgTok.reduce((a, b) => a + b, 0) / avgTok.length).toFixed(1) : '?';
      return { label: r.label, total, R4: perRule.R4, R5: perRule.R5, C1: perRule.C1, C2: perRule.C2, halls, avgTok: avgTokStr, totalMs: r.totalMs };
   });

   rows.sort((a, b) => b.total - a.total);

   console.log(`\n${'═'.repeat(65)}`);
   console.log('  FINAL RANKING');
   console.log('═'.repeat(65));
   console.log(`  ${'Model'.padEnd(45)} Score  R4   R5   C1   Halls  Tok/s`);
   console.log(`  ${'─'.repeat(63)}`);
   for (const r of rows) {
      const cols = [
         r.label.padEnd(45),
         r.total.toFixed(1).padStart(5),
         pct(r.R4),
         pct(r.R5),
         pct(r.C1),
         String(r.halls).padStart(5),
         r.avgTok.padStart(6),
      ].join('  ');
      console.log(`  ${cols}`);
   }
   return rows;
}

// ── promptfoo scriptPath evaluator ──────────────────────────────────────────────
// Called by promptfoo for each test case in benchmarks/triage/promptfooconfig.yaml.
// output  = model's raw string response
// context = { vars: { item_id, item_json } }
// Returns { pass, score, reason }

export async function promptfooAssert(output, context) {
   const { GOLDEN } = await import('./triage-golden.mjs');
   const itemId = context?.vars?.item_id;
   const item = GOLDEN.find((g) => g.id === itemId);
   if (!item) {
      return { pass: false, score: 0, reason: `Unknown item_id: ${itemId}` };
   }

   const { scores, parsedOk, anchorHallucination, detail } = gradeOne(item, output);
   const { total } = computeScore([{ grade: { scores } }]);
   const pctScore = total / 100;   // promptfoo expects 0-1

   const ruleDetail = Object.entries(scores)
      .filter(([, v]) => v === 0)
      .map(([k]) => k)
      .join(', ');

   const reason = [
      `score=${total.toFixed(1)}/100`,
      anchorHallucination ? 'ANCHOR_HALL' : null,
      !parsedOk ? `JSON_FAIL: ${detail}` : null,
      ruleDetail ? `failed_rules=[${ruleDetail}]` : null,
   ].filter(Boolean).join(' | ');

   return {
      pass: parsedOk && !anchorHallucination && total >= 70,
      score: pctScore,
      reason,
   };
}
