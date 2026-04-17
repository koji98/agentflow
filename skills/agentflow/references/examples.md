# Graph Authoring Patterns

Use these as compact mental models.

## Small explicit graph

Use primitives only:

1. `agent` or `exec` to make the change
2. declare any handoff file in `artifacts`
3. `check` to verify it

Good when:

- one repo surface is changing
- the validation command is obvious
- there is no need for multi-branch evidence gathering or operator review

## Evidence fan-out then synthesis

Use `parallel` when multiple read-only investigations can run independently, then fan in to one synthesis node.

Good shape:

1. `agent` inspect request and choose surfaces
2. `parallel` gather evidence
3. each branch publishes a named artifact or relies on `agent_response`
4. `agent` synthesize findings from explicit artifact context
4. `check` review or verify synthesis if needed

Good when:

- the investigation branches do not mutate state
- synthesis needs all branches together
- each branch can be explained independently

## Soft verifier

Use this when a command should run and produce evidence, but failure should not stop the graph immediately.

Good shape:

1. `exec` run command and publish status or logs
2. `agent` inspect named artifacts or `result_json` and explain success, failure, or next cleanup

Good when:

- a long integration run can fail for environment or app reasons
- you want root-cause documentation even on failure
- the graph should continue collecting information after the command runs

## Repair loop

Use `repeat` only when a descendant `check` or `checkpoint` should decide whether to continue.

Good shape:

1. implement node
2. validation node with hard pass/fail semantics
3. next attempt may consume `latest_failed` artifacts from the prior failed iteration with `if_available: true`
4. repeat back-edge on failure

Only use when the repair owner, gate, and maximum useful cycle count are all obvious.

## Managed pattern handoff

Use a managed pattern when the built-in lifecycle matches the task, then hand off to a primitive node only if something concrete still needs to happen afterward.

Examples in this repo:

- `docs/examples/graphs/pattern-deep-research-showcase.json`
- `docs/examples/graphs/pattern-spec-design-showcase.json`
- `docs/examples/graphs/pattern-generate-evaluate-fix-showcase.json`
- `docs/examples/graphs/pattern-review-change-showcase.json`

## Local eval suite

Use an eval suite when you need to measure workflow quality across cases.

Good shape:

1. `suite.json` defines graph template, cases, graders, variants, and thresholds
2. `cases.jsonl` defines realistic local tasks and fixture paths
3. graph template uses placeholders such as `{{case.task}}` and `{{case.repos.main.path}}`
4. script graders inspect run artifacts and print normalized JSON

Example in this repo:

- `docs/examples/evals/basic/suite.json`
