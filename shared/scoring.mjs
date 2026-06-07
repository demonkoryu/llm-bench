/**
 * Pure scoring + grouping + fleet model for llm-bench.
 *
 * This module has NO node imports so it can run unchanged in the browser (the
 * dashboard inlines its source) AND in Node (build-report, render-chart, …). That
 * shared-code guarantee is what keeps the dashboard's live re-ranking from drifting
 * from the canonical report numbers.
 *
 * Three pure stages:
 *   computeMetrics(rows)        → canonical normalized table (raw + norm per metric)
 *   scoreGroups(models, dials)  → comprehension / coding / capability per model
 *   computeFleet(models, dials) → VRAM-packed fleet suitability per model
 *
 * Scoring STRUCTURE is fixed here (GROUPS); the dashboard only turns weight DIALS.
 *
 * Capability (the headline subranking) = coding × comprehension.
 *   • comprehension (additive) — document-comprehension axes: triage/categorization,
 *     summarization, docqa, reasoning.
 *   • coding (multiplicative composite) — the two hard gates toolcalling × struct_output
 *     × a renormalized competence bundle (coding grade, agentic loop, instruction
 *     following). A missing gate or missing coding grade zeroes coding (and thus the
 *     model), exactly as the old gate behavior — relocated into the coding group.
 *   • gate + amplifier are merged: both are just 0..1 multiplicative terms.
 * Speed is NOT part of capability — it feeds the fleet score (see computeFleet).
 * Context size (maxctx) is a standalone view, no longer a score amplifier.
 */

// RX 7900 XT usable VRAM (MiB). Mirrors config/hosts.yaml.
export const CARD_TOTAL_MIB = 20464;

// ── Fixed group structure (membership + kind). Iterate on this in code, never the UI.
export const GROUPS = {
   comprehension: {
      kind: 'additive',
      members: ['triage', 'summarization', 'docqa', 'reasoning'],
   },
   coding: {
      kind: 'multiplier-composite',
      gates: ['toolcalling', 'struct_output'],
      members: ['grade', 'agentic_loop', 'instruction_following'],
   },
   speed: {
      // Displayed/dialable speed score (additive). Capability ignores it; the fleet
      // score uses its own pargen-capacity + ttft-latency term (see computeFleet).
      kind: 'additive',
      members: ['e2e_throughput', 'cold_ttft', 'warm_ttft', 'decode_retention'],
   },
};

// Default dial values — reproduce a clean, documented baseline.
export const DEFAULT_DIALS = {
   comprehension: {
      strength: 1, // exponent into capability (0 = neutralized, 1 = full)
      weights: { triage: 0.27, summarization: 0.22, docqa: 0.2, reasoning: 0.31 },
   },
   coding: {
      strength: 1,
      weights: { grade: 0.6, agentic_loop: 0.25, instruction_following: 0.15 },
   },
   speed: {
      weights: { e2e_throughput: 0.4, cold_ttft: 0.45, warm_ttft: 0.15, decode_retention: 0 },
   },
   fleet: {
      worker_ctx: 65536, // each worker slot's context window (sizes the slot packing)
      parallel_overhead: 512, // MiB extra for --parallel + unified KV
      reserve: 512, // MiB held back from the card
      ctx_tier: 100000, // main ctx is clamped to this tier (100k+ counts the same)
      w_cap: 2, // capability exponent — >1 makes high-capability dominate the ranking
      w_ctx: 1, // context-reach exponent (uses the clamped ctx_tier)
      w_slots: 1, // slot-count exponent — "several of them" parallel capacity
      w_thru: 0.5, // measured-throughput exponent (pargen aggregate); modulates without overtaking capability (w_cap=2)
   },
};

