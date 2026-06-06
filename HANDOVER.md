# Handover — next steps

The capability + fleet dashboard and the readable run fingerprint are shipped on `main`
(see `README.md`). One thing is intentionally left to do: **wire measured parallel-gen
(pargen) throughput into the fleet ranking.**

Right now the fleet score's throughput term is **off** (`w_thru = 0` in
`shared/scoring.mjs` → `DEFAULT_DIALS.fleet`) because **no model has `speed_pargen` data**
yet — so the fleet ranks on capability + context + slots only.

## Do this

1. **Run pargen for every model** (the missing fleet input). Use the current checkpoint
   (newest dir under `results/runs/`, currently `rose-rx7900xt-vulkan-20260606-173048`) as
   the seed:
   ```bash
   node runners/parallel-gen.mjs --input <checkpoint-run-id>
   ```
2. **Fold it into the checkpoint:**
   ```bash
   npm run consolidate
   ```
3. **Give pargen weight in the fleet ranking** — raise `w_thru` from `0` (try `0.5`–`1.0`)
   in `DEFAULT_DIALS.fleet` (`shared/scoring.mjs`). The fleet formula is
   `capability^w_cap × ctx_norm^w_ctx × slots_norm^w_slots × throughput^w_thru`.
   ⚠ Once `w_thru > 0`, any model **without** pargen drops out of the fleet ranking
   (flagged `needs pargen run`) — so finish step 1 fleet-wide first.
4. **Regenerate and check:**
   ```bash
   npm run report && npm run dashboard && npm run chart
   ```
   Open `results/dashboard.html`; you can also nudge `w_thru` live with the fleet dials to
   sanity-check before committing the new default.

Commit the new `w_thru` default + regenerated `results/` and push to `main`.
