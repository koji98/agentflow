# Agentflow Blueprints

> Paste this entire document into an LLM conversation to get help writing agentflow plans.

agentflow is a file-driven workflow orchestrator for coding agents. You write a JSON plan with `task`, `command`, `group`, and `loop` nodes, and agentflow executes it — spawning agent CLI sessions, running deterministic shell commands, managing git worktrees, evaluating loop gates, and writing deterministic run artifacts.

Plans are **blueprints**: structured specifications that decompose large-scale codebase work into atomic, sequential agent tasks with built-in validation.

---

## Complete Plan JSON Schema

### Minimal valid plan

```json
{
  "repos": { "main": "." },
  "flow": [
    { "type": "task", "id": "implement", "prompt": "Implement the feature." }
  ]
}
```

### All top-level keys

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `version` | string | No | — | Optional metadata |
| `setup` | string | No | `""` | Global instructions injected into every task prompt |
| `objective` | string | No | `null` | Overall goal shared with agents and loop evaluators |
| `persona` | string | No | `null` | Default persona for all tasks and AI-gate fallback |
| `repos` | object | **Yes** | — | Map of alias → repo path (relative paths resolve from plan file directory) |
| `provider` | `"codex"` \| `"cursor"` | No | `"codex"` | Default agent CLI provider |
| `model` | string | No | `"gpt-5-nano"` | Default model identifier |
| `reasoning` | string | No | `"xhigh"` | Reasoning effort (codex only; ignored by cursor) |
| `profile` | string | No | `null` | Profile (codex only; ignored by cursor) |
| `on_failure` | `"stop"` \| `"continue"` | No | `"stop"` | Stop on first failure or continue |
| `worktrees` | boolean | No | `true` | Use git worktrees for per-task isolation |
| `context_files` | string[] | No | `[]` | Files every task should read |
| `limits` | object | No | see below | Resource limits, retries, caps |
| `options` | object | No | see below | Runtime settings |
| `flow` | node[] | **Yes** | — | Non-empty array of workflow nodes |

Unknown keys are rejected at every level.

### `limits` object

| Key | Type | Default | Description |
|---|---|---|---|
| `max_retries` | integer | `0` | Retry count per failed task |
| `retry_on` | string[] | `["FAILED","TIMEOUT"]` | Which outcomes trigger retry |
| `max_iterations` | integer | `null` | Global loop iteration cap (prefer per-loop instead) |
| `max_runtime_sec` | integer | `null` | Max total run time in seconds |
| `max_total_tasks` | integer | `null` | Max total executable node executions (task + command, including retries) |
| `max_failures` | integer | `null` | Max failures before abort |
| `worker_timeout_sec` | integer | `7200` | Per-task timeout in seconds |
| `timeout_grace_sec` | integer | `20` | Grace period between SIGTERM and SIGKILL |
| `max_parallel_tasks` | integer | `null` | Concurrency cap for parallel groups |

### `options` object

| Key | Type | Default |
|---|---|---|
| `run_root` | string | `"tmp/agentflow_runs"` |
| `run_id` | string | `null` |
| `cleanup_worktrees` | boolean | `true` |

### Node types

#### `task` — single agent invocation

| Key | Type | Required | Default |
|---|---|---|---|
| `type` | `"task"` | Yes | — |
| `id` | string | Yes | — (must be globally unique) |
| `prompt` | string | Yes | — |
| `repo` | string | No | single repo default (required when multiple repos) |
| `provider` | string | No | plan-level |
| `model` | string | No | plan-level |
| `persona` | string | No | plan-level |
| `context_files` | string[] | No | `[]` |
| `context_from` | string[] | No | all prior tasks |

#### `command` — single deterministic shell command

| Key | Type | Required | Default |
|---|---|---|---|
| `type` | `"command"` | Yes | — |
| `id` | string | Yes | — (must be globally unique across task + command ids) |
| `repo` | string | No | single repo default (required when multiple repos) |
| `command` | string | Yes | — |
| `args` | string[] | Yes | — (may be empty) |
| `cwd` | string | No | repo root (must be relative) |
| `timeout_sec` | integer | No | falls back to `limits.worker_timeout_sec` |
| `allow_failure` | boolean | No | `false` |

