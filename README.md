# agentflow

`agentflow` is a file-driven workflow runner for coding agents.

You define a JSON plan, and `agentflow` executes it (tasks, groups, loops with gates) against a target repository while writing deterministic run artifacts.

## Prerequisites

- Node.js `>=18`
- `git` on `PATH`
- At least one supported provider CLI installed and authenticated:
  - `codex` CLI (default provider)
  - Cursor CLI (`agent` command) — install via `curl https://cursor.com/install -fsS | bash`

Quick checks:

```bash
node -v
git --version
codex --help    # if using codex provider
agent --version # if using cursor provider
```

## Install

```bash
npm install
```

## Run

```bash
npm run dev -- --plan example_plan.json
```

Dry-run:

```bash
npm run dev -- --plan example_plan.json --dry-run
```

Live run with writable sandbox:

```bash
npm run dev -- --plan example_plan.json --sandbox workspace-write
```

CLI help:

```bash
npm run start
npm run plan-help
```

## CLI Options

- `--plan <path>`: required JSON plan path
- `--dry-run`: force dry-run (live is default)
- `--skip-git-repo-check`: pass through to provider CLI when repo trust checks block execution (codex: `--skip-git-repo-check`, cursor: `--trust`)
- `--sandbox <mode>`: sandbox mode (`read-only`, `workspace-write`, or `danger-full-access`); default is `workspace-write`. For cursor provider, maps to `enabled`/`disabled`.
- `--plan-help`: print schema help

## Plan Schema (Complete)

### Top-Level

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `version` | string | No | none | Optional metadata only. |
| `setup` | string | Yes | none | Run-level instructions included in every task prompt. |
| `objective` | string | No | `null` | Optional objective used by AI loop gates. |
| `target` | object | Yes | none | Repo targeting config. |
| `defaults` | object | No | see below | Default provider/model/reasoning/profile for tasks and AI gates. |
| `policy` | object | No | see below | Failure and retry policy plus termination limits. |
| `runtime` | object | No | see below | Runtime behavior and artifact directory config. |
| `context_files` | string[] | No | `[]` | Global context files for all tasks. |
| `flow` | flow node[] | Yes | none | Ordered workflow nodes. |

Unknown keys are rejected at every schema level (top-level and nested objects).

### `target`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `repo_root` | string | Yes | none | Repo root path (relative to plan file dir when relative). |
| `use_worktrees` | boolean | No | `true` | Execute tasks in per-task worktrees for workspace isolation. |

