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
 *   enable_thinking — chat_template_kwargs.enable_thinking=true/false (Qwen3, Gemma4)
 *   system_keyword  — /think or /no_think prepended to system message (Nemotron)
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
 *   'system_keyword'
 *     Nemotron Nano v2 (and possibly future models without Jinja kwarg support).
 *     Prepends /think or /no_think to the system message (or inserts a system
 *     message if none is present). No chat_template_kwargs sent.
 *
 * @param {Array}        messages   original message array (not mutated)
 * @param {boolean|null} think      true = think, false = no_think, null = omit toggle
 * @param {string}       control    'enable_thinking' | 'system_keyword' (default: 'enable_thinking')
 * @returns {{ messages: Array, extraBody: object }}
 */
export function applyThinkControl(messages, think, control = 'enable_thinking') {
   if (think === null) {
      return { messages, extraBody: {} };
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
