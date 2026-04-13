# CLI And Validation Reference

Use this when authoring, reviewing, or handing off an Agentflow graph.

## Core commands

- `agentflow graph-help`
  Prints the authored graph contract, supported node kinds, path rules, and a minimal example.
- `agentflow validate --graph <path/to/agentflow.graph.json>`
  Validates the authored graph and resolved launch settings.
- `agentflow compile --graph <path/to/agentflow.graph.json>`
  Shows the compiled graph contract that the runtime will execute.
- `agentflow run --graph <path/to/agentflow.graph.json>`
  Creates a run root and executes the compiled graph.
- `agentflow run --graph <path> --label <run-label>`
  Same as `run`, with an operator-facing label added to the run id.
- `agentflow resume --run-root <path/to/run-root>`
  Recompiles the original graph and preserves only passed work whose compiled contract still matches.
- `agentflow eval validate --suite <path/to/suite.json>`
  Validates a local eval suite without running graph cases.
- `agentflow eval run --suite <path/to/suite.json>`
  Runs local eval cases through Agentflow graph templates and writes an eval ledger.
- `agentflow eval report --eval-root <path/to/eval-root>`
  Reads an existing eval root and reports the aggregate result.

Use `agentflow --help` or `agentflow <command> --help` when the command surface is unclear.

## Important rules

- The graph is the source of truth for `defaults.launch_profile` and `defaults.workspace_backend`.
- Do not invent CLI launch overrides for profile or workspace backend.
- `--graph` resolves from the shell current working directory.
- `repos.<alias>.path` resolves from the graph file directory.
- `validate` and `compile` do not create a run root.
- `run` and `resume` do.
- `eval run` creates an eval root and one normal graph run root per case/variant.

## Authoring loop

Recommended order:

1. draft or edit the graph
2. run `agentflow validate --graph ...`
3. run `agentflow compile --graph ...` if you need to inspect the lowered contract
4. run `agentflow run --graph ...` when the graph is ready to execute

Recommended eval loop:

1. draft or edit the eval suite and cases
2. run `agentflow eval validate --suite ...`
3. run `agentflow eval run --suite ...`
4. inspect `evaluation-ledger.json`, `benchmark.json`, and case-level `grading.json`

## Review standard

Before handing off a graph, make sure:

- `validate` passes
- the chosen node kinds express the intended control-flow semantics
- outputs and `context_from` references line up
- hard-stop versus soft-review failure boundaries are deliberate
- launch settings live in the graph, not in imagined CLI flags

Before handing off an eval suite, make sure:

- `eval validate` passes
- graph templates use `{{case.repos.<alias>.path}}` for repo paths
- required graders emit normalized JSON with boolean `passed`
- thresholds express the intended release bar
