/**
 * Real triage prompt, schema, and vault context — copied verbatim from
 * src/server/wispTools.ts (TRIAGE_STATIC_PROMPT, TRIAGE_SCHEMA, buildVaultContext).
 *
 * Keep in sync with wispTools.ts if the production prompt changes.
 * The vault context below reflects live state as of 2026-05-29.
 */

// ── Vault context (mirrors buildVaultContext() output for the live vault) ─────

export const VAULT_CONTEXT = `## Vault areas
- craft — Software, AI/MCP, hardware/making, and mind/productivity-philosophy.
  - _AI.md: Sub-Topic anchor for LLM, MCP, RAG, and wisp infrastructure.
  - _Hardware.md: Sub-Topic anchor for CNC, electronics, and making.
  - _Mind.md: Sub-Topic anchor for productivity philosophy, PKM, and mental models.
  - _Software.md: Sub-Topic anchor for programming, dev tools, and software engineering.
  (files without a matching anchor go at top of area folder)

- finance — Markets, trading, and personal finance.
  - _Trading.md: Sub-Topic anchor for trading strategies, instruments, and analysis.
  (files without a matching anchor go at top of area folder)

- music — DJing, production, and music theory. (no anchors — files go at top of area folder)

- work — Career and employer-specific content. (no anchors — files go at top of area folder)`;

// ── System prompt (verbatim from wispTools.ts:705-731) ────────────────────────

export const TRIAGE_STATIC_PROMPT = `You are a PKM triage classifier for a personal knowledge vault.
The vault structure is provided below. Use it to classify each inbox item.

${VAULT_CONTEXT}

Classify each inbox item:
1. Detect content type: link-only | web-clipping | freeform-text | empty-stub
2. Choose proposed_action:
   - promote_resource: reference content worth keeping (articles, links, how-tos, tools, research) → USE THIS for most items
   - promote_project: substantive multi-step initiative the user will actively work on → route to an existing active project if it fits
   - spawn_task: single actionable item with a clear next action
   - dismiss: clutter, obvious duplicates, test notes, expired content
   - skip: ONLY when you genuinely cannot determine the area — very rare
3. For promote_resource: assign target_area (must be one of the listed area slugs) and target_anchor:
   - Use an existing anchor filename listed under that area if one fits
   - If the item belongs to a topic that clearly warrants its own anchor but none exists yet, set target_anchor to the proposed filename (e.g. "_Trading.md") AND populate propose_new_anchor with { filename, title, description } — the user will review and create it
   - If no anchor applies and you would not create a new one, set target_anchor to null
   - target_anchor MUST be null for areas that have no anchors listed and no new one is warranted
4. Generate a 1-sentence summary
5. Suggest 2-5 tags prefixed with the area slug (e.g. craft/ai, finance/trading, music/synthesis)
6. Confidence:
   - 0.90–0.95: title/content unambiguously identifies area and type
   - 0.75–0.89: reasonable inference from partial content
   - 0.50–0.74: sparse item (bare URL, empty stub) — guessing from title only
   - <0.50: genuinely ambiguous

Return ONLY valid JSON matching the provided schema. No commentary, no markdown fences.`;

// ── JSON schema (verbatim from wispTools.ts:606-645) ─────────────────────────

export const TRIAGE_SCHEMA = {
   type: 'object',
   required: [
      'proposed_action',
      'suggested_type',
      'suggested_title',
      'suggested_summary',
      'suggested_tags',
      'target_area',
      'target_anchor',
      'confidence',
      'reasoning',
   ],
   properties: {
      proposed_action: { type: 'string', enum: ['promote_resource', 'promote_project', 'spawn_task', 'dismiss', 'skip'] },
      suggested_type: { type: 'string', enum: ['resource', 'project', 'task', null], nullable: true },
      suggested_title: { type: 'string' },
      suggested_summary: { type: 'string' },
      suggested_tags: { type: 'array', items: { type: 'string' } },
      target_area: { type: 'string', enum: ['craft', 'finance', 'music', 'work', null], nullable: true },
      target_anchor: { type: 'string', nullable: true },
      propose_new_anchor: {
         anyOf: [
            {
               type: 'object',
               required: ['filename', 'title', 'description'],
               properties: {
                  filename: { type: 'string' },
                  title: { type: 'string' },
                  description: { type: 'string' },
               },
            },
            { type: 'null' },
         ],
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reasoning: { type: 'string' },
   },
};

// Known anchors per area (from live vault state)
export const AREA_ANCHORS = {
   craft: ['_AI.md', '_Hardware.md', '_Mind.md', '_Software.md'],
   finance: ['_Trading.md'],
   music: [],
   work: [],
};
