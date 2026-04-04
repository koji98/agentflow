# Operations

This is the canonical local operator runbook for Agentflow. Keep it aligned with `README.md`, `docs/SCOPE.md`, command help, and `scripts/validate-smoke.mjs`.

## Supported Release Contract

The supported surface is intentionally narrow:

- local graph authoring in `1` format
- CLI `validate`, `compile`, `run`, and `ui`
- web launchpad and monitor for inspection and historical run readback
- workspace backends `inplace` and `worktree`
- local Codex CLI and Cursor CLI harness adapters
- durable run artifacts under one canonical runs root

Replacement-ready for the supported surface means exactly this:

1. The documented local workflow works without source edits: `graph-help`, `validate`, `compile`, `run`, then `ui` or the web monitor.
2. Runtime outcomes are artifact-complete for `passed`, `failed`, `canceled`, and preflight-failed runs.
3. The CLI and web monitor agree on the same runs root by contract.
4. `npm run validate:smoke` passes on the exact tree being handed off.
5. No deferred features are required to operate the supported workflow.

Anything beyond that stays out of scope until `docs/SCOPE.md` and `docs/DEFERRED.md` change.

## Canonical Runs Root

Run artifacts belong to the runs root, not to an individual repo checkout.

Resolution contract:

- If `AGENTFLOW_RUNS_ROOT` is set, it must be absolute and both CLI and web use that path.
- Otherwise both CLI and web use `<launch-cwd>/.agentflow/runs`.
- For packaged web scripts, `<launch-cwd>` comes from `INIT_CWD` so `npm run start --workspace web-app` and `npm run dev --workspace web-app` preserve the operator shell directory instead of silently switching to `web-app/`.

Path resolution contract:

- `--graph` resolves relative to the shell current working directory that launched the CLI.
- `$.repos.*.path` resolves relative to the graph file directory after the graph loads.
- Reuse the exact `start_command` or `dev_command` emitted by `run` or `ui` when the CLI and monitor launch from different directories.

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
- `repos/`
- `workspaces/`
- `nodes/`

## Lifecycle And Cleanup

Lifecycle rules that matter operationally:

- `validate` and `compile` never create a run root.
- `run` creates the run root before execution so preflight failures still leave inspectable artifacts.
- `summary.md`, `run.json`, `state.json`, and `events.jsonl` are expected to agree on the terminal outcome.
- `state.json` now includes an `artifact_index` block so hashed `nodes/node-*` and `executions/exec-*` directories can be mapped back to compiled ids, execution ids, and full paths without manual guessing.

Cleanup and reconciliation rules:

- `inplace` runs operate directly in the source repo paths resolved from the graph.
- `worktree` runs create one git worktree per repo under `<run-root>/workspaces/<repo-alias>`.
- On `passed`, `failed`, and `canceled` outcomes, the runtime cleans up worktree registrations before finalizing terminal artifacts.
- If worktree initialization fails partway through, already-created worktrees are rolled back before the run is marked failed.
- If worktree cleanup itself fails, the run is forced to terminal `failed` and the cleanup error is recorded in the terminal reason.
- `agentflow resume --run-root <run-root>` reuses the same run root, preserves nodes whose latest durable outcome is `passed`, restarts everything else, and recreates missing worktree paths when the original failed run already cleaned them up.
- When the monitor reopens stale `pending` or `running` artifacts, projection reconciles them from durable state or from a recorded local runtime owner fingerprint that no longer matches a live process on this host instead of leaving them live forever.

What the operator should expect:

