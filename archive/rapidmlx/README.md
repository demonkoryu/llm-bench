# Archived: RapidMLX runner (retired 2026-07-22)

The M1 Mac (llm1) inference engine was switched from **RapidMLX** to **OptiQ** (`mlx-optiq`)
on 2026-07-22. These files are kept for reference only — they are **not** imported or executed
by the live harness.

- `rapidmlx-server.mjs` — the former `runners/rapidmlx-server.mjs` model-server manager
  (`engine: rapidmlx`). Relative imports (`../shared/...`) are **not** adjusted for this new
  location; restore the file to `runners/` before reusing it.
- `serve.sh` — the former `scripts/llm1/serve.sh` RapidMLX launcher
  (`rapid-mlx serve … --kv-cache-dtype int4 --pflash off --max-num-seqs 1`, port 8000).

## Why OptiQ replaced it
- **Auth/id robustness**: OptiQ serves single-model by default (request `model` is a label),
  eliminating the served-id case-mismatch bug class that hit the RapidMLX depth probes.
- **No cloud fallback**: OptiQ generates every token locally (RapidMLX had `--cloud-threshold`).
- The live replacement is `runners/optiq-server.mjs` + `scripts/llm1/serve.sh` (OptiQ),
  `engine: optiq` / `backend: optiq` in `config/hosts.yaml` and `config/models.yaml`.

## To restore RapidMLX
1. `git mv archive/rapidmlx/rapidmlx-server.mjs runners/rapidmlx-server.mjs`
2. `git mv archive/rapidmlx/serve.sh scripts/llm1/serve.sh`
3. Re-point `runners/bench-run.mjs`, `benches/probes/agent_ctx.mjs`, and the two config files
   back to `engine: rapidmlx` (full history in git).