#### `group` — container of child nodes

| Key | Type | Required |
|---|---|---|
| `type` | `"group"` | Yes |
| `id` | string | Yes |
| `parallel` | boolean | Yes (`false` = sequential, `true` = concurrent) |
| `steps` | node[] | Yes (non-empty) |

#### `loop` — repeating container with gate

| Key | Type | Required |
|---|---|---|
| `type` | `"loop"` | Yes |
| `id` | string | Yes |
| `max_iterations` | integer | No (falls back to `limits.max_iterations`, then 1) |
| `gate` | object | Yes |
| `body` | node[] | Yes (non-empty) |

### Gate types (inside `loop.gate`)

**Deterministic gate** — runs a command, parses stdout as JSON:

```json
{
  "type": "deterministic",
  "command": "python3",
  "args": ["scripts/validate.py", "--json"],
  "repo": "main",
  "cwd": ".",
  "timeout_sec": 30,
  "score_threshold": 0.9,
  "required_artifacts": []
}
```

**AI gate** — prompts a model, parses output as JSON:

```json
{
  "type": "ai",
  "prompt": "Evaluate whether the objective is complete...",
  "repo": "main",
  "persona": "You are a strict QA evaluator.",
  "provider": "codex",
  "model": "gpt-5-nano",
  "reasoning": "xhigh",
  "include_recent_tasks": 20,
  "timeout_sec": 120,
  "score_threshold": 0.9,
  "required_artifacts": []
}
```

**Gate output contract:** `{ "passed": boolean, "score": number|null, "reasons": string[] }`

If `score_threshold` is set, pass requires `score >= threshold`. Otherwise pass requires `passed: true`.

Gate feedback (pass/fail, score, reasons) is automatically injected into the next loop iteration's task prompt.

### Path resolution for `context_files`

| Format | Resolves from |
|---|---|
| `/absolute/path` | Used as-is |
| `alias:relative/path` | Named repo root |
| `plan:relative/path` | Plan file directory |
| `relative/path` | Plan file directory |

### Task completion contract

- **DONE**: exit code 0 + report file exists
- **FAILED**: nonzero exit, timeout, or missing report

Each task is prompted to write `report.md` (required for DONE) and `summary.md` (feeds into downstream `context_from`).

### Command completion contract

- **DONE**: exit code 0
- **FAILED**: nonzero exit, timeout, or spawn error

Each command node writes `command_exec.log`, `command_result.json`, `summary.md`, and `report.md`.

---

## Blueprint Methodology

### Three-Phase Architecture

Every effective plan follows this structure:

```
PREPARATION → EXECUTION (batched + reviewed) → VALIDATION + DELIVERY
```

1. **Preparation**: Extract reference data, write validation scripts, establish ground truth. Runs on the default branch.
2. **Execution**: Batched modifications with review/canary steps between batches.
3. **Validation + Delivery**: Run validation, embed proof in commits, push branches, create PRs.

### Five Core Principles

1. **Atomic Tasks** — One focused objective per task. If the prompt says "and then also", split it. Max ~80 files for identical changes, ~30 for varied, ~15 for complex.

2. **Explicit Over Implicit** — List exact files to modify and files to exclude. Never say "update all files" without specifying which.

3. **Verify After Every Batch** — Every modification batch must end with a verification command or a dedicated review task.

4. **Chain Context, Don't Repeat It** — Use `context_from` to pass learnings forward. A review task's findings feed into the next batch automatically.

5. **Fail Forward** — Use `on_failure: "continue"` for long plans. Fix failures with `--resume`.

### Recommended Limits

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

Set `max_iterations: null` globally. Set per-loop `max_iterations` instead — a global cap applies across ALL loops and can cause premature exhaustion on resume.

---

## Prompt Construction

### Persona Formula

Every task needs a persona (global default or per-task override):

```
You are a senior [ROLE] with [N]+ years of experience in [DOMAIN].
You are an expert in [SPECIFIC_SKILLS]. You are [KEY_TRAIT] — [TRAIT_DESCRIPTION].
```

