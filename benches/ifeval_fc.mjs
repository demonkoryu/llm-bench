// Bench module: ifeval_fc — IFEval-FC on a PINNED subset.
//
// Measures whether a model honours a formatting instruction that lives inside a JSON-schema
// PARAMETER DESCRIPTION while making a function call. Upstream's example: a parameter whose
// description says "must use exactly 6 consecutive spaces between every pair of words". The model
// gets one tool and one user query; the argument value it supplies is graded by a deterministic
// checker. Nothing here is judged by another model.
//
// WHY IT IS DIFFERENT FROM `toolcalling`. That bench asks whether the right tool is called with
// plausible arguments. This one takes the call for granted and asks whether the ARGUMENT VALUE obeys
// a constraint stated only in the schema — a place models are known to skim.
//
// THE GRADER IS NOT OURS. benchmarks/ifeval-fc/vendor/ holds upstream's checkers at a pinned commit,
// and benchmarks/ifeval-fc/verify.py runs them in a subprocess. Reimplementing them in JS would put
// this bench's numbers at the mercy of my reading of "what counts as a sentence"; upstream's own test
// suite runs against the vendored copy instead. Same split as swe_live: driving in JS, judging in
// Python.
//
// THE THREE-STAGE FUNNEL. Upstream scores a case 1 only when the function was called, the chosen
// parameter was present, AND the value passed its checker. Those failures are not interchangeable —
// a model that never emits a tool call is failing at something entirely different from one that
// calls correctly and then miscounts commas — so all three stages are recorded. A config that scores
// 0 because it cannot emit tool calls at all must be legible as exactly that.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'benchmarks', 'ifeval-fc', 'subset-v1.json');
const VERIFY = join(ROOT, 'benchmarks', 'ifeval-fc', 'verify.py');

// Its own venv, not swe-live's. The checkers need nltk, and there is no reason to perturb a working
// benchmark's pinned environment for an unrelated bench.
const PY = process.env.IFEVAL_FC_PY ?? '/home/demonkoryu/.local/state/ifeval-fc/venv/bin/python';

export const MANIFEST_PATH = MANIFEST;
export const loadManifest = () => JSON.parse(readFileSync(MANIFEST, 'utf8'));

// Deliberately terse. Upstream presents the schema and the query with no coaching, and a system
// prompt that said "obey the parameter descriptions" would measure the prompt rather than the model.
const SYSTEM = 'You are a helpful assistant with access to tools. Use the provided tool to answer the user.';

/** The tool payload for one case: exactly one function, as upstream's evaluate.py binds it. */
const toolFor = (c) => [{ type: 'function', function: c.fn_schema }];

/**
 * Grade every collected value in ONE subprocess.
 *
 * Batched because 150 cases x 23 passes is 3,450 gradings and interpreter startup would dominate a
 * check that takes microseconds. A verifier that cannot run at all throws rather than returning
 * all-false: "every case failed its format check" and "the grader is missing" look identical in the
 * output and must not.
 */
