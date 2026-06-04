#!/usr/bin/env node

/**
 * Standalone smoke test for the coding benchmark — no llama-server required.
 *
 * Feeds reference solutions through the real grader/sandbox to prove that
 * extraction, vm isolation, deep-equality, and the timeout path all work before
 * spending a model run. Also seeds three negative cases (a wrong solution, an
 * infinite loop, and a sandbox-escape attempt) to confirm they are scored 0
 * rather than passing or hanging.
 *
 *   npm run coding-smoke
 *
 * Exit 0 if every reference solution is pass@1 and every negative case fails.
 */

import { CASES } from '../benchmarks/coding/cases.mjs';
import { CASES as HARD_CASES } from '../benchmarks/coding/cases-hard.mjs';
import { gradeCase } from '../benchmarks/coding/grader.mjs';

// Reference 2048 engine (spec-correct) + a buggy variant that double-merges.
const G2048_REF = `
function transpose(m){return m[0].map((_,c)=>m.map(r=>r[c]));}
class Game2048{
  constructor(board,q){this.board=board.map(r=>r.slice());this.q=(q||[]).slice();this.qi=0;this.score=0;}
  _sl(row){const v=row.filter(x=>x!==0),o=[];let g=0;for(let i=0;i<v.length;i++){if(i+1<v.length&&v[i]===v[i+1]){const m=v[i]*2;o.push(m);g+=m;i++;}else o.push(v[i]);}while(o.length<row.length)o.push(0);return{row:o,g};}
  move(d){const b=JSON.stringify(this.board);let g=this.board.map(r=>r.slice());
    if(d==='right')g=g.map(r=>r.slice().reverse());else if(d==='up')g=transpose(g);else if(d==='down')g=transpose(g).map(r=>r.slice().reverse());
    let gn=0;g=g.map(r=>{const s=this._sl(r);gn+=s.g;return s.row;});
    if(d==='right')g=g.map(r=>r.slice().reverse());else if(d==='up')g=transpose(g);else if(d==='down')g=transpose(g.map(r=>r.slice().reverse()));
    this.board=g;const ch=JSON.stringify(this.board)!==b;
    if(ch){this.score+=gn;if(this.qi<this.q.length){const{r,c,v}=this.q[this.qi++];this.board[r][c]=v;}}return ch;}
  getBoard(){return this.board;}
  getScore(){return this.score;}
  isGameOver(){for(const row of this.board)for(const v of row)if(v===0)return false;
    for(let r=0;r<4;r++)for(let c=0;c<4;c++){if(c+1<4&&this.board[r][c]===this.board[r][c+1])return false;if(r+1<4&&this.board[r][c]===this.board[r+1][c])return false;}return true;}
}`;
const G2048_BUGGY = G2048_REF.replace(
   `_sl(row){const v=row.filter(x=>x!==0),o=[];let g=0;for(let i=0;i<v.length;i++){if(i+1<v.length&&v[i]===v[i+1]){const m=v[i]*2;o.push(m);g+=m;i++;}else o.push(v[i]);}while(o.length<row.length)o.push(0);return{row:o,g};}`,
   // bug: collapses a whole run of equal tiles into one (double-merges)
   `_sl(row){const v=row.filter(x=>x!==0),o=[];let g=0;let i=0;while(i<v.length){let j=i;let val=v[i];while(j+1<v.length&&v[j+1]===v[i]){val*=2;j++;}if(val!==v[i])g+=val;o.push(val);i=j+1;}while(o.length<row.length)o.push(0);return{row:o,g};}`,
);

