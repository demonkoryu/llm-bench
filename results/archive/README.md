# results/archive

Rows deleted from the `measurements` table, kept as CSV so a deletion stays auditable. Nothing here is
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
