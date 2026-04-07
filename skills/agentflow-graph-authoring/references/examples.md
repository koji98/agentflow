# Graph Authoring Patterns

Use these as compact mental models.

## Small explicit graph

Use primitives only:

1. `agent` or `exec` to make the change
2. `check` to verify it

Good when:

- one repo surface is changing
- the validation command is obvious
- there is no need for multi-branch evidence gathering or operator review

## Evidence fan-out then synthesis

Use `parallel` when multiple read-only investigations can run independently, then fan in to one synthesis node.

Good shape:

1. `agent` inspect request and choose surfaces
2. `parallel` gather evidence
3. `agent` synthesize findings
4. `check` review or verify synthesis if needed

Good when:

- the investigation branches do not mutate state
- synthesis needs all branches together
- each branch can be explained independently

## Soft verifier

Use this when a command should run and produce evidence, but failure should not stop the graph immediately.

Good shape:

1. `exec` run command and publish status or logs
2. `agent` inspect artifacts and explain success, failure, or next cleanup

Good when:

- a long integration run can fail for environment or app reasons
- you want root-cause documentation even on failure
- the graph should continue collecting information after the command runs

## Repair loop

Use `repeat` only when a descendant `check` or `checkpoint` should decide whether to continue.

Good shape:

1. implement node
2. validation node
3. repeat back-edge on failure

Only use when the repair owner, gate, and maximum useful cycle count are all obvious.

## Managed workflow handoff

Use a managed workflow when the built-in lifecycle matches the task, then hand off to a primitive node only if something concrete still needs to happen afterward.

Examples in this repo:

- `docs/examples/graphs/deep-research-showcase.json`
- `docs/examples/graphs/spec-design-showcase.json`
- `docs/examples/graphs/execute-spec-showcase.json`
- `docs/examples/graphs/review-change-showcase.json`
