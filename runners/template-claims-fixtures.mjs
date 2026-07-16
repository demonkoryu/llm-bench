// Fixtures for template-claims.mjs — deterministic conversations that exercise the
// froggeric template's specific claims. Assistant "thinking" is carried in the
// canonical `reasoning_content` field, which both templates read at render time.

const SYSTEM = 'You are an assistant with access to tools. Reason before acting.';

export const TOOLS = [
   {
      type: 'function',
      function: {
         name: 'get_user',
         description: 'Look up a user by numeric id.',
         parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
   },
   {
      type: 'function',
      function: {
         name: 'set_plan',
         description: "Change a user's plan.",
         parameters: { type: 'object', properties: { id: { type: 'string' }, plan: { type: 'string' } }, required: ['id', 'plan'] },
      },
   },
   {
      type: 'function',
      function: {
         name: 'search_kb',
         description: 'Search the knowledge base.',
         parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
   },
];

// ── growing multi-turn agentic transcript (P1 prefix-stability, P2, P7) ──────
const A = [
   { role: 'system', content: SYSTEM },
   { role: 'user', content: 'Look up user 42 and tell me their plan.' },
   {
      role: 'assistant',
      content: '',
      reasoning_content: 'I should fetch user 42 with get_user.',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_user', arguments: '{"id":"42"}' } }],
   },
   { role: 'tool', tool_call_id: 'c1', content: '{"name":"Ada","plan":"pro"}' },
   { role: 'assistant', content: 'User 42 is Ada, on the pro plan.', reasoning_content: 'The lookup returned Ada on pro; I can answer.' },
   { role: 'user', content: 'Now user 7?' },
   {
      role: 'assistant',
      content: '',
      reasoning_content: 'Fetch user 7 the same way.',
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'get_user', arguments: '{"id":"7"}' } }],
   },
   { role: 'tool', tool_call_id: 'c2', content: '{"name":"Bo","plan":"free"}' },
   { role: 'assistant', content: 'User 7 is Bo, on the free plan.', reasoning_content: 'Bo is on free.' },
   { role: 'user', content: 'Upgrade user 7 to pro.' },
   {
      role: 'assistant',
      content: '',
      reasoning_content: 'Call set_plan for user 7 → pro.',
      tool_calls: [{ id: 'c3', type: 'function', function: { name: 'set_plan', arguments: '{"id":"7","plan":"pro"}' } }],
   },
   { role: 'tool', tool_call_id: 'c3', content: '{"ok":true}' },
   { role: 'assistant', content: 'Done — user 7 is now on the pro plan.', reasoning_content: 'Upgrade succeeded.' },
];

// empty-think poisoning fixture: assistant turns with blank reasoning
const E = [
   { role: 'system', content: SYSTEM },
   { role: 'user', content: 'Say hi.' },
   { role: 'assistant', content: 'Hi!', reasoning_content: '' },
   { role: 'user', content: 'And again.' },
   { role: 'assistant', content: 'Hi again!', reasoning_content: '' },
   { role: 'user', content: 'Once more.' },
   { role: 'assistant', content: 'Hello!', reasoning_content: '' },
];

const BIG = 'LOG '.repeat(40000); // ~160k chars of tool output

export const FIXTURES = {
   agentic: {
      messages: A,
      tools: TOOLS,
      cutsHistory: [5, 9, 13], // full-turn boundaries, rendered add_generation_prompt=false (P1)
      cutsRequests: [2, 6, 10], // what a client actually sends before generating each turn (P7)
   },
   footprint: {
      plain: {
         messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: 'Summarize the water cycle in one sentence.' },
            { role: 'assistant', content: 'Water evaporates, condenses into clouds, and falls as precipitation.' },
         ],
         tools: null,
      },
      tools_schema: {
         messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: 'Look up user 42.' },
         ],
         tools: TOOLS,
      },
      multiturn_think: { messages: A, tools: TOOLS },
   },
   thinkHistory: { messages: E, tools: null },
   midSystem: {
      messages: [
         { role: 'system', content: SYSTEM },
         { role: 'user', content: 'Remember X=1.' },
         { role: 'system', content: 'New policy: always answer in French.' },
         { role: 'user', content: 'What is X?' },
      ],
   },
   oversized: {
      messages: [
         { role: 'system', content: SYSTEM },
         { role: 'user', content: 'Search the logs.' },
         {
            role: 'assistant',
            content: '',
            reasoning_content: 'search',
            tool_calls: [{ id: 's1', type: 'function', function: { name: 'search_kb', arguments: '{"query":"logs"}' } }],
         },
         { role: 'tool', tool_call_id: 's1', content: BIG },
      ],
      tools: TOOLS,
      rawChars: BIG.length,
   },
};

// ── P6 agentic error-recovery tasks ──────────────────────────────────────────
// makeErrorExecutor returns a stateful (name,args)->string executor per task.
export const RECOVERY_TASKS = [
   {
      id: 'transient-retry',
      needsRecovery: true,
      prompt: 'What plan is user 42 on? Use the tools.',
      behavior: { get_user: (n) => (n === 1 ? { error: 'HTTP 503: upstream timeout, retry' } : { name: 'Ada', plan: 'pro' }) },
      grade: (res) => /\bpro\b/i.test(res.content || ''),
   },
   {
      id: 'badarg-correct',
      needsRecovery: true,
      prompt: 'Get the plan for the user whose numeric id is 42 (their name is Ada). Use the tools.',
      behavior: {
         get_user: (n, args) =>
            /^\d+$/.test(String(args.id || '')) ? { name: 'Ada', plan: 'pro' } : { error: 'invalid id: must be numeric' },
      },
      grade: (res) => /\bpro\b/i.test(res.content || ''),
   },
   {
      id: 'permanent-stop',
      needsRecovery: false,
      prompt: 'Search the knowledge base for the refund policy and summarize it.',
      behavior: { search_kb: () => ({ error: 'search index permanently unavailable (500)' }) },
      // graceful: does NOT loop forever, and acknowledges it cannot complete
      grade: (res) =>
         (res.steps || 0) < 10 && /(unable|cannot|can't|couldn't|not available|unavailable|failed|error)/i.test(res.content || ''),
   },
];

export function makeErrorExecutor(task) {
   const counts = {};
   return (name, args) => {
      counts[name] = (counts[name] || 0) + 1;
      const fn = task.behavior[name];
      const result = fn ? fn(counts[name], args || {}) : { error: `unknown tool ${name}` };
      return JSON.stringify(result);
   };
}
