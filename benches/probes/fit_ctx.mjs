// Probe: llama.cpp NATIVE auto-fit context ceiling (fit-ctx.sh → llama-fit-params).
//
// A fast, memory-fit-only estimate of the largest context that fits VRAM — computed
// analytically by llama.cpp with the model's real serving flags (KV quant, batch, -fa,
// full GPU offload) and NO explicit `-c`. Unlike the maxctx ladder there is NO coherence
// check, so this is an upper "will it allocate" bound: a different lens on max context,
// meant to be compared against maxctx's validated coherence_ceiling.
//
// Self-manages the GPU (fit-ctx.sh kills any running server + waits for VRAM to clear)
// and leaves none running — best placed alongside the maxctx probe.
export const bench = {
   name: 'fit_ctx',
   kind: 'probe',
   thinkDependent: false,
   async run({ srv, model }) {
      const r = await srv.probeFitCtx(model);
      if (r?.fitCtx == null) {
         return [{ bench: 'fit_ctx', status: 'error' }];
      }
      return [{ bench: 'fit_ctx', score: r.fitCtx, status: 'ok' }];
   },
};