// Self-describing scoring shape for report.json + the chart subtitle.
export const SCORING = {
   formula: 'capability = coding × comprehension   (fleet: see scoring.fleet)',
   groups: {
      comprehension: 'additive: triage, summarization, docqa, reasoning',
      coding: 'multiplicative: gate(toolcalling) × gate(struct_output) × bundle(grade, agentic_loop, instruction_following)',
      speed: 'additive (display): e2e_throughput, cold_ttft, warm_ttft, decode_retention',
   },
   fleet: 'fleet_suitability = capability^w_cap × ctx_norm^w_ctx × slots_norm^w_slots × throughput^w_thru (geometric blend; capability dominates, context/slots modulate; ctx clamped at ctx_tier)',
   default_dials: DEFAULT_DIALS,
};

// ── Identity ─────────────────────────────────────────────────────────────────

/** Lowercase, strip everything but [a-z0-9] so the slug can't introduce extra '-'. */
export function slugify(s) {
   return String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
}

/** Strip the hybrid think suffix to the canonical model id.
 *  The KV-quant variant tag (`--kv<quant>`) lives INSIDE the base id (before the think
 *  suffix), so it survives this strip on purpose — q8 and q4 stay distinct rows that
 *  each join to their own secondary metrics. Order is always base[--kv<quant>][--think]. */
export function baseModel(m) {
   return String(m).replace(/--(?:nothi|think)$/, '');
}

/** Drop the `--kv<quant>` variant tag from a base id, recovering the underlying GGUF id.
 *  Used only for capability lookup (caps are keyed by the real model, not its KV variant);
 *  everywhere else the variant tag is kept so the quants rank as separate configs. */
export function stripVariant(baseId) {
   return String(baseId).replace(/--kv[a-z0-9_]+$/i, '');
}

// ── Shared (base-model-keyed) benches ────────────────────────────────────────────
const SHARED_BENCH_EXACT = new Set([
   'maxctx',
   'struct_output',
   'power_eff',
   'kv_per_tok',
   'judge',
   'instruction_following',
   'agentic_loop',
   'prefix_cache_cold_ms',
   'prefix_cache_warm_ms',
   'prefix_cache_speedup',
]);
const SHARED_BENCH_PREFIXES = ['speed_decay-', 'speed_pargen-', 'quality_decay-', 'ttft-', 'e2e-'];

/** True for a base-model-keyed bench (recorded once per base model). */
export function isSharedBench(bench) {
   const b = String(bench);
   return SHARED_BENCH_EXACT.has(b) || SHARED_BENCH_PREFIXES.some((p) => b.startsWith(p));
}

// ── Deterministic merge across runs ──────────────────────────────────────────────
function statusRank(s) {
   return s === 'ok' ? 2 : s ? 1 : 0;
}

function supersedes(a, b) {
   const ra = statusRank(a.status);
   const rb = statusRank(b.status);
   if (ra !== rb) {
      return ra > rb;
   }
   const ta = a.ts ?? '';
   const tb = b.ts ?? '';
   if (ta !== tb) {
      return ta > tb;
   }
   return true;
}

/**
 * Dedup rows across runs by identity (model|think|bench): ok beats error, newest ts
 * wins. ORDER-INDEPENDENT. Returns a fresh array in first-seen key order.
 */
export function mergeResultRows(rows) {
   const best = new Map();
   const order = [];
   for (const r of rows) {
      const key = `${r.model}|${r.think}|${r.bench}`;
      const prev = best.get(key);
      if (!prev) {
         best.set(key, r);
         order.push(key);
      } else if (supersedes(r, prev)) {
         best.set(key, r);
      }
   }
   return order.map((k) => best.get(k));
}

// ── Stage 1: computeMetrics — raw extraction + fleet-relative normalization ────────

/**
 * Turn raw per-bench rows into per-(model × think) summaries carrying every measured
 * field (raw) plus a fleet-normalized `norm` map (0..1) for each scorable metric.
 * Behavior of the extraction matches the historical aggregateModels; the `norm` map
 * and fleet memory inputs (kvPerTokMiB) are the additions that drive scoring/fleet.
 *
 * @returns {{ models, denom }} denom = { maxCtx, maxE2E, minTtft8k, minWarm, maxCoding }
 */
