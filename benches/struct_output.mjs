// Bench module: struct_output — natural JSON/schema adherence without grammar.
// Ported from runners/struct-output.mjs (TASKS + extractJson inline; validated logic).
// NOTE: the sibling `power_eff` metric needs host wattage sensing (a host probe), so it
// is handled by the orchestrator's probe path, not here.
const TASKS = [
   {
      p: 'Extract the person as JSON with keys name (string), age (number), email (string): "Dana Lee, 34, dana@x.io".',
      req: { name: 'string', age: 'number', email: 'string' },
   },
   {
      p: 'Classify the sentiment of "this update is fantastic" as JSON with keys sentiment (string) and confidence (number 0-1).',
      req: { sentiment: 'string', confidence: 'number' },
   },
   {
      p: 'Parse this address into JSON {street, city, zip}: "221B Baker Street, London, NW1 6XE".',
      req: { street: 'string', city: 'string', zip: 'string' },
   },
   {
      p: 'Emit a tool call as JSON with keys function (string) and arguments (object) to get weather for Tokyo in celsius.',
      req: { function: 'string', arguments: 'object' },
   },
   { p: 'Return JSON {items: [...]} listing the three primary colors as strings.', req: { items: 'array' } },
   {
      p: 'Return JSON describing a user: {user: {id (number), name (string)}, active (boolean)} for id 7, name Mia, active.',
      req: { user: 'object', active: 'boolean' },
   },
   {
      p: 'Convert to JSON {title, year, genres[]}: the film Inception, 2010, sci-fi and thriller.',
      req: { title: 'string', year: 'number', genres: 'array' },
   },
   { p: 'Return JSON {steps: [{n, action}]} for making tea in two steps.', req: { steps: 'array' } },
   {
      p: 'Return JSON {ok (boolean), code (number), message (string)} for a successful request, code 200.',
      req: { ok: 'boolean', code: 'number', message: 'string' },
   },
   {
      p: 'Extract amounts as JSON {currency (string), total (number), items (number)}: "3 items, total $42.50 USD".',
      req: { currency: 'string', total: 'number', items: 'number' },
   },
   {
      p: 'Return JSON {query (string), filters: {min_price (number), in_stock (boolean)}} for searching laptops under 1000 in stock.',
      req: { query: 'string', filters: 'object' },
   },
   { p: 'Return JSON {name, coords: {lat (number), lon (number)}} for Paris (48.85, 2.35).', req: { name: 'string', coords: 'object' } },
];
const SYS = 'You output only valid JSON. No prose, no markdown fences — just the JSON object.';

function extractJson(text) {
   const s = String(text).replace(/```(json)?/gi, '');
   const start = s.indexOf('{');
   if (start < 0) { return null; }
   let depth = 0;
   for (let i = start; i < s.length; i++) {
      if (s[i] === '{') { depth++; }
      else if (s[i] === '}' && --depth === 0) {
         try {
            return JSON.parse(s.slice(start, i + 1));
         } catch {
            return null;
         }
      }
   }
   return null;
}
const isType = (v, ty) =>
   ty === 'array' ? Array.isArray(v) : ty === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === ty;

export const bench = {
   name: 'struct_output',
   thinkDependent: false,
   async run(client, { think, thinkControl }) {
      let parseOk = 0,
         schemaOk = 0;
      for (const t of TASKS) {
         let text = '';
         try {
            const { completion } = await client.chat(
               [
                  { role: 'system', content: SYS },
                  { role: 'user', content: t.p },
               ],
               { think, thinkControl, max_tokens: 256, temperature: 0.0 },
               120000,
            );
            text = completion?.choices?.[0]?.message?.content ?? '';
         } catch {
            /* failure */
         }
         const obj = extractJson(text);
         if (obj) {
            parseOk++;
            if (Object.entries(t.req).every(([k, ty]) => k in obj && isType(obj[k], ty))) { schemaOk++; }
         }
      }
      return { bench: 'struct_output', score: (schemaOk / TASKS.length) * 100, json_fail: TASKS.length - parseOk, status: 'ok' };
   },
};
