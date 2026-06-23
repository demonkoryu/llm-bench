/**
 * Hand-authored hard algorithmic coding problems.
 *
 * These supplement the HumanEval-JS (MultiPL-E) baseline with problems that
 * require non-trivial algorithm design: DP, graph algorithms, stack-based
 * techniques, and tricky edge-case handling. The goal is to differentiate
 * models that ceiling on HumanEval.
 *
 * Consumed by benchmarks/coding/grader.mjs — same { entry, signature, prompt, tests } contract.
 */

export const CASES = {
   hard_longest_increasing_subsequence: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'length_of_lis',
      signature: 'function length_of_lis(nums)',
      prompt:
         'Given an integer array `nums`, return the length of the longest strictly increasing subsequence.\n\n' +
         'A subsequence is derived by deleting some (or no) elements without changing the order of the remaining elements.\n\n' +
         '>>> length_of_lis([10, 9, 2, 5, 3, 7, 101, 18])\n4\n' +
         '>>> length_of_lis([0, 1, 0, 3, 2, 3])\n4',
      tests: [
         { args: [[10, 9, 2, 5, 3, 7, 101, 18]], expected: 4 },
         { args: [[0, 1, 0, 3, 2, 3]], expected: 4 },
         { args: [[7, 7, 7, 7, 7]], expected: 1 },
         { args: [[]], expected: 0 },
         { args: [[42]], expected: 1 },
         { args: [[5, 4, 3, 2, 1]], expected: 1 },
         { args: [[1, 2, 3, 4, 5]], expected: 5 },
         { args: [[1, 3, 6, 7, 9, 4, 10, 5, 6]], expected: 6 },
      ],
   },

   hard_coin_change: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'coin_change',
      signature: 'function coin_change(coins, amount)',
      prompt:
         'Given an array of coin denominations `coins` and a target `amount`, return the fewest number of coins ' +
         'needed to make that amount. If it cannot be made, return -1. You may use each coin denomination infinitely many times.\n\n' +
         '>>> coin_change([1, 2, 5], 11)\n3\n' +
         '>>> coin_change([2], 3)\n-1',
      tests: [
         { args: [[1, 2, 5], 11], expected: 3 },
         { args: [[2], 3], expected: -1 },
         { args: [[1], 0], expected: 0 },
         { args: [[1], 1], expected: 1 },
         { args: [[1], 2], expected: 2 },
         { args: [[1, 2, 5], 100], expected: 20 },
         { args: [[186, 419, 83, 408], 6249], expected: 20 },
         { args: [[3, 7], 1], expected: -1 },
         { args: [[2, 5, 10, 1], 27], expected: 4 },
      ],
   },

   hard_edit_distance: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'min_distance',
      signature: 'function min_distance(word1, word2)',
      prompt:
         'Given two strings `word1` and `word2`, return the minimum number of operations required to convert ' +
         '`word1` to `word2`. You have three operations: insert a character, delete a character, replace a character.\n\n' +
         ">>> min_distance('horse', 'ros')\n3\n" +
         ">>> min_distance('intention', 'execution')\n5",
      tests: [
         { args: ['horse', 'ros'], expected: 3 },
         { args: ['intention', 'execution'], expected: 5 },
         { args: ['', ''], expected: 0 },
         { args: ['', 'abc'], expected: 3 },
         { args: ['abc', ''], expected: 3 },
         { args: ['abc', 'abc'], expected: 0 },
         { args: ['kitten', 'sitting'], expected: 3 },
         { args: ['saturday', 'sunday'], expected: 3 },
         { args: ['a', 'b'], expected: 1 },
      ],
   },

   hard_merge_intervals: {
      category: 'hard',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'merge_intervals',
      signature: 'function merge_intervals(intervals)',
      prompt:
         'Given an array of `intervals` where intervals[i] = [start_i, end_i], merge all overlapping intervals ' +
         'and return an array of the non-overlapping intervals that cover all the intervals in the input, sorted by start.\n\n' +
         '>>> merge_intervals([[1,3],[2,6],[8,10],[15,18]])\n[[1,6],[8,10],[15,18]]',
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
                  [0, 4],
               ],
            ],
            expected: [[0, 4]],
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
         { args: [[[1, 2]]], expected: [[1, 2]] },
         { args: [[]], expected: [] },
         {
            args: [
               [
                  [1, 10],
                  [2, 3],
                  [4, 5],
                  [6, 7],
               ],
            ],
            expected: [[1, 10]],
         },
         {
            args: [
               [
                  [5, 8],
                  [1, 3],
                  [9, 12],
                  [2, 6],
               ],
            ],
            expected: [
               [1, 8],
               [9, 12],
            ],
         },
      ],
   },

   hard_trapping_rain_water: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'trap',
      signature: 'function trap(height)',
      prompt:
         'Given `n` non-negative integers representing an elevation map where the width of each bar is 1, ' +
         'compute how much water it can trap after raining.\n\n' +
         '>>> trap([0,1,0,2,1,0,1,3,2,1,2,1])\n6\n' +
         '>>> trap([4,2,0,3,2,5])\n9',
      tests: [
         { args: [[0, 1, 0, 2, 1, 0, 1, 3, 2, 1, 2, 1]], expected: 6 },
         { args: [[4, 2, 0, 3, 2, 5]], expected: 9 },
         { args: [[]], expected: 0 },
         { args: [[3]], expected: 0 },
         { args: [[3, 3]], expected: 0 },
         { args: [[5, 0, 5]], expected: 5 },
         { args: [[0, 0, 0]], expected: 0 },
         { args: [[3, 0, 2, 0, 4]], expected: 7 },
         { args: [[1, 2, 3, 4, 5]], expected: 0 },
         { args: [[5, 4, 3, 2, 1]], expected: 0 },
      ],
   },

   hard_next_permutation: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'next_permutation',
      signature: 'function next_permutation(nums)',
      prompt:
         'Given an array of integers `nums`, rearrange it into the lexicographically next greater permutation. ' +
         'If no such permutation exists (the array is in descending order), rearrange it to the lowest possible order (ascending). ' +
         'Return the new array. The rearrangement must be in-place (modify and return `nums`).\n\n' +
         '>>> next_permutation([1,2,3])\n[1,3,2]\n' +
         '>>> next_permutation([3,2,1])\n[1,2,3]\n' +
         '>>> next_permutation([1,1,5])\n[1,5,1]',
      tests: [
         { args: [[1, 2, 3]], expected: [1, 3, 2] },
         { args: [[3, 2, 1]], expected: [1, 2, 3] },
         { args: [[1, 1, 5]], expected: [1, 5, 1] },
         { args: [[1]], expected: [1] },
         { args: [[1, 3, 2]], expected: [2, 1, 3] },
         { args: [[2, 3, 1]], expected: [3, 1, 2] },
         { args: [[5, 1, 1]], expected: [1, 1, 5] },
         { args: [[1, 2, 3, 4]], expected: [1, 2, 4, 3] },
         { args: [[4, 3, 2, 1]], expected: [1, 2, 3, 4] },
      ],
   },

   hard_word_break: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'word_break',
      signature: 'function word_break(s, wordDict)',
      prompt:
         'Given a string `s` and an array of strings `wordDict`, return true if `s` can be segmented into a ' +
         'space-separated sequence of one or more dictionary words. The same word may be reused multiple times.\n\n' +
         ">>> word_break('leetcode', ['leet', 'code'])\ntrue\n" +
         ">>> word_break('catsandog', ['cats', 'dog', 'sand', 'and', 'cat'])\nfalse",
      tests: [
         { args: ['leetcode', ['leet', 'code']], expected: true },
         { args: ['applepenapple', ['apple', 'pen']], expected: true },
         { args: ['catsandog', ['cats', 'dog', 'sand', 'and', 'cat']], expected: false },
         { args: ['', []], expected: true },
         { args: ['a', ['a']], expected: true },
         { args: ['a', ['b']], expected: false },
         { args: ['aaaaaaa', ['aaa', 'aaaa']], expected: true },
         { args: ['goalspecial', ['go', 'goal', 'goals', 'special']], expected: true },
         { args: ['catsanddog', ['cats', 'dog', 'sand', 'and', 'cat']], expected: true },
      ],
   },

   hard_count_inversions: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'count_inversions',
      signature: 'function count_inversions(arr)',
      prompt:
         'Given an array of integers, count the number of inversions. An inversion is a pair (i, j) where ' +
         'i < j but arr[i] > arr[j].\n\n' +
         '>>> count_inversions([2, 4, 1, 3, 5])\n3\n' +
         '>>> count_inversions([5, 4, 3, 2, 1])\n10',
      tests: [
         { args: [[2, 4, 1, 3, 5]], expected: 3 },
         { args: [[5, 4, 3, 2, 1]], expected: 10 },
         { args: [[1, 2, 3, 4, 5]], expected: 0 },
         { args: [[]], expected: 0 },
         { args: [[1]], expected: 0 },
         { args: [[2, 1]], expected: 1 },
         { args: [[1, 5, 4, 8, 10, 2, 6]], expected: 5 },
         { args: [[3, 1, 2]], expected: 2 },
      ],
   },

   hard_max_product_subarray: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'max_product',
      signature: 'function max_product(nums)',
      prompt:
         'Given an integer array `nums`, find a contiguous subarray (at least one element) that has the ' +
         'largest product, and return the product.\n\n' +
         '>>> max_product([2, 3, -2, 4])\n6\n' +
         '>>> max_product([-2, 0, -1])\n0\n' +
         '>>> max_product([-2, 3, -4])\n24',
      tests: [
         { args: [[2, 3, -2, 4]], expected: 6 },
         { args: [[-2, 0, -1]], expected: 0 },
         { args: [[-2, 3, -4]], expected: 24 },
         { args: [[0]], expected: 0 },
         { args: [[-2]], expected: -2 },
         { args: [[2, -5, -2, -4, 3]], expected: 24 },
         { args: [[-1, -2, -3, 0]], expected: 6 },
         { args: [[1, 2, 3, 4]], expected: 24 },
         { args: [[-3, 0, 1, -2]], expected: 1 },
      ],
   },

   hard_decode_ways: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'num_decodings',
      signature: 'function num_decodings(s)',
      prompt:
         "A message containing letters A-Z can be encoded as numbers: 'A' → '1', 'B' → '2', ..., 'Z' → '26'. " +
         'Given a string `s` containing only digits, return the number of ways to decode it. ' +
         "Leading zeros in a segment are invalid (e.g. '06' is not valid, but '6' is).\n\n" +
         ">>> num_decodings('12')\n2\n" +
         ">>> num_decodings('226')\n3\n" +
         ">>> num_decodings('06')\n0",
      tests: [
         { args: ['12'], expected: 2 },
         { args: ['226'], expected: 3 },
         { args: ['06'], expected: 0 },
         { args: ['0'], expected: 0 },
         { args: ['1'], expected: 1 },
         { args: ['10'], expected: 1 },
         { args: ['27'], expected: 1 },
         { args: ['11106'], expected: 2 },
         { args: ['111'], expected: 3 },
         { args: ['1234'], expected: 3 },
      ],
   },

   hard_spiral_order: {
      category: 'hard',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'spiral_order',
      signature: 'function spiral_order(matrix)',
      prompt:
         'Given an m x n matrix, return all elements of the matrix in spiral order (clockwise from the top-left).\n\n' +
         '>>> spiral_order([[1,2,3],[4,5,6],[7,8,9]])\n[1,2,3,6,9,8,7,4,5]',
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
         { args: [[[1, 2, 3]]], expected: [1, 2, 3] },
         { args: [[[1], [2], [3]]], expected: [1, 2, 3] },
         { args: [[]], expected: [] },
      ],
   },

   hard_largest_rectangle_histogram: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'largest_rectangle_area',
      signature: 'function largest_rectangle_area(heights)',
      prompt:
         "Given an array of integers `heights` representing the histogram's bar heights where the width of " +
         'each bar is 1, return the area of the largest rectangle in the histogram.\n\n' +
         '>>> largest_rectangle_area([2,1,5,6,2,3])\n10\n' +
         '>>> largest_rectangle_area([2,4])\n4',
      tests: [
         { args: [[2, 1, 5, 6, 2, 3]], expected: 10 },
         { args: [[2, 4]], expected: 4 },
         { args: [[1]], expected: 1 },
         { args: [[]], expected: 0 },
         { args: [[1, 1, 1, 1, 1]], expected: 5 },
         { args: [[6, 2, 5, 4, 5, 1, 6]], expected: 12 },
         { args: [[3, 6, 5, 7, 4, 8, 1, 0]], expected: 20 },
         { args: [[1, 2, 3, 4, 5]], expected: 9 },
         { args: [[5, 4, 3, 2, 1]], expected: 9 },
      ],
   },

   hard_jump_game: {
      category: 'hard',
      difficulty: 'medium',
      source: 'hand-authored',
      entry: 'can_jump',
      signature: 'function can_jump(nums)',
      prompt:
         'Given an array of non-negative integers `nums`, where each element represents the maximum jump length ' +
         'from that position, determine if you can reach the last index starting from the first index.\n\n' +
         '>>> can_jump([2,3,1,1,4])\ntrue\n' +
         '>>> can_jump([3,2,1,0,4])\nfalse',
      tests: [
         { args: [[2, 3, 1, 1, 4]], expected: true },
         { args: [[3, 2, 1, 0, 4]], expected: false },
         { args: [[0]], expected: true },
         { args: [[1, 0]], expected: true },
         { args: [[0, 1]], expected: false },
         { args: [[2, 0, 0]], expected: true },
         { args: [[1, 1, 1, 1, 1]], expected: true },
         { args: [[5, 0, 0, 0, 0, 0]], expected: true },
         { args: [[1, 0, 1, 0]], expected: false },
      ],
   },

   hard_longest_common_subsequence: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'longest_common_subsequence',
      signature: 'function longest_common_subsequence(text1, text2)',
      prompt:
         'Given two strings `text1` and `text2`, return the length of their longest common subsequence. ' +
         'A subsequence is a sequence that can be derived by deleting some (or no) characters without changing ' +
         'the relative order.\n\n' +
         ">>> longest_common_subsequence('abcde', 'ace')\n3\n" +
         ">>> longest_common_subsequence('abc', 'def')\n0",
      tests: [
         { args: ['abcde', 'ace'], expected: 3 },
         { args: ['abc', 'abc'], expected: 3 },
         { args: ['abc', 'def'], expected: 0 },
         { args: ['', 'abc'], expected: 0 },
         { args: ['abc', ''], expected: 0 },
         { args: ['', ''], expected: 0 },
         { args: ['oxcpqrsvwf', 'shmtulqrypy'], expected: 2 },
         { args: ['bsbininm', 'jmjkbkjkv'], expected: 1 },
         { args: ['abcba', 'abcbcba'], expected: 5 },
      ],
   },

   hard_knapsack_01: {
      category: 'hard',
      difficulty: 'hard',
      source: 'hand-authored',
      entry: 'knapsack',
      signature: 'function knapsack(weights, values, capacity)',
      prompt:
         'Given `n` items where item `i` has weight `weights[i]` and value `values[i]`, and a knapsack with ' +
         'maximum capacity `capacity`, return the maximum total value you can carry. Each item can be used at most once.\n\n' +
         '>>> knapsack([1, 3, 4, 5], [1, 4, 5, 7], 7)\n9\n' +
         '>>> knapsack([2, 3, 4, 5], [3, 4, 5, 6], 5)\n7',
      tests: [
         { args: [[1, 3, 4, 5], [1, 4, 5, 7], 7], expected: 9 },
         { args: [[2, 3, 4, 5], [3, 4, 5, 6], 5], expected: 7 },
         { args: [[], [], 10], expected: 0 },
         { args: [[10], [5], 3], expected: 0 },
         { args: [[5], [10], 5], expected: 10 },
         { args: [[1, 1, 1], [10, 20, 30], 2], expected: 50 },
         { args: [[3, 4, 2], [4, 5, 3], 7], expected: 9 },
         { args: [[10, 20, 30], [60, 100, 120], 50], expected: 220 },
      ],
   },
};
