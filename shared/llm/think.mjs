/**
 * Think-mode utilities for llama.cpp models.
 *
 * Capability classes:
 *   non_thinking   — no thinking mode (Qwen3-2507, Qwen3-Coder)
 *   hybrid         — supports both think=true and think=false (Qwen3, Qwen3.6, Gemma4, Nemotron)
 *   thinking       — always outputs think tags, no toggle (DeepSeek-R1 distill)
 *   reasoning_only — always reasons, no toggle (LFM2.5)
 *
 * Think toggle mechanisms (see applyThinkControl):
 *   enable_thinking     — chat_template_kwargs.enable_thinking=true/false (Qwen3, Gemma4)
 *   enable_thinking_top — TOP-LEVEL enable_thinking=true/false (NInfer)
 *   system_keyword      — /think or /no_think prepended to system message (Nemotron)
 *
 * Reasoning traces are extracted server-side via --reasoning-format auto.
 * The server delivers clean `content`; no client-side stripping is needed, though
 * stripThink() in repair.mjs is kept as a defensive no-op.
 */

export const CAPABILITY = {
   NON_THINKING: 'non_thinking',
   HYBRID: 'hybrid',
   THINKING: 'thinking',
   REASONING_ONLY: 'reasoning_only',
};

/**
 * Return the capability class for a model config entry.
 * Looks at model.think field from models.yaml:
 *   none      → non_thinking
 *   optional  → hybrid
 *   required  → thinking
 *   reasoning → reasoning_only  (new value for LFM2.5)
 */
export function capabilityClass(model) {
   switch (model.think) {
      case 'optional':
         return CAPABILITY.HYBRID;
      case 'required':
         return CAPABILITY.THINKING;
      case 'reasoning':
         return CAPABILITY.REASONING_ONLY;
      default:
         return CAPABILITY.NON_THINKING;
   }
}

/**
 * Given a capability class, return the think-toggle states to run.
 *   non_thinking   → [null]          (never send enable_thinking)
 *   hybrid         → [false, true]   (run both)
 *   thinking       → [true]          (always on; false would be a no-op)
 *   reasoning_only → [null]          (server-controlled; can't toggle)
 *
 * THE single implementation — bench-run.mjs used to carry a second, divergent one
 * (thinkStatesFor) that mapped think:'reasoning' to [true] instead of [null]. Both were
 * half-right and the split is why: a state here is what gets SENT to applyThinkControl, and
 * an always-reasoning model has no toggle to set, so [null] (send nothing) is correct. What
 * the old [true] was really encoding is how the row should be LABELLED — the model does
 * reason, so 'no_think' would be a lie. That is now thinkModeFor()'s job, not this one's.
 * Sending vs labelling are two questions; keep them two functions.
 *
 * Verified empirically before the merge (rose, 2026-08-26, Muse-Glimmer-30B UD-Q5_K_XL): the
 * ATEM template renders a BYTE-IDENTICAL prompt via /apply-template with enable_thinking
 * absent, true, and false. So dropping the bogus toggle changed no stored measurement — the
 * pre-existing 'think' rows were taken with a provable no-op and stay valid.
 *
 * thinking → [true] is deliberately left alone. No models.yaml entry uses think:'required'
 * today, so the class is unexercised, and its label is 'think' under thinkModeFor() either
 * way; redefining an untested class was not part of this fix.
 */
export function thinkStates(cap) {
   switch (cap) {
      case CAPABILITY.HYBRID:
         return [false, true];
      case CAPABILITY.THINKING:
         return [true];
      case CAPABILITY.REASONING_ONLY:
         return [null];
      default:
         return [null]; // non_thinking
   }
}

/**
 * The `think_mode` dimension value for a measurement row: does this request actually reason?
 *
 * Derived from reasons(), NOT from `think === true`, because the two diverge exactly where the
 * old code was wrong. An always-reasoning model is sent think === null (no toggle exists), and
 * labelling that 'no_think' would record the opposite of what the model did — poisoning every
 * think-vs-no-think comparison downstream for the one class where the distinction is fixed.
 *
 * think_mode is part of both bench-run's RESUME_KEY and pg-store's IDENTITY_KEY, so this
 * function decides row identity. Changing what it returns re-partitions stored history: rows
 * under the old label stop being superseded by rows under the new one and both survive $LATEST
 * forever. So the swap was checked against the live DB first, not assumed safe.
 *
 * Exactly one label moves versus the old `think === true ? …` rule: a reasoning_only model under
 * --think no_think, 'no_think' → 'think'. That is the lie being corrected (the model reasons no
 * matter what the flag says), and it is unreachable for stored data — the two think:'reasoning'
 * entries have 0 rows labelled 'no_think' between them (checked 2026-08-26; they carry only 'think'
 * and 'n/a'). Default runs and --think think are label-identical for every class. Net orphans: 0.
 */
export function thinkModeFor(model, think) {
   return reasons(model, think) ? 'think' : 'no_think';
}

