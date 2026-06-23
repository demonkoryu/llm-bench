/**
 * Hand-authored practical/real-world coding problems.
 *
 * These test patterns that working programmers encounter: parsing, data
 * transformation, class design, string processing. Differentiate models on
 * "can you write useful code" vs. "can you solve a puzzle".
 *
 * Consumed by benchmarks/coding/grader.mjs — same { entry, signature, prompt, tests } contract.
 */

export const CASES = {
   practical_parse_csv_row: {
      category: 'practical',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'parse_csv_row',
      signature: 'function parse_csv_row(line)',
      prompt:
         'Parse a single CSV row string into an array of field values. Rules:\n' +
         '- Fields are separated by commas.\n' +
         '- A field may be enclosed in double quotes. Inside a quoted field, a literal double-quote is represented by two consecutive double-quotes ("").\n' +
         '- Quoted fields may contain commas and newlines (\\n) without splitting.\n' +
         '- Leading/trailing whitespace outside quotes is part of the field (do NOT trim).\n' +
         "- An empty string returns [''].\n\n" +
         '>>> parse_csv_row(\'a,b,c\')\n["a","b","c"]\n' +
         '>>> parse_csv_row(\'"hello, world",42\')\n["hello, world","42"]',
      tests: [
         { args: ['a,b,c'], expected: ['a', 'b', 'c'] },
         { args: ['"hello, world",42'], expected: ['hello, world', '42'] },
         { args: ['""'], expected: [''] },
         { args: ['"she said ""hi""",done'], expected: ['she said "hi"', 'done'] },
         { args: [''], expected: [''] },
         { args: ['one'], expected: ['one'] },
         { args: [','], expected: ['', ''] },
         { args: [',,'], expected: ['', '', ''] },
         { args: ['"a,b",c,"d,e"'], expected: ['a,b', 'c', 'd,e'] },
         { args: ['"line1\\nline2",next'], expected: ['line1\\nline2', 'next'] },
      ],
   },

   practical_deep_flatten: {
      category: 'practical',
      difficulty: 'easy',
      source: 'hand-authored',
      entry: 'deep_flatten',
      signature: 'function deep_flatten(arr)',
      prompt:
         'Given an arbitrarily nested array, return a flat array containing all non-array elements in order.\n\n' +
         '>>> deep_flatten([1, [2, [3, [4]], 5]])\n[1, 2, 3, 4, 5]',
      tests: [
         { args: [[1, [2, [3, [4]], 5]]], expected: [1, 2, 3, 4, 5] },
         { args: [[]], expected: [] },
         { args: [[1, 2, 3]], expected: [1, 2, 3] },
         { args: [[[[[[1]]]]]], expected: [1] },
         { args: [['a', ['b', ['c']]]], expected: ['a', 'b', 'c'] },
         { args: [[1, [], 2, [[], 3]]], expected: [1, 2, 3] },
         { args: [[null, [false, [0, ['']]]]], expected: [null, false, 0, ''] },
      ],
   },

   practical_parse_query_string: {
      category: 'practical',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'parse_qs',
      signature: 'function parse_qs(qs)',
      prompt:
         "Parse a URL query string (without the leading '?') into an object. Rules:\n" +
         "- Key-value pairs are separated by '&'.\n" +
         "- Keys and values are separated by '='.\n" +
         '- Both keys and values are percent-decoded (use decodeURIComponent).\n' +
         "- A key with no '=' has value '' (empty string).\n" +
         '- Duplicate keys: the value becomes an array of all values for that key, in order.\n' +
         '- An empty string returns {}.\n\n' +
         ">>> parse_qs('a=1&b=2')\n{a: '1', b: '2'}\n" +
         ">>> parse_qs('x=1&x=2')\n{x: ['1', '2']}",
      tests: [
         { args: ['a=1&b=2'], expected: { a: '1', b: '2' } },
         { args: ['x=1&x=2'], expected: { x: ['1', '2'] } },
         { args: [''], expected: {} },
         { args: ['key'], expected: { key: '' } },
         { args: ['a=hello%20world'], expected: { a: 'hello world' } },
         { args: ['a=1&b=2&a=3'], expected: { a: ['1', '3'], b: '2' } },
         { args: ['foo=bar&baz='], expected: { foo: 'bar', baz: '' } },
         { args: ['a%3Db=c%26d'], expected: { 'a=b': 'c&d' } },
      ],
   },

   practical_semver_compare: {
      category: 'practical',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'semver_compare',
      signature: 'function semver_compare(a, b)',
      prompt:
         'Compare two semantic version strings (MAJOR.MINOR.PATCH, no pre-release tags). ' +
         'Return -1 if a < b, 0 if a == b, 1 if a > b. Each component is a non-negative integer.\n\n' +
         ">>> semver_compare('1.2.3', '1.2.4')\n-1\n" +
         ">>> semver_compare('2.0.0', '1.9.9')\n1",
      tests: [
         { args: ['1.2.3', '1.2.4'], expected: -1 },
         { args: ['2.0.0', '1.9.9'], expected: 1 },
         { args: ['1.0.0', '1.0.0'], expected: 0 },
         { args: ['0.1.0', '0.0.1'], expected: 1 },
         { args: ['1.0.0', '0.99.99'], expected: 1 },
         { args: ['10.0.0', '9.99.99'], expected: 1 },
         { args: ['1.10.0', '1.9.0'], expected: 1 },
         { args: ['0.0.0', '0.0.0'], expected: 0 },
         { args: ['1.2.10', '1.2.9'], expected: 1 },
      ],
   },

   practical_template_interpolate: {
      category: 'practical',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'interpolate',
      signature: 'function interpolate(template, vars)',
      prompt:
         'Replace all `${key}` placeholders in the template string with the corresponding value from the `vars` object. ' +
         'Supports nested keys via dot notation: `${a.b}` looks up `vars.a.b`. ' +
         'If a key is missing, leave the placeholder unchanged. Placeholders do not nest.\n\n' +
         ">>> interpolate('Hello ${name}!', {name: 'Alice'})\n'Hello Alice!'\n" +
         ">>> interpolate('${a.b}', {a: {b: 42}})\n'42'",
      tests: [
         { args: ['Hello ${name}!', { name: 'Alice' }], expected: 'Hello Alice!' },
         { args: ['${a.b}', { a: { b: 42 } }], expected: '42' },
         { args: ['${missing} stays', {}], expected: '${missing} stays' },
         { args: ['no placeholders', { x: 1 }], expected: 'no placeholders' },
         { args: ['${x} and ${y}', { x: 'A', y: 'B' }], expected: 'A and B' },
         { args: ['', { x: 1 }], expected: '' },
         { args: ['${a.b.c}', { a: { b: { c: 'deep' } } }], expected: 'deep' },
         { args: ['${x}${x}', { x: '!' }], expected: '!!' },
         { args: ['${a.x}', { a: {} }], expected: '${a.x}' },
      ],
   },

   practical_flatten_object: {
      category: 'practical',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'flatten_object',
      signature: 'function flatten_object(obj)',
      prompt:
         'Given a nested object, return a flat object where each key is the dot-separated path to the leaf value. ' +
         'Only recurse into plain objects (not arrays, null, Date, etc. — those are leaf values).\n\n' +
         '>>> flatten_object({a: {b: 1, c: {d: 2}}, e: 3})\n{"a.b": 1, "a.c.d": 2, "e": 3}',
      tests: [
         {
            args: [{ a: { b: 1, c: { d: 2 } }, e: 3 }],
            expected: { 'a.b': 1, 'a.c.d': 2, e: 3 },
         },
         { args: [{}], expected: {} },
         { args: [{ x: 1 }], expected: { x: 1 } },
         {
            args: [{ a: { b: { c: { d: 'deep' } } } }],
            expected: { 'a.b.c.d': 'deep' },
         },
         {
            args: [{ a: [1, 2], b: null, c: true }],
            expected: { a: [1, 2], b: null, c: true },
         },
         {
            args: [{ a: { x: 1 }, b: { x: 2 } }],
            expected: { 'a.x': 1, 'b.x': 2 },
         },
      ],
   },

   practical_text_wrap: {
      category: 'practical',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'text_wrap',
      signature: 'function text_wrap(text, width)',
      prompt:
         'Word-wrap a string to the given column width. Rules:\n' +
         '- Break at spaces; do not break words.\n' +
         '- If a single word exceeds the width, place it on its own line (do not break it).\n' +
         '- Multiple spaces between words should be collapsed to a single space.\n' +
         '- Trailing spaces on each line should be stripped.\n' +
         '- Return an array of lines.\n\n' +
         ">>> text_wrap('The quick brown fox jumps over the lazy dog', 15)\n" +
         "['The quick brown', 'fox jumps over', 'the lazy dog']",
      tests: [
         {
            args: ['The quick brown fox jumps over the lazy dog', 15],
            expected: ['The quick brown', 'fox jumps over', 'the lazy dog'],
         },
         { args: ['short', 100], expected: ['short'] },
         { args: ['', 10], expected: [''] },
         {
            args: ['superlongword other', 5],
            expected: ['superlongword', 'other'],
         },
         { args: ['a b c d e', 3], expected: ['a b', 'c d', 'e'] },
         {
            args: ['word  word  word', 10],
            expected: ['word word', 'word'],
         },
         { args: ['one two three four', 9], expected: ['one two', 'three', 'four'] },
      ],
   },

   practical_group_by: {
      category: 'practical',
      difficulty: 'easy',
      source: 'hand-authored',
      entry: 'group_by',
      signature: 'function group_by(arr, keyFn)',
      prompt:
         'Group an array of items by the string returned by `keyFn(item)`. ' +
         'Return an object where each key maps to an array of items in that group (preserving order).\n\n' +
         ">>> group_by([6.1, 4.2, 6.3], Math.floor)\n{'4': [4.2], '6': [6.1, 6.3]}\n" +
         ">>> group_by(['one', 'two', 'three'], s => s.length)\n{'3': ['one', 'two'], '5': ['three']}",
      tests: [
         { call: 'group_by([6.1, 4.2, 6.3], Math.floor)', expected: { 4: [4.2], 6: [6.1, 6.3] } },
         { call: "group_by(['one', 'two', 'three'], s => String(s.length))", expected: { 3: ['one', 'two'], 5: ['three'] } },
         { call: 'group_by([], x => x)', expected: {} },
         { call: "group_by([1,2,3,4,5,6], n => n % 2 === 0 ? 'even' : 'odd')", expected: { even: [2, 4, 6], odd: [1, 3, 5] } },
         {
            call: "group_by(['apple','avocado','banana','blueberry'], s => s[0])",
            expected: { a: ['apple', 'avocado'], b: ['banana', 'blueberry'] },
         },
         { call: 'group_by([true, false, true, true], String)', expected: { true: [true, true, true], false: [false] } },
      ],
   },

   practical_lru_cache: {
      category: 'practical',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'LRUCache',
      signature: 'class LRUCache { constructor(capacity) {} get(key) {} put(key, value) {} }',
      prompt:
         'Implement a Least Recently Used (LRU) cache with the following operations:\n' +
         '- `new LRUCache(capacity)` — create a cache with the given positive integer capacity.\n' +
         '- `get(key)` — return the value for `key`, or -1 if not found. Marks the key as recently used.\n' +
         '- `put(key, value)` — insert or update the key. If the cache exceeds capacity, evict the least recently used key.\n\n' +
         'Both operations must run in O(1) average time.',
      tests: [
         { call: 'const c = new LRUCache(2); c.put(1, 1); c.put(2, 2); c.get(1)', expected: 1 },
         { call: 'const c = new LRUCache(2); c.put(1, 1); c.put(2, 2); c.get(1); c.put(3, 3); c.get(2)', expected: -1 },
         { call: 'const c = new LRUCache(2); c.put(1, 1); c.put(2, 2); c.get(1); c.put(3, 3); c.get(3)', expected: 3 },
         { call: 'const c = new LRUCache(1); c.put(1, 10); c.put(2, 20); c.get(1)', expected: -1 },
         { call: 'const c = new LRUCache(1); c.put(1, 10); c.put(2, 20); c.get(2)', expected: 20 },
         { call: 'const c = new LRUCache(2); c.get(99)', expected: -1 },
         { call: 'const c = new LRUCache(2); c.put(1, 1); c.put(1, 10); c.get(1)', expected: 10 },
         {
            call: 'const c = new LRUCache(3); c.put(1,1); c.put(2,2); c.put(3,3); c.put(4,4); [c.get(1), c.get(2), c.get(3), c.get(4)]',
            expected: [-1, 2, 3, 4],
         },
      ],
   },

   practical_deep_merge: {
      category: 'practical',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'deep_merge',
      signature: 'function deep_merge(target, source)',
      prompt:
         'Deep merge `source` into `target`, returning a new object (do not mutate inputs). Rules:\n' +
         '- If both values for a key are plain objects, merge recursively.\n' +
         '- Otherwise, the source value wins.\n' +
         "- Arrays, null, Date, etc. are NOT plain objects — they replace, don't merge.\n\n" +
         '>>> deep_merge({a: {x: 1}}, {a: {y: 2}})\n{a: {x: 1, y: 2}}',
      tests: [
         {
            args: [{ a: { x: 1 } }, { a: { y: 2 } }],
            expected: { a: { x: 1, y: 2 } },
         },
         {
            args: [{ a: 1 }, { b: 2 }],
            expected: { a: 1, b: 2 },
         },
         {
            args: [{ a: { b: 1 } }, { a: 2 }],
            expected: { a: 2 },
         },
         {
            args: [{}, { a: 1 }],
            expected: { a: 1 },
         },
         {
            args: [{ a: 1 }, {}],
            expected: { a: 1 },
         },
         {
            args: [{ a: [1] }, { a: [2] }],
            expected: { a: [2] },
         },
         {
            args: [{ a: { b: { c: 1 } } }, { a: { b: { d: 2 } } }],
            expected: { a: { b: { c: 1, d: 2 } } },
         },
         {
            args: [{ a: null }, { a: { b: 1 } }],
            expected: { a: { b: 1 } },
         },
      ],
   },

   practical_run_length_encode: {
      category: 'practical',
      difficulty: 'easy',
      source: 'hand-authored',
      entry: 'rle_encode',
      signature: 'function rle_encode(s)',
      prompt:
         'Run-length encode a string. Consecutive identical characters are replaced by the character followed by ' +
         'the count. A count of 1 is omitted.\n\n' +
         ">>> rle_encode('aaabbc')\n'a3b2c'\n" +
         ">>> rle_encode('abc')\n'abc'",
      tests: [
         { args: ['aaabbc'], expected: 'a3b2c' },
         { args: ['abc'], expected: 'abc' },
         { args: [''], expected: '' },
         { args: ['a'], expected: 'a' },
         { args: ['aaa'], expected: 'a3' },
         { args: ['aabbbcccc'], expected: 'a2b3c4' },
         { args: ['abababab'], expected: 'abababab' },
         { args: ['aaAAaa'], expected: 'a2A2a2' },
      ],
   },

   practical_tokenize_expression: {
      category: 'practical',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'tokenize',
      signature: 'function tokenize(expr)',
      prompt:
         'Tokenize a simple mathematical expression string into an array of tokens. Token types:\n' +
         "- Numbers: integer or decimal (e.g. '42', '3.14'). Negative numbers only appear at the start or after '('.\n" +
         '- Operators: +, -, *, /, ^, (, )\n' +
         '- Whitespace is ignored.\n' +
         'Return an array of strings, each being one token.\n\n' +
         ">>> tokenize('3 + 4 * 2')\n['3', '+', '4', '*', '2']\n" +
         ">>> tokenize('(1+2)*-3')\n['(', '1', '+', '2', ')', '*', '-3']",
      tests: [
         { args: ['3 + 4 * 2'], expected: ['3', '+', '4', '*', '2'] },
         { args: ['(1+2)*-3'], expected: ['(', '1', '+', '2', ')', '*', '-3'] },
         { args: ['42'], expected: ['42'] },
         { args: ['3.14'], expected: ['3.14'] },
         { args: ['-5+3'], expected: ['-5', '+', '3'] },
         { args: ['2^10'], expected: ['2', '^', '10'] },
         { args: ['( 1 + 2 )'], expected: ['(', '1', '+', '2', ')'] },
         { args: ['100/(-25)'], expected: ['100', '/', '(', '-25', ')'] },
         { args: [''], expected: [] },
      ],
   },
};