export function computeMetrics(rows) {
   const data = mergeResultRows(rows).filter((r) => r.status === 'ok' && r.bench !== 'load' && r.bench !== 'smoke');

   const maxctxByModel = new Map();
   const maxctxVramByModel = new Map();
   const kvPerTokByModel = new Map(); // base model → KV MiB/token (kv_per_tok score is KiB/token)
   const decayByModel = new Map();
   const pargenByModel = new Map();
   const qualityByModel = new Map();
   const ttftByModel = new Map();
   const e2eByModel = new Map();
   const structByModel = new Map();
   const ifByModel = new Map();
   const agenticByModel = new Map();
   const agenticStepsByModel = new Map();
   const prefixCacheByModel = new Map();
   const powerEffByModel = new Map();
   const codingByMT = new Map();
   const setDepth = (map, base, key, val) => {
      if (!map.has(base)) {
         map.set(base, new Map());
      }
      map.get(base).set(key, val);
   };
   const depthOf = (bench, prefix) => Number(bench.replace(prefix, '').replace('k', '')) * 1024;
   for (const r of data) {
      const bench = String(r.bench);
      const v = parseFloat(r.score);
      if (bench.startsWith('speed_pargen-')) {
         if (Number.isFinite(v)) {
            setDepth(pargenByModel, baseModel(r.model), Number(bench.replace('speed_pargen-', '')), v);
         }
      } else if (bench.startsWith('quality_decay-')) {
         if (Number.isFinite(v)) {
            setDepth(qualityByModel, baseModel(r.model), depthOf(bench, 'quality_decay-'), v);
         }
      } else if (bench.startsWith('ttft-')) {
         if (Number.isFinite(v)) {
            setDepth(ttftByModel, baseModel(r.model), depthOf(bench, 'ttft-'), v);
         }
      } else if (bench.startsWith('e2e-')) {
         if (Number.isFinite(v)) {
            setDepth(e2eByModel, baseModel(r.model), depthOf(bench, 'e2e-'), v);
         }
      } else if (bench === 'struct_output') {
         if (Number.isFinite(v)) {
            structByModel.set(baseModel(r.model), v);
         }
      } else if (bench === 'instruction_following') {
         if (Number.isFinite(v)) {
            ifByModel.set(baseModel(r.model), v);
         }
      } else if (bench === 'agentic_loop') {
         if (Number.isFinite(v)) {
            agenticByModel.set(baseModel(r.model), v);
            const sm = /steps\s+([\d.]+)/.exec(r.notes ?? '');
            if (sm) {
               agenticStepsByModel.set(baseModel(r.model), Number(sm[1]));
            }
         }
      } else if (bench === 'prefix_cache_warm_ms') {
         if (Number.isFinite(v)) {
            const cm = /cold\s+([\d.]+)/.exec(r.notes ?? '');
            const sm = /speedup\s+([\d.]+)/.exec(r.notes ?? '');
            prefixCacheByModel.set(baseModel(r.model), {
               warm: v,
               cold: cm ? Number(cm[1]) : null,
               speedup: sm ? Number(sm[1]) : null,
            });
         }
      } else if (bench === 'power_eff') {
         if (Number.isFinite(v)) {
            powerEffByModel.set(baseModel(r.model), v);
         }
      } else if (bench === 'kv_per_tok') {
         // kv-probe stores KiB/token in `score`; fleet wants MiB/token.
         if (Number.isFinite(v) && v > 0) {
            kvPerTokByModel.set(baseModel(r.model), v / 1024);
         }
      } else if (bench === 'coding_multipl') {
         const tr = /tests\s+([\d.]+)%/.exec(r.notes ?? '');
         if (Number.isFinite(v) || tr) {
            codingByMT.set(`${baseModel(r.model)}|${r.think}`, {
               pass1: Number.isFinite(v) ? v : null,
               testRate: tr ? Number(tr[1]) : null,
            });
         }
      }
      if (r.bench === 'maxctx') {
         if (Number.isFinite(v)) {
            maxctxByModel.set(baseModel(r.model), v);
         }
         const vram = parseFloat(r.vram_mib);
         if (Number.isFinite(vram)) {
            maxctxVramByModel.set(baseModel(r.model), vram);
         }
      } else if (bench.startsWith('speed_decay-')) {
         const depth = Number(bench.replace('speed_decay-', '').replace('k', '')) * 1024;
         if (Number.isFinite(v)) {
            setDepth(decayByModel, baseModel(r.model), depth, v);
         }
      }
   }

   const modelMap = new Map();
   for (const r of data) {
      if (isSharedBench(r.bench)) {
         continue;
      }
      const key = `${r.model}|${r.think}`;
      if (!modelMap.has(key)) {
         modelMap.set(key, { model: r.model, think: r.think, rows: [] });
      }
      modelMap.get(key).rows.push(r);
   }

   const latestScore = (rs, bench) => {
      const m = rs
         .filter((r) => r.bench === bench)
         .map((r) => parseFloat(r.score))
         .filter(Number.isFinite);
      return m.length ? m[m.length - 1] : null;
   };

   const W_CODE_PASS1 = 0.4;
   const W_CODE_TESTRATE = 0.6;
   const codingGradeOf = (base) => {
      for (const st of ['no_think', 'n/a']) {
         const c = codingByMT.get(`${base}|${st}`);
         if (c && (c.pass1 != null || c.testRate != null)) {
            return W_CODE_PASS1 * (c.pass1 ?? 0) + W_CODE_TESTRATE * (c.testRate ?? 0);
         }
      }
      return null;
   };

   const models = [...modelMap.values()]
      .map(({ model, think, rows: rs }) => {
         const base = baseModel(model);
         const maxctx = maxctxByModel.get(base) ?? null;
         const maxctxVram = maxctxVramByModel.get(base) ?? null;
         const triage = latestScore(rs, 'triage');
         const reasoning = latestScore(rs, 'reasoning');
         const toolcall = latestScore(rs, 'toolcalling');
         const summ = latestScore(rs, 'summarization');
         const docqa = latestScore(rs, 'docqa');
         const speedTg =
            Math.max(latestScore(rs, 'speed_short') ?? 0, latestScore(rs, 'speed_long-32k') ?? 0, latestScore(rs, 'speed') ?? 0) || null;
         const latestField = (bench, field) => {
            const m = rs
               .filter((r) => r.bench === bench)
               .map((r) => parseFloat(r[field]))
               .filter(Number.isFinite);
            return m.length ? m[m.length - 1] : null;
         };
         const prefill4k = latestField('speed_prefill-4k', 'prefill_tps');
         const prefill12k = latestField('speed_prefill-12k', 'prefill_tps');
         const endToEnd = (P, pf) => (pf && speedTg ? (P + 512) / (P / pf + 512 / speedTg) : null);
         const total4k = endToEnd(4096, prefill4k);
         const total12k = endToEnd(12288, prefill12k);
         const e2e = [total4k, total12k].filter(Number.isFinite);
         const totalE2E = e2e.length ? e2e.reduce((a, b) => a + b, 0) / e2e.length : speedTg;
         const decayMap = decayByModel.get(base);
         const decayCurve = decayMap
            ? [...decayMap.entries()].map(([depth, dec]) => ({ depth, decode: dec })).sort((a, b) => a.depth - b.depth)
            : [];
         const decodeBase = decayMap?.get(0) ?? null;
         const refPt = [...decayCurve].filter((x) => x.depth > 0 && x.depth <= 32768).pop() ?? null;
         const decodeRef = refPt?.decode ?? null;
         const decodeRefDepth = refPt?.depth ?? null;
         const decodeRetentionPct = decodeBase && decodeRef ? Math.min(100, Math.round((decodeRef / decodeBase) * 100)) : null;
         const pgMap = pargenByModel.get(base);
         const pargenCurve = pgMap ? [...pgMap.entries()].map(([conc, tps]) => ({ conc, tps })).sort((a, b) => a.conc - b.conc) : [];
         const pargen1 = pgMap?.get(1) ?? null;
         const pargenMaxK = pargenCurve.length ? pargenCurve[pargenCurve.length - 1].conc : null;
         const pargenAggMax = pargenCurve.length ? pargenCurve[pargenCurve.length - 1].tps : null;
         const pargenSpeedup = pargen1 && pargenAggMax ? Math.round((pargenAggMax / pargen1) * 100) / 100 : null;
         const qMap = qualityByModel.get(base);
         const qualityCurve = qMap ? [...qMap.entries()].map(([depth, acc]) => ({ depth, acc })).sort((a, b) => a.depth - b.depth) : [];
         const qualityBase = qMap?.get(0) ?? null;
         const qRef = [...qualityCurve].filter((x) => x.depth > 0 && x.depth <= 32768).pop() ?? null;
         const qualityRetentionPct = qualityBase && qRef?.acc != null ? Math.min(100, Math.round((qRef.acc / qualityBase) * 100)) : null;
         const tMap = ttftByModel.get(base);
         const ttftCurve = tMap ? [...tMap.entries()].map(([depth, ms]) => ({ depth, ms })).sort((a, b) => a.depth - b.depth) : [];
         const ttftRefPt = [...ttftCurve].filter((x) => x.depth > 0 && x.depth <= 32768).pop() ?? null;
         const ttftRefMs = ttftRefPt?.ms ?? null;
         const ttft8kMs = tMap?.get(8192) ?? null;
         const e2eMap = e2eByModel.get(base);
         const e2eCurve = e2eMap ? [...e2eMap.entries()].map(([depth, tps]) => ({ depth, tps })).sort((a, b) => a.depth - b.depth) : [];
         const e2eThroughput = e2eCurve.length ? e2eCurve.reduce((a, b) => a + b.tps, 0) / e2eCurve.length : null;
         const e2eRefPt = [...e2eCurve].filter((x) => x.depth > 0 && x.depth <= 32768).pop() ?? null;
         const e2eRef = e2eRefPt?.tps ?? null;
         const structScore = structByModel.get(base) ?? null;
         const codingGrade = codingGradeOf(base);
         const powerEff = powerEffByModel.get(base) ?? null;
         const ifScore = ifByModel.get(base) ?? null;
         const agenticScore = agenticByModel.get(base) ?? null;
         const agenticSteps = agenticStepsByModel.get(base) ?? null;
         const prefixCache = prefixCacheByModel.get(base) ?? null;
         const kvPerTokMiB = kvPerTokByModel.get(base) ?? null;
         return {
            label: `${model}${think !== 'n/a' ? ` [${think}]` : ''}`,
            model,
            base_model: base,
            think,
            maxctx,
            maxctxVram,
            kvPerTokMiB,
            triage,
            reasoning,
            toolcall,
            summ,
            docqa,
            speedTg,
            totalE2E,
            prefill4k,
            prefill12k,
            total4k,
            total12k,
            decayCurve,
            decodeBase,
            decodeRef,
            decodeRefDepth,
            decodeRetentionPct,
            pargenCurve,
            pargen1,
            pargenAggMax,
            pargenMaxK,
            pargenSpeedup,
            qualityCurve,
            qualityBase,
            qualityRetentionPct,
            ttftCurve,
            ttftRefMs,
            ttft8kMs,
            e2eCurve,
            e2eThroughput,
            e2eRef,
            structScore,
            ifScore,
            agenticScore,
            agenticSteps,
            prefixCache,
            powerEff,
            codingGrade,
            // Filled in after the fleet-relative denominators are known (loops below):
            // declared here so the inferred shape carries them (no TS2568 suggestions).
            norm: /** @type {Record<string, number | null>} */ ({}),
            throughputNorm: /** @type {number | null} */ (null),
            latencyNorm: /** @type {number | null} */ (null),
            warmLatencyNorm: /** @type {number | null} */ (null),
            codingGradeNorm: /** @type {number | null} */ (null),
            maxctxSharedFrom: /** @type {string | null} */ (null),
         };
      })
      .filter((m) => m.maxctx || m.triage || m.speedTg);

   // Tag maxctx reuse across think variants of the same base model.
   const THINK_ORDER = { 'n/a': 0, no_think: 1, think: 2 };
   const byBase = new Map();
   for (const m of models) {
      if (!byBase.has(m.base_model)) {
         byBase.set(m.base_model, []);
      }
      byBase.get(m.base_model).push(m);
   }
   for (const variants of byBase.values()) {
      variants.sort((a, b) => (THINK_ORDER[a.think] ?? 9) - (THINK_ORDER[b.think] ?? 9));
      for (const v of variants) {
         v.maxctxSharedFrom = v === variants[0] ? null : variants[0].think;
      }
   }

   const maxCtx = Math.max(...models.map((m) => m.maxctx ?? 0)) || 1;
   const maxE2E = Math.max(...models.map((m) => m.e2eThroughput ?? 0)) || 1;
   const minTtft8k = Math.min(...models.map((m) => m.ttft8kMs ?? Infinity));
   const minWarm = Math.min(...models.map((m) => m.prefixCache?.warm ?? Infinity));
   const maxCoding = Math.max(...models.map((m) => m.codingGrade ?? 0)) || 1;
   const denom = { maxCtx, maxE2E, minTtft8k, minWarm, maxCoding };

   // Fleet-relative normalization (0..1, null when unmeasured). Each metric maps to a
   // group member name used by scoreGroups/the dashboard dials.
   for (const m of models) {
      const cold = m.ttft8kMs != null && Number.isFinite(minTtft8k) ? minTtft8k / m.ttft8kMs : null;
      const warm = m.prefixCache?.warm != null && Number.isFinite(minWarm) ? minWarm / m.prefixCache.warm : null;
      m.norm = {
         // comprehension
         triage: m.triage != null ? m.triage / 100 : null,
         summarization: m.summ != null ? m.summ / 100 : null,
         docqa: m.docqa != null ? m.docqa / 10 : null,
         reasoning: m.reasoning != null ? m.reasoning / 100 : null,
         // coding
         grade: m.codingGrade != null ? m.codingGrade / maxCoding : null,
         agentic_loop: m.agenticScore != null ? m.agenticScore / 100 : null,
         instruction_following: m.ifScore != null ? m.ifScore / 100 : null,
         toolcalling: m.toolcall != null ? m.toolcall / 100 : null,
         struct_output: m.structScore != null ? m.structScore / 100 : null,
         // speed
         e2e_throughput: m.e2eThroughput != null ? m.e2eThroughput / maxE2E : null,
         cold_ttft: cold,
         warm_ttft: warm,
         decode_retention: m.decodeRetentionPct != null ? m.decodeRetentionPct / 100 : null,
         // context
         maxctx: m.maxctx != null ? m.maxctx / maxCtx : null,
      };
      // Backward-compatible exposures used by render-chart / build-report.
      m.throughputNorm = m.norm.e2e_throughput;
      m.latencyNorm = m.norm.cold_ttft;
      m.warmLatencyNorm = m.norm.warm_ttft;
      m.codingGradeNorm = m.norm.grade;
   }

   return { models, denom };
}