Examples:
- `"You are a senior backend engineer with 15+ years of experience in large-scale Python codebases. You are meticulous about consistency. You never miss a file and always verify your work."`
- `"You are a senior QA engineer focused on correctness and edge cases."`
- `"You are a senior DevOps engineer. You are meticulous about clean commits and validation proof."`

Add domain context when the task requires business logic knowledge:
```
You understand e-commerce data models — products, variants, inventory, orders...
```

### Five-Part Prompt Structure

```
1. CONTEXT       — Branch, state, what happened before
2. SCOPE         — Exact files to modify + files to EXCLUDE
3. PATTERN       — The exact code change with before/after examples
4. VERIFICATION  — Shell command to check the work + expected output
5. OUTPUT        — What to write in summary.md
```

### Example: Batch Modification Task

```
Add the @audit_log decorator to all service classes in src/services/.
First, verify you're on feat/add-audit-logging.

## Files to modify (~20 files)
All .py files in src/services/ EXCEPT __init__.py and base_service.py.
Find them: ls src/services/*.py | grep -v __init__ | grep -v base_service

## What to change
Before:
  class OrderService(BaseService):
After:
  from app.decorators import audit_log
  @audit_log
  class OrderService(BaseService):

## Verify
grep -rL '@audit_log' src/services/*.py | grep -v __init__ | grep -v base_service
Expected: 0 results

In your summary.md: list every file modified, total count, any issues.
```

### Example: Script Authoring Task

```
Write scripts/validate.py that checks the migration.

Usage: python3 scripts/validate.py [--json]

Checks:
1. Find all .py files in src/services/ (excluding __init__, base_service)
2. Verify @audit_log decorator present on each class
3. Verify import exists

JSON output (gate-compatible):
{ "passed": true, "score": 1.0, "reasons": [], "summary": { "files_checked": 20 } }

Constraints: stdlib only, no app imports, runnable from repo root.
```

### Example: Validate and Deliver Task

```
Run validation, commit with proof, and push.
Verify you're on feat/add-audit-logging.

Step 1: python3 scripts/validate.py --json → capture output, fix issues
Step 2: python3 -m pytest tests/services/ -v → confirm passing
Step 3:
  git add -A
  git commit -m "feat: add audit logging
  Validation: $(python3 scripts/validate.py --json 2>/dev/null)"
  git push origin feat/add-audit-logging
Step 4: git checkout main

In your summary.md: validation output, test results, push confirmation.
```

---

## Plan Patterns

### 1. Extract → Transform → Validate (ETV)

One agent extracts reference data, another transforms the target, a third validates.

```json
{
  "repos": { "source": "../source-repo", "target": "../target-repo" },
  "worktrees": false,
  "flow": [
    { "type": "task", "id": "extract", "repo": "source", "prompt": "Extract data into scripts/reference.json..." },
    { "type": "task", "id": "write_validator", "repo": "target", "prompt": "Write scripts/validate.py..." },
    { "type": "task", "id": "apply", "repo": "target", "prompt": "Apply changes using the reference...", "context_files": ["source:scripts/reference.json"] },
    { "type": "task", "id": "validate", "repo": "target", "prompt": "Run validation and fix issues...", "context_from": ["apply"] }
  ]
}
```

### 2. Batch + Review

First batch gets a canary review; subsequent batches inherit confidence.

```json
{
  "flow": [
    { "type": "task", "id": "batch_1", "prompt": "Modify files A-G (15 files)..." },
    { "type": "task", "id": "canary_review", "persona": "You are a meticulous code reviewer.", "prompt": "Review 5 files from batch 1...", "context_from": ["batch_1"] },
    { "type": "task", "id": "batch_2", "prompt": "Modify files H-P...", "context_from": ["canary_review"] },
    { "type": "task", "id": "batch_3", "prompt": "Modify files Q-Z...", "context_from": ["canary_review"] }
  ]
}
```

### 3. Loop Until Clean

Deterministic gate repeats fix task until validation passes.

```json
{
  "type": "loop",
  "id": "fix_until_valid",
  "max_iterations": 4,
  "gate": {
    "type": "deterministic",
    "command": "python3",
    "args": ["scripts/validate.py", "--json"],
    "timeout_sec": 120
  },
  "body": [
    { "type": "task", "id": "fix_issues", "prompt": "Read the gate feedback. Fix EVERY issue in the reasons array." }
  ]
}
```

