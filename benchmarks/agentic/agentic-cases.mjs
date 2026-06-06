/**
 * Multi-turn agentic tool-loop cases (ReAct-style).
 *
 * A single deterministic in-memory "world" (users → accounts → currency rates) and
 * a small tool set. Each case poses a task that requires CHAINING several dependent
 * tool calls — the output of one call is the input to the next — plus one task that
 * forces ERROR RECOVERY (a bad id returns a tool error the model must work around)
 * and tasks that test KNOWING WHEN TO STOP (answer directly, don't loop).
 *
 * The executor is pure and stateless across calls (the world is fixed), so grading
 * is fully deterministic: each case's grade() reads the loop's final content +
 * the recorded tool calls and returns { pass, optimalSteps, recovered }.
 *
 * Used by runners/agentic-loop.mjs via client.toolsLoop().
 */

// --- Fixed world -----------------------------------------------------------
const USERS = [
   { id: 'u1', name: 'Alice', account_id: 'a1' },
   { id: 'u2', name: 'Bob', account_id: 'a2' },
   { id: 'u3', name: 'Carol', account_id: 'a3' },
];
const ACCOUNTS = {
   a1: { balance: 1200, currency: 'USD' },
   a2: { balance: 900, currency: 'EUR' },
   a3: { balance: 5000, currency: 'GBP' },
};
// 1 unit of currency = N USD.
const RATE_USD = { USD: 1, EUR: 1.1, GBP: 1.25 };

const norm = (s) =>
   String(s ?? '')
      .trim()
      .toUpperCase();

/** Build a fresh tool executor (no mutable state, but kept per-run for clarity). */
export function makeExecutor() {
   return (name, args) => {
      switch (name) {
         case 'list_users':
            return JSON.stringify(USERS.map((u) => ({ id: u.id, name: u.name })));
         case 'get_user': {
            const u = USERS.find((x) => x.id === args.user_id || norm(x.name) === norm(args.user_id) || norm(x.name) === norm(args.name));
            if (!u) {
               return JSON.stringify({ error: `no such user: ${args.user_id ?? args.name ?? '?'}` });
            }
            return JSON.stringify(u);
         }
         case 'get_account': {
            const a = ACCOUNTS[args.account_id];
            if (!a) {
               return JSON.stringify({ error: `no such account: ${args.account_id}` });
            }
            return JSON.stringify({ account_id: args.account_id, ...a });
         }
         case 'convert': {
            const from = norm(args.from);
            const to = norm(args.to);
            if (!RATE_USD[from] || !RATE_USD[to]) {
               return JSON.stringify({ error: `unknown currency ${args.from}/${args.to}` });
            }
            const result = (Number(args.amount) * RATE_USD[from]) / RATE_USD[to];
            return JSON.stringify({ result: Math.round(result * 100) / 100 });
         }
         default:
            return JSON.stringify({ error: `unknown tool: ${name}` });
      }
   };
}

export const TOOLS = [
   {
      type: 'function',
      function: {
         name: 'list_users',
         description: 'List all users with their id and name.',
         parameters: { type: 'object', properties: {} },
      },
   },
   {
      type: 'function',
      function: {
         name: 'get_user',
         description: 'Look up a single user by id (e.g. "u1") and return their account_id.',
         parameters: {
            type: 'object',
            properties: { user_id: { type: 'string', description: 'User id such as u1' } },
            required: ['user_id'],
         },
      },
   },
   {
      type: 'function',
      function: {
         name: 'get_account',
         description: 'Get the balance and currency for an account_id (e.g. "a1").',
         parameters: {
            type: 'object',
            properties: { account_id: { type: 'string', description: 'Account id such as a1' } },
            required: ['account_id'],
         },
      },
   },
   {
      type: 'function',
      function: {
         name: 'convert',
         description: 'Convert an amount between currencies (USD, EUR, GBP).',
         parameters: {
            type: 'object',
            properties: {
               amount: { type: 'number' },
               from: { type: 'string', description: 'Source currency code' },
               to: { type: 'string', description: 'Target currency code' },
            },
            required: ['amount', 'from', 'to'],
         },
      },
   },
];

// A number appears in `text` within ±tol (handles commas and decimals).
const hasNumber = (text, target, tol = 2) => {
   const nums = (text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
   return nums.some((n) => Math.abs(n - target) <= tol);
};
// Did the loop hit a tool error and then make a later successful call? = recovery.
const recoveredFrom = (calls, executor) => {
   let sawError = false;
   for (const c of calls) {
      const out = executor(c.name, c.arguments);
      const isErr = /"error"/.test(out);
      if (isErr) {
         sawError = true;
      } else if (sawError) {
         return true; // a good call after a prior error
      }
   }
   return false;
};

export const CASES = [
   {
      id: 'chain-balance-eur',
      prompt:
         "What is Alice's account balance converted to EUR? Use the tools to look it up step by step, then reply with just the number rounded to the nearest whole euro.",
      optimalSteps: 4, // list_users/get_user → get_account → convert
      grade: ({ content }) => ({ pass: hasNumber(content, 1091, 2), optimalSteps: 4 }),
   },
   {
      id: 'chain-richest-user',
      prompt: 'Which user has the highest balance once every balance is converted to USD? Reply with just that user’s name.',
      optimalSteps: 8, // list + 3×(get_account) + 3×(convert) then answer; chain-heavy
      grade: ({ content }) => ({ pass: /\bcarol\b/i.test(content), optimalSteps: 8 }),
   },
   {
      id: 'error-recovery',
      prompt:
         'Look up the account for user id "u9". If that id does not exist, find the user named Bob instead and report HIS balance. Reply with the balance amount and its currency.',
      optimalSteps: 4,
      grade: ({ content, allToolCalls }) => ({
         pass: hasNumber(content, 900, 1) && /\beur\b/i.test(content),
         optimalSteps: 4,
         recovered: recoveredFrom(allToolCalls, makeExecutor()),
      }),
   },
   {
      id: 'stop-after-list',
      prompt: 'List the names of all users. Reply with their names separated by commas. Do not do anything else.',
      optimalSteps: 2, // list_users → answer
      grade: ({ content }) => ({
         pass: /alice/i.test(content) && /bob/i.test(content) && /carol/i.test(content),
         optimalSteps: 2,
      }),
   },
   {
      id: 'no-tool-needed',
      prompt: 'You have tools available, but answer this directly without calling any: what is 12 + 30?',
      optimalSteps: 1, // answer immediately, no tool call
      grade: ({ content, allToolCalls }) => ({
         pass: hasNumber(content, 42, 0) && allToolCalls.length === 0,
         optimalSteps: 1,
      }),
   },
];
