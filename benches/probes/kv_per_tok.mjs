// Probe: KV-cache footprint (ported from runners/kv-probe.mjs). Loads at two ctx sizes
// and reads board VRAM at each; the slope (ΔVRAM / Δctx) is KV bytes/token. Emits
// kv_per_tok (KiB/token) and updates the capabilities cache.
import { extraFlagsToString } from '../../runners/llamacpp-server.mjs';

const C_LOW = 8192;

export const bench = {
   name: 'kv_per_tok',
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
         await srv.waitHealthy(360000);
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
      upsertCap?.({ kv_bytes_per_token: kvKiB * 1024, vram_at_ctx: vHigh });
      return [{ bench: 'kv_per_tok', score: kvKiB, vram_mib: vHigh, ctx_loaded: cHigh, status: 'ok' }];
   },
};