/**
 * True when the model will actually emit a reasoning trace for this request.
 *
 * Benches size their token budget as `think === true ? big : small`, which is WRONG for a
 * reasoning_only model on a `thinkDependent: false` bench — think is null there, so the model reasons
 * on a non-reasoning budget. Mechanism as traced on 2026-08-26 (and NOT what an even earlier version
 * of this comment claimed): bench-run.mjs picked think states two different ways. thinkDependent:true
 * went through its own thinkStatesFor(), which mapped think:'reasoning' to [true], so those benches
 * saw think===true and already took the big branch; thinkDependent:false hardcoded
 * `[m.think === 'optional' ? false : null]`, ignoring capability class, so the SAME always-reasoning
 * model arrived as think===null in the same run and silently got the small budget.
 *
 * Both of those paths are gone (thinkStates + soleThinkStateFor now), and think is null for a
 * reasoning_only model on BOTH kinds of bench — which is precisely why the budget question has to be
 * asked through this function rather than off the raw toggle.
 *
 * That is what scored Muse-Glimmer-30B at 41.67% on struct_output (2026-08-26) — the one bench that
 * is both thinkDependent:false and budget-on-think. With max_tokens 256 the model spent the whole
 * budget inside the reasoning trace and returned EMPTY content on 7 of 12 tasks: finish_reason=length,
 * not one malformed JSON. At 4096 the same 12 tasks score 100%.
 *
 * Use this instead of `think === true` wherever a budget or timeout is being sized. It cannot make
 * things worse: it only ever turns a null into true for a model that does reason, so hybrid and
 * non_thinking models are bit-identical either way.
 *
 * The divergence this uncovered — thinkStatesFor() in bench-run.mjs vs thinkStates() here, [true] vs
 * [null] for think:'reasoning' — was fixed on 2026-08-26: bench-run lost its copy, thinkStates() is
 * now the only one, and thinkModeFor() took over the labelling half that the [true] was standing in
 * for. See those two docblocks for why the split matters.
 *
 * @param {object}       model  models.yaml entry (needs .think)
 * @param {boolean|null} think  the resolved think state for this request
 */
export function reasons(model, think) {
   if (think === true) {
      return true;
   }
   if (think === false) {
      return false;
   }
   const cap = capabilityClass(model ?? {});
   return cap === CAPABILITY.REASONING_ONLY || cap === CAPABILITY.THINKING;
}

/**
 * Apply the model's think-control mechanism to produce a final messages array
 * and extra request body fields.
 *
 * Different model families use different mechanisms to toggle thinking:
 *
 *   'enable_thinking' (default)
 *     Qwen3, Qwen3.6, Gemma4 (E4B + 26B-A4B).
 *     Sends: chat_template_kwargs.enable_thinking = true|false
 *     The model's Jinja template reads this kwarg to wrap/suppress the think block.
 *
 *   'enable_thinking_top'
 *     NInfer (engine: ninfer). Same Qwen switch, different envelope: NInfer takes
 *     `enable_thinking` as a TOP-LEVEL request field and hard-rejects the nested spelling —
 *     `chat_template_kwargs` there accepts only `preserve_thinking`, and any other non-null key
 *     returns HTTP 400 `chat_template_option_not_supported` (src/serve/openai_schema.cpp). So the
 *     default mechanism above is not merely ignored on that engine, it fails the request outright,
 *     which is why this is its own mode rather than a tolerated variation.
 *     NInfer's documented alternative, `reasoning_effort: "none"`, is deliberately NOT used:
 *     it toggles the same new-turn switch, and sending both risks HTTP 400
 *     `conflicting_template_option`. One mechanism, matching the llama.cpp rows' semantics.
 *
 *   'system_keyword'
 *     Nemotron Nano v2 (and possibly future models without Jinja kwarg support).
 *     Prepends /think or /no_think to the system message (or inserts a system
 *     message if none is present). No chat_template_kwargs sent.
 *
 * @param {Array}        messages   original message array (not mutated)
 * @param {boolean|null} think      true = think, false = no_think, null = omit toggle
 * @param {string}       control    'enable_thinking' | 'enable_thinking_top' | 'system_keyword'
 *                                   (default: 'enable_thinking')
 * @returns {{ messages: Array, extraBody: object }}
 */
export function applyThinkControl(messages, think, control = 'enable_thinking') {
   if (think === null) {
      return { messages, extraBody: {} };
   }

   if (control === 'enable_thinking_top') {
      return { messages, extraBody: { enable_thinking: think } };
   }

   if (control === 'system_keyword') {
      const keyword = think ? '/think' : '/no_think';
      const msgs = [...messages];
      const sysIdx = msgs.findIndex((m) => m.role === 'system');
      if (sysIdx >= 0) {
         // Prepend to existing system message
         msgs[sysIdx] = { ...msgs[sysIdx], content: `${keyword}\n${msgs[sysIdx].content}` };
      } else {
         // Insert a minimal system message at the front
         msgs.unshift({ role: 'system', content: keyword });
      }
      return { messages: msgs, extraBody: {} };
   }

   // default: 'enable_thinking' — chat_template_kwargs
   return {
      messages,
      extraBody: { chat_template_kwargs: { enable_thinking: think } },
   };
}
