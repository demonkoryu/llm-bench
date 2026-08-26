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

## The retired-hardware artifacts (deleted from the tree, not archived here)

Deleted 2026-08-26 when the fleet went V100-only. Unlike the row dumps above, these were
git-tracked files, so `git log --diff-filter=D -- <path>` recovers them and copying them into
this directory would only duplicate history.

| removed | what it was |
|---|---|
| `results/tidy/host=rose/backend=vulkan/` | 16 parquet parts, the entire tidy export — every part was Vulkan |
| `results/runs/*rx7900xt-vulkan-*/` | 34 run manifests from the RX 7900 XT |
| 13 entries in `results/caps/capabilities.json` | `\|vulkan\|RX 7900 XT` context caps; 2 `\|cuda\|V100` entries remain |
| `results/froggeric-template-ab.md`, `results/froggeric-ab-dashboard.html`, `results/ab-froggeric-manifest.tsv`, `ab-compare.mjs` | round 1 of the froggeric chat-template A/B — an end-to-end capability comparison generated on the RX 7900 XT, plus the script whose only input was that manifest |
| `results/froggeric-template-ab-m1-optiq.md` | the M1/OptiQ arm of the same A/B |

Round 2 of the template A/B (`results/froggeric-template-claims.md`, `results/template-claims.json`,
`runners/template-claims.mjs`) is **kept**: it tests the template's claims by *rendering*
(`/apply-template` + `/tokenize`) rather than generating, so its results were byte-identical across
all four models and carry no hardware dependence. It also supersedes round 1's verdict, which is
why removing round 1 costs no conclusion. `results/optiq-schema-outlines.md` is likewise kept
despite the name — `shared/triage-prompt.mjs` cites it as the reason the triage schema encodes
nullables as `anyOf[{enum},{null}]`, and that encoding is still live on CUDA.

Config side: the four `engine: optiq` model entries are `disabled: true` rather than deleted, and
the `m1` host block is annotated PARKED. `--target m1` now matches no model and exits 1. The
entries carry a lot of measured provenance (bpw figures, the mlx_vlm text-only finding, the
prefix-cache-nil caveat) that would be expensive to reconstruct if Apple silicon ever returns.
