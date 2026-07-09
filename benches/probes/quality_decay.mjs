// Probe: quality retention at depth (ported from runners/quality-decay.mjs). Plants a
// needle (unique-const retrieval) at increasing context depths and grades the integer
// answer; retention = acc@depth ÷ acc@0 isolates the context effect. Emits
// quality_decay-<k>k (accuracy %) and ttft-<k>k (prompt_ms) per depth.
import { makeFillPrompt } from '../../shared/codebase.mjs';
import { extraFlagsToString } from '../../runners/llamacpp-server.mjs';

const DEPTHS = [16384, 32768, 65536];
const REPS = 3;
// The needle constant name contains digits (e.g. FLOW_RETRY_LIMIT_4), so grabbing the
// FIRST integer mis-grades "…LIMIT_4 is 88" as "4". Match the expected answer among ALL
// integers in the (think-stripped) response instead.
const answersWith = (s, expected) => (String(s).replace(/<think>[\s\S]*?<\/think>/g, '').match(/-?\d+/g) || []).includes(String(expected));

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
        // Needle retrieval, not reasoning → disable thinking so the answer lands in
        // `content` directly (else the model reasons and truncates before answering).
        try { res = await client.chat(built.messages, { think: false, thinkControl: 'enable_thinking', max_tokens: 64, temperature: 0.0 }, 900000); }
        catch { continue; }
        if (res.timings?.prompt_ms) ttfts.push(res.timings.prompt_ms);
        n++;
        const msg = res.completion?.choices?.[0]?.message ?? {};
        if (answersWith(`${msg.content ?? ''} ${msg.reasoning_content ?? ''}`, built.expectedAnswer)) correct++;
      }
      const k = Math.round(d / 1024);
      if (n) rows.push({ bench: `quality_decay-${k}k`, score: (correct / n) * 100, status: 'ok' });
      if (ttfts.length) rows.push({ bench: `ttft-${k}k`, score: ttfts.sort((a, b) => a - b)[Math.floor(ttfts.length / 2)], status: 'ok' });
    }
    return rows;
  },
};
