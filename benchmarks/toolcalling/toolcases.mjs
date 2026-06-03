/**
 * Tool-calling case definitions — tools exposed per case + expected call + validator.
 * Keyed by case_id. Used by both the provider (tools selection) and grader (validation).
 * Moved out of YAML vars to avoid promptfoo's array-expansion behavior.
 */

export const TOOL_NAMES = ['get_weather', 'add_numbers', 'send_email', 'convert_currency', 'search_db'];

export const TOOLS_POOL = {
   get_weather: {
      type: 'function',
      function: {
         name: 'get_weather',
         description: 'Get the current weather for a city.',
         parameters: {
            type: 'object',
            properties: {
               city: { type: 'string', description: 'City name' },
               unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature unit' },
            },
            required: ['city'],
         },
      },
   },
   add_numbers: {
      type: 'function',
      function: {
         name: 'add_numbers',
         description: 'Add a list of numbers together.',
         parameters: {
            type: 'object',
            properties: {
               numbers: { type: 'array', items: { type: 'number' }, description: 'Numbers to add' },
            },
            required: ['numbers'],
         },
      },
   },
   send_email: {
      type: 'function',
      function: {
         name: 'send_email',
         description: 'Send an email.',
         parameters: {
            type: 'object',
            properties: {
               to: { type: 'string', description: 'Recipient email address' },
               subject: { type: 'string', description: 'Email subject' },
               body: { type: 'string', description: 'Email body' },
            },
            required: ['to', 'subject', 'body'],
         },
      },
   },
   convert_currency: {
      type: 'function',
      function: {
         name: 'convert_currency',
         description: 'Convert an amount from one currency to another.',
         parameters: {
            type: 'object',
            properties: {
               amount: { type: 'number', description: 'Amount to convert' },
               from: { type: 'string', description: 'Source currency code (e.g. USD)' },
               to: { type: 'string', description: 'Target currency code (e.g. EUR)' },
            },
            required: ['amount', 'from', 'to'],
         },
      },
   },
   search_db: {
      type: 'function',
      function: {
         name: 'search_db',
         description: 'Search a product database.',
         parameters: {
            type: 'object',
            properties: {
               query: { type: 'string', description: 'Search query' },
               limit: { type: 'number', description: 'Max results to return' },
            },
            required: ['query'],
         },
      },
   },
};

export const CASES = {
   'weather-basic': {
      user: 'What is the weather in Tokyo right now?',
      tools: ['get_weather'],
      expect: 'get_weather',
      validate: (a) => /tokyo/i.test(a.city ?? ''),
   },
   'weather-unit': {
      user: 'What is the temperature in Berlin in Fahrenheit?',
      tools: ['get_weather'],
      expect: 'get_weather',
      validate: (a) => /berlin/i.test(a.city ?? '') && a.unit === 'fahrenheit',
   },
   'add-list': {
      user: 'Add up these numbers for me: 12, 30, and 8.',
      tools: ['add_numbers', 'get_weather'],
      expect: 'add_numbers',
      validate: (a) => Array.isArray(a.numbers) && [...a.numbers].sort((x, y) => x - y).join(',') === '8,12,30',
   },
   currency: {
      user: 'Convert 250 US dollars to euros.',
      tools: ['convert_currency', 'add_numbers'],
      expect: 'convert_currency',
      validate: (a) => a.amount === 250 && /usd/i.test(a.from ?? '') && /eur/i.test(a.to ?? ''),
   },
   'email-fields': {
      user: 'Email alice@example.com with the subject "Lunch" and tell her I will be 10 minutes late.',
      tools: ['send_email'],
      expect: 'send_email',
      validate: (a) => /alice@example\.com/i.test(a.to ?? '') && /lunch/i.test(a.subject ?? '') && /late|10/i.test(a.body ?? ''),
   },
   'pick-right-tool': {
      user: 'Find wireless headphones in the catalog, show me 5.',
      tools: ['get_weather', 'add_numbers', 'send_email', 'convert_currency', 'search_db'],
      expect: 'search_db',
      validate: (a) => /headphone/i.test(a.query ?? ''),
   },
   'distractor-tools': {
      user: 'How much is 1000 Japanese yen in British pounds?',
      tools: ['get_weather', 'add_numbers', 'send_email', 'convert_currency', 'search_db'],
      expect: 'convert_currency',
      validate: (a) => a.amount === 1000 && /jpy/i.test(a.from ?? '') && /gbp/i.test(a.to ?? ''),
   },
   'no-tool-needed': {
      user: 'Thanks, that is all I needed. Have a good day!',
      tools: ['get_weather', 'add_numbers', 'send_email'],
      expect: null,
      validate: () => true,
   },
   'missing-tool': {
      user: 'Please book me a flight from London to New York tomorrow.',
      tools: ['get_weather', 'add_numbers'],
      expect: null,
      validate: () => true,
   },
   'numbers-from-prose': {
      user: 'I bought three items costing seven dollars, fifteen dollars, and twenty-two dollars. What is the total?',
      tools: ['add_numbers'],
      expect: 'add_numbers',
      validate: (a) => Array.isArray(a.numbers) && [...a.numbers].sort((x, y) => x - y).join(',') === '7,15,22',
   },
};