async function gradeAll(records) {
   if (records.length === 0) {
      return new Map();
   }
   if (!existsSync(VERIFY)) {
      throw new Error(`ifeval_fc: verifier not found at ${VERIFY}`);
   }
   const stdin = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
   // spawn + explicit stdin.end(), NOT execFile({input}). execFile has no `input` option -- that is
   // execFileSync/spawnSync -- so passing one is silently ignored: the child's stdin is never
   // written and never closed, verify.py blocks forever on `for line in sys.stdin`, and the bench
   // hangs AFTER all its generations have completed. It cost 30 minutes of two idle GPUs and looked
   // like a slow model rather than a deadlock, because nothing logs between generating and grading.
   const stdout = await new Promise((resolve, reject) => {
      const child = spawn(PY, [VERIFY], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
         child.kill('SIGKILL');
         reject(new Error('ifeval_fc: verifier timed out after 120s'));
      }, 120_000);
      child.stdout.on('data', (d) => {
         out += d;
      });
      child.stderr.on('data', (d) => {
         err += d;
      });
      child.on('error', (e) => {
         clearTimeout(timer);
         reject(e);
      });
      child.on('close', (code) => {
         clearTimeout(timer);
         if (code === 0) {
            resolve(out);
         } else {
            reject(new Error(`ifeval_fc: verifier exited ${code}: ${err.slice(-400)}`));
         }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
   });
   const out = new Map();
   for (const line of stdout.split('\n')) {
      if (!line.trim()) {
         continue;
      }
      try {
         const v = JSON.parse(line);
         out.set(v.case_id, v);
      } catch {
         // one unparseable verdict should not lose the rest
      }
   }
   return out;
}

/**
 * SMOKE MODE. `IFEVAL_FC_LIMIT=n` runs only the first n cases, for answering "can this configuration
 * emit a tool call at all" without paying for the whole pin across twelve configurations.
 *
 * It returns status 'skip', which is what makes it safe: the dashboard's measurements loader already
 * drops skip rows, so a truncated run is visible in a log and can never reach the page. An env var
 * that silently shortened the case list would produce a row indistinguishable from a real one at a
 * different denominator, which is the same class of error as publishing a 12-instance SWE rate
 * beside a 16-instance one.
 */
const LIMIT = Number.parseInt(process.env.IFEVAL_FC_LIMIT ?? '', 10) || null;

export const bench = {
   name: 'ifeval_fc',
   thinkDependent: true,
   async run(client, { think, sampling, thinkControl }) {
      const manifest = loadManifest();
      const params = manifest.run_params;
      const entries = manifest.cases;

      let called = 0;      // stage 1: a tool call came back naming the expected function
      let provided = 0;    // stage 2: the chosen parameter was present in that call
      let total = 0;
      let reqFails = 0;
      const toGrade = [];
      const perChecker = {};

      for (const entry of entries) {
         for (const [qi, query] of entry.user_queries.entries()) {
            if (LIMIT && total >= LIMIT) {
               break;
            }
            total += 1;
            const caseId = `${entry.case_id}#${qi}`;
            perChecker[entry.checker] ??= { n: 0, ok: 0 };
            perChecker[entry.checker].n += 1;

            let completion;
            try {
               ({ completion } = await client.chat(
                  [
                     { role: 'system', content: SYSTEM },
                     { role: 'user', content: query },
                  ],
                  { think, thinkControl, tools: toolFor(entry), max_tokens: params.max_tokens, ...sampling },
               ));
            } catch {
               // A transport failure is not a formatting failure. Counted separately so a flaky
               // endpoint cannot masquerade as a model that ignores instructions.
               reqFails += 1;
               continue;
            }

            const calls = completion.choices?.[0]?.message?.tool_calls ?? [];
            const match = calls.find((c) => c.function?.name === entry.fn_schema.name);
            if (!match) {
               continue;
            }
            called += 1;

            let args;
            try {
               args = typeof match.function.arguments === 'string' ? JSON.parse(match.function.arguments) : match.function.arguments;
            } catch {
               // Unparseable arguments mean the parameter was not provided in any usable sense.
               continue;
            }
            if (args == null || !(entry.chosen_param in args)) {
               continue;
            }
            provided += 1;

            toGrade.push({
               case_id: caseId,
               checker: entry.checker,
               args: entry.args,
               description: entry.description,
               value: args[entry.chosen_param],
               _checker: entry.checker,
            });
         }
      }

      // Progress lines, because their absence is what made a 30-minute deadlock in the verifier look
      // like a slow model: nothing distinguished "still generating" from "finished generating and
      // hung". swe_live logs every instance for the same reason.
      console.error(
         `  [ifeval_fc] ${total} cases · called ${called} · param ${provided} · req_fail ${reqFails} — grading ${toGrade.length}`,
      );
      const verdicts = await gradeAll(toGrade.map(({ _checker, ...r }) => r));
      console.error(`  [ifeval_fc] graded ${verdicts.size}/${toGrade.length}`);
      let ok = 0;
      for (const r of toGrade) {
         if (verdicts.get(r.case_id)?.ok) {
            ok += 1;
            perChecker[r._checker].ok += 1;
         }
      }

      return {
         bench: 'ifeval_fc',
         ifeval_fc_pass: ok,
         ifeval_fc_total: total,
         ifeval_fc_rate: total ? ok / total : null,
         // The funnel. Reported as counts rather than rates so the drop between stages is readable:
         // called -> provided -> pass.
         ifeval_fc_called: called,
         ifeval_fc_param: provided,
         ifeval_fc_req_fail: reqFails,
         ...Object.fromEntries(
            Object.entries(perChecker).map(([k, v]) => [`ifeval_fc_chk_${k.replace(/Checker$/, '')}`, v.n ? v.ok / v.n : null]),
         ),
         // 'skip' when truncated: diagnostic only, and dropped before publication.
         status: LIMIT ? 'skip' : 'ok',
      };
   },
};
