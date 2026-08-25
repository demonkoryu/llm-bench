// Declarative, versioned scoring config (pure data). Clean-slate rewrite — takes
// structural inspiration from the retired shared/scoring.mjs (comprehension geometric
// mean, coding gate×competence, capability = comprehension×coding) but is defined
// fresh around the tidy store's leaf metrics. The engine (analysis/score.mjs) reads
// this; the dashboard's weight dials override the `dials` block live.

export const SCORING_VERSION = 3;

// Which dimension columns identify one rankable entity (a "served configuration").
// think_mode is handled separately (per-think rows + a synthesized best-of).
// NOTE: llamacpp_build is deliberately NOT an entity dim — builds are merged so that
// metrics measured across a llama.cpp upgrade (e.g. no_think@10050 + think@10064) group
// into ONE served config. The build stays in the DB for provenance but never splits or
// labels an entity. (caps-cache DOES key on build — ctx-ceiling memoization must invalidate.)
// spec_decode IS an entity dim: speculative decoding (MTP) changes throughput by a large factor
// while leaving output identical, so merging a non-MTP and an MTP measurement of the same GGUF
// averages two different machines into one meaningless number. It split the V100 Qwen3.8 speed
// rows (pre-MTP runs vs the 2026-08-25 MTP runs) — hence a dim, not just provenance.
export const ENTITY_DIMS = ['family', 'gguf_file', 'quant', 'kv_quant', 'chat_template', 'spec_decode', 'backend', 'gpu'];

// The template-independent identity: ENTITY_DIMS minus chat_template. 'general'-scope metric rows
// (perf/serving probes — see tidy-schema's scopeFor) are shared across every chat_template variant
// of the same served config, so a config measured for capability under one template inherits the
// probe metrics measured under another. Matches the key caps-cache already uses for these probes.
export const GENERAL_KEY_DIMS = ENTITY_DIMS.filter((d) => d !== 'chat_template');
export const reducedKey = (row) => GENERAL_KEY_DIMS.map((d) => row[d] ?? '').join('␟');

// Normalization strategies (per metric). Applied across the entities in the current
// selection → re-normalizes per filtered view (an A/B or a dense-vs-MoE slice answers
// "best within this comparison"). `identity` = value already lives in 0..1.
export const NORM = { identity: 'identity', ratioMax: 'ratioMax', minmax: 'minmax', inverseMin: 'inverseMin' };

// Group structure (membership fixed here; the UI only turns weights/strengths).
export const GROUPS = {
   comprehension: { kind: 'geometric', members: ['triage', 'summarization', 'docqa', 'reasoning'] },
   coding: {
      kind: 'gate-competence',
      gates: ['toolcalling', 'struct_output', 'instruction_following', 'agentic_loop'],
      competence: ['coding_grade'],
   },
   speed: { kind: 'additive', members: ['e2e_throughput', 'ttft', 'decode_retention'] },
};

// Coding grade blend across the four coding benches (each = 0.4·pass@1 + 0.6·test-rate).
export const CODING_WEIGHTS = { coding_hard: 0.35, coding_practical: 0.25, coding_bugfix: 0.2 };

// Default dial values (the documented baseline; dashboard overrides live).
export const DEFAULT_DIALS = {
   comprehension: { strength: 1, weights: { triage: 0.27, summarization: 0.22, docqa: 0.2, reasoning: 0.31 } },
   coding: { strength: 1, weights: { coding_grade: 1.0 } },
   speed: { weights: { e2e_throughput: 0.5, ttft: 0.4, decode_retention: 0.1 } },
   fleet: { worker_ctx: 65536, reserve: 512, parallel_overhead: 512, ctx_tier: 100000, w_cap: 2, w_ctx: 1, w_slots: 1, w_thru: 0.5 },
};

// (No CARD_TOTAL_MIB here: usable VRAM is a per-host fact from config/hosts.yaml `vram_total_mib`,
// threaded to consumers at runtime. The old 20464 literal was an RX 7900 XT value that nothing read.)
