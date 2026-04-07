# Failure Playbook

Use this reference when a run failed, stopped unexpectedly, or preserved or restarted work in a surprising way.

## Failure buckets

- graph load or validation failure
- compile-time contract failure
- context materialization failure
- harness launch or prompt execution failure
- `exec` command failure
- deterministic `check` gate failure
- AI `check` quality failure
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
- were the node boundaries too large to diagnose cleanly?
- did the graph publish enough artifacts to explain the failure?
- did resume restart because a real input or instruction file changed, or because the graph design was too broad?

Use those answers to improve the graph, not just the run.
