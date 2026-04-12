# Failure Playbook

Use this reference when a run failed, stopped unexpectedly, or preserved or restarted work in a surprising way.

## Failure buckets

- graph load or validation failure
- compile-time contract failure
- readiness prerequisite failure
- context materialization failure
- missing local command environment
- harness launch or prompt execution failure
- `exec` command failure
- deterministic `check` gate failure
- AI `check` quality failure
- soft verification warning on a passed run
- `checkpoint` stop or operator branch choice
- resume invalidation or non-preservation

## What to inspect first

For graph or compile failures:

- `summary.md`
- `run.json`
- compile diagnostics

For execution failures:

- `state.json`
- `events.jsonl`
- execution-root `execution.json`
- `stdout.log`
- `stderr.log`
- `result.json`

For context or preservation surprises:

- `context_packet.json`
- `context_summary.md`
- `context_provenance.json`

## Authoring feedback loop

When diagnosing a run, also ask whether the graph was authored cleanly:

- should that failing command have been a hard `check` or a soft `exec` plus review?
- should a required command environment have been declared with profile or node `env_files` instead of hidden shell setup?
- were the node boundaries too large to diagnose cleanly?
- did the graph publish enough artifacts to explain the failure?
- did resume restart because the compiled contract changed, or because the graph design was too broad?

Use those answers to improve the graph, not just the run.
