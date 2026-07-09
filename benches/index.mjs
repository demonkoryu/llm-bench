// Bench registry. Each module reuses the validated benchmarks/*/{cases,grader} and
// exposes { name, thinkDependent, run(client, ctx) -> rawRow }. The orchestrator
// (runners/bench-run.mjs) drives them and emits tidy measurements.
//
// Extendable: summarization, docqa, coding_*, struct_output, speed/e2e/ttft follow the
// same pattern (port their run-suite/secondary driver, reuse the grader). Historical
// data for all of these is already in the store via backfill; these modules add the
// ability to (re)measure them live under new configs.
import { bench as agentic_loop } from './agentic_loop.mjs';
import { bench as instruction_following } from './instruction_following.mjs';
import { bench as reasoning } from './reasoning.mjs';
import { bench as reasoning_hard } from './reasoning_hard.mjs';
import { bench as toolcalling } from './toolcalling.mjs';

export const BENCHES = Object.fromEntries(
  [toolcalling, reasoning, reasoning_hard, agentic_loop, instruction_following].map((b) => [b.name, b]),
);
