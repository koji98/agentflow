# agentflow

A standalone Node/TypeScript workflow runner for agent CLIs.

It executes a plan file that describes tasks, parallel blocks, and looped quality gates over a target repository.

## What it does

- Runs agent tasks against any repo path you provide.
- Supports sequential, parallel, and loop-until-pass execution.
- Records deterministic run artifacts (state, events, logs, reports).
- Supports typed loop gates:
  - `deterministic` gate: command-based evaluator
  - `ai` gate: model-based evaluator with auto-injected loop context

## Install

```bash
cd agentflow
npm install
```

## Run

```bash
npm install
npx agentflow --help
npx agentflow --plan-help
npx agentflow --plan example_plan.json
```

CLI flags:
- `--plan <path>`: plan file path
- `--repo <path>`: override `target.repo_root` for this run
- `--plan-doc <path>`: override `plan_doc` for this run
- `--dry-run` / `--no-dry-run`: override `runtime.dry_run`

## Plan API

The plan file is JSON (or markdown with one fenced `json` block).

Required top-level fields:
- `setup`
- `target`
- `flow`

Main optional fields:
- `objective`
- `defaults`
- `policy`
- `runtime`
- `plan_doc`
- `context_files`

References:
- this README
- `./example_plan.json`

Path semantics:
- `--plan` is resolved from shell cwd.
- `target.repo_root` is resolved from the plan file directory.
- `plan_doc` and `context_files` are resolved from the plan file directory.
- Absolute paths are supported everywhere.
- Optional path prefixes in plan fields:
  - `repo:<path>` to resolve from resolved repo root.
  - `plan:<path>` to resolve from plan file directory.

## Flow model

- `task`: one agent execution unit.
- `parallel`: run child flow nodes concurrently.
- `loop`: run `body` repeatedly until `gate` passes or `max_iterations` is reached.

## Gate model

### Deterministic gate

Executes a command and evaluates its JSON output.

```json
{
  "type": "deterministic",
  "command": "node",
  "args": ["scripts/evaluate.js"],
  "score_threshold": 0.9
}
```

### AI gate

Prompts an agent model to judge completion. The runner auto-injects recent loop-task context.

```json
{
  "type": "ai",
  "prompt": "Decide whether quality is sufficient to stop iteration.",
  "provider": "codex",
  "model": "gpt-5-nano",
  "reasoning": "xhigh",
  "score_threshold": 0.9
}
```

Gate output contract:

```json
{
  "passed": true,
  "score": 0.93,
  "reasons": ["all acceptance checks passed"]
}
```

Pass rule:
- if `score_threshold` exists, requires `score >= score_threshold`
- otherwise requires `passed: true`

## Providers

- `codex`: implemented
- `cursor`: schema-supported, adapter placeholder

## Run artifacts

Each run writes to `runtime.run_root/<run_id>/`.

Core files:
- `run_state.json`
- `run_events.jsonl`
- `run_summary.md`
- `raw_thoughts.md`
- `decision_trace.json`

Per task:
- prompt file
- execution log
- last message output
- structured report metadata JSON

Per gate evaluation:
- `evaluations/<gate_id>/...`

## Development

```bash
npm run typecheck
```
