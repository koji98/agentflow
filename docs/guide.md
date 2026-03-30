# Blueprint-Driven Agent Orchestration

agentflow plans are **blueprints** — structured specifications that decompose _[large-scale]_ codebase changes into atomic, sequential agent tasks/commands with built-in validation and review.

This guide covers the methodology for designing effective blueprints that produce reliable, high-quality results across hundreds of files and multiple repositories.

## Core Principles

### 1. Atomic Tasks

Each task should do **one focused thing**. If you find yourself writing "and then also..." in a prompt, split it into two tasks.

**Why:** Agents perform best with clear, bounded scope. A task that modifies 20 files with a consistent pattern will succeed far more reliably than one that modifies 200 files with mixed patterns.

**Rule of thumb:** If a task touches more than ~80 files or involves more than one type of change, break it down.

### 2. Explicit Over Implicit

Never assume the agent knows which branch it's on, which files to skip, or what the expected output looks like. State everything.

Bad:
```
"Update all the config files with the new pattern."
```

Good:
```
"Add the `deprecated = True` flag to every model class in `app/models/legacy/`.

For each .py file in that directory:
1. Import `deprecated` from `app.decorators` if not already imported
2. Add `deprecated = True` as a class attribute after `class Meta`

Files to modify (~25 files):
  ls app/models/legacy/*.py

Verify with: grep -rL 'deprecated = True' app/models/legacy/*.py
Expected: 0 files missing."
```

### 3. Verify After Every Batch

Every modification batch should end with a verification step — either within the task itself or in a dedicated review task. Never trust that changes were applied correctly without checking.

### 4. Chain Context, Don't Repeat It

Use `context_from` to pass learnings between tasks. A review task's findings normally flow into the next batch via its summary, but tasks can opt into full reports with `context_from_artifact: "report"` when a short summary is not enough.

### 5. Fail Forward

Set `on_failure: "continue"` for long-running plans. A failure in one batch shouldn't block the remaining 15 tasks. Fix failures with `--resume` after the run completes.

## Blueprint Architecture

Every effective blueprint follows a three-phase structure:

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────┐
│ PREPARATION │ ──▶ │    EXECUTION     │ ──▶ │   VALIDATION   │
│             │     │ (batched + reviewed) │  │   + DELIVERY   │
└─────────────┘     └──────────────────┘     └────────────────┘
```

### Phase 1: Preparation

Extract reference data, write validation tooling, and establish the ground truth that execution tasks will work against.

Preparation tasks run on the default branch. They produce artifacts (JSON reference files, validation scripts) that downstream tasks consume.

**Examples:**
- Parse an API schema to extract endpoint definitions into a JSON reference
- Write a validation script that checks specific invariants
- Generate a mapping file from one system's naming to another's

### Phase 2: Execution

The bulk of the plan. Organized into **batched groups** with review steps between batches.

**Batch sizing guidelines:**

| Change complexity | Files per batch |
|---|---|
| Identical change to every file (add import + 1 line) | 60–100 |
| Varied changes by category (different values per file) | 15–30 |
| Complex changes requiring judgment | 5–15 |

**Review cadence:** Add a review/canary task after the first batch of any new pattern. If the first batch succeeds and the canary confirms correctness, subsequent batches following the same pattern will be reliable.

### Phase 3: Validation + Delivery

Run comprehensive validation, include proof in outputs (commit messages, PR descriptions), and deliver the results (push branches, create PRs).

## Plan Topology

### Sequential (recommended default)

```json
{
  "worktrees": false,
  "limits": { "max_parallel_tasks": 1 },
  "flow": [
    { "type": "group", "id": "phase_1", "parallel": false, "steps": ["..."] },
    { "type": "group", "id": "phase_2", "parallel": false, "steps": ["..."] }
  ]
}
```

All tasks execute one at a time in a single working directory. Simpler, predictable, no worktree overhead. **Use this unless you have a specific reason for parallelism.**

### Parallel (for independent work)

```json
{
  "worktrees": true,
  "flow": [{
    "type": "group",
    "id": "independent_work",
    "parallel": true,
    "steps": [
      { "type": "task", "id": "update_api", "repo": "api", "prompt": "..." },
      { "type": "task", "id": "update_web", "repo": "web", "prompt": "..." }
    ]
  }]
}
```

Tasks run concurrently. With `worktrees: true`, each step gets its own isolated worktree branch.
Use this only for truly independent work across repos or directories with no shared state.

**Warning:** `parallel: true` does not imply worktrees by itself. If `worktrees: false`, parallel steps share one working directory and can race each other.

When `worktrees: true` and steps run sequentially, each successful step's repo changes are snapshotted so later steps in the same repo start from that updated state.
If your branch policy disallows `/`, set `options.worktree_branch_template` to a slash-free format (must include `{group}`).

### Loop + Gate (for convergent quality)

```json
{
  "type": "loop",
  "id": "fix_until_clean",
  "max_iterations": 4,
  "gate": {
    "type": "deterministic",
    "command": "python3",
    "args": ["scripts/validate.py"],
    "timeout_sec": 120
  },
  "body": [{
    "type": "task",
    "id": "fix_issues",
    "prompt": "Read the gate feedback and fix every issue listed..."
  }]
}
```

Loops repeat until the gate passes or iterations are exhausted. Use for tasks where you can programmatically verify correctness.

### Command nodes (for deterministic orchestration)

Use `type: "command"` for deterministic steps that should run exactly as written (for example nested `agentflow --validate`, git operations, or PR creation):

```json
{
  "type": "command",
  "id": "validate_child",
  "repo": "main",
  "command": "/bin/zsh",
  "args": ["-lc", "agentflow --plan ./child.json --validate"],
  "cwd": ".",
  "timeout_sec": 600,
  "allow_failure": false
}
```

`command` nodes stream stdout/stderr live in the parent CLI and also write `command_exec.log`, `command_result.json`, `summary.md`, and `report.md`. Their summaries can be referenced by downstream tasks via `context_from`.

## Context File Strategy

### Global context (injected into every task)

Use sparingly. Only include files that every single task needs — typically a guide document with rules and patterns.

```json
{
  "context_files": ["plan:GUIDE.md"]
}
```

### Per-task context

Give each task only the files it needs. An extraction task needs the source file. A porting task needs the reference, target base classes, and an exemplar.

```json
{
  "type": "task",
  "id": "update_models",
  "context_files": [
    "backend:src/models/base.py",
    "backend:src/models/user.py",
    "frontend:scripts/schema_reference.json"
  ]
}
```

### context_from (prior task context)

By default, all prior task summaries are injected. Use explicit `context_from` to limit noise:

```json
{
  "context_from": ["extract_schema", "write_validator"]
}

