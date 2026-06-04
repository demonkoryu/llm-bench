/**
 * Coding benchmark cases — execution-graded JavaScript code generation.
 *
 * Each model is asked to implement a single pure function with the given
 * `entry` name and signature. The grader extracts the code, evaluates it in an
 * isolated child-process vm sandbox, and runs the HIDDEN `tests` array against
 * the model's function. Score is the fraction of test cases that pass (partial
 * credit), aggregated to a per-problem pass@1 and a fleet test-pass rate.
 *
 * Why JavaScript: the orchestrator is Node, so execution needs zero extra
 * toolchain and runs cross-platform (incl. Windows). Untrusted model code is
 * confined to a fresh vm context with no `require`/`process`/`fs` and a wall
 * clock kill from the parent (see grader.mjs).
 *
 * Difficulty tiers calibrate the spread small local coders actually exhibit:
 *   easy   — every model should solve; catches total failures / format misses.
 *   medium — separates competent coders from pattern-matchers.
 *   hard   — algorithmic correctness + edge handling; separates the top tier.
 *
 * `tests` are kept deliberately edge-heavy (empty input, single element,
 * negatives, duplicates, overflow-ish sizes) — that is where small models trip.
 * Keep every expected value JSON-serializable (numbers, strings, bools, arrays,
 * plain objects) so deep-equality grading is unambiguous.
 */

