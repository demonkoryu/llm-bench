// Bench registry. Each module reuses the validated benchmarks/*/{cases,grader} and
// exposes { name, thinkDependent, run(client, ctx) -> rawRow }. The orchestrator
// (runners/bench-run.mjs) drives them and emits tidy measurements.
import { bench as agentic_loop } from './agentic_loop.mjs';
import { benches as codingBenches } from './coding.mjs';
import { bench as docqa } from './docqa.mjs';
import { bench as instruction_following } from './instruction_following.mjs';
// performance/capacity probes (kind: 'probe' — self-manage the server)
import { bench as kv_per_tok } from './probes/kv_per_tok.mjs';
import { bench as maxctx } from './probes/maxctx.mjs';
import { bench as parallel_gen } from './probes/parallel_gen.mjs';
import { bench as prefix_cache } from './probes/prefix_cache.mjs';
import { bench as quality_decay } from './probes/quality_decay.mjs';
import { bench as speed } from './probes/speed.mjs';
import { bench as throughput } from './probes/throughput.mjs';
import { bench as reasoning } from './reasoning.mjs';
import { bench as reasoning_expert } from './reasoning_expert.mjs';
import { bench as reasoning_hard } from './reasoning_hard.mjs';
import { bench as struct_output } from './struct_output.mjs';
import { bench as summarization } from './summarization.mjs';
import { bench as toolcalling } from './toolcalling.mjs';
import { bench as triage } from './triage.mjs';

const all = [
   triage,
   reasoning,
   reasoning_hard,
   reasoning_expert,
   toolcalling,
   summarization,
   docqa,
   ...codingBenches,
   agentic_loop,
   struct_output,
   instruction_following,
   maxctx,
   kv_per_tok,
   throughput,
   speed,
   prefix_cache,
   quality_decay,
   parallel_gen,
];
export const BENCHES = Object.fromEntries(all.map((b) => [b.name, b]));
