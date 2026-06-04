/**
 * Coding benchmark — HARD tier (bench id `coding_hard`).
 *
 * Large, stateful, multi-method spec-implementation tasks that break the ceiling
 * the function-level set hit (every capable model scored ~94–100% there). Graded
 * the same way — execute the model's code against hidden tests — but the tests
 * here use the `call` form: each test is a JS expression that constructs and
 * drives the model's class, then returns observable state (board / score / flags)
 * for structural comparison. See coding-harness.mjs for the `call` path.
 *
 * Determinism is engineered into the spec: the constructor takes an explicit
 * initial board and an injected spawn queue, so there is exactly one correct
 * result for any move sequence — no randomness, no geometric ambiguity (the trap
 * that makes Tetris hard to grade). `expected` literals are derived from a
 * reference engine (_gen-2048.mjs) and hand-checked against the spec.
 */

export const CASES = {
   '2048-engine': {
      category: 'game',
      difficulty: 'hard',
      tier: 'hard',
      entry: 'Game2048',
      signature:
         'class Game2048 { constructor(board, spawnQueue); move(dir): boolean; getBoard(): number[][]; getScore(): number; isGameOver(): boolean }',
      prompt:
         'Implement the game engine for 2048 as a JavaScript class named `Game2048`. ' +
         'Follow this spec EXACTLY — it is graded by executing your class.\n\n' +
         'Board: a 4×4 grid, represented as an array of 4 rows, each an array of 4 integers. ' +
         '0 means an empty cell; non-zero values are tiles.\n\n' +
         'Constructor `new Game2048(board, spawnQueue)`:\n' +
         '  • `board` — the initial 4×4 grid. Copy it; do not alias the caller’s array.\n' +
         '  • `spawnQueue` — an array of spawn instructions `{r, c, v}` consumed IN ORDER, ' +
         'one per spawn (see move). The score starts at 0.\n\n' +
         'Provide three METHODS (called with parentheses):\n' +
         '  • `getBoard()` → the current 4×4 grid.\n' +
         '  • `getScore()` → the running score (a number).\n' +
         '  • `isGameOver()` → boolean: true iff there are NO empty cells AND no two ' +
         'horizontally- or vertically-adjacent cells are equal (no move would change the board).\n\n' +
         'Method `move(dir)` where `dir` is one of "left", "right", "up", "down":\n' +
         '  1. Slide all tiles as far as possible in `dir`. When two tiles of equal value ' +
         'collide while sliding, they merge into one tile of double the value, and that merged ' +
         'value is ADDED to `score`. A tile that resulted from a merge cannot merge again in the ' +
         'same move. When multiple merges are possible in a line, the ones nearer the direction ' +
         'of travel happen first (e.g. moving [2,2,2,2] left gives [4,4,0,0], NOT [8,0,0,0]; ' +
         '[2,2,4] moving left gives [4,4,0]).\n' +
         '  2. If the board CHANGED as a result of the move, consume the next spawn `{r,c,v}` from ' +
         'the queue and set that cell to `v`, then return `true`. If the board did NOT change, ' +
         'consume NO spawn and return `false`.',
      tests: [
         // 1. basic left merge + spawn into bottom-right
         {
            call: `(()=>{const g=new Game2048([[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],[{r:3,c:3,v:2}]);g.move('left');return g.getBoard();})()`,
            expected: [
               [4, 0, 0, 0],
               [0, 0, 0, 0],
               [0, 0, 0, 0],
               [0, 0, 0, 2],
            ],
         },
         // 2. no double-merge: four 2s become two 4s, not one 8
         {
            call: `(()=>{const g=new Game2048([[2,2,2,2],[0,0,0,0],[0,0,0,0],[0,0,0,0]],[{r:3,c:0,v:2}]);g.move('left');return g.getBoard();})()`,
            expected: [
               [4, 4, 0, 0],
               [0, 0, 0, 0],
               [0, 0, 0, 0],
               [2, 0, 0, 0],
            ],
         },
         // 3. merge-before-shift: [2,2,4] -> [4,4]
         {
            call: `(()=>{const g=new Game2048([[2,2,4,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],[{r:3,c:3,v:2}]);g.move('left');return g.getBoard();})()`,
            expected: [
               [4, 4, 0, 0],
               [0, 0, 0, 0],
               [0, 0, 0, 0],
               [0, 0, 0, 2],
            ],
         },
         // 4. direction = right, with merge ordering toward the right wall
         {
            call: `(()=>{const g=new Game2048([[2,2,2,2],[0,0,0,0],[0,0,0,0],[0,0,0,0]],[{r:0,c:1,v:2}]);g.move('right');return g.getBoard();})()`,
            expected: [
               [0, 2, 4, 4],
               [0, 0, 0, 0],
               [0, 0, 0, 0],
               [0, 0, 0, 0],
            ],
         },
         // 5. up merge across a column ([2,2,4,4] -> [4,8])
         {
            call: `(()=>{const g=new Game2048([[2,0,0,0],[2,0,0,0],[4,0,0,0],[4,0,0,0]],[{r:3,c:3,v:2}]);g.move('up');return g.getBoard();})()`,
            expected: [
               [4, 0, 0, 0],
               [8, 0, 0, 0],
               [0, 0, 0, 0],
               [0, 0, 0, 2],
            ],
         },
         // 6. down merge across a column ([2,2,2] down -> [.,.,2,4])
         {
            call: `(()=>{const g=new Game2048([[2,0,0,0],[2,0,0,0],[2,0,0,0],[0,0,0,0]],[{r:0,c:3,v:2}]);g.move('down');return g.getBoard();})()`,
            expected: [
               [0, 0, 0, 2],
               [0, 0, 0, 0],
               [2, 0, 0, 0],
               [4, 0, 0, 0],
            ],
         },
         // 7. score: [4,4,2,2] left => +8 +4 = 12
         {
            call: `(()=>{const g=new Game2048([[4,4,2,2],[0,0,0,0],[0,0,0,0],[0,0,0,0]],[{r:1,c:0,v:2}]);g.move('left');return g.getScore();})()`,
            expected: 12,
         },
         // 8. no-change move returns false and consumes no spawn
         {
            call: `(()=>{const g=new Game2048([[2,4,8,16],[0,0,0,0],[0,0,0,0],[0,0,0,0]],[{r:1,c:0,v:2}]);const changed=g.move('left');return {changed,board:g.getBoard()};})()`,
            expected: {
               changed: false,
               board: [
                  [2, 4, 8, 16],
                  [0, 0, 0, 0],
                  [0, 0, 0, 0],
                  [0, 0, 0, 0],
               ],
            },
         },
         // 9. multi-move: state persists across moves, score accumulates, spawns ordered
         {
            call: `(()=>{const g=new Game2048([[2,2,0,0],[2,2,0,0],[0,0,0,0],[0,0,0,0]],[{r:3,c:3,v:2},{r:3,c:2,v:2}]);g.move('left');g.move('up');return {board:g.getBoard(),score:g.getScore()};})()`,
            expected: {
               board: [
                  [8, 0, 0, 2],
                  [0, 0, 0, 0],
                  [0, 0, 0, 0],
                  [0, 0, 2, 0],
               ],
               score: 16,
            },
         },
         // 10. gameOver true: full board, no adjacent equals
         {
            call: `(()=>{const g=new Game2048([[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,2]],[]);return g.isGameOver();})()`,
            expected: true,
         },
         // 11. gameOver false: an empty cell remains
         {
            call: `(()=>{const g=new Game2048([[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,0]],[]);return g.isGameOver();})()`,
            expected: false,
         },
         // 12. gameOver false: full board but a horizontal merge is available
         {
            call: `(()=>{const g=new Game2048([[2,2,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,2]],[]);return g.isGameOver();})()`,
            expected: false,
         },
      ],
   },
};
