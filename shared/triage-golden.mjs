/**
 * Golden inbox items for triage rule-compliance grading.
 *
 * Each item has:
 *   title, content_preview  — fed to the LLM exactly as buildTriagePrompt() does
 *   expected                — used by the grader for correctness scoring (C1/C2)
 *   anchor_rule             — the anchor-validity constraint for grading R4/R5:
 *     'existing:<filename>'  must produce exactly this existing anchor
 *     'null'                 must produce target_anchor: null (unless propose_new_anchor set)
 *     'any-valid'            any existing anchor for the area is acceptable, or null
 *
 * Note: anchor_rule 'null' allows propose_new_anchor to be set (that's spec-correct),
 * but target_anchor pointing to a non-existent file WITH propose_new_anchor:null is a R4 fail.
 */

export const GOLDEN = [
   // 1. craft/AI — clear existing anchor
   {
      id: 'craft-ai-rag',
      title: 'Agentic RAG whitepaper',
      content_preview: 'Whitepaper on Agentic Retrieval-Augmented Generation. Covers multi-step reasoning with retrieval, tool use, and LLM orchestration.',
      expected: { action: 'promote_resource', area: 'craft' },
      anchor_rule: 'existing:_AI.md',
   },

   // 2. craft/software — existing _Software.md anchor
   {
      id: 'craft-software-howto',
      title: 'How to profile Python and Rust programs',
      content_preview: 'A guide to profiling CPU-bound Python code with cProfile and Rust with cargo flamegraph. Includes tips for reading flamegraphs.',
      expected: { action: 'promote_resource', area: 'craft' },
      anchor_rule: 'existing:_Software.md',
   },

   // 3. finance/trading — existing _Trading.md anchor
   {
      id: 'finance-trading',
      title: 'Analyze premarket direction reversal',
      content_preview: 'Strategy for identifying when premarket direction is likely to reverse at the open. Uses volume delta and level 2 tape reading.',
      expected: { action: 'promote_resource', area: 'finance' },
      anchor_rule: 'existing:_Trading.md',
   },

   // 4. THE edge case — music item, NO music anchors exist
   {
      id: 'music-no-anchor',
      title: 'Access Virus KB Get sound A77',
      content_preview: 'Reference for getting the A77 patch sound from the Access Virus KB synthesizer. Includes parameter settings and MIDI CC map.',
      expected: { action: 'promote_resource', area: 'music' },
      // Music has no anchors → must be null UNLESS propose_new_anchor is properly set
      anchor_rule: 'null',
   },

   // 5. craft/hardware — existing _Hardware.md anchor
   {
      id: 'craft-hardware',
      title: 'Keyboard debouncing algorithms for custom firmware',
      content_preview: 'Overview of keyboard debounce algorithms: eager, defer-until-idle, and Roland eager-pr. Relevant for QMK and ZMK custom keyboard firmware.',
      expected: { action: 'promote_resource', area: 'craft' },
      anchor_rule: 'existing:_Hardware.md',
   },

   // 6. craft/mind — existing _Mind.md anchor
   {
      id: 'craft-mind',
      title: 'A Three-Level System for Organizing Information in PKM',
      content_preview: 'Introduces a three-level hierarchy (Topics, Classes, Tags) for personal knowledge management. Contrasts with flat tag systems and PARA.',
      expected: { action: 'promote_resource', area: 'craft' },
      anchor_rule: 'existing:_Mind.md',
   },

   // 7. dismiss — empty test stub
   {
      id: 'dismiss-stub',
      title: 'test123',
      content_preview: 'asdf test note ignore',
      expected: { action: 'dismiss', area: null },
      anchor_rule: 'null',
   },

   // 8. ambiguous bare URL — skip is acceptable, low confidence expected
   {
      id: 'ambiguous-url',
      title: '2026-05-24',
      content_preview: 'https://example.com/some-article-2024',
      expected: { action: 'skip', area: null },   // skip or any promote with low confidence
      anchor_rule: 'any-valid',
   },

   // 9. work item — NO work anchors exist
   {
      id: 'work-no-anchor',
      title: 'Q3 performance review template',
      content_preview: 'Template for writing the self-assessment section of a Q3 performance review. Covers achievements, growth areas, and OKR alignment.',
      expected: { action: 'promote_resource', area: 'work' },
      // Work has no anchors → must be null UNLESS propose_new_anchor is properly set
      anchor_rule: 'null',
   },

   // ── Added 2026-05-30: 9 new cases (doubles the set to 18) ──────────────────

   // 10. craft/AI — second existing _AI.md (MCP topic)
   {
      id: 'craft-ai-mcp',
      title: 'Model Context Protocol server design patterns',
      content_preview: 'Patterns for building MCP servers: tool granularity, structured output via JSON schema, OAuth + PKCE auth, and stateless HTTP transport.',
      expected: { action: 'promote_resource', area: 'craft' },
      anchor_rule: 'existing:_AI.md',
   },

   // 11. finance/trading — second existing _Trading.md (options)
   {
      id: 'finance-options',
      title: '0DTE options theta decay curve',
      content_preview: 'How theta decay accelerates intraday for zero-days-to-expiry SPX options, and why selling premium after 2pm has a different risk profile.',
      expected: { action: 'promote_resource', area: 'finance' },
      anchor_rule: 'existing:_Trading.md',
   },

   // 12. music — second no-anchor edge (production technique)
   {
      id: 'music-production',
      title: 'Sidechain compression for trance pumping',
      content_preview: 'Technique for the classic trance pumping effect: sidechain a compressor on the bass and pads keyed to the kick. Covers attack/release tuning.',
      expected: { action: 'promote_resource', area: 'music' },
      // Music has no anchors → must be null UNLESS propose_new_anchor is properly set
      anchor_rule: 'null',
   },

   // 13. work — second no-anchor edge (career)
   {
      id: 'work-career',
      title: 'Negotiating a senior engineer offer',
      content_preview: 'Notes on negotiating a senior software engineer offer: anchoring on total comp, equity refresh, competing offers, and the recruiter call script.',
      expected: { action: 'promote_resource', area: 'work' },
      anchor_rule: 'null',
   },

   // 14. craft/hardware — second existing _Hardware.md (CNC)
   {
      id: 'craft-hardware-cnc',
      title: 'CNC feeds and speeds for 6061 aluminum',
      content_preview: 'Calculating feeds and speeds for milling 6061 aluminum: chip load per tooth, surface speed, and avoiding recutting chips with proper coolant.',
      expected: { action: 'promote_resource', area: 'craft' },
      anchor_rule: 'existing:_Hardware.md',
   },

   // 15. craft/mind — second existing _Mind.md (PKM method)
   {
      id: 'craft-mind-zettel',
      title: 'Zettelkasten linking vs folder hierarchies',
      content_preview: 'Argues that dense bidirectional links between atomic notes outperform deep folder hierarchies for knowledge retrieval and serendipitous connection.',
      expected: { action: 'promote_resource', area: 'craft' },
      anchor_rule: 'existing:_Mind.md',
   },

   // 16. spawn_task — a single actionable item with a clear next action + deadline
   {
      id: 'spawn-task-domain',
      title: 'Renew xor0.de domain before it expires',
      content_preview: 'Action: renew the xor0.de domain registration and verify the Cloudflare Tunnel cert before the 2026-07-15 expiry, or obsidian-mcp goes down.',
      expected: { action: 'spawn_task', area: 'craft' },
      anchor_rule: 'null',
   },

   // 17. promote_project — substantive multi-step initiative
   {
      id: 'craft-project-rag',
      title: 'Build a local RAG pipeline over the vault',
      content_preview: 'Plan: index all Obsidian notes with nomic-embed, store vectors locally, and answer questions over the vault via qwen3.5 with retrieval. Multi-week build.',
      expected: { action: 'promote_project', area: 'craft' },
      anchor_rule: 'any-valid',
   },

   // 18. dismiss — second clutter/duplicate stub
   {
      id: 'dismiss-dup',
      title: 'Untitled 3',
      content_preview: 'aaa\n\nnote to self lorem ipsum placeholder do not keep',
      expected: { action: 'dismiss', area: null },
      anchor_rule: 'null',
   },
];
