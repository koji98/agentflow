# Cursor Rule for Plan Authoring

This file is a [Cursor Rule](https://docs.cursor.com/context/rules-for-ai) you can copy into your own project to get AI-assisted plan authoring.

## Setup

Copy the content below the divider into your project:

```
.cursor/rules/agentflow-plans.md
```

The `globs` pattern will activate it whenever you edit a file matching `*plan*.json` or `*agentflow*.json`.

---

```markdown
---
description: Rules for authoring agentflow plan JSON files
globs:
  - "**/*.plan.json"
  - "**/plan_*.json"
  - "**/*_plan.json"
  - "**/agentflow*.json"
---

# Agentflow Plan Authoring Rules

When creating or editing agentflow plan JSON files, follow these rules strictly.

## Plan JSON Schema

### Required top-level fields

- `repos` (object): Map of alias → repo path. Relative paths resolve from the plan file's directory.
- `flow` (array): Non-empty array of workflow nodes.

### Common top-level fields

- `provider`: `"codex"` or `"cursor"`. Default: `"codex"`.
- `model`: Model identifier string passed to the provider CLI.
- `worktrees`: `false` (default) or `true`. Set `true` only when you need isolated per-step workspaces.
- `persona`: Default persona injected into all task prompts. Override per-task.
- `setup`: Background instructions injected into every task prompt.
- `objective`: Overall goal shared with agents and loop evaluators.
- `context_files`: File paths every task should read. Use sparingly.
- `on_failure`: `"stop"` (default) or `"continue"`.
- `limits`: Resource limits object.
- `options`: Runtime options (run_root, cleanup_worktrees).
- `options.worktree_branch_template`: Optional branch naming template for worktree mode. Placeholders: `{run_id}`, `{repo}`, `{group}`, `{node}`, `{attempt}`, `{kind}`, `{kind_short}`. Must include `{group}`.

### Node types

1. **`task`** — Single agent invocation. Fields: `type`, `id`, `prompt`, `repo` (required when multiple repos), `provider`, `model`, `persona`, `context_files`, `context_from`.
2. **`group`** — Container. Fields: `type`, `id`, `parallel` (boolean, required), `steps` (non-empty array).
3. **`loop`** — Repeating container. Fields: `type`, `id`, `max_iterations`, `gate` (object), `body` (non-empty array).

### Gate types (inside loop)

1. **`deterministic`** — Runs a command, parses stdout as JSON `{ "passed": bool, "score": number|null, "reasons": string[] }`.
2. **`ai`** — Prompts a model for the same JSON output.

## Architecture Rules

- Structure plans as: **Preparation → Execution → Validation/Delivery**.
- One focused objective per task. If the prompt says "and then also", split it.
- Batch sizes: 60–100 files for identical changes, 15–30 for varied, 5–15 for complex.
- Default to `"worktrees": false` and `"parallel": false` unless tasks are truly independent.
- Never set `limits.max_iterations` globally — set per-loop `max_iterations` instead.

## Prompt Rules

- Every task must have a persona (global or per-task).
- Every task must list exact files/patterns to modify AND files to exclude.
- Every modification task must include a verification command.
- Every task must specify what to write in summary.md.
- Branch tasks must verify git state at start and return to default branch at end.

## Limits

Always set generous limits:
```json
{
  "limits": {
    "max_retries": 2,
    "worker_timeout_sec": 7200,
    "max_total_tasks": 50,
    "max_failures": 6,
    "max_runtime_sec": 172800,
    "max_iterations": null
  }
}
```

## Context Files

- `plan:FILE` — relative to plan file directory.
- `ALIAS:PATH` — relative to named repo root.
- `/absolute/path` — used as-is.
- Keep global context minimal. Prefer per-task `context_files`.
- Set explicit `context_from` for tasks beyond position 5.

## Anti-Patterns

1. Mega tasks (300 files in one task)
2. Vague prompts ("update the files")
3. Missing branch checks
4. Tight global `max_iterations`
5. Context overload (15 global context files)
6. Parallel groups with overlapping file modifications
7. No verification step
8. No persona

## Validate before running

```bash
agentflow --plan plan.json --validate
```
```
