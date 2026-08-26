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
 * True when the model will actually emit a reasoning trace for this request.
 *
 * Benches size their token budget as `think === true ? big : small`, which is WRONG for a
 * reasoning_only model: thinkStates() returns [null] for BOTH non_thinking and reasoning_only, so
 * `think === null` cannot distinguish "never reasons" from "always reasons" and the always-reasoning
 * model silently gets the non-thinking budget. That is what scored Muse-Glimmer-30B at 41.67% on
 * struct_output (2026-08-26): with max_tokens 256 the model spent the whole budget inside the
 * reasoning trace and returned EMPTY content on 7 of 12 tasks -- finish_reason=length, not one
 * malformed JSON. At 4096 the same 12 tasks score 100%.
 *
 * Use this instead of `think === true` wherever a budget or timeout is being sized. Behaviour is
 * unchanged for hybrid (think is true/false), thinking (always true) and non_thinking (always null)
 * models -- only reasoning_only models are affected.
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
