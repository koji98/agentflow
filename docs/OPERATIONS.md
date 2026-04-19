# Operations

This is the canonical local operator runbook for Agentflow. Keep it aligned with `README.md`, `docs/SCOPE.md`, command help, and `scripts/validate-smoke.mjs`.

## Supported Release Contract

The supported surface is intentionally narrow:

- local graph authoring in `1` format
- CLI `graph-help`, `validate` (with optional `--show-compiled` and `--run-ready`), `plugin resolve`, `run`, `resume` (with optional `--latest`), `apply`, `runs list`, and `inspect`
- workspace backends `inplace` (default) and `worktree`
- local Cursor CLI and Codex CLI harness adapters
- durable run artifacts under one canonical runs root

Replacement-ready for the supported surface means exactly this:

1. The documented local workflow works without source edits: `graph-help`, `validate`, `validate --show-compiled`, `run`, then artifact inspection (`runs list`, `inspect`) or `resume`.
2. Runtime outcomes are artifact-complete for `passed`, `failed`, `canceled`, and preflight-failed runs.
3. All CLI commands agree on the same runs-root contract.
4. `npm run validate:smoke` passes on the exact tree being handed off.
5. No deferred features are required to operate the supported workflow.

Anything beyond that stays out of scope until `docs/SCOPE.md` and `docs/DEFERRED.md` change.

## Canonical Runs Root

Run artifacts belong to the runs root, not to an individual repo checkout.

Resolution contract:

- If `--runs-root <path>` is passed, CLI commands use it.
- Else if `AGENTFLOW_RUNS_ROOT` is set, it must be absolute and CLI commands use that path.
- Otherwise CLI commands use `<graph-dir>/.agentflow/runs`, where `<graph-dir>` is the directory containing the resolved `--graph` file.

Path resolution contract:

- `--graph` resolves relative to the shell current working directory that launched the CLI.
- `$.repos.*.path` resolves relative to the graph file directory after the graph loads.

Each run gets a dedicated run root under `<runs-root>/<run-id>/`. The run id is generated from the launch timestamp, graph id, and optional label.

Expected durable artifacts under the run root:

- `run.json`
- `authored_graph.json`
- `compiled_graph.json`
- `execution_manifest.json`
- `compile_diagnostics.json`
- `state.json`
- `events.jsonl`
- `summary.md`
- `workspaces/`
- `nodes/`

## Lifecycle And Cleanup

Lifecycle rules that matter operationally:

- `validate` (with or without `--show-compiled`) never creates a run root.
- `run` creates the run root before execution so preflight failures still leave inspectable artifacts.
- `summary.md`, `run.json`, `state.json`, and `events.jsonl` are expected to agree on the terminal outcome.
- `execution_manifest.json` is the single durable source of repo workspace bindings and compiled execution policy.
- `state.json` is runtime state only; it does not persist a filesystem index of node or execution directories.

Cleanup and reconciliation rules:

- `inplace` runs operate directly in the source repo paths resolved from the graph.
- `worktree` runs create one git worktree per repo under `<run-root>/workspaces/<repo-alias>`.
- On `passed`, `failed`, and `canceled` outcomes, the runtime cleans up worktree registrations before finalizing terminal artifacts.
- If worktree initialization fails partway through, already-created worktrees are rolled back before the run is marked failed.
- If worktree cleanup itself fails, the run is forced to terminal `failed` and the cleanup error is recorded in the terminal reason.
- `agentflow resume --run-root <run-root>` recompiles the original graph path with the current Agentflow build, preserves only passed nodes whose compiled contract is unchanged, restarts everything else, and recreates missing worktree paths when the original failed run already cleaned them up. Pass `--graph <graph> --latest` to resume the most recent failed or canceled run for a graph automatically.
- When inspection tooling reopens stale `pending` or `running` artifacts, projection reconciles them from durable state or from a recorded local runtime owner fingerprint that no longer matches a live process on this host instead of leaving them live forever.

What the operator should expect:

