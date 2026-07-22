// Probe: llama.cpp NATIVE auto-fit context ceiling (fit-ctx.sh → llama-fit-params).
//
// A fast, memory-fit-only estimate of the largest context that fits VRAM — computed
// analytically by llama.cpp with the model's real serving flags (KV quant, batch, -fa,
// full GPU offload) and NO explicit `-c`. Unlike agent_ctx there is NO coherence or
// concurrency check, so this is an upper "will it allocate" bound: a different, cheaper
// lens on max context, meant to be compared against agent_ctx's verified shared-pool total.
//
// Self-manages the GPU (fit-ctx.sh kills any running server + waits for VRAM to clear)
// and leaves none running — best placed alongside the agent_ctx probe.
export const bench = {
   name: 'fit_ctx',
   kind: 'probe',
   thinkDependent: false,
   // fit-ctx.sh kills any running server, clears VRAM, and computes the fit itself,
   // so bench-run must NOT pre-start a full model server for it (that pre-start is
   // slow and hangs past the health timeout on cold non-QAT models).
   selfManagesServer: true,
   async run({ srv, model }) {
      // llama-fit-params is a llama.cpp-only binary — there is no analytic fit tool on MLX.
      // Skip cleanly (no row) on non-llamacpp engines rather than emitting a spurious error row.
      if ((model.engine ?? 'llamacpp') !== 'llamacpp') {
         return [];
      }
      const r = await srv.probeFitCtx(model);
      if (r?.fitCtx == null) {
         return [{ bench: 'fit_ctx', status: 'error' }];
      }
      return [{ bench: 'fit_ctx', score: r.fitCtx, status: 'ok' }];
   },
};
