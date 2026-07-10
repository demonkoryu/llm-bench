// Probe: throughput + TTFT at depth (ported from runners/throughput-ttft.mjs).
// Emits e2e-<k>k (e2e tok/s, decode tok/s, prefill tok/s) + ttft-<k>k (prompt_ms).
// Self-manages the server (loads at maxctx so the depths fit); a unique nonce per rep
// busts the KV prefix cache for a true full prefill.
import { makeFillPrompt } from '../../shared/codebase.mjs';
import { extraFlagsToString } from '../../runners/llamacpp-server.mjs';

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const DEPTHS = [2048, 8192, 32768];
const GEN = 128, REPS = 2;

export const bench = {
  name: 'throughput', kind: 'probe', thinkDependent: false, resumeBench: 'e2e-8k',
  async run({ srv, client, model, maxctx }) {
    const ctx = Math.max(maxctx, 8192);
    await srv.killAll(); await srv.waitVramClear(30000);
    await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx, extraFlags: extraFlagsToString(model.extra_flags) });
    await srv.waitHealthy(360000);
    let nonce = 0; const rows = [];
    for (const d of DEPTHS.filter((x) => x + GEN + 512 < ctx)) {
      const ttfts = [], e2es = [], decs = [], prefs = [];
      for (let r = 0; r < REPS; r++) {
        const built = makeFillPrompt(d);
        const um = built.messages[built.messages.length - 1];
        um.content = `// throughput probe ${++nonce}\n${um.content}`;
        let t;
        try { ({ timings: t } = await client.chat(built.messages, { think: null, max_tokens: GEN, temperature: 0.0, ignore_eos: true }, 900000)); } catch { continue; }
        const pn = t?.prompt_n, pm = t?.prompt_ms, gn = t?.predicted_n, gm = t?.predicted_ms;
        if (![pn, pm, gn, gm].every(Number.isFinite) || pm + gm <= 0) continue;
        ttfts.push(pm); e2es.push(((pn + gn) / (pm + gm)) * 1000); decs.push(gn / (gm / 1000)); prefs.push(pn / (pm / 1000));
      }
      const k = Math.round(d / 1024);
      if (e2es.length) rows.push({ bench: `e2e-${k}k`, score: median(e2es), tok_s: median(decs), prefill_tps: median(prefs), status: 'ok' });
      if (ttfts.length) rows.push({ bench: `ttft-${k}k`, score: median(ttfts), status: 'ok' });
    }
    return rows;
  },
};
