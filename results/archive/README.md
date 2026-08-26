# results/archive

Rows deleted from the `measurements` table, kept so a deletion stays auditable. Nothing here is
input to a dashboard or to `analysis/` — it is the record of what was removed and why.

## ninfer-20260825-discarded-rows.csv

185 rows from five ninfer runs on the sm_70 V100, dropped 2026-08-25.

| run_id | rows | why |
|---|---|---|
| `v100-ninfer-20260825-160511-benchrun` | 22 | DFlash at k=7 |
| `v100-ninfer-20260825-164012-benchrun` | 37 | DFlash at k=7 |
| `v100-ninfer-20260825-153123-benchrun` | 11 | pre-fix 27B |
| `v100-ninfer-20260825-153331-benchrun` | 113 | pre-fix 27B |
| `v100-ninfer-20260825-164306-benchrun` | 2 | quality_decay smoke test |

The two DFlash runs are the dangerous ones and the reason this file exists rather than nothing. They
measured the speculative verify path at 7 draft positions, and that path is only correct to 3 on this
port, so the throughput they report was produced alongside corrupt output. They carry `status=ok` on
every row and look like ordinary fast results; DFlash reports high acceptance precisely while emitting
garbage. Kept for the record, never for comparison.

The two 27B runs predate the `kv_quant` derivation and `think_control` fixes: they record an empty KV
column while actually running int8 KV, and their `quality_decay` returned zero rows without saying so.
Superseded in full by `v100-ninfer-20260825-164433-benchrun`.

## pre-v100-purge-20260825-non-v100-rows.json.gz

4,085 rows — 73% of the store — deleted 2026-08-26 when the fleet went V100-only. Every row not
measured on a V100: 3,674 on the RX 7900 XT under vulkan (the card is gone from `rose`), 362 on the
M1 under optiq, 49 on the M1 under rapidmlx. What remains is 1,506 raw / 1,138 live, all V100.

This was a deliberate clean slate, not a correctness fix — nothing here is known-wrong the way the
DFlash rows above are. It was taken because a store spanning two hardware generations cannot be read
as one fleet: `$LATEST` is latest-wins across the whole identity key, so a Vulkan row and a CUDA row
for the same model are separate live rows that a reader has to know to disambiguate by hand.

Ten model artifacts lost all coverage and will show nothing on the dashboard until re-measured on a
V100: every `qwen3.6-27b` artifact (IQ4_XS, UD-Q4_K_XL, 4bit, OptiQ-4bit), the Qwen3.8-27B OptiQ and
MLX variants, `gemma-4-31B-it-IQ4_XS`, `granite-4.0-h-tiny`, `LFM2.5-8B-A1B`, and
`Nemotron-3-Nano-4B`. The two OptiQ entries are the notable loss: they were the only cross-engine
comparison against Apple silicon, and `config/models.yaml` still declares them against host `m1`,
which is outside the V100 fleet — so they cannot come back without a policy change.

Deleted against raw `measurements`, not against `$LATEST`. Deleting only a live row promotes the
superseded row beneath it, so history has to go with it; verified afterwards at 0 identity groups
with more than one live row.
