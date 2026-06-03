/**
 * Think-mode utilities for llama.cpp models.
 *
 * Covers the two mechanisms llama.cpp uses for reasoning/thinking:
 *
 *  1. Tag-based: model outputs <think>...</think> inline in content (Qwen3, DeepSeek-R1).
 *     Controlled per-request via chat_template_kwargs.enable_thinking.
 *
 *  2. Split-field: model puts reasoning in `reasoning_content` and leaves `content`
 *     empty or null (LFM2.5 and other always-reasoning models). The openai SDK strips
 *     non-standard response fields, so we must intercept and merge before SDK parsing
 *     (see client.mjs customFetch).
 *
 * Capability classes:
 *   non_thinking   — no thinking mode at all (Gemma4, older Qwen2.5, phi, granite, llama)
 *   hybrid         — supports both think=true and think=false (Qwen3, Qwen3.6, 14B)
 *   thinking       — always outputs think tags, think toggle a no-op (DeepSeek-R1 distill)
 *   reasoning_only — always reasons, reasoning in `reasoning_content` field (LFM2.5)
 */

export const CAPABILITY = {
   NON_THINKING:   'non_thinking',
   HYBRID:         'hybrid',
   THINKING:       'thinking',
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
      case 'optional':   return CAPABILITY.HYBRID;
      case 'required':   return CAPABILITY.THINKING;
      case 'reasoning':  return CAPABILITY.REASONING_ONLY;
      default:           return CAPABILITY.NON_THINKING;
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
      case CAPABILITY.HYBRID:         return [false, true];
      case CAPABILITY.THINKING:       return [true];
      case CAPABILITY.REASONING_ONLY: return [null];
      default:                        return [null];   // non_thinking
   }
}

/**
 * Build the chat_template_kwargs to inject into the request body.
 * Returns null if think state is null (don't send the field at all).
 */
export function thinkKwargs(thinkState) {
   if (thinkState === null) return null;
   return { enable_thinking: thinkState };
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
   if (think === null) return { messages, extraBody: {} };

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

/**
 * Merge reasoning_content into content for models that split them.
 * Mutates the parsed response object in place; returns it.
 * Used by customFetch in client.mjs.
 */
export function mergeReasoningContent(data) {
   if (!data?.choices) return data;
   for (const choice of data.choices) {
      const msg = choice.message;
      if (msg && (msg.content === '' || msg.content == null) && msg.reasoning_content) {
         msg.content = `<think>${msg.reasoning_content}</think>`;
      }
   }
   return data;
}
