# Run manifest — proposal (not implemented)

Status: **proposal**, 2026-08-15. Nothing here is built yet; this is the design to approve or amend.

## Problem

The invocation itself is stored nowhere. `results/runs/<run_id>/run.json` is written **only on clean
completion**, on the machine that drove the run, and it records lifecycle facts rather than intent — so the
one case it would be useful for (a run that died) is exactly the case where it does not exist.

Consequences today:

- "What is still outstanding?" can only be *inferred* by re-deriving the intended matrix from the current
  `config/models.yaml` and diffing against `measurements`. If `models.yaml` changed since, the inference is
  wrong and nobody can tell.
- The flags that produced a set of rows are unrecoverable. `--ctx`, `--samples`, `--think` are partly
  reconstructable from the dims; `--benches`, `--models`, `--chat-template` are not.
- The harness version that produced a row is unrecorded, so a behavioural change in a grader is
  indistinguishable from a change in the model.

## Shape

One row per invocation, keyed on the **existing** `run_id` (already on every measurement row, so the join
needs no migration).

```sql
CREATE TABLE IF NOT EXISTS runs (
   run_id         TEXT PRIMARY KEY,
   run_kind       TEXT,        -- 'benchrun'
   -- invocation, as given
   argv           TEXT,        -- process.argv.slice(2), verbatim — what was actually typed
   flags          JSONB,       -- parsed + defaulted flag values, so `--resume` implicit-true is visible
   planned        JSONB,       -- [{model, gguf_file, bench, think_mode}] — the matrix this run intended
   -- provenance
   harness_sha    TEXT,        -- git rev-parse HEAD of the llm-bench checkout
   harness_dirty  BOOLEAN,     -- `git status --porcelain` non-empty at start
   models_hash    TEXT,        -- sha256 of config/models.yaml as read
   hosts_hash     TEXT,        -- sha256 of config/hosts.yaml as read
   seed           BIGINT,      -- resolved OPTIQ_SEED
   -- platform (denormalised for querying without a join)
   target         TEXT,
   host           TEXT,
   gpu            TEXT,
   backend        TEXT,
   engine         TEXT,        -- 'llamacpp' | 'optiq'
   engine_version TEXT,
   -- lifecycle
   started_at     TIMESTAMP,
   ended_at       TIMESTAMP,   -- NULL while running
   exit_status    TEXT,        -- 'running' | 'complete' | 'failed' | 'interrupted'
   exit_detail    TEXT,        -- error message or signal, truncated
   rows_written   BIGINT
);
```

`exit_status` starts as `running` (inserted before the first model loads) and is updated once in the
`finally` block. A row left at `running` with an old `started_at` *is* the signal that a run was killed —
which is the state we currently cannot observe at all.

## Per-(config × bench) status: derive, don't duplicate

The brief asks the manifest to hold per-(config × bench) status. With the `status='partial'` → `'ok'`
promotion now in `measurements`, that status is already **fully determined by the measurement rows**.
Storing it a second time would create two sources of truth that can disagree after a crash. Expose it as a
view instead:

```sql
CREATE OR REPLACE VIEW run_bench_status AS
SELECT run_id, gguf_file, kv_quant, chat_template, backend, gpu, host, ctx,
       n_parallel, batch, ubatch, spec_decode, sampling_hash, think_mode, bench,
       max(n)                                                  AS samples,
       CASE WHEN bool_or(status = 'ok') THEN 'ok' ELSE 'partial' END AS status,
       min(ts) AS first_ts, max(ts) AS last_ts, count(*) AS rows
FROM measurements
GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15;
```

## Continuation

`planned` is what makes continuation possible from database state alone. Without it, "outstanding" has to be
recomputed from whatever `models.yaml` says *now*; with it, the run's own intent is frozen at start.

```
outstanding(run_id) = runs.planned
                      MINUS (SELECT ... FROM run_bench_status WHERE status='ok' AND samples >= flags.samples)
```

Proposed flag: `--continue <run_id>` — load that run's `flags` and `planned`, subtract the done set, and
re-issue only the remainder under a **new** `run_id` carrying `seed_run_id = <original>` (the column already
exists and is currently always NULL). That keeps the append-only measurement history intact while making the
lineage queryable.

## Open questions

1. `planned` duplicates information derivable from `flags` + `models_hash`. It is stored anyway because
   `models.yaml` is mutable and unversioned in the DB. Alternative: store the resolved `models.yaml` blob
   itself. Costs ~15 KB/run, removes the ambiguity entirely. **Recommendation: store the blob**, keyed by
   `models_hash` in a `config_blobs(hash, content)` side table so repeated runs share one copy.
2. Should non-`benchrun` entrypoints (`smoke.mjs`, the one-off `struct-output` / `agentic-loop` runners
   visible in `run_kind`) also write manifest rows? They already write `measurements`. Writing partial
   manifests for them is cheap and makes `runs` a complete index of the store.
3. `harness_dirty` is a weak signal on a dev machine. Consider storing `git diff --stat` output instead of a
   boolean, truncated to a few hundred characters.
