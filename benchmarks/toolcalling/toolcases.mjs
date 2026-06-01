/**
 * Tool-calling case definitions — tools exposed per case + expected call + validator.
 * Keyed by case_id. Used by both the provider (tools selection) and grader (validation).
 * Moved out of YAML vars to avoid promptfoo's array-expansion behavior.
 */

export const TOOL_NAMES = ['get_weather', 'add_numbers', 'send_email', 'convert_currency', 'search_db'];

export const CASES = {
   'weather-basic': {
      tools: ['get_weather'],
      expect: 'get_weather',
      validate: (a) => /tokyo/i.test(a.city ?? ''),
   },
   'weather-unit': {
      tools: ['get_weather'],
      expect: 'get_weather',
      validate: (a) => /berlin/i.test(a.city ?? '') && a.unit === 'fahrenheit',
   },
   'add-list': {
      tools: ['add_numbers', 'get_weather'],
      expect: 'add_numbers',
      validate: (a) => Array.isArray(a.numbers) && [...a.numbers].sort((x, y) => x - y).join(',') === '8,12,30',
   },
   'currency': {
      tools: ['convert_currency', 'add_numbers'],
      expect: 'convert_currency',
      validate: (a) => a.amount === 250 && /usd/i.test(a.from ?? '') && /eur/i.test(a.to ?? ''),
   },
   'email-fields': {
      tools: ['send_email'],
      expect: 'send_email',
      validate: (a) => /alice@example\.com/i.test(a.to ?? '') && /lunch/i.test(a.subject ?? '') && /late|10/i.test(a.body ?? ''),
   },
   'pick-right-tool': {
      tools: ['get_weather', 'add_numbers', 'send_email', 'convert_currency', 'search_db'],
      expect: 'search_db',
      validate: (a) => /headphone/i.test(a.query ?? ''),
   },
   'distractor-tools': {
      tools: ['get_weather', 'add_numbers', 'send_email', 'convert_currency', 'search_db'],
      expect: 'convert_currency',
      validate: (a) => a.amount === 1000 && /jpy/i.test(a.from ?? '') && /gbp/i.test(a.to ?? ''),
   },
   'no-tool-needed': {
      tools: ['get_weather', 'add_numbers', 'send_email'],
      expect: null,
      validate: () => true,
   },
   'missing-tool': {
      tools: ['get_weather', 'add_numbers'],
      expect: null,
      validate: () => true,
   },
   'numbers-from-prose': {
      tools: ['add_numbers'],
      expect: 'add_numbers',
      validate: (a) => Array.isArray(a.numbers) && [...a.numbers].sort((x, y) => x - y).join(',') === '7,15,22',
   },
};
