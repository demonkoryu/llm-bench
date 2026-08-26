// Probe: quality retention at depth (ported from runners/quality-decay.mjs). Plants a
// needle (unique-const retrieval) at increasing context depths and grades the integer
// answer; retention = acc@depth ÷ acc@0 isolates the context effect. Emits
// quality_decay-<k>k (accuracy %) per depth.
//
// It used to also emit ttft-<k>k from prompt_ms, which collided with the throughput probe's
// ttft-<k>k — identical bench name and dimensions, so the store could not tell them apart and
// $LATEST resolved the pair by timestamp. The two also disagreed on meaning: throughput's was a
// cold full prefill, this one's was accidentally WARM, because makeFillPrompt() is deterministic
// and REPS=3 reused one prompt, so reps 2-3 hit the prefix cache and the median of
// [cold, warm, warm] landed on a warm value. Timing is a by-product here, not the thing being
// measured, and this probe has no business owning a latency metric — throughput.mjs measures TTFT
// warm and deliberately now. Existing ttft-0k/16k/64k rows in the store came from here; they were
// warm, so they do not contradict the new definition, but nothing refreshes them any more.

import { extraFlagsToString, LOAD_TIMEOUT_MS } from '../../runners/llamacpp-server.mjs';
import { makeFillPrompt } from '../../shared/codebase.mjs';

const DEPTHS = [16384, 32768, 65536];
const REPS = 3;
// The needle constant name contains digits (e.g. FLOW_RETRY_LIMIT_4), so grabbing the
// FIRST integer mis-grades "…LIMIT_4 is 88" as "4". Match the expected answer among ALL
// integers in the (think-stripped) response instead.
const answersWith = (s, expected) =>
   (
      String(s)
         .replace(/<think>[\s\S]*?<\/think>/g, '')
         .match(/-?\d+/g) || []
   ).includes(String(expected));

export const bench = {
   name: 'quality_decay',
   kind: 'probe',
   thinkDependent: false,
   resumeBench: 'quality_decay-64k',
   async run({ srv, client, model, maxctx }) {
      const ctx = Math.max(maxctx, 16384);
      await srv.killAll();
      await srv.waitVramClear(30000);
      await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx, extraFlags: extraFlagsToString(model.extra_flags) });
      await srv.waitHealthy(LOAD_TIMEOUT_MS);
      const depths = [0, ...DEPTHS.filter((d) => d + 512 < ctx)];
      // Whichever think mechanism the model declares. Hardcoding `enable_thinking` here made this
      // probe silently unmeasurable on any engine that rejects it: ninfer 400s that field, every
      // request threw into the catch below, and the probe returned zero rows without a word.
      const thinkControl = model.think_control ?? 'enable_thinking';
      const rows = [];
      let lastErr = null;
      for (const d of depths) {
         let correct = 0,
            n = 0;
         for (let r = 0; r < REPS; r++) {
            const built = makeFillPrompt(Math.max(d, 256));
            let res;
            // Needle retrieval, not reasoning → ask for thinking off so the answer lands in
            // `content` directly rather than after a reasoning trace. This is a request, not a
            // guarantee: a model with no toggle (think:'reasoning' / 'required') reasons anyway, and
            // applyThinkControl on such a model is a proven no-op. answersWith() below therefore
            // grades content AND reasoning_content together, so an answer reached inside a trace
            // still scores.
            //
            // max_tokens is 8192 rather than a snug budget because a snug one does not measure
            // retention, it measures trace length. Established on Muse-Glimmer-30B (rose,
            // 2026-08-26) under the previous budget of 64: Muse opens its trace by echoing the
            // prompt, so whether the value fits depended on how long the echoed preamble happened
            // to be at that depth — at 16k the trace reached only "FLOW" and scored 0/3 (two
            // independent runs), while at 32k the shorter echo reached "FLOW_RETRY_LIMIT_4 = 88"
            // and scored 100. Given room it answered correctly at both. A too-small budget thus
            // produces a 0 that reads as "lost the needle" and a curve that is non-monotonic in
            // depth, and it cannot be keyed off reasons(model, false), which is false by
            // construction and so blind to the case. 8192 is deliberately generous: the answer is
            // one integer, so the budget exists only to let a trace finish, and overshooting costs
            // nothing beyond time on the models that actually need it.
            //
            // Widening this made every quality_decay row measured under max_tokens 64 incomparable
            // with rows measured after it. Those rows are gone: the store was reset to V100-only
            // measurements on 2026-08-26 and the family re-measured under this budget.
            try {
               res = await client.chat(built.messages, { think: false, thinkControl, max_tokens: 8192, temperature: 0.0 }, 900000);
            } catch (e) {
               lastErr = e;
               continue;
            }
            n++;
            const msg = res.completion?.choices?.[0]?.message ?? {};
            if (answersWith(`${msg.content ?? ''} ${msg.reasoning_content ?? ''}`, built.expectedAnswer)) {
               correct++;
            }
         }
         const k = Math.round(d / 1024);
         if (n) {
            rows.push({ bench: `quality_decay-${k}k`, score: (correct / n) * 100, status: 'ok', lane_ctx: ctx });
         }
      }
      // Zero rows is indistinguishable from "measured nothing" downstream, so say why rather than
      // returning an empty array and letting the run look complete.
      if (!rows.length) {
         console.warn(`  [quality_decay] no depth produced a measurement — every request failed: ${lastErr?.message ?? 'unknown error'}`);
      }
      return rows;
   },
};
