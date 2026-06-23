/**
 * Hand-authored bug-fixing coding problems.
 *
 * Each case presents a JavaScript function with a specific bug. The model must
 * identify and fix the bug, returning corrected code. Tests verify the fixed
 * implementation. This tests code comprehension rather than generation.
 *
 * The `buggy_code` field holds the broken implementation shown to the model.
 * The prompt describes the expected behavior and includes the buggy code.
 *
 * Consumed by benchmarks/coding/grader.mjs — same { entry, tests } contract.
 */

export const CASES = {
   bugfix_binary_search: {
      category: 'bugfix',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'binary_search',
      signature: 'function binary_search(arr, target)',
      buggy_code:
         'function binary_search(arr, target) {\n' +
         '   let lo = 0, hi = arr.length - 1;\n' +
         '   while (lo <= hi) {\n' +
         '      const mid = Math.floor((lo + hi) / 2);\n' +
         '      if (arr[mid] === target) return mid;\n' +
         '      if (arr[mid] < target) lo = mid + 1;\n' +
         '      else hi = mid;\n' +
         '   }\n' +
         '   return -1;\n' +
         '}',
      prompt:
         'The following function should perform binary search on a sorted array, returning the index of `target` ' +
         'or -1 if not found. It has a bug that causes an infinite loop for certain inputs. Fix it.\n\n' +
         '```javascript\n' +
         'function binary_search(arr, target) {\n' +
         '   let lo = 0, hi = arr.length - 1;\n' +
         '   while (lo <= hi) {\n' +
         '      const mid = Math.floor((lo + hi) / 2);\n' +
         '      if (arr[mid] === target) return mid;\n' +
         '      if (arr[mid] < target) lo = mid + 1;\n' +
         '      else hi = mid;\n' +
         '   }\n' +
         '   return -1;\n' +
         '}\n' +
         '```',
      tests: [
         { args: [[1, 3, 5, 7, 9], 5], expected: 2 },
         { args: [[1, 3, 5, 7, 9], 1], expected: 0 },
         { args: [[1, 3, 5, 7, 9], 9], expected: 4 },
         { args: [[1, 3, 5, 7, 9], 4], expected: -1 },
         { args: [[1, 3, 5, 7, 9], 0], expected: -1 },
         { args: [[1, 3, 5, 7, 9], 10], expected: -1 },
         { args: [[], 1], expected: -1 },
         { args: [[42], 42], expected: 0 },
         { args: [[42], 1], expected: -1 },
      ],
   },

   bugfix_flatten_recursive: {
      category: 'bugfix',
      difficulty: 'easy',
      source: 'hand-authored',
      entry: 'flatten',
      signature: 'function flatten(arr)',
      buggy_code:
         'function flatten(arr) {\n' +
         '   const result = [];\n' +
         '   for (const item of arr) {\n' +
         '      if (Array.isArray(item)) {\n' +
         '         result.push(flatten(item));\n' +
         '      } else {\n' +
         '         result.push(item);\n' +
         '      }\n' +
         '   }\n' +
         '   return result;\n' +
         '}',
      prompt:
         'The following function should recursively flatten a nested array into a single-level array. ' +
         'It has a bug where nested arrays are pushed as subarrays instead of being spread. Fix it.\n\n' +
         '```javascript\n' +
         'function flatten(arr) {\n' +
         '   const result = [];\n' +
         '   for (const item of arr) {\n' +
         '      if (Array.isArray(item)) {\n' +
         '         result.push(flatten(item));\n' +
         '      } else {\n' +
         '         result.push(item);\n' +
         '      }\n' +
         '   }\n' +
         '   return result;\n' +
         '}\n' +
         '```',
      tests: [
         { args: [[1, [2, [3, [4]], 5]]], expected: [1, 2, 3, 4, 5] },
         { args: [[]], expected: [] },
         { args: [[1, 2, 3]], expected: [1, 2, 3] },
         { args: [[[[1]]]], expected: [1] },
         { args: [['a', ['b', 'c']]], expected: ['a', 'b', 'c'] },
         { args: [[1, [], [2, []]]], expected: [1, 2] },
      ],
   },

   bugfix_sort_numeric: {
      category: 'bugfix',
      difficulty: 'easy',
      source: 'hand-authored',
      entry: 'sort_by_age',
      signature: 'function sort_by_age(people)',
      buggy_code: 'function sort_by_age(people) {\n' + '   return people.slice().sort((a, b) => a.age - b.age);\n' + '}',
      prompt:
         'The following function should sort an array of `{name, age}` objects by age (ascending), ' +
         'but when ages are equal it should sort by name alphabetically. Currently it only sorts by age. Fix it.\n\n' +
         '```javascript\n' +
         'function sort_by_age(people) {\n' +
         '   return people.slice().sort((a, b) => a.age - b.age);\n' +
         '}\n' +
         '```',
      tests: [
         {
            args: [
               [
                  { name: 'Charlie', age: 30 },
                  { name: 'Alice', age: 25 },
                  { name: 'Bob', age: 30 },
               ],
            ],
            expected: [
               { name: 'Alice', age: 25 },
               { name: 'Bob', age: 30 },
               { name: 'Charlie', age: 30 },
            ],
         },
         { args: [[]], expected: [] },
         {
            args: [[{ name: 'A', age: 1 }]],
            expected: [{ name: 'A', age: 1 }],
         },
         {
            args: [
               [
                  { name: 'Z', age: 20 },
                  { name: 'A', age: 20 },
                  { name: 'M', age: 20 },
               ],
            ],
            expected: [
               { name: 'A', age: 20 },
               { name: 'M', age: 20 },
               { name: 'Z', age: 20 },
            ],
         },
         {
            args: [
               [
                  { name: 'D', age: 40 },
                  { name: 'C', age: 30 },
                  { name: 'B', age: 20 },
                  { name: 'A', age: 10 },
               ],
            ],
            expected: [
               { name: 'A', age: 10 },
               { name: 'B', age: 20 },
               { name: 'C', age: 30 },
               { name: 'D', age: 40 },
            ],
         },
      ],
   },

   bugfix_unique_paths: {
      category: 'bugfix',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'unique_paths',
      signature: 'function unique_paths(m, n)',
      buggy_code:
         'function unique_paths(m, n) {\n' +
         '   const dp = Array(m).fill(null).map(() => Array(n).fill(0));\n' +
         '   for (let i = 0; i < m; i++) {\n' +
         '      for (let j = 0; j < n; j++) {\n' +
         '         dp[i][j] = dp[i-1]?.[j] + dp[i][j-1];\n' +
         '      }\n' +
         '   }\n' +
         '   return dp[m-1][n-1];\n' +
         '}',
      prompt:
         'The following function should count the number of unique paths from the top-left to the bottom-right ' +
         'of an m×n grid (moving only right or down). It has a bug in how it initializes/computes the DP table. Fix it.\n\n' +
         '```javascript\n' +
         'function unique_paths(m, n) {\n' +
         '   const dp = Array(m).fill(null).map(() => Array(n).fill(0));\n' +
         '   for (let i = 0; i < m; i++) {\n' +
         '      for (let j = 0; j < n; j++) {\n' +
         '         dp[i][j] = dp[i-1]?.[j] + dp[i][j-1];\n' +
         '      }\n' +
         '   }\n' +
         '   return dp[m-1][n-1];\n' +
         '}\n' +
         '```',
      tests: [
         { args: [3, 7], expected: 28 },
         { args: [3, 2], expected: 3 },
         { args: [1, 1], expected: 1 },
         { args: [1, 5], expected: 1 },
         { args: [5, 1], expected: 1 },
         { args: [2, 2], expected: 2 },
         { args: [4, 4], expected: 20 },
         { args: [7, 3], expected: 28 },
      ],
   },

   bugfix_deep_clone: {
      category: 'bugfix',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'deep_clone',
      signature: 'function deep_clone(obj)',
      buggy_code:
         'function deep_clone(obj) {\n' +
         "   if (obj === null || typeof obj !== 'object') return obj;\n" +
         '   if (Array.isArray(obj)) return obj.map(deep_clone);\n' +
         '   const result = {};\n' +
         '   for (const key of Object.keys(obj)) {\n' +
         '      result[key] = obj[key];\n' +
         '   }\n' +
         '   return result;\n' +
         '}',
      prompt:
         'The following function should deep-clone a value (plain objects, arrays, primitives). ' +
         'It correctly handles arrays and primitives, but has a bug where nested objects are shallow-copied. Fix it.\n\n' +
         '```javascript\n' +
         'function deep_clone(obj) {\n' +
         "   if (obj === null || typeof obj !== 'object') return obj;\n" +
         '   if (Array.isArray(obj)) return obj.map(deep_clone);\n' +
         '   const result = {};\n' +
         '   for (const key of Object.keys(obj)) {\n' +
         '      result[key] = obj[key];\n' +
         '   }\n' +
         '   return result;\n' +
         '}\n' +
         '```',
      tests: [
         { call: 'const a = {x: {y: 1}}; const b = deep_clone(a); b.x.y = 99; a.x.y', expected: 1 },
         { call: 'deep_clone(42)', expected: 42 },
         { call: 'deep_clone(null)', expected: null },
         { call: "deep_clone('hello')", expected: 'hello' },
         { call: 'const a = [1, [2, 3]]; const b = deep_clone(a); b[1][0] = 99; a[1][0]', expected: 2 },
         { call: 'deep_clone({a: 1, b: [2, 3], c: {d: 4}})', expected: { a: 1, b: [2, 3], c: { d: 4 } } },
         { call: 'deep_clone([])', expected: [] },
         { call: 'deep_clone({})', expected: {} },
      ],
   },

   bugfix_reduce_sum: {
      category: 'bugfix',
      difficulty: 'easy',
      source: 'hand-authored',
      entry: 'sum_nested',
      signature: 'function sum_nested(arr)',
      buggy_code:
         'function sum_nested(arr) {\n' +
         '   return arr.reduce((acc, item) => {\n' +
         '      if (Array.isArray(item)) {\n' +
         '         return acc + sum_nested(item);\n' +
         '      }\n' +
         '      return acc + item;\n' +
         '   });\n' +
         '}',
      prompt:
         'The following function should sum all numbers in an arbitrarily nested array. ' +
         'It crashes on empty arrays and gives wrong results when the first element is an array. ' +
         'The bug is a missing initial value in the `reduce` call. Fix it.\n\n' +
         '```javascript\n' +
         'function sum_nested(arr) {\n' +
         '   return arr.reduce((acc, item) => {\n' +
         '      if (Array.isArray(item)) {\n' +
         '         return acc + sum_nested(item);\n' +
         '      }\n' +
         '      return acc + item;\n' +
         '   });\n' +
         '}\n' +
         '```',
      tests: [
         { args: [[1, 2, 3]], expected: 6 },
         { args: [[]], expected: 0 },
         { args: [[1, [2, [3, [4]]]]], expected: 10 },
         { args: [[[1], [2], [3]]], expected: 6 },
         { args: [[0, 0, 0]], expected: 0 },
         { args: [[-1, 1, -2, 2]], expected: 0 },
         { args: [[100]], expected: 100 },
      ],
   },

   bugfix_balanced_parens: {
      category: 'bugfix',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'is_balanced',
      signature: 'function is_balanced(s)',
      buggy_code:
         'function is_balanced(s) {\n' +
         '   const stack = [];\n' +
         "   const pairs = { '(': ')', '[': ']', '{': '}' };\n" +
         '   for (const ch of s) {\n' +
         '      if (pairs[ch]) {\n' +
         '         stack.push(ch);\n' +
         "      } else if (ch === ')' || ch === ']' || ch === '}') {\n" +
         '         if (stack.length === 0) return false;\n' +
         '         const top = stack.pop();\n' +
         '         if (pairs[top] !== top) return false;\n' +
         '      }\n' +
         '   }\n' +
         '   return stack.length === 0;\n' +
         '}',
      prompt:
         'The following function should check if a string has balanced brackets ((), [], {}). ' +
         'Non-bracket characters should be ignored. It has a bug in the closing-bracket check. Fix it.\n\n' +
         '```javascript\n' +
         'function is_balanced(s) {\n' +
         '   const stack = [];\n' +
         "   const pairs = { '(': ')', '[': ']', '{': '}' };\n" +
         '   for (const ch of s) {\n' +
         '      if (pairs[ch]) {\n' +
         '         stack.push(ch);\n' +
         "      } else if (ch === ')' || ch === ']' || ch === '}') {\n" +
         '         if (stack.length === 0) return false;\n' +
         '         const top = stack.pop();\n' +
         '         if (pairs[top] !== top) return false;\n' +
         '      }\n' +
         '   }\n' +
         '   return stack.length === 0;\n' +
         '}\n' +
         '```',
      tests: [
         { args: ['()[]{}'], expected: true },
         { args: ['([{}])'], expected: true },
         { args: ['(]'], expected: false },
         { args: ['([)]'], expected: false },
         { args: [''], expected: true },
         { args: ['hello (world) [!]'], expected: true },
         { args: ['{[}]'], expected: false },
         { args: ['((()))'], expected: true },
         { args: ['('], expected: false },
         { args: [')'], expected: false },
      ],
   },

   bugfix_caesar_cipher: {
      category: 'bugfix',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'caesar',
      signature: 'function caesar(text, shift)',
      buggy_code:
         'function caesar(text, shift) {\n' +
         "   return text.split('').map(ch => {\n" +
         "      if (ch >= 'a' && ch <= 'z') {\n" +
         '         return String.fromCharCode(ch.charCodeAt(0) + shift);\n' +
         '      }\n' +
         "      if (ch >= 'A' && ch <= 'Z') {\n" +
         '         return String.fromCharCode(ch.charCodeAt(0) + shift);\n' +
         '      }\n' +
         '      return ch;\n' +
         "   }).join('');\n" +
         '}',
      prompt:
         'The following Caesar cipher function should shift each letter by `shift` positions in the alphabet, ' +
         "wrapping around (e.g. 'z' shifted by 1 → 'a'). Non-letter characters are unchanged. " +
         'The shift can be any integer (including negative and values > 26). ' +
         "It has a bug: it doesn't wrap around the alphabet. Fix it.\n\n" +
         '```javascript\n' +
         'function caesar(text, shift) {\n' +
         "   return text.split('').map(ch => {\n" +
         "      if (ch >= 'a' && ch <= 'z') {\n" +
         '         return String.fromCharCode(ch.charCodeAt(0) + shift);\n' +
         '      }\n' +
         "      if (ch >= 'A' && ch <= 'Z') {\n" +
         '         return String.fromCharCode(ch.charCodeAt(0) + shift);\n' +
         '      }\n' +
         '      return ch;\n' +
         "   }).join('');\n" +
         '}\n' +
         '```',
      tests: [
         { args: ['abc', 1], expected: 'bcd' },
         { args: ['xyz', 3], expected: 'abc' },
         { args: ['ABC', 1], expected: 'BCD' },
         { args: ['XYZ', 3], expected: 'ABC' },
         { args: ['Hello, World!', 13], expected: 'Uryyb, Jbeyq!' },
         { args: ['abc', 0], expected: 'abc' },
         { args: ['abc', 26], expected: 'abc' },
         { args: ['bcd', -1], expected: 'abc' },
         { args: ['abc', -3], expected: 'xyz' },
         { args: ['a1b2c3', 1], expected: 'b1c2d3' },
      ],
   },

   bugfix_matrix_rotate: {
      category: 'bugfix',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'rotate_90',
      signature: 'function rotate_90(matrix)',
      buggy_code:
         'function rotate_90(matrix) {\n' +
         '   const n = matrix.length;\n' +
         '   const result = Array(n).fill(null).map(() => Array(n).fill(0));\n' +
         '   for (let i = 0; i < n; i++) {\n' +
         '      for (let j = 0; j < n; j++) {\n' +
         '         result[i][j] = matrix[j][n - 1 - i];\n' +
         '      }\n' +
         '   }\n' +
         '   return result;\n' +
         '}',
      prompt:
         'The following function should rotate an n×n matrix 90 degrees clockwise. ' +
         'It has a bug in the index mapping that produces the wrong rotation. Fix it.\n\n' +
         '```javascript\n' +
         'function rotate_90(matrix) {\n' +
         '   const n = matrix.length;\n' +
         '   const result = Array(n).fill(null).map(() => Array(n).fill(0));\n' +
         '   for (let i = 0; i < n; i++) {\n' +
         '      for (let j = 0; j < n; j++) {\n' +
         '         result[i][j] = matrix[j][n - 1 - i];\n' +
         '      }\n' +
         '   }\n' +
         '   return result;\n' +
         '}\n' +
         '```',
      tests: [
         {
            args: [
               [
                  [1, 2],
                  [3, 4],
               ],
            ],
            expected: [
               [3, 1],
               [4, 2],
            ],
         },
         {
            args: [
               [
                  [1, 2, 3],
                  [4, 5, 6],
                  [7, 8, 9],
               ],
            ],
            expected: [
               [7, 4, 1],
               [8, 5, 2],
               [9, 6, 3],
            ],
         },
         { args: [[[1]]], expected: [[1]] },
         {
            args: [
               [
                  [1, 2, 3, 4],
                  [5, 6, 7, 8],
                  [9, 10, 11, 12],
                  [13, 14, 15, 16],
               ],
            ],
            expected: [
               [13, 9, 5, 1],
               [14, 10, 6, 2],
               [15, 11, 7, 3],
               [16, 12, 8, 4],
            ],
         },
      ],
   },

   bugfix_memoize: {
      category: 'bugfix',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'memoize',
      signature: 'function memoize(fn)',
      buggy_code:
         'function memoize(fn) {\n' +
         '   const cache = {};\n' +
         '   return function(...args) {\n' +
         '      const key = args.toString();\n' +
         '      if (key in cache) return cache[key];\n' +
         '      cache[key] = fn(...args);\n' +
         '      return cache[key];\n' +
         '   };\n' +
         '}',
      prompt:
         'The following `memoize` function should cache results of a function based on its arguments. ' +
         'It has a bug: using `args.toString()` as the cache key causes collisions. For example, ' +
         "`fn(1, '2,3')` and `fn('1,2', 3)` both produce the key '1,2,3'. " +
         'Fix it so that different argument lists always produce different cache keys.\n\n' +
         '```javascript\n' +
         'function memoize(fn) {\n' +
         '   const cache = {};\n' +
         '   return function(...args) {\n' +
         '      const key = args.toString();\n' +
         '      if (key in cache) return cache[key];\n' +
         '      cache[key] = fn(...args);\n' +
         '      return cache[key];\n' +
         '   };\n' +
         '}\n' +
         '```',
      tests: [
         { call: 'const add = memoize((a, b) => a + b); add(1, 2)', expected: 3 },
         { call: 'const add = memoize((a, b) => a + b); add(1, 2); add(1, 2)', expected: 3 },
         { call: 'let calls = 0; const f = memoize(x => { calls++; return x * 2; }); f(5); f(5); calls', expected: 1 },
         { call: 'let calls = 0; const f = memoize(x => { calls++; return x * 2; }); f(5); f(10); calls', expected: 2 },
         {
            call: "const f = memoize((...a) => a.join('-')); [f(1, '2,3'), f('1,2', 3)]",
            expected: ['1-2,3', '1,2-3'],
         },
         { call: 'const f = memoize(x => x); f(null)', expected: null },
      ],
   },
};