- A preflight failure can happen before any node starts and still produce a readable run from artifacts alone.
- In this release, graph-global preflight includes workspace initialization plus readiness checks derived from declared prerequisites and resolved repo sources. Node-specific harness and checkpoint readiness remain lazy and fail the node that reaches that boundary.
- A canceled run is canceled from the terminal that launched `run` with `Ctrl-C`.
- `run` and `resume` print live graph progress to `stderr`. When `stdout` is an interactive terminal they print a compact terminal summary with final status and duration; when `stdout` is redirected or piped they keep emitting the full structured JSON result on `stdout`, so shell pipelines can still consume the command result without parsing progress noise.
- The `workspaces/` directory is an implementation detail of the run and is not preserved as a long-lived checkout contract after worktree cleanup.
- Authored `workspace_file` and `workspace_glob` context resolves live when each node starts. Missing files or empty globs become explicit omitted context instead of run-preflight failure.
- Node directories under `nodes/` use compiled-order prefixes plus readable labels, for example `001-plan-<hash>`. Execution directories use append-only runtime ordinals, for example `001-exec-<hash>` or `i001-a001-exec-<hash>` inside repeat loops.
- Execution directories keep bookkeeping at the root and segment bulky material: `context/` contains the context packet, manifest, provenance, and materialized files; `logs/` contains stdout and stderr; `artifacts/` contains every graph-consumable artifact, including reserved artifacts.
- Agent harness prompts orient the model as one node in a graph, list declared artifacts, and capture the model's final response as `artifacts/agent-response.md` for narrative handoff.
- Agent artifact repair is bounded by `artifact_repair.max_attempts`. It defaults to one repair attempt for agent nodes, runs in the same workspace and output artifact directory, and records repair prompts and logs under `artifact-repairs/<attempt>/` inside the original execution directory.
- `run` and `resume` only resolve repo aliases that the compiled graph actually references; unused declared repos stay inert.
- `workspace_glob` context uses a deterministic sorted filesystem walk with root `.gitignore` and `.ignore` filtering plus hard exclusions for `.git`, `.agentflow`, and `node_modules`.
- Terminal runs capture per-repo workspace change artifacts before cleanup when possible: `workspace-changes/<repo>/status.txt`, `workspace-changes/<repo>/diff.patch`, and `workspace-changes/<repo>/changed-files.json`.

## Recommended Dev Workflow

From the repository root:

```bash
cd /path/to/agentflow
npm install
npm run validate:smoke
npm run validate:confidence
npm run validate:real-harness
```

Use the CLI in this order:

```bash
agentflow graph-help
agentflow validate --graph ./agentflow.graph.json
agentflow validate --graph ./agentflow.graph.json --run-ready
agentflow validate --graph ./agentflow.graph.json --show-compiled
agentflow run --graph ./agentflow.graph.json
agentflow runs list --graph ./agentflow.graph.json
agentflow inspect ./.agentflow/runs/<run-id>
agentflow resume --graph ./agentflow.graph.json --latest
```

Plain `validate` proves the authored graph and compiled contract. Add `--run-ready` when you want local machine proof before launch: it checks required runtime tools such as `git`, referenced repo worktrees, executable node commands, and harness binaries used by compiled agent or AI-check nodes. Add `--show-compiled` when you want to inspect the compiled contract the runtime will execute, including lowered managed nodes and resolved profiles.

Recommended local loop while developing Agentflow:

1. Run `agentflow --help` or `agentflow <command> --help` before changing CLI behavior.
2. Use `npm run validate:smoke` after changes that affect operator-facing contracts or docs.
3. Use `npm run validate:confidence` before handoff when you need measured deterministic coverage proof in addition to the release replacement gate.
4. Use `npm run validate:real-harness` only when you want additive smoke proof against locally installed Codex or Cursor binaries; it skips cleanly when neither harness is configured or detected and does not change the deterministic gates. Codex smoke pins `reasoning_effort=medium` by default when the graph leaves it unspecified, so local Codex config does not silently change the result.
5. Use focused tests while iterating, then rerun the smoke gate, confidence gate, or optional real-harness gate that matches the risk of the change.

Useful overrides:

- `--runs-root <path>` for an explicit per-command runs root (highest precedence)
- `AGENTFLOW_RUNS_ROOT` for a shared absolute runs root
- `AGENTFLOW_CODEX_CLI_BIN` and `AGENTFLOW_CURSOR_CLI_BIN` when the harness binaries are not on `PATH`
- `AGENTFLOW_REAL_HARNESS=codex-cli`, `cursor-cli`, or `all` to narrow or widen `npm run validate:real-harness` without changing the deterministic default gates

Harness policy notes:

- Codex-backed `agent` and AI `check` nodes resolve `reasoning_effort` from the graph when provided and otherwise default to `medium`.
- Cursor-backed `agent` nodes treat `read-only` as proposal mode by omitting `--force`.
- AI `check` nodes require a harness that supports strict read-only evaluation; in this release that means `codex-cli`.

## CLI Entry Points

Each supported command returns explicit next-step hints. Non-interactive `validate`, `run`, `resume`, `runs list`, and `inspect` remain JSON-first; interactive `validate`, `run`, and `resume` render compact terminal summaries instead of dumping full payloads.