### 4. Multi-Branch Pipeline

Process multiple branches sequentially: checkout → modify → validate → push.

```json
{
  "flow": [
    {
      "type": "group", "id": "branch_a", "parallel": false,
      "steps": [
        { "type": "task", "id": "a_checkout", "prompt": "git checkout branch-a..." },
        { "type": "task", "id": "a_modify", "prompt": "Apply changes..." },
        { "type": "task", "id": "a_push", "prompt": "Validate, commit with proof, push..." }
      ]
    },
    {
      "type": "group", "id": "branch_b", "parallel": false,
      "steps": [
        { "type": "task", "id": "b_checkout", "prompt": "git checkout branch-b..." },
        { "type": "task", "id": "b_modify", "prompt": "Apply changes..." },
        { "type": "task", "id": "b_push", "prompt": "Validate, commit with proof, push..." }
      ]
    }
  ]
}
```

### 5. Preparation Fan-Out

Independent prep tasks in parallel (safe when targeting different repos).

```json
{
  "flow": [
    {
      "type": "group", "id": "prep", "parallel": true,
      "steps": [
        { "type": "task", "id": "extract_ui", "repo": "ui", "prompt": "Extract into JSON..." },
        { "type": "task", "id": "extract_api", "repo": "api", "prompt": "Extract into JSON..." }
      ]
    },
    {
      "type": "task", "id": "merge", "repo": "target",
      "prompt": "Merge both references...",
      "context_files": ["ui:scripts/ref.json", "api:scripts/ref.json"],
      "context_from": ["extract_ui", "extract_api"]
    }
  ]
}
```

### 6. Cascading PR Orchestrator (command nodes)

Use command nodes to deterministically run child plans and git/gh commands per branch in sequence.

```json
{
  "repos": { "main": "." },
  "flow": [
    {
      "type": "command",
      "id": "validate_child_01",
      "repo": "main",
      "command": "/bin/zsh",
      "args": ["-lc", "agentflow --plan ./plans/child_01.json --validate"],
      "timeout_sec": 600
    },
    {
      "type": "command",
      "id": "run_child_01",
      "repo": "main",
      "command": "/bin/zsh",
      "args": ["-lc", "agentflow --plan ./plans/child_01.json"],
      "timeout_sec": 7200
    },
    {
      "type": "command",
      "id": "push_child_01",
      "repo": "main",
      "command": "/bin/zsh",
      "args": ["-lc", "git add -A && git commit -m 'chore: child 01' && git push -u origin HEAD"]
    },
    {
      "type": "command",
      "id": "pr_child_01",
      "repo": "main",
      "command": "/bin/zsh",
      "args": ["-lc", "gh pr create --base stack/parent --title 'child 01' --body 'Automated by agentflow'"]
    }
  ]
}
```

### Composing Patterns

Real plans combine patterns:

```
Preparation Fan-Out ──▶ Batch + Review ──▶ Loop Until Clean ──▶ Multi-Branch Pipeline
```

---

## Anti-Patterns

| Anti-Pattern | Why it fails | Fix |
|---|---|---|
| **Mega task** (300 files) | Agent loses track, misses files | Split into 15-30 file batches |
| **Vague prompt** ("update the files") | Agent guesses wrong | List exact files, exact change, exact verification |
| **No persona** | Lower quality, less focused | Always set persona (global or per-task) |
| **No verification** | Silent failures | Add verification command + expected output |
| **Missing branch check** | Modifies wrong branch | Start every branch task with `git checkout` |
| **Global `max_iterations`** | One loop exhaustion kills the run | Set `null` globally, use per-loop |
| **Context overload** | 15 global context files bloat prompts | Use per-task `context_files`, 2-3 max |
| **Over-parallelism** | Worktree conflicts in same repo | Default to sequential |
| **Tight timeouts** | Complex tasks time out | `worker_timeout_sec: 7200` minimum |
| **No `context_from`** | Task 20 gets 19 prior summaries | Set explicit `context_from` after task 5 |

---

## CLI Quick Reference

