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
- `context/packet.json`
- `context/manifest.md`
- `context/provenance.json`
- `context/materialized/`
- `logs/stdout.log`
- `logs/stderr.log`
- `result.json`
- `artifacts/result.json`
- `artifacts/agent-response.md` for agent nodes
- `artifact-repairs/<attempt>/prompt.md`, `stdout.log`, `stderr.log`, and `result.json` when agent artifact repair ran

`artifacts/` is always the graph-consumable handoff folder. It contains reserved artifacts plus declared artifacts copied from `AGENTFLOW_OUTPUT_DIR` or the workspace. For terminal runs, also inspect `workspace-changes/<repo>/status.txt`, `workspace-changes/<repo>/diff.patch`, and `workspace-changes/<repo>/changed-files.json` when workspace delivery matters.

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

- workspace file context content changes
- workspace glob context content changes
- workspace glob match-set changes
- harness instruction changes
- unrelated repo changes

This means a graph can preserve a passed node even if live files changed after the prior run. If that is not acceptable for the workflow, model the dependency as a new node or validation gate rather than assuming resume will re-run it.

## Authoring feedback loop

When diagnosing a run, also ask:

- should that failing command have been a hard `check` or a soft `exec` plus review?
- should a required command environment have been declared with profile or node `env_files`?
- were node boundaries too large to diagnose cleanly?
- did the graph publish enough artifacts to explain the failure?
- did the failing node write the expected `agent_response`, `result_json`, or declared artifact?
- for worktree runs, does `workspace-changes/<repo>/diff.patch` contain the expected source edits before cleanup?
- did resume restart because the compiled contract changed, or because the graph design was too broad?
- if the run belongs to an eval suite, should the failure become a new case, grader assertion, or threshold?