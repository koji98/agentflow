# Run Artifact Reference

Use this to navigate a run quickly.

## Run root

Important files:

- `run.json`
- `authored_graph.json`
- `compiled_graph.json`
- `execution_manifest.json`
- `compile_diagnostics.json`
- `state.json`
- `events.jsonl`
- `summary.md`

Key points:

- the run root is the durable source of truth
- node and execution directories use hashed names on disk
- `execution_manifest.json` records repo workspace bindings and effective policy

## Execution root

Important files:

- `execution.json`
- `stdout.log`
- `stderr.log`
- `result.json`

`artifacts/` is optional and only exists when workspace outputs are copied there.

Context files appear only when context resolution succeeded:

- `context_packet.json`
- `context_summary.md`
- `context_provenance.json`

## Context behavior

- `context_packet.json` shows what was materialized
- `context_summary.md` gives the concise operator view
- `context_provenance.json` records resolved inputs and harness instruction digests for inspection

Context byte budgets are enforced incrementally during materialization.