Use `context_from_artifact: "report"` when a downstream task needs the full worker report instead of the brief summary:

```json
{
  "context_from": ["extract_schema"],
  "context_from_artifact": "report"
}
```
```

This is critical for long plans — task 20 doesn't need the summary from task 3 if they're unrelated.

## Resource Limits

### Conservative defaults for production plans

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

**Key settings:**

- **`worker_timeout_sec`**: Default 7200 (2 hours). Don't lower this for complex tasks — agents may need time for large batches.
- **`max_iterations`**: Set to `null` globally to avoid premature loop exhaustion on resume. Set per-loop `max_iterations` instead.
- **`max_total_tasks`**: Set higher than your task count to leave room for retries and loop iterations.
- **`max_failures`**: Allow some failures for `on_failure: "continue"` plans. You can fix them with `--resume`.

## Git Workflow Patterns

### Branch-per-category

When splitting changes into multiple PRs, have each task group operate on its own branch:

```
Task 1: git checkout branch-A → modify → commit → push
Task 2: git checkout branch-B → modify → commit → push
```

Each task should:
1. Verify its branch at the start
2. Copy shared scripts from the default branch if needed
3. Return to the default branch at the end

### Proof-based commits

Include validation output directly in commit messages:

```bash
git commit -m "chore: migrate user models

Validation proof:
$(python3 scripts/validate.py 2>/dev/null)"
```

This makes the commit itself the evidence that the changes are correct.

## Anti-Patterns

### The Mega Task
Asking one agent to modify 300 files across 4 categories. Break it into 4+ focused tasks.

### The Vague Prompt
"Update all the files." Which files? What update? What's the expected output? Always be explicit.

### The Missing Branch Check
Assuming the agent is on the right branch. Always start with `git checkout <branch>` or a verification.

### Over-Parallelism
Running 8 tasks in parallel on the same repo. Worktrees add overhead and merge conflicts. Default to sequential.

### Tight Limits
Setting `max_iterations: 3` globally when you have multiple loops. One loop exhaustion kills the entire run. Use `null` globally and set per-loop limits.

### Context Overload
Putting 15 context files at the global level. Each task only needs 2-3 files. Use per-task `context_files`.
