/**
 * Summarization case definitions.
 * Each entry has:
 *   title          Item title fed to the model
 *   content        Full content text fed to the model
 *   expected_area  Correct vault area classification
 *   tags_prefix    Required tag prefix in model output
 *   must_mention   Keywords that should appear in the summary
 */
export const SUMM_ITEMS = {
   'rag-paper': {
      title: 'Agentic RAG whitepaper',
      content: 'Covers multi-step reasoning with retrieval, tool use, and LLM orchestration. Describes how agents decompose queries into sub-tasks, retrieve relevant context at each step, and synthesize answers using chained tool calls.',
      expected_area: 'craft',
      tags_prefix:   'craft',
      must_mention:  ['retrieval', 'agent', 'reasoning'],
   },
   'trance-compression': {
      title: 'Sidechain compression for trance pumping',
      content: 'Classic trance pumping effect: sidechain a compressor on bass and pads keyed to the kick drum. Attack 0.1ms, release 80-150ms for the pump feel. Ghost kick sidechain keeps it in time without audible kick bleed.',
      expected_area: 'music',
      tags_prefix:   'music',
      must_mention:  ['sidechain', 'compressor', 'kick'],
   },
   'trading-0dte': {
      title: '0DTE options theta decay',
      content: 'Zero-days-to-expiry SPX options accelerate theta decay after 2pm. Selling premium after 2pm captures the steepest part of the intraday theta curve but gamma risk is highest in the last 30 minutes.',
      expected_area: 'finance',
      tags_prefix:   'finance',
      must_mention:  ['theta', 'options', 'gamma'],
   },
   'qmk-debounce': {
      title: 'Keyboard debouncing in QMK firmware',
      content: 'QMK supports eager, defer-until-idle, and sym_eager_pk debounce algorithms. Eager fires immediately on press and delays release; sym_eager_pk is best for per-key debounce on split keyboards with noisy switches.',
      expected_area: 'craft',
      tags_prefix:   'craft',
      must_mention:  ['debounce', 'QMK', 'keyboard'],
   },
   'zettelkasten': {
      title: 'Zettelkasten vs folder hierarchies for PKM',
      content: 'Dense bidirectional links between atomic notes outperform deep folder hierarchies for knowledge retrieval. Each note has exactly one idea; links surface unexpected connections better than any taxonomy.',
      expected_area: 'craft',
      tags_prefix:   'craft',
      must_mention:  ['links', 'atomic', 'hierarchy'],
   },
   'salary-negotiation': {
      title: 'Negotiating a senior engineer offer',
      content: 'Anchor high on total compensation including equity refresh. Use competing offers as leverage. Recruiter call script: confirm base, then move to signing bonus and RSU refresh before benefits.',
      expected_area: 'work',
      tags_prefix:   'work',
      must_mention:  ['compensation', 'offer', 'equity'],
   },
};

// Legacy alias for old imports that expected CASES
export const CASES = Object.fromEntries(
   Object.entries(SUMM_ITEMS).map(([k, v]) => [k, {
      expected_area: v.expected_area,
      tags_prefix:   v.tags_prefix,
      must_mention:  v.must_mention,
   }])
);
