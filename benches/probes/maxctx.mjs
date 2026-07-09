// Probe: max context ceiling (ladder). Skips the ladder on a caps-cache HIT for this
// exact (gguf,quant,kv,backend,gpu,llamacpp_build); on a MISS runs the reused ladder
// (srv.startForModel) and populates the cache. Emits the maxctx row.
export const bench = {
  name: 'maxctx', kind: 'probe', thinkDependent: false,
  async run({ srv, model, caps, upsertCap }) {
    if (caps?.coherence_ceiling) {
      // cache hit under the current build → no re-probe
      return [{ bench: 'maxctx', score: caps.coherence_ceiling, ctx_loaded: caps.ctx_ceiling, oom_ceiling: caps.oom_ceiling, coherence_ceiling: caps.coherence_ceiling, vram_mib: caps.vram_at_ctx, status: 'ok' }];
    }
    // miss → run the reused ladder (multiple loads + coherence checks)
    const { ctxLoaded, oomCeiling, coherenceCeiling, vramMib } = await srv.startForModel(model);
    upsertCap?.({ ctx_ceiling: ctxLoaded, oom_ceiling: oomCeiling, coherence_ceiling: coherenceCeiling, vram_at_ctx: vramMib, native_max_ctx: model.native_max_ctx ?? null });
    return [{ bench: 'maxctx', score: coherenceCeiling ?? ctxLoaded, ctx_loaded: ctxLoaded, oom_ceiling: oomCeiling, coherence_ceiling: coherenceCeiling, vram_mib: vramMib, status: 'ok' }];
  },
};