- A preflight failure can happen before any node starts and still produce a readable run in the monitor.
- A canceled run is canceled from the terminal that launched `run` with `Ctrl-C`; the monitor only reflects the durable result.
- `run` and `resume` print live graph progress to `stderr` while the final structured JSON result stays on `stdout`, so shell pipelines can still consume the command result without parsing progress noise.
- The `workspaces/` directory is an implementation detail of the run and is not preserved as a long-lived checkout contract after worktree cleanup.

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
npm run graph-help
npm run validate -- --graph ./agentflow.graph.json
npm run compile -- --graph ./agentflow.graph.json
npm run run -- --graph ./agentflow.graph.json
npm run ui -- --graph ./agentflow.graph.json
```

Recommended local loop while developing Agentflow:

1. Run `npm run help` or `npm run help -- <command> --help` before changing CLI behavior.
2. Use `npm run validate:smoke` after changes that affect operator-facing contracts or docs.
3. Use `npm run validate:confidence` before handoff when you need measured coverage proof and packaged browser proof in addition to the release replacement gate.
4. Use `npm run test:browser` after `npm run build` or `npm run validate:smoke` when you want direct packaged-browser proof; use `npm run test:browser -- --headed` to watch it locally. Failure screenshots are written to `output/playwright/test-browser-failure.png`.
5. Use `npm run validate:real-harness` only when you want additive smoke proof against locally installed Codex or Cursor binaries; it skips cleanly when neither harness is configured or detected and does not change the deterministic gates. Codex smoke pins `reasoning_effort=medium` by default when the graph leaves it unspecified, so local Codex config does not silently change the result.
6. Use focused tests while iterating, then rerun the smoke gate, confidence gate, browser smoke, or optional real-harness gate that matches the risk of the change.

Web monitor entrypoints:

```bash
npm run start --workspace web-app
npm run dev --workspace web-app
```

Default URLs:

- launchpad and packaged client: `http://127.0.0.1:4178/`
- dev API bridge: `http://127.0.0.1:4179`

Useful overrides:

- `AGENTFLOW_RUNS_ROOT` for a shared absolute runs root
- `PORT` for `npm run start --workspace web-app`
- `AGENTFLOW_WEB_APP_PORT`, `AGENTFLOW_WEB_API_PORT`, and `AGENTFLOW_WEB_API_ORIGIN` for `npm run dev --workspace web-app`
- `AGENTFLOW_CODEX_CLI_BIN` and `AGENTFLOW_CURSOR_CLI_BIN` when the harness binaries are not on `PATH`
- `AGENTFLOW_REAL_HARNESS=codex-cli`, `cursor-cli`, or `all` to narrow or widen `npm run validate:real-harness` without changing the deterministic default gates

Harness policy notes:

- Codex-backed `agent` and AI `check` nodes resolve `reasoning_effort` from the graph when provided and otherwise default to `medium`.
- Cursor-backed `agent` nodes treat `read-only` as proposal mode by omitting `--force`.
- AI `check` nodes require `codex-cli`; cursor-backed AI checks fail closed because the release does not treat Cursor as a strict read-only evaluator.

## CLI Entry Points

Each supported command is JSON-first and returns explicit next-step hints.

- `graph-help`: prints the authored graph contract, supported node kinds, path rules, and minimal example.
- `validate`: validates authoring plus launch settings and returns `path_resolution`, launch data, compiled summary, and next-step commands.
- `compile`: returns the compiled graph contract for inspection plus the same path and next-step metadata.
- `run`: executes the compiled graph, writes durable artifacts, and returns `runs_root`, `run_root`, artifact paths, monitor handoff commands, and the cancellation note.
- `ui`: returns launchpad or inspect preload metadata, the runs-root contract, and exact `start` or `dev` commands for the monitor.

For help:

```bash
npm run help
npm run help -- run --help
npm run help -- ui --help
```

## Common Failure Modes

These are the high-signal failures to expect in this release.

### Graph or path resolution failures

Symptoms:

- `Graph could not be loaded or normalized from --graph.`
- repo path diagnostics under `$.repos.<alias>.path`

Checks:

- verify the `--graph` path from the shell that launched the CLI
- verify each `repos.*.path` from the graph file directory, not from the launch shell
- run `validate` before `run`

### Launch override failures

Symptoms:

- `Launch settings could not be resolved...`
- unknown launch profile or unsupported workspace backend diagnostics

Checks:

- confirm `--profile` matches a declared profile
- use only `inplace` or `worktree` for `--workspace-backend`
- run `graph-help` if the authored contract is unclear

### Worktree preflight failures

Symptoms:

