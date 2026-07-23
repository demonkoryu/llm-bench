# Triage schema: `null`-in-`enum` breaks Outlines (mlx_lm) — use `anyOf`

## Symptom

On `Qwen3.6-27B-OptiQ-4bit` (mlx_lm/OptiQ on the M1), the **triage** bench produced
`json_fail = 18/18` — every item's JSON was truncated and unparseable, so all rubric
ratios (`triage_R1..R7`, `triage_C1/C2`) came out 0. The same `TRIAGE_SCHEMA` grades
fine on the llama.cpp fleet. reasoning (a trivial `{answer:string}` schema) passed 11/12
and struct_output (prompt-only, no schema) scored 100 — so it was not a general JSON
weakness, and not the model.

## Root cause

mlx_lm enforces `response_format` by masking logits through the **Outlines** library:
it compiles the JSON Schema into a finite-state machine and only allows schema-valid
tokens. Outlines mis-compiles one specific construct — **`null` listed as a member of an
`enum` array** (`enum: ['craft', ..., null]`). For that construct the generated grammar
permits the end-of-sequence token *immediately after the property key*, so generation
stops after ~6–7 tokens with truncated JSON (`{ "target_area`), `finish_reason=stop`
(not `length`).

llama.cpp does not hit this because it uses a different constraint engine — its own
`json-schema-to-grammar` (GBNF) converter — which compiles `enum:[...,null]` to a correct
alternation. Same schema, different backend, so the Outlines bug never bites. This is a
widely-reported failure class for union/`null`/`enum` combinations across structured-output
stacks (e.g. LM Studio bug tracker #103, "union types always generate as null unless enum
is provided").

## Isolation (live daemon, construct-by-construct)

| Construct | Result |
|---|---|
| two plain string fields | ✓ valid |
| `enum` (no null) | ✓ valid |
| **`enum` WITH `null` member** | ✗ truncates at key |
| bare union `type:['string','null']` | ✓ valid |
| **union + `enum`-with-null** | ✗ truncates at key |
| `anyOf:[string, null]` | ✓ valid |
| `anyOf:[object, null]` | ✓ valid |
| **nested field with null-enum** | ✗ truncates at key |

`null`-in-`enum` is the *only* construct that fails, every time. `nullable:true` (an
OpenAPI-ism, not standard JSON Schema) is harmless but was also removed for correctness.

## Fix

Move `null` out of the `enum` and into an `anyOf` branch. Semantically identical (same
allowed values), compiles on both Outlines and llama.cpp:

```js
// before
target_area: { type: 'string', enum: ['craft','finance','music','work', null], nullable: true }
// after
target_area: { anyOf: [ { type: 'string', enum: ['craft','finance','music','work'] }, { type: 'null' } ] }
```

Applied to `suggested_type` and `target_area`; `target_anchor` went `nullable:true` →
`type:['string','null']`; `propose_new_anchor` (`anyOf:[object,null]`) was already fine.

Validated live: the full rewritten schema returned complete valid JSON — `finish=stop`,
183 tokens, all 9 required keys, enum constraint intact.

## Upstream

`TRIAGE_SCHEMA` is copied from production `wispTools.ts` (separate wisp repo). The
`null`-in-`enum` is a latent portability bug there too — wisp would break on any
Outlines/mlx-backed serving. The same `anyOf` encoding should be adopted upstream.
