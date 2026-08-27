// Probe: VRAM cost per token of context. Loads at two ctx sizes and reads board VRAM at each; the
// slope (ΔVRAM / Δctx) is the per-context-token footprint. Emits vram_per_ctx_tok (KiB/token) and
// updates the capabilities cache.
//
// NAMED FOR WHAT IT MEASURES (renamed from kv_per_tok 2026-08-27). The slope is NOT the KV cache: it
// is every allocation that grows with context, which for the MTP entries includes the speculative
// draft model's own cache. agent_ctx already said so — "kv_per_tok (which keeps MTP) reported an
// MTP-inclusive KiB/tok" — and put the draft context at ~4794 MiB for a 65536 pool, but the metric
// kept a name that invited reading it as cache size.
//
// Measured on Qwen3.8-27B Q6_K (rose, 2026-08-27): the slope is 88.96 KiB/tok at KV q8_0 and 80.46
// at k8v4 (K q8_0 / V q4_0) — an 8.5 KiB/tok difference, confirmed independently as a flat 512 MiB
// at a fixed ctx=65536. q8_0 is ~8.5 bits/element and q4_0 ~4.5, so halving V's precision cuts V's
// own footprint ~47%; against the slope that reads as only ~9%, against the cache it is ~24%. Do not
// compare this number against a bits-per-weight calculation: the denominators are different things.
import { extraFlagsToString, LOAD_TIMEOUT_MS } from '../../runners/llamacpp-server.mjs';

const C_LOW = 8192;

export const bench = {
   name: 'vram_per_ctx_tok',
   kind: 'probe',
   thinkDependent: false,
   async run({ srv, model, maxctx, upsertCap }) {
      // KV footprint is derived from board VRAM deltas (rocm-smi). Apple Silicon has unified
      // memory with no VRAM readout — skip cleanly on non-llamacpp engines.
      if ((model.engine ?? 'llamacpp') !== 'llamacpp') {
         return [];
      }
      const cHigh = maxctx;
      if (!cHigh || cHigh <= C_LOW) {
         return [];
      }
      const vramAtCtx = async (ctx) => {
         await srv.killAll();
         await srv.waitVramClear(30000);
         await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx, extraFlags: extraFlagsToString(model.extra_flags) });
         await srv.waitHealthy(LOAD_TIMEOUT_MS);
         return srv.snapshotVram();
      };
      const vLow = await vramAtCtx(C_LOW);
      const vHigh = await vramAtCtx(cHigh);
      if (vLow == null || vHigh == null) {
         return [];
      }
      const kvKiB = ((vHigh - vLow) / (cHigh - C_LOW)) * 1024;
      if (kvKiB <= 0) {
         return [];
      }
      upsertCap?.({ vram_bytes_per_ctx_tok: kvKiB * 1024, vram_at_ctx: vHigh });
      return [{ bench: 'vram_per_ctx_tok', score: kvKiB, vram_mib: vHigh, ctx_loaded: cHigh, status: 'ok' }];
   },
};
