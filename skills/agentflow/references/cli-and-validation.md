# CLI And Validation Reference

Use this when authoring, reviewing, or handing off an Agentflow graph.

## Core commands

- `agentflow graph-help`
  Prints the authored graph contract, supported node kinds, path rules, and a minimal example.
- `agentflow validate --graph <path/to/agentflow.graph.json>`
  Validates the authored graph and resolved launch settings without running local machine dependency checks.
- `agentflow validate --graph <path/to/agentflow.graph.json> --run-ready`
  Validates the graph plus local launch dependencies: `git`, referenced repo worktrees, executable node commands, and harness binaries used by agent or AI-check nodes.
  Plain validate proves graph legality; run-ready validate proves the current machine is prepared to launch it.
- `agentflow validate --graph <path/to/agentflow.graph.json> --show-compiled`
  Includes the compiled graph contract and lowered managed nodes in the result so you can inspect what the runtime will execute. Replaces the old `agentflow compile` command.
- `agentflow plugin resolve --graph <path/to/agentflow.graph.json>`
  Clones Git plugin workflows declared by the graph, pins them to commits, and writes `agentflow.plugins.lock.json` next to the graph.
- `agentflow run --graph <path/to/agentflow.graph.json>`
  Creates a run root and executes the compiled graph.
- `agentflow run --graph <path> --label <run-label>`
  Same as `run`, with an operator-facing label added to the run id.
- `agentflow resume --run-root <path/to/run-root>`
  Recompiles the original graph and preserves only passed work whose compiled contract still matches.
- `agentflow resume --graph <path> --latest`
  Picks the most recent failed or canceled run for that graph automatically and resumes it.
- `agentflow runs list --graph <path>`
  Lists recorded runs for a graph under the resolved runs root with status, timestamps, workspace backend, and run-root path.
- `agentflow inspect <path/to/run-root>`
  Returns terminal status, total nodes, attempt counts, summary path, and short stderr tails for each failed node in a single run root.
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
- `validate` (with or without `--show-compiled`) does not create a run root.
- `validate`, `run`, `resume`, `runs list`, and `inspect` do not clone plugin workflows implicitly; resolve plugins first.
- `run` and `resume` do create run roots.
- `eval run` creates an eval root and one normal graph run root per case/variant.

## Authoring loop

Recommended order:

1. draft or edit the graph
2. run `agentflow plugin resolve --graph ...` if the graph declares `plugins`
3. run `agentflow validate --graph ...`
4. fix diagnostics until validation passes
5. run `agentflow validate --graph ... --run-ready` when local commands, git worktrees, Codex, Cursor, or plugin scripts matter before launch
6. run `agentflow validate --graph ... --show-compiled`
7. inspect the compiled contract for node count, dependencies, repeat scopes, managed expansion, profiles, and artifact references
8. run `agentflow run --graph ...` when the graph is ready to execute

Do not skip `validate --show-compiled` for nontrivial graphs. Plain validate tells you the graph is legal; `--show-compiled` tells you what will actually run.

Recommended eval loop:

1. draft or edit the eval suite and cases
2. run `agentflow eval validate --suite ...`
3. run `agentflow eval run --suite ...`
4. inspect `evaluation-ledger.json`, `benchmark.json`, and case-level `grading.json`

## Review standard

Before handing off a graph, make sure:

- `validate` passes
- `plugin resolve` passes when the graph declares `plugins`
- `validate --run-ready` passes when the handoff says the graph is ready to run on the current machine
- `validate --show-compiled` passes
- the chosen node kinds express the intended control-flow semantics
- declared artifacts and artifact context references line up
- hard-stop versus soft-review failure boundaries are deliberate
- launch settings live in the graph, not in imagined CLI flags

When validation fails, repair the graph instead of explaining around the error. Common repairs:

- remove invalid `inputs`, `context_from`, or `outputs`; use only current `context` and `artifacts`
- add missing `repo` fields in multi-repo graphs
- declare an artifact that a downstream node references
- add or remove `if_available: true` on artifact context based on whether the consumer can proceed without that material
- move env-dependent command setup into `env_files`
- cap broad globs with `max_files`
- replace a soft `check` in `repeat.until` with a hard gate
- run `agentflow plugin resolve --graph ...` when diagnostics say a plugin is unresolved, stale, or missing from cache

Before handing off an eval suite, make sure:

- `eval validate` passes
- graph templates use `{{case.repos.<alias>.path}}` for repo paths
- required graders emit normalized JSON with boolean `passed`
- thresholds express the intended release bar