- worktree-backed runs fail before node execution
- errors like `Repo "<path>" is not a git worktree.`

Checks:

- ensure each repo path is a real git working tree
- use `inplace` if you intentionally do not want a git worktree copy
- inspect the preflight-failed run in the monitor; artifacts are still written

### Missing harness binaries

Symptoms:

- agent or AI-check runs fail during preflight before execution starts

Checks:

- make sure `codex` and/or `agent` are installed and authenticated when the graph needs them
- set `AGENTFLOW_CODEX_CLI_BIN` or `AGENTFLOW_CURSOR_CLI_BIN` to explicit binary paths if needed
- remember that `validate`, `compile`, and `ui` do not require those binaries, and `npm run validate:smoke` injects temporary mock binaries instead of depending on real installs
- use `npm run validate:real-harness -- --harness codex-cli` or `cursor-cli` for an additive real-install smoke; it reports `skipped` instead of failing when the selected binary is unavailable

### Monitor shows the wrong run set

Symptoms:

- the CLI run succeeded but the web monitor does not show it

Checks:

- compare the CLI `runs_root` with the web process environment
- start the web app with the exact `start_command` or `dev_command` emitted by `run` or `ui`
- avoid assuming the monitor default is `web-app/.agentflow/runs`; it is keyed off the launch directory or an absolute `AGENTFLOW_RUNS_ROOT`

### Packaged web start cannot serve the client

Symptoms:

- `Web client build artifacts are missing. Run npm run build before npm run start --workspace web-app.`

Checks:

- run `npm run build`
- use `npm run dev --workspace web-app` during client iteration if you do not need the packaged build

## Replacement Sign-Off

Before calling the package replacement-ready for the supported surface:

```bash
npm run validate:smoke
```

That gate is the required proof point. It checks canonical operating-doc presence, runs `typecheck`, `test`, and `build`, and smoke-tests the built `validate`, `compile`, and `ui` commands against the shipped repeat fixture.
It also smoke-tests built `run` through temporary Codex and Cursor mock harness binaries across both supported workspace backends so the shipped supported workflow is proven without requiring real harness installs.

When you need deeper handoff confidence on the same exact tree, also run:

```bash
npm run validate:confidence
```

That gate layers the required smoke proof with measured coverage floors over `src/`, `web-app/server/`, and the core client render or view-model surfaces under `web-app/client/src/app.tsx`, `web-app/client/src/components/`, and `web-app/client/src/lib/`, plus a packaged browser smoke that seeds a known recent-run set and drives the launchpad and run monitor against a deterministic local run. The browser proof asserts recent runs, timeline, inspector, stdout, and artifact preview rendering from the built server and client artifacts. The first browser pass will install Playwright Chromium automatically if it is missing, so browser-binary provisioning stays machine-local rather than part of the built tree.
`validate:confidence` prints the measured floors, browser-smoke proof, and residual risks directly in its JSON output.

Run the browser layer by itself when you want direct packaged-web proof or local debugging:

```bash
npm run build
npm run test:browser
npm run test:browser -- --headed
```

That standalone smoke proves the built client and built web server artifact can share one runs root, list deterministic recent runs, compile the selected graph from the launchpad, open the newest run, and render the monitor timeline, inspector, stdout, artifact preview, and passed header status. It does not prove live SSE updates, browser-driven cancellation, or multi-browser behavior.

For active runs, `agent` and AI `check` executions append live harness output directly into the current execution's `stdout.log` and `stderr.log`. The UI tail view reads those files while the run is in progress, and completion still rewrites the final authoritative log contents.

That live harness output is separate from the CLI progress stream. CLI progress is human-oriented terminal status on `stderr`; durable execution logs remain the source of truth for the monitor and artifacts.

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
- live browser behavior while a run is still executing
- real harness auth, quota, network stability, and prompt quality beyond one-node smoke
- every machine-specific git, filesystem, and repo-topology variation

For sign-off, record the exact commands run and whether each layer returned `passed`, `failed`, or `skipped`. If a layer was not run, mark that surface unproven instead of implying coverage.