// ── Stage 2: scoreGroups — apply the fixed structure with dial values ──────────────

function additive(norm, weights) {
   let s = 0;
   for (const [k, w] of Object.entries(weights ?? {})) {
      const v = norm[k];
      if (v != null && Number.isFinite(v)) {
         s += w * v;
      }
   }
   return s;
}

/** Renormalized weighted mean over present members; `required` member missing → null. */
function codingCompetence(norm, weights) {
   if (norm.grade == null) {
      return null; // grade is the anchor — no coding data ⇒ unusable coder
   }
   let num = 0;
   let den = 0;
   for (const k of ['grade', 'agentic_loop', 'instruction_following']) {
      const w = weights?.[k] ?? 0;
      if (norm[k] != null && Number.isFinite(norm[k]) && w > 0) {
         num += w * norm[k];
         den += w;
      }
   }
   return den ? num / den : 0;
}

const dialsOrDefault = (dials) => ({
   comprehension: { ...DEFAULT_DIALS.comprehension, ...(dials?.comprehension ?? {}) },
   coding: { ...DEFAULT_DIALS.coding, ...(dials?.coding ?? {}) },
   speed: { ...DEFAULT_DIALS.speed, ...(dials?.speed ?? {}) },
   fleet: { ...DEFAULT_DIALS.fleet, ...(dials?.fleet ?? {}) },
});