```bash
agentflow --plan plan.json                    # execute
agentflow --plan plan.json --validate         # validate only
agentflow --plan plan.json --dry-run          # simulate
agentflow --plan plan.json --resume <run_dir> # resume failed run
agentflow --plan-help                         # full schema reference
```

---

## Full Example Plan

```json
{
  "version": "1",
  "setup": "We are migrating all service classes to use the new audit logging decorator.",
  "objective": "Add @audit_log decorator to all services with validation proof.",
  "persona": "You are a senior Python engineer with 15+ years of experience. You are meticulous about consistency and always verify your work.",
  "repos": { "backend": "../backend" },
  "provider": "cursor",
  "model": "claude-4.6-opus-high",
  "worktrees": false,
  "on_failure": "continue",
  "context_files": ["plan:MIGRATION_GUIDE.md"],
  "limits": {
    "max_retries": 2,
    "worker_timeout_sec": 7200,
    "max_total_tasks": 30,
    "max_failures": 4,
    "max_iterations": null
  },
  "flow": [
    {
      "type": "task",
      "id": "write_validator",
      "prompt": "Write scripts/validate_audit.py that checks all service files for the @audit_log decorator. Output gate-compatible JSON: { passed, score, reasons }. Use stdlib only, no app imports.",
      "persona": "You are a senior test engineer who writes robust validation scripts."
    },
    {
      "type": "task",
      "id": "batch_1_core",
      "prompt": "Add @audit_log to the 10 core service files: order_service.py, payment_service.py, user_service.py, auth_service.py, cart_service.py, product_service.py, inventory_service.py, shipping_service.py, notification_service.py, analytics_service.py.\n\nFor each: add import and decorator before class definition.\n\nVerify: grep -rL '@audit_log' src/services/{order,payment,user,auth,cart,product,inventory,shipping,notification,analytics}_service.py\nExpected: 0\n\nIn your summary.md: list every file, confirm decorator + import added.",
      "context_from": ["write_validator"]
    },
    {
      "type": "task",
      "id": "canary_review",
      "persona": "You are a meticulous code reviewer focused on correctness and consistency.",
      "prompt": "Review 5 files from batch 1: order_service.py, payment_service.py, user_service.py, auth_service.py, cart_service.py.\n\nVerify:\n1. Import is correct\n2. Decorator is on the line before class definition\n3. No duplicate imports\n4. base_service.py was NOT modified\n\nFix any issues found.\n\nIn your summary.md: pass/fail per file, any fixes applied.",
      "context_from": ["batch_1_core"]
    },
    {
      "type": "task",
      "id": "batch_2_remaining",
      "prompt": "Add @audit_log to all remaining service files not yet modified.\n\nFind them: ls src/services/*.py | grep -v __init__ | grep -v base_service | grep -v '_service.py already done'\n\nSame pattern as batch 1. Verify: python3 scripts/validate_audit.py --json\n\nIn your summary.md: files modified, validation output.",
      "context_from": ["canary_review"]
    },
    {
      "type": "loop",
      "id": "validation_loop",
      "max_iterations": 3,
      "gate": {
        "type": "deterministic",
        "command": "python3",
        "args": ["scripts/validate_audit.py", "--json"],
        "timeout_sec": 60
      },
      "body": [
        {
          "type": "task",
          "id": "fix_validation",
          "prompt": "The validation gate failed. Read the reasons array from the gate feedback and fix EVERY issue. Do not skip any.\n\nAfter fixing, run: python3 scripts/validate_audit.py\nConfirm all checks pass.\n\nIn your summary.md: what was broken, what you fixed, final validation output."
        }
      ]
    },
    {
      "type": "task",
      "id": "deliver",
      "prompt": "Create a branch, commit with validation proof, and push.\n\ngit checkout -b feat/add-audit-logging\ngit add -A\ngit commit -m \"feat: add audit logging to all services\n\nValidation:\n$(python3 scripts/validate_audit.py --json 2>/dev/null)\"\ngit push -u origin feat/add-audit-logging\n\nIn your summary.md: branch name, commit hash, push confirmation, validation output.",
      "persona": "You are a senior DevOps engineer. Clean commits with validation proof.",
      "context_from": ["batch_2_remaining"]
    }
  ]
}
```