### `defaults`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `provider` | `"codex"` \| `"cursor"` | No | `"codex"` | Launch provider. |
| `model` | string | No | `"gpt-5-nano"` | Default model flag passed to provider CLI. |
| `reasoning` | `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | No | `"xhigh"` | Default reasoning effort (codex only; ignored by cursor). |
| `profile` | string | No | `null` | Optional default profile (codex only; ignored by cursor). |

### `policy`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `fail_mode` | `"stop"` \| `"continue"` | No | `"stop"` | Stop fast or continue after failures. |
| `max_iterations` | integer `> 0` | No | `null` | Global loop-iteration cap across all loops. |
| `max_runtime_sec` | integer `> 0` | No | `null` | Global runtime cap. |
| `max_total_tasks` | integer `> 0` | No | `null` | Global task-attempt cap. |
| `max_failures` | integer `>= 0` | No | `null` | Global failure cap. |
| `retry` | object | No | `{ "max_retries": 0, "retry_on": ["FAILED","TIMEOUT"] }` | Global retry policy applied to every task. |

### `policy.retry`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `max_retries` | integer `>= 0` | No | `0` | Additional attempts after first failure. |
| `retry_on` | (`"FAILED"` \| `"TIMEOUT"` \| `"BLOCKED"`)[] | No | `["FAILED","TIMEOUT"]` | Failure classes eligible for retry. |

### `runtime`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `run_root` | string | No | `"tmp/agentflow_runs"` | Directory root where run artifacts are written. |
| `run_id` | string | No | generated | Optional explicit run id. |
| `cleanup_worktrees` | boolean | No | `true` | Cleanup created worktrees/branches on finalize. |
| `dry_run` | boolean | No | `false` | Parsed but CLI `--dry-run` controls actual dry mode. |
| `worker_timeout_sec` | integer `>= 0` | No | `7200` | Per-task timeout in seconds (`0` disables timeout). |
| `timeout_grace_sec` | integer `>= 1` | No | `20` | Grace seconds before hard process termination. |
| `max_parallel_tasks` | integer `> 0` | No | `null` | Cap for concurrent child execution when `group.parallel=true`. |

## Flow Nodes

### `task`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | `"task"` | Yes | none | Node discriminator. |
| `id` | string | Yes | none | Task id (must be globally unique in plan). |
| `prompt` | string | Yes | none | Task instruction text. |
| `provider` | `"codex"` \| `"cursor"` | No | `defaults.provider` | Optional per-task provider override. |
| `model` | string | No | `defaults.model` | Optional per-task model override. |
| `context_files` | string[] | No | `[]` | Task-only context files (added after global context files). |

### `group`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | `"group"` | Yes | none | Node discriminator. |
| `id` | string | Yes | none | Group id used in logs/traces. |
| `parallel` | boolean | Yes | none | `true` runs child steps concurrently, `false` runs in-order sequentially. |
| `steps` | flow node[] | Yes | none | Non-empty child node array. |

### `loop`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | `"loop"` | Yes | none | Node discriminator. |
| `id` | string | Yes | none | Loop id used in traces/artifacts. |
| `max_iterations` | integer `> 0` | No | `null` | Per-loop cap; falls back to `policy.max_iterations`; defaults to 1 if neither is set. |
| `gate` | gate object | Yes | none | Loop evaluator gate. |
| `body` | flow node[] | Yes | none | Non-empty child node array run each iteration. |

## Gates

### Shared Gate Keys

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | `"deterministic"` \| `"ai"` | Yes | none | Gate type. |
| `id` | string | No | `<loop_id>_gate` | Gate id used in evaluation artifact paths. |
| `score_threshold` | number | No | `null` | If set, gate passes only when `score >= threshold`. |
| `timeout_sec` | integer `> 0` | No | `120` | Gate timeout in seconds. |
| `required_artifacts` | string[] | No | `[]` | Required files; gate fails if missing. |

### Deterministic Gate (`type: "deterministic"`)

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `command` | string | Yes | none | Command executable. |
| `args` | string[] | No | `[]` | Command args. |
| `cwd` | string | No | project root | Command working directory (relative to project root when relative). |

### AI Gate (`type: "ai"`)

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | string | Yes | none | Evaluator instructions. |
| `provider` | `"codex"` \| `"cursor"` | No | `defaults.provider` | Gate provider override. |
| `model` | string | No | `defaults.model` | Gate model override. |
| `reasoning` | reasoning enum | No | `defaults.reasoning` | Gate reasoning override. |
| `profile` | string | No | `defaults.profile` | Gate profile override. |
| `include_recent_tasks` | integer `> 0` | No | `20` | Number of recent loop tasks/groups injected into gate prompt context. |

## Path Resolution

For `context_files` values:

- absolute path: used as-is
- `repo:<path>`: resolved from `target.repo_root`
- `plan:<path>`: resolved from plan file directory
- plain relative path: resolved from plan file directory

## Completion Contract

Each task must emit a status line in final output:

- `Status: DONE` or `Status: BLOCKED`
- `DONE` requires writing a report file at the path provided in the prompt

## Artifacts

Run directory: `runtime.run_root/<run_id>/`

Core:

- `run_state.json`
- `run_events.jsonl`
- `run_summary.md`
- `raw_thoughts.md`
- `decision_trace.json`

Per task:

- `prompt.md`
- `worker_exec.log`
- `worker_last_message.md`
- `worker_report.md`
- `worker_report.json`

Per gate:

- `evaluations/<gate_id>/...`

## Exit Codes

- `0`: success
- `1`: validation/execution failure
- `2`: CLI usage error

## Example

- [example_plan.json](./example_plan.json)

## Development

```bash
npm run typecheck
npm test
```

## Providers

### codex (default)

Uses `codex exec` with stdin piping and `-o` for output capture. Supports `--profile`, `--sandbox`, and `-c model_reasoning_effort=...` flags.

### cursor

Uses Cursor CLI (`agent -p`) in non-interactive print mode. The prompt is passed as a positional argument. Output is captured from stdout. Runs with `--force` and `--trust` for headless operation.

Sandbox mapping: `read-only` and `workspace-write` map to `--sandbox enabled`; `danger-full-access` maps to `--sandbox disabled`.

The `reasoning` and `profile` plan fields are silently ignored when the cursor provider is used, as the Cursor CLI does not support equivalent flags.
