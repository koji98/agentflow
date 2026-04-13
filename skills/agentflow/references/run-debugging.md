# Run Debugging

Debug Agentflow from durable artifacts first.

## Start at the run root

Read:

- `run.json`
- `summary.md`
- `state.json`
- `events.jsonl`

Then inspect:

- `authored_graph.json`
- `compiled_graph.json`
- `execution_manifest.json`
- `compile_diagnostics.json`

## Move to the relevant execution

Use node and execution metadata to inspect:

- `execution.json`
- `context_packet.json`
- `context_summary.md`
- `context_provenance.json`
- `stdout.log`
- `stderr.log`
- `result.json`

`artifacts/` is optional and appears only when workspace outputs are copied there.

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
- eval suite case, grader, or threshold failure

## Resume reference

`resume` recompiles the original graph and preserves passed work only when the compiled executable contract still matches.

Invalidates preservation:

- compiled node contract changes
- repeat scope shape changes
- unfinished repeat scopes

Does not invalidate preservation:

- explicit file-input content changes
- glob content changes
- glob match-set changes
- harness instruction changes
- unrelated repo changes

## Authoring feedback loop

When diagnosing a run, also ask:

- should that failing command have been a hard `check` or a soft `exec` plus review?
- should a required command environment have been declared with profile or node `env_files`?
- were node boundaries too large to diagnose cleanly?
- did the graph publish enough artifacts to explain the failure?
- did resume restart because the compiled contract changed, or because the graph design was too broad?
- if the run belongs to an eval suite, should the failure become a new case, grader assertion, or threshold?
