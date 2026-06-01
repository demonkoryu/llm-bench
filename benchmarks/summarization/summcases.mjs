/** Summarization case definitions. Keyed by case_id. */
export const CASES = {
   'rag-paper':           { expected_area: 'craft',   tags_prefix: 'craft',   must_mention: ['retrieval', 'agent', 'reasoning'] },
   'trance-compression':  { expected_area: 'music',   tags_prefix: 'music',   must_mention: ['sidechain', 'compressor', 'kick'] },
   'trading-0dte':        { expected_area: 'finance', tags_prefix: 'finance', must_mention: ['theta', 'options', 'gamma'] },
   'qmk-debounce':        { expected_area: 'craft',   tags_prefix: 'craft',   must_mention: ['debounce', 'QMK', 'keyboard'] },
   'zettelkasten':        { expected_area: 'craft',   tags_prefix: 'craft',   must_mention: ['links', 'atomic', 'hierarchy'] },
   'salary-negotiation':  { expected_area: 'work',    tags_prefix: 'work',    must_mention: ['compensation', 'offer', 'equity'] },
};