- `graph-help`: prints the authored graph contract, supported node kinds, path rules, `prerequisites.checks`, local command `env_files`, soft verification via `on_failure`, and a minimal example.
- `validate`: validates the authored graph, validates the compiled graph, runs declared readiness checks, and returns `path_resolution`, launch data, readiness data, compiled summary, managed expansion details, and next-step commands. Add `--run-ready` to also verify local runtime dependencies such as `git`, repo worktrees, executable node commands, and harness binaries. Add `--show-compiled` to include the compiled graph contract and lowered managed nodes in the result for inspection.
- `plugin resolve`: clones Git plugin workflows declared by the graph, pins them to commits, and writes `agentflow.plugins.lock.json` next to the graph.
- `run`: executes the compiled graph, writes durable artifacts, and returns `runs_root`, `run_root`, artifact paths, rerun or resume commands, and the cancellation note.
- `resume`: recompiles a failed or canceled run root and resumes from durable state when the compiled contract still matches preserved work. Pass `--graph <graph> --latest` to pick the most recent failed or canceled run for that graph automatically.
- `apply`: applies captured `workspace-changes/<repo>/diff.patch` from a run back to the source repo recorded in `execution_manifest.json`, or to `--target <path>` when provided. It refuses dirty targets unless `--allow-dirty` is passed and commits only when `--commit-message <message>` is provided.
- `runs list`: enumerates recorded runs for a graph under the resolved runs root and returns each run's id, status, started/finished timestamps, workspace backend, launch profile, and absolute run-root path.
- `inspect`: returns terminal status, total nodes, attempt counts, summary path, and short stderr tails for each failed node in a single run root.

For help:

```bash
agentflow --help
agentflow plugin --help
agentflow run --help
agentflow resume --help
agentflow runs --help
agentflow inspect --help
```

## Common Failure Modes

These are the high-signal failures to expect in this release.

### Graph or path resolution failures

Symptoms:

- `Graph could not be loaded or normalized from --graph.`
- repo path diagnostics under `$.repos.<alias>.path`
- `Plugin "<alias>" is not resolved. Run agentflow plugin resolve --graph <path>.`
- plugin lockfile stale diagnostics under `$.plugins.<alias>`

Checks:

- verify the `--graph` path from the shell that launched the CLI
- verify each `repos.*.path` from the graph file directory, not from the launch shell
- run `agentflow plugin resolve --graph <path>` when the graph declares `plugins`
- run `validate` before `run`

### Launch setting failures

Symptoms:

- `Launch settings could not be resolved...`
- unknown launch profile or unsupported workspace backend diagnostics

Checks:

- confirm `defaults.launch_profile` points at a declared profile (default `"default"` only resolves when a profile named `default` exists)
- use only `inplace` or `worktree` in `defaults.workspace_backend`; `inplace` is the default when omitted
- ensure every `agent` and AI `check` node can resolve a `harness` through its profile chain; `harness` is environment-dependent and is not auto-defaulted
- run `graph-help` if the authored contract is unclear

### Worktree preflight failures

Symptoms:

- worktree-backed runs fail before node execution
- errors like `Repo "<path>" is not a git worktree.`

Checks:

- ensure each repo path is a real git working tree
- use `inplace` if you intentionally do not want a git worktree copy
- inspect the preflight-failed run artifacts; they are still written

### Readiness prerequisite failures

Symptoms:

- `Graph compiled, but readiness validation is blocked...`
- `run.preflight_failed` with `reason = readiness_blocked`
- missing file, command, env var, or repo diagnostics under `readiness.checks`

Checks:

- use top-level `prerequisites.checks` for launch-time assumptions that must be explicit
- mark non-blocking checks with `"required": false` when they should warn but not stop the run
- re-run `validate` after fixing the missing prerequisite to confirm `readiness.status = "ready"`; use `validate --run-ready` when the fix is a local machine dependency rather than graph syntax

### Missing command environment

Symptoms:

- deterministic `check` or `exec` fails because a test command cannot see a required secret or local env value
- a command succeeds from the shell but fails under Agentflow with a missing env-var message

Checks:

- remember that local command nodes use a narrow baseline environment instead of inheriting arbitrary shell variables
- put repo-local dotenv-style files in `env_files` on the relevant profile or node, for example `"env_files": [".env.development"]`
- keep secrets out of graph inline `env`; use ignored env files or the existing repo secret workflow instead
- declare a top-level env prerequisite only when the launch shell itself must provide the variable

### Missing harness binaries

Symptoms:

- a reachable `agent` or AI `check` node fails when it reaches execution
- the run summary or execution result mentions an unavailable harness binary