export const CASES = {
   // ── easy: format + basic control flow ────────────────────────────────────
   fizzbuzz: {
      category: 'algo',
      difficulty: 'easy',
      entry: 'fizzbuzz',
      signature: 'fizzbuzz(n: number): string',
      prompt:
         'Implement `fizzbuzz(n)`. Return "Fizz" if n is divisible by 3, "Buzz" if divisible by 5, ' +
         '"FizzBuzz" if divisible by both 3 and 5, otherwise the number as a string.',
      tests: [
         { args: [1], expected: '1' },
         { args: [3], expected: 'Fizz' },
         { args: [5], expected: 'Buzz' },
         { args: [15], expected: 'FizzBuzz' },
         { args: [30], expected: 'FizzBuzz' },
         { args: [98], expected: '98' },
         { args: [0], expected: 'FizzBuzz' },
      ],
   },

   'reverse-words': {
      category: 'string',
      difficulty: 'easy',
      entry: 'reverseWords',
      signature: 'reverseWords(s: string): string',
      prompt:
         'Implement `reverseWords(s)`. Return the string with the order of space-separated words reversed, ' +
         'collapsing any runs of whitespace to a single space and trimming leading/trailing whitespace. ' +
         'Example: "  the  sky is " → "is sky the".',
      tests: [
         { args: ['the sky is blue'], expected: 'blue is sky the' },
         { args: ['  hello   world  '], expected: 'world hello' },
         { args: ['single'], expected: 'single' },
         { args: [''], expected: '' },
         { args: ['   '], expected: '' },
         { args: ['a b c d e'], expected: 'e d c b a' },
      ],
   },

   'sum-even': {
      category: 'algo',
      difficulty: 'easy',
      entry: 'sumEven',
      signature: 'sumEven(nums: number[]): number',
      prompt: 'Implement `sumEven(nums)`. Return the sum of the even integers in the array. Empty array returns 0.',
      tests: [
         { args: [[1, 2, 3, 4, 5, 6]], expected: 12 },
         { args: [[]], expected: 0 },
         { args: [[1, 3, 5]], expected: 0 },
         { args: [[-2, -4, 7]], expected: -6 },
         { args: [[0]], expected: 0 },
      ],
   },

   // ── medium: classic interview algorithms ─────────────────────────────────
   'two-sum': {
      category: 'algo',
      difficulty: 'medium',
      entry: 'twoSum',
      signature: 'twoSum(nums: number[], target: number): number[]',
      prompt:
         'Implement `twoSum(nums, target)`. Return the indices [i, j] (i < j) of the two numbers that add up to ' +
         'target. Exactly one solution exists. Return [] if none.',
      tests: [
         { args: [[2, 7, 11, 15], 9], expected: [0, 1] },
         { args: [[3, 2, 4], 6], expected: [1, 2] },
         { args: [[3, 3], 6], expected: [0, 1] },
         { args: [[1, 2, 3], 7], expected: [] },
         { args: [[-1, -2, -3, -4], -6], expected: [1, 3] },
      ],
   },

   'valid-parens': {
      category: 'algo',
      difficulty: 'medium',
      entry: 'isValid',
      signature: 'isValid(s: string): boolean',
      prompt:
         'Implement `isValid(s)`. Given a string of just the characters ()[]{}, return true if every bracket is ' +
         'closed by the matching type in the correct order. Empty string is valid.',
      tests: [
         { args: ['()'], expected: true },
         { args: ['()[]{}'], expected: true },
         { args: ['(]'], expected: false },
         { args: ['([)]'], expected: false },
         { args: ['{[]}'], expected: true },
         { args: [''], expected: true },
         { args: ['('], expected: false },
         { args: [']'], expected: false },
      ],
   },

   'roman-to-int': {
      category: 'string',
      difficulty: 'medium',
      entry: 'romanToInt',
      signature: 'romanToInt(s: string): number',
      prompt:
         'Implement `romanToInt(s)`. Convert a Roman numeral string (I,V,X,L,C,D,M) to its integer value, ' +
         'handling subtractive pairs (IV=4, IX=9, XL=40, XC=90, CD=400, CM=900).',
      tests: [
         { args: ['III'], expected: 3 },
         { args: ['IV'], expected: 4 },
         { args: ['IX'], expected: 9 },
         { args: ['LVIII'], expected: 58 },
         { args: ['MCMXCIV'], expected: 1994 },
         { args: ['MMXXIV'], expected: 2024 },
      ],
   },

   'group-anagrams': {
      category: 'datastruct',
      difficulty: 'medium',
      entry: 'groupAnagrams',
      signature: 'groupAnagrams(words: string[]): string[][]',
      prompt:
         'Implement `groupAnagrams(words)`. Group the words that are anagrams of each other. Return an array of ' +
         'groups; within each group preserve the input order, and order the groups by the first appearance of ' +
         'any member in the input. Example: ["eat","tea","tan","ate","nat","bat"] → ' +
         '[["eat","tea","ate"],["tan","nat"],["bat"]].',
      tests: [
         {
            args: [['eat', 'tea', 'tan', 'ate', 'nat', 'bat']],
            expected: [['eat', 'tea', 'ate'], ['tan', 'nat'], ['bat']],
         },
         { args: [['']], expected: [['']] },
         { args: [['a']], expected: [['a']] },
         { args: [['abc', 'bca', 'cab', 'xyz']], expected: [['abc', 'bca', 'cab'], ['xyz']] },
      ],
   },

   'merge-intervals': {
      category: 'algo',
      difficulty: 'medium',
      entry: 'mergeIntervals',
      signature: 'mergeIntervals(intervals: number[][]): number[][]',
      prompt:
         'Implement `mergeIntervals(intervals)`. Given an array of [start, end] pairs, merge all overlapping ' +
         'intervals and return the result sorted by start. Touching intervals ([1,2] and [2,3]) merge.',
      tests: [
         {
            args: [
               [
                  [1, 3],
                  [2, 6],
                  [8, 10],
                  [15, 18],
               ],
            ],
            expected: [
               [1, 6],
               [8, 10],
               [15, 18],
            ],
         },
         {
            args: [
               [
                  [1, 4],
                  [4, 5],
               ],
            ],
            expected: [[1, 5]],
         },
         {
            args: [
               [
                  [1, 4],
                  [2, 3],
               ],
            ],
            expected: [[1, 4]],
         },
         { args: [[]], expected: [] },
         {
            args: [
               [
                  [5, 6],
                  [1, 3],
                  [2, 4],
               ],
            ],
            expected: [
               [1, 4],
               [5, 6],
            ],
         },
      ],
   },

   'lru-ish-cache': {
      category: 'datastruct',
      difficulty: 'medium',
      entry: 'firstUnique',
      signature: 'firstUnique(s: string): string',
      prompt:
         'Implement `firstUnique(s)`. Return the first character in the string that appears exactly once. ' +
         'If there is none, return an empty string "".',
      tests: [
         { args: ['leetcode'], expected: 'l' },
         { args: ['loveleetcode'], expected: 'v' },
         { args: ['aabb'], expected: '' },
         { args: [''], expected: '' },
         { args: ['z'], expected: 'z' },
         { args: ['aabbc'], expected: 'c' },
      ],
   },

   // ── hard: correctness + edge handling separates the top tier ─────────────
   'longest-substring': {
      category: 'algo',
      difficulty: 'hard',
      entry: 'lengthOfLongestSubstring',
      signature: 'lengthOfLongestSubstring(s: string): number',
      prompt: 'Implement `lengthOfLongestSubstring(s)`. Return the length of the longest substring without repeating ' + 'characters.',
      tests: [
         { args: ['abcabcbb'], expected: 3 },
         { args: ['bbbbb'], expected: 1 },
         { args: ['pwwkew'], expected: 3 },
         { args: [''], expected: 0 },
         { args: ['au'], expected: 2 },
         { args: ['dvdf'], expected: 3 },
         { args: [' '], expected: 1 },
         { args: ['tmmzuxt'], expected: 5 },
      ],
   },

   'coin-change': {
      category: 'algo',
      difficulty: 'hard',
      entry: 'coinChange',
      signature: 'coinChange(coins: number[], amount: number): number',
      prompt:
         'Implement `coinChange(coins, amount)`. Return the fewest number of coins needed to make up `amount`. ' +
         'Each coin may be used unlimited times. Return -1 if it cannot be made. amount 0 returns 0.',
      tests: [
         { args: [[1, 2, 5], 11], expected: 3 },
         { args: [[2], 3], expected: -1 },
         { args: [[1], 0], expected: 0 },
         { args: [[1, 3, 4], 6], expected: 2 },
         { args: [[2, 5, 10, 1], 27], expected: 4 },
         { args: [[186, 419, 83, 408], 6249], expected: 20 },
      ],
   },

   'spiral-order': {
      category: 'algo',
      difficulty: 'hard',
      entry: 'spiralOrder',
      signature: 'spiralOrder(matrix: number[][]): number[]',
      prompt:
         'Implement `spiralOrder(matrix)`. Return all elements of the m×n matrix in clockwise spiral order ' +
         'starting from the top-left.',
      tests: [
         {
            args: [
               [
                  [1, 2, 3],
                  [4, 5, 6],
                  [7, 8, 9],
               ],
            ],
            expected: [1, 2, 3, 6, 9, 8, 7, 4, 5],
         },
         {
            args: [
               [
                  [1, 2, 3, 4],
                  [5, 6, 7, 8],
                  [9, 10, 11, 12],
               ],
            ],
            expected: [1, 2, 3, 4, 8, 12, 11, 10, 9, 5, 6, 7],
         },
         { args: [[[1]]], expected: [1] },
         {
            args: [
               [
                  [1, 2],
                  [3, 4],
               ],
            ],
            expected: [1, 2, 4, 3],
         },
         { args: [[[1], [2], [3]]], expected: [1, 2, 3] },
         { args: [[]], expected: [] },
      ],
   },

   'edit-distance': {
      category: 'algo',
      difficulty: 'hard',
      entry: 'editDistance',
      signature: 'editDistance(a: string, b: string): number',
      prompt:
         'Implement `editDistance(a, b)`. Return the minimum number of single-character insertions, deletions, ' +
         'or substitutions to turn string a into string b (Levenshtein distance).',
      tests: [
         { args: ['horse', 'ros'], expected: 3 },
         { args: ['intention', 'execution'], expected: 5 },
         { args: ['', ''], expected: 0 },
         { args: ['abc', ''], expected: 3 },
         { args: ['', 'abc'], expected: 3 },
         { args: ['kitten', 'sitting'], expected: 3 },
         { args: ['same', 'same'], expected: 0 },
      ],
   },

   // ── edge: traps that punish naive implementations ────────────────────────
   'median-two': {
      category: 'edge',
      difficulty: 'hard',
      entry: 'median',
      signature: 'median(nums: number[]): number',
      prompt:
         'Implement `median(nums)`. Return the median of the array. For an even count, return the average of the ' +
         'two middle values (a number, possibly fractional). The input is NOT sorted. Empty array returns 0.',
      tests: [
         { args: [[3, 1, 2]], expected: 2 },
         { args: [[4, 1, 2, 3]], expected: 2.5 },
         { args: [[1]], expected: 1 },
         { args: [[]], expected: 0 },
         { args: [[7, 7, 7, 7]], expected: 7 },
         { args: [[-5, -1, -3]], expected: -3 },
         { args: [[1, 2]], expected: 1.5 },
      ],
   },

   'rounding-trap': {
      category: 'edge',
      difficulty: 'medium',
      entry: 'roundHalfUp',
      signature: 'roundHalfUp(x: number): number',
      prompt:
         'Implement `roundHalfUp(x)`. Round to the nearest integer with ties (exactly .5) always going UP toward ' +
         '+Infinity, so roundHalfUp(2.5) = 3 and roundHalfUp(-2.5) = -2. Note: JS Math.round already does this — ' +
         'but verify the negative-tie behavior carefully.',
      tests: [
         { args: [2.5], expected: 3 },
         { args: [2.4], expected: 2 },
         { args: [-2.5], expected: -2 },
         { args: [-2.6], expected: -3 },
         { args: [0], expected: 0 },
         { args: [0.5], expected: 1 },
         { args: [-0.5], expected: 0 },
      ],
   },

   // ── bugfix: read, diagnose, repair existing code ─────────────────────────
   'bugfix-binsearch': {
      category: 'bugfix',
      difficulty: 'medium',
      entry: 'binarySearch',
      signature: 'binarySearch(arr: number[], target: number): number',
      prompt:
         'The following binary search has a bug. Return a CORRECTED version that returns the index of `target` ' +
         'in the sorted array `arr`, or -1 if absent. Keep the function name `binarySearch`.\n\n' +
         '```js\n' +
         'function binarySearch(arr, target) {\n' +
         '  let lo = 0, hi = arr.length;\n' +
         '  while (lo < hi) {\n' +
         '    const mid = (lo + hi) / 2;\n' +
         '    if (arr[mid] === target) return mid;\n' +
         '    if (arr[mid] < target) lo = mid;\n' +
         '    else hi = mid;\n' +
         '  }\n' +
         '  return -1;\n' +
         '}\n' +
         '```',
      tests: [
         { args: [[1, 3, 5, 7, 9], 7], expected: 3 },
         { args: [[1, 3, 5, 7, 9], 1], expected: 0 },
         { args: [[1, 3, 5, 7, 9], 9], expected: 4 },
         { args: [[1, 3, 5, 7, 9], 4], expected: -1 },
         { args: [[], 1], expected: -1 },
         { args: [[42], 42], expected: 0 },
      ],
   },

   'bugfix-flatten': {
      category: 'bugfix',
      difficulty: 'medium',
      entry: 'flatten',
      signature: 'flatten(arr: any[]): number[]',
      prompt:
         'The following deep-flatten has a bug — it only flattens one level. Return a CORRECTED version that ' +
         'fully flattens an arbitrarily nested array of numbers into a flat array, preserving order. Keep the ' +
         'function name `flatten`.\n\n' +
         '```js\n' +
         'function flatten(arr) {\n' +
         '  const out = [];\n' +
         '  for (const x of arr) {\n' +
         '    if (Array.isArray(x)) out.push(...x);\n' +
         '    else out.push(x);\n' +
         '  }\n' +
         '  return out;\n' +
         '}\n' +
         '```',
      tests: [
         { args: [[1, [2, [3, [4]]]]], expected: [1, 2, 3, 4] },
         {
            args: [
               [
                  [1, 2],
                  [3, 4],
               ],
            ],
            expected: [1, 2, 3, 4],
         },
         { args: [[1, 2, 3]], expected: [1, 2, 3] },
         { args: [[]], expected: [] },
         { args: [[[[[5]]]]], expected: [5] },
         { args: [[1, [], [2, []], 3]], expected: [1, 2, 3] },
      ],
   },

   'bugfix-dedup-order': {
      category: 'bugfix',
      difficulty: 'medium',
      entry: 'dedup',
      signature: 'dedup(arr: number[]): number[]',
      prompt:
         'The following dedup is supposed to remove duplicates while PRESERVING first-seen order, but it sorts ' +
         'the output, breaking order. Return a CORRECTED version that preserves first-seen order. Keep the ' +
         'function name `dedup`.\n\n' +
         '```js\n' +
         'function dedup(arr) {\n' +
         '  return [...new Set(arr)].sort();\n' +
         '}\n' +
         '```',
      tests: [
         { args: [[3, 1, 2, 1, 3]], expected: [3, 1, 2] },
         { args: [[1, 1, 1]], expected: [1] },
         { args: [[]], expected: [] },
         { args: [[10, 9, 8, 9, 10]], expected: [10, 9, 8] },
         { args: [[5]], expected: [5] },
      ],
   },
};