/**
 * Score each model's groups + capability in place and return a descending ranking.
 * capability = comprehension^s_comp × coding^s_cod (gate+amplifier merged: a 0 in
 * coding's gates zeroes coding and thus capability).
 */
export function scoreGroups(models, dials = DEFAULT_DIALS) {
   const d = dialsOrDefault(dials);
   for (const m of models) {
      const comp = additive(m.norm, d.comprehension.weights);
      const competence = codingCompetence(m.norm, d.coding.weights);
      const gate = (m.norm.toolcalling ?? 0) * (m.norm.struct_output ?? 0);
      const coding = competence == null ? 0 : gate * competence;
      const speed = additive(m.norm, d.speed.weights);
      const capability = comp ** (d.comprehension.strength ?? 1) * coding ** (d.coding.strength ?? 1);
      m.comprehension = comp;
      m.coding = coding;
      m.codingCompetence = competence;
      m.speed = speed;
      m.capability = capability;
      m.score = Math.round(capability * 1000) / 10;
      // Back-compat alias for consumers that read m.codingMult.
      m.codingMult = coding;
   }
   return [...models].sort((a, b) => b.score - a.score);
}

// ── Stage 3: computeFleet — VRAM-packed slots × measured throughput × capability ──

/**
 * Per-model fleet suitability — a geometric blend that ranks capable all-rounders to
 * the top while context reach and slot count strongly modulate:
 *   fleet = capability^w_cap × ctx_norm^w_ctx × slots_norm^w_slots × throughput^w_thru
 * ctx_norm clamps main ctx at ctx_tier (100k+ counts the same); slots_norm is relative
 * to the fleet's best slot count. The throughput term is OFF by default (w_thru=0) so
 * the board is fully populated without pargen; when w_thru>0, a model lacking a pargen
 * run is flagged needs_pargen and left unscored. Memory (weights/slots) is from the
 * coherence-verified VRAM point and the measured KV slope.
 */
