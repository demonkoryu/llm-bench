// Probe: quality retention at depth (ported from runners/quality-decay.mjs). Plants a
// needle (unique-const retrieval) at increasing context depths and grades the integer
// answer; retention = acc@depth ÷ acc@0 isolates the context effect. Emits
// quality_decay-<k>k (accuracy %) and ttft-<k>k (prompt_ms) per depth.
import { makeFillPrompt } from '../../shared/codebase.mjs';
import { extraFlagsToString } from '../../runners/llamacpp-server.mjs';

const DEPTHS = [16384, 32768, 65536];
const REPS = 3;
const asInt = (s) => { const m = String(s).replace(/<think>[\s\S]*?<\/think>/g, '').match(/-?\d+/); return m ? m[0] : null; };

export const bench = {
  name: 'quality_decay', kind: 'probe', thinkDependent: false,
  async run({ srv, client, model, maxctx }) {
    const ctx = Math.max(maxctx, 16384);
    await srv.killAll(); await srv.waitVramClear(30000);
    await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx, extraFlags: extraFlagsToString(model.extra_flags) });
    await srv.waitHealthy(360000);
    const depths = [0, ...DEPTHS.filter((d) => d + 512 < ctx)];
    const rows = [];
    for (const d of depths) {
      let correct = 0, n = 0; const ttfts = [];
      for (let r = 0; r < REPS; r++) {
        const built = makeFillPrompt(Math.max(d, 256));
        let res;
        try { res = await client.chat(built.messages, { think: null, max_tokens: 32, temperature: 0.0 }, 900000); }
        catch { continue; }
        if (res.timings?.prompt_ms) ttfts.push(res.timings.prompt_ms);
        n++;
        const content = res.completion?.choices?.[0]?.message?.content ?? '';
        if (asInt(content) === String(built.expectedAnswer)) correct++;
      }
      const k = Math.round(d / 1024);
      if (n) rows.push({ bench: `quality_decay-${k}k`, score: (correct / n) * 100, status: 'ok' });
      if (ttfts.length) rows.push({ bench: `ttft-${k}k`, score: ttfts.sort((a, b) => a - b)[Math.floor(ttfts.length / 2)], status: 'ok' });
    }
    return rows;
  },
};