Checks:

- make sure `codex` and/or `agent` are installed and authenticated when the graph needs them
- set `AGENTFLOW_CODEX_CLI_BIN` or `AGENTFLOW_CURSOR_CLI_BIN` to explicit binary paths if needed
- remember that plain `validate` (with or without `--show-compiled`) does not require those binaries; `validate --run-ready` does when the compiled graph uses the harness
- use `npm run validate:real-harness -- --harness codex-cli` or `cursor-cli` for an additive real-install smoke; it reports `skipped` instead of failing when the selected binary is unavailable

### Checkpoint graphs without an interactive terminal

Symptoms:

- a reachable `checkpoint` node fails when it reaches execution
- the execution error mentions interactive TTY support or a missing checkpoint executor

Checks:

- launch `run` or `resume` from an interactive terminal
- remember that `checkpoint` is only supported inside `repeat` bodies
- make sure the checkpoint `review_from` reference resolves to an upstream named artifact

### Artifacts are not where you expect

Symptoms:

- the CLI run succeeded but you cannot find the run root you expected

Checks:

- compare the emitted `runs_root` with your shell environment
- check whether you passed `--runs-root <path>` or set `AGENTFLOW_RUNS_ROOT`
- remember that the default fallback is `<graph-dir>/.agentflow/runs`, the directory containing the resolved `--graph` file

### Agent declared artifact is missing

Symptoms:

- an agent node reports success but the node later fails while materializing a declared artifact
- `events.jsonl` contains `artifact_repair.started` followed by `artifact_repair.failed`
- the execution metadata contains `artifact_repair.status = "failed"`

Checks:

- inspect the original execution's `artifacts/agent-response.md`, `logs/stdout.log`, `logs/stderr.log`, and `artifact-repairs/<attempt>/prompt.md`
- confirm the graph declared the artifact path under the right source: `output_dir` means `AGENTFLOW_OUTPUT_DIR`, while `workspace` means the repo workspace
- set profile or node `artifact_repair.max_attempts` to `0` when repair would mask a graph-authoring bug, or raise it up to `3` when the agent can usually recover the handoff from existing workspace changes
- if repair says the harness is unavailable, install or configure the resolved harness binary before rerunning; repair uses the same harness as the agent node

## Replacement Sign-Off

Before calling the package replacement-ready for the supported surface:

```bash
npm run validate:smoke
```

That gate is the required proof point. It checks canonical operating-doc presence, runs `typecheck`, `test`, and `build`, and smoke-tests the built `validate --show-compiled`, `runs list`, and `inspect` commands against the shipped repeat fixture.
It also smoke-tests built `run` through temporary Codex and Cursor mock harness binaries across both supported workspace backends so the shipped supported workflow is proven without requiring real harness installs.

When you need deeper handoff confidence on the same exact tree, also run:

```bash
npm run validate:confidence
```

That gate layers the required smoke proof with measured coverage floors over `src/` and prints the residual risks directly in its JSON output.

Add optional real-harness proof when you need it:

```bash
npm run validate:real-harness
```

For active runs, `agent` and AI `check` executions append live harness output directly into the current execution's `logs/stdout.log` and `logs/stderr.log`. Completion still rewrites the final authoritative log contents.

That live harness output is separate from the CLI progress stream. CLI progress is human-oriented terminal status on `stderr`; durable execution logs remain the source of truth in the run artifacts.

Optional machine-local proof is separate:

```bash
npm run build
npm run validate:real-harness
npm run validate:real-harness -- --harness codex-cli
npm run validate:real-harness -- --harness cursor-cli
```

That command uses the built CLI, runs a one-node smoke only for real harness binaries detected through `AGENTFLOW_CODEX_CLI_BIN`, `AGENTFLOW_CURSOR_CLI_BIN`, `codex`, or `agent`, and verifies durable passed artifacts. If nothing is configured, it exits cleanly with `skipped` and explains what stayed unproven. If a binary is detected but the smoke fails, the command returns `failed`, surfaces the run summary diagnostics, and records the captured `summary.md` path so the failure can be diagnosed as a real environment or harness-contract problem. It is additive confidence, not a replacement-readiness requirement.

What remains unproven unless you test it separately:

- abrupt packaged-CLI death or host restart in the middle of a run
- real harness auth, quota, network stability, and prompt quality beyond one-node smoke
- every machine-specific git, filesystem, and repo-topology variation

For sign-off, record the exact commands run and whether each layer returned `passed`, `failed`, or `skipped`. If a layer was not run, mark that surface unproven instead of implying coverage.