export function computeFleet(models, dials = DEFAULT_DIALS) {
   const f = dialsOrDefault(dials).fleet;
   const budget = CARD_TOTAL_MIB - (f.reserve ?? 0);

   const per = models.map((m) => {
      const out = {
         model: m.model,
         base_model: m.base_model,
         think: m.think,
         label: m.label,
         capability: m.capability ?? null,
         needs_pargen: false,
         main_ctx: m.maxctx ?? null,
         weights_mib: null,
         n_workers: null,
         slots: null,
         agg_tps: null,
         worker_ctx: null,
         ctx_norm: null,
         slots_norm: null,
         capacity_norm: null,
         latency_norm: null,
         fleet_suitability: null,
      };
      if (m.maxctx == null || m.maxctxVram == null || m.kvPerTokMiB == null) {
         out.reason = 'needs kv-probe + maxctx';
         return out;
      }
      const kv = m.kvPerTokMiB;
      const weights = Math.max(0, m.maxctxVram - kv * m.maxctx);
      const workerCtx = Math.min(f.worker_ctx, m.maxctx);
      const free = budget - (f.parallel_overhead ?? 0) - weights - kv * m.maxctx;
      const nWorkers = Math.max(0, Math.floor(free / (kv * workerCtx)));
      const slots = 1 + nWorkers;
      out.weights_mib = weights;
      out.worker_ctx = workerCtx;
      out.n_workers = nWorkers;
      out.slots = slots;
      // Optional measured-throughput capacity — pick the aggregate at the largest
      // measured concurrency ≤ the slots we can actually host (else the highest point).
      if (m.pargenCurve?.length) {
         const cap = Math.min(slots, m.pargenCurve[m.pargenCurve.length - 1].conc);
         const pick = [...m.pargenCurve].filter((p) => p.conc <= cap).pop() ?? m.pargenCurve[m.pargenCurve.length - 1];
         out.agg_tps = pick.tps;
      }
      return out;
   });

   const bestAgg = Math.max(...per.map((p) => p.agg_tps ?? 0)) || 1;
   const bestSlots = Math.max(...per.map((p) => p.slots ?? 0)) || 1;
   const minTtft = Math.min(...models.map((m) => m.ttft8kMs ?? Infinity));
   const ttftByKey = new Map(models.map((m) => [`${m.model}|${m.think}`, m.ttft8kMs ?? null]));
   const tier = f.ctx_tier ?? 100000;
   const wThru = f.w_thru ?? 0;

   for (const p of per) {
      const ttft = ttftByKey.get(`${p.model}|${p.think}`);
      p.latency_norm = ttft != null && Number.isFinite(minTtft) ? minTtft / ttft : null;
      p.capacity_norm = p.agg_tps != null ? p.agg_tps / bestAgg : null;
      if (p.capability == null || p.slots == null || p.main_ctx == null) {
         if (!p.reason) {
            p.reason = 'needs kv-probe + maxctx';
         }
         continue;
      }
      p.ctx_norm = Math.min(p.main_ctx, tier) / tier;
      p.slots_norm = p.slots / bestSlots;
      // Throughput term: honored only when weighted (w_thru>0) AND measured. When
      // weighted but missing, the model can't satisfy the requested formula → flag it.
      const thruTerm = wThru > 0 ? (p.capacity_norm != null ? p.capacity_norm ** wThru : null) : 1;
      if (thruTerm == null) {
         p.needs_pargen = true;
         p.reason = 'needs pargen run';
         continue;
      }
      p.fleet_suitability = p.capability ** (f.w_cap ?? 2) * p.ctx_norm ** (f.w_ctx ?? 1) * p.slots_norm ** (f.w_slots ?? 1) * thruTerm;
   }

   const ranking = [...per].filter((p) => p.fleet_suitability != null).sort((a, b) => b.fleet_suitability - a.fleet_suitability);
   return { fleet: per, fleetRanking: ranking, bestAgg, bestSlots, minTtft };
}

// ── Compat wrapper — preserves the historical aggregateModels return shape ─────────

/**
 * computeMetrics → scoreGroups → computeFleet. Returns the historical shape
 * ({ models, ranking, maxCtx, maxE2E, minTtft8k, weights }) plus the new
 * capability/fleet data, so existing consumers keep working while the headline
 * `m.score` is now capability (coding × comprehension).
 */
export function aggregateModels(rows, dials = DEFAULT_DIALS) {
   const { models, denom } = computeMetrics(rows);
   const ranking = scoreGroups(models, dials);
   const { fleet, fleetRanking } = computeFleet(models, dials);
   return {
      models,
      ranking,
      fleet,
      fleetRanking,
      maxCtx: denom.maxCtx,
      maxE2E: denom.maxE2E,
      minTtft8k: denom.minTtft8k,
      weights: dials,
   };
}