// Reference solutions, returned the way a model would — inside a ```js block.
const SOLUTIONS = {
   fizzbuzz: `function fizzbuzz(n){let s='';if(n%3===0)s+='Fizz';if(n%5===0)s+='Buzz';return s||String(n);}`,
   'reverse-words': `function reverseWords(s){return s.trim().split(/\\s+/).filter(Boolean).reverse().join(' ');}`,
   'sum-even': `function sumEven(nums){return nums.filter(x=>x%2===0).reduce((a,b)=>a+b,0);}`,
   'two-sum': `function twoSum(nums,target){const m=new Map();for(let i=0;i<nums.length;i++){const c=target-nums[i];if(m.has(c))return [m.get(c),i];m.set(nums[i],i);}return [];}`,
   'valid-parens': `function isValid(s){const st=[],p={')':'(',']':'[','}':'{'};for(const c of s){if(c in p){if(st.pop()!==p[c])return false;}else st.push(c);}return st.length===0;}`,
   'roman-to-int': `function romanToInt(s){const v={I:1,V:5,X:10,L:50,C:100,D:500,M:1000};let t=0;for(let i=0;i<s.length;i++){if(i+1<s.length&&v[s[i]]<v[s[i+1]])t-=v[s[i]];else t+=v[s[i]];}return t;}`,
   'group-anagrams': `function groupAnagrams(words){const m=new Map();for(const w of words){const k=[...w].sort().join('');if(!m.has(k))m.set(k,[]);m.get(k).push(w);}return [...m.values()];}`,
   'merge-intervals': `function mergeIntervals(intervals){if(!intervals.length)return [];const s=[...intervals].sort((a,b)=>a[0]-b[0]);const out=[s[0].slice()];for(let i=1;i<s.length;i++){const last=out[out.length-1];if(s[i][0]<=last[1])last[1]=Math.max(last[1],s[i][1]);else out.push(s[i].slice());}return out;}`,
   'lru-ish-cache': `function firstUnique(s){const c={};for(const ch of s)c[ch]=(c[ch]||0)+1;for(const ch of s)if(c[ch]===1)return ch;return '';}`,
   'longest-substring': `function lengthOfLongestSubstring(s){let best=0,start=0;const seen=new Map();for(let i=0;i<s.length;i++){if(seen.has(s[i])&&seen.get(s[i])>=start)start=seen.get(s[i])+1;seen.set(s[i],i);best=Math.max(best,i-start+1);}return best;}`,
   'coin-change': `function coinChange(coins,amount){const dp=new Array(amount+1).fill(Infinity);dp[0]=0;for(let a=1;a<=amount;a++)for(const c of coins)if(c<=a)dp[a]=Math.min(dp[a],dp[a-c]+1);return dp[amount]===Infinity?-1:dp[amount];}`,
   'spiral-order': `function spiralOrder(matrix){const out=[];if(!matrix.length)return out;let top=0,bot=matrix.length-1,left=0,right=matrix[0].length-1;while(top<=bot&&left<=right){for(let j=left;j<=right;j++)out.push(matrix[top][j]);top++;for(let i=top;i<=bot;i++)out.push(matrix[i][right]);right--;if(top<=bot){for(let j=right;j>=left;j--)out.push(matrix[bot][j]);bot--;}if(left<=right){for(let i=bot;i>=top;i--)out.push(matrix[i][left]);left++;}}return out;}`,
   'edit-distance': `function editDistance(a,b){const m=a.length,n=b.length;const dp=Array.from({length:m+1},()=>new Array(n+1).fill(0));for(let i=0;i<=m;i++)dp[i][0]=i;for(let j=0;j<=n;j++)dp[0][j]=j;for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);return dp[m][n];}`,
   'median-two': `function median(nums){if(!nums.length)return 0;const s=[...nums].sort((a,b)=>a-b);const m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;}`,
   'rounding-trap': `function roundHalfUp(x){return Math.round(x);}`,
   'bugfix-binsearch': `function binarySearch(arr,target){let lo=0,hi=arr.length-1;while(lo<=hi){const mid=(lo+hi)>>1;if(arr[mid]===target)return mid;if(arr[mid]<target)lo=mid+1;else hi=mid-1;}return -1;}`,
   'bugfix-flatten': `function flatten(arr){const out=[];for(const x of arr){if(Array.isArray(x))out.push(...flatten(x));else out.push(x);}return out;}`,
   'bugfix-dedup-order': `function dedup(arr){return [...new Set(arr)];}`,
};

// Negative cases: must all score < 1.0 and must not hang the suite.
const NEGATIVES = [
   { id: 'fizzbuzz', label: 'wrong-answer', output: '```js\nfunction fizzbuzz(n){return String(n);}\n```' },
   { id: 'sum-even', label: 'infinite-loop', output: '```js\nfunction sumEven(nums){while(true){}return 0;}\n```' },
   { id: 'sum-even', label: 'sandbox-escape', output: "```js\nfunction sumEven(nums){return require('fs').readdirSync('.').length;}\n```" },
   { id: 'two-sum', label: 'no-code', output: 'I think the answer involves a hash map but here it is in prose only.' },
];

async function main() {
   let fails = 0;

   console.log('── reference solutions (expect pass@1) ──');
   for (const [id, caseObj] of Object.entries(CASES)) {
      const sol = SOLUTIONS[id];
      if (!sol) {
         console.log(`  ?? ${id.padEnd(20)} NO REFERENCE SOLUTION`);
         fails++;
         continue;
      }
      const r = await gradeCase(caseObj, `\`\`\`js\n${sol}\n\`\`\``);
      const ok = r.pass;
      if (!ok) {
         fails++;
      }
      console.log(`  ${ok ? 'OK' : 'XX'} ${id.padEnd(20)} ${r.reason}`);
   }

   console.log('\n── negative cases (expect failure, no hang) ──');
   for (const neg of NEGATIVES) {
      const t0 = Date.now();
      const r = await gradeCase(CASES[neg.id], neg.output, { timeoutMs: 3000 });
      const elapsed = Date.now() - t0;
      const ok = !r.pass; // a negative case is "ok" when it does NOT pass
      if (!ok) {
         fails++;
      }
      console.log(`  ${ok ? 'OK' : 'XX'} ${neg.label.padEnd(16)} ${r.reason}  (${elapsed}ms)`);
   }

   console.log('\n── hard tier: 2048 engine (reference expect pass@1, buggy expect fail) ──');
   {
      const c = HARD_CASES['2048-engine'];
      const ref = await gradeCase(c, `\`\`\`js\n${G2048_REF}\n\`\`\``);
      if (!ref.pass) {
         fails++;
      }
      console.log(`  ${ref.pass ? 'OK' : 'XX'} 2048 reference     ${ref.reason}`);
      const bug = await gradeCase(c, `\`\`\`js\n${G2048_BUGGY}\n\`\`\``);
      if (bug.pass) {
         fails++; // a double-merging engine must NOT be scored pass@1
      }
      console.log(`  ${bug.pass ? 'XX' : 'OK'} 2048 buggy(merge)  ${bug.reason}`);
   }

   console.log(`\n${fails === 0 ? 'PASS' : `FAIL (${fails})`} — coding sandbox + grader`);
   process.exit(fails === 0 ? 0 : 1);
}

main();
