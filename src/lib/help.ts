/**
 * Builds the short CLI usage text.
 */
export function usageText() {
  return `agentflow

TLDR:
- File-driven workflow orchestrator for coding agents.
- Run a JSON plan with task/command/group/loop nodes and deterministic artifacts.

Usage:
- agentflow --plan <plan_file> [--dry-run] [--skip-git-repo-check] [--sandbox <mode>]
- agentflow --plan <plan_file> --validate
- agentflow --plan <plan_file> --resume <run_dir>
- agentflow --supervise <mission_state_file> [--supervisor-config <path>] [--supervisor-profile <name>] [--validate]
- agentflow --plan-help

Most useful commands:
- agentflow --help
  Show this command overview.
- agentflow --plan-help
  Show detailed plan schema and all supported keys.
- agentflow --plan example_plan.json
  Execute a live run from a plan file.
- agentflow --plan example_plan.json --dry-run
  Simulate execution without launching agent CLI sessions.
- agentflow --plan example_plan.json --validate
  Validate the plan schema and context files without running anything.
- agentflow --plan example_plan.json --resume tmp/agentflow_runs/20260227_120000
  Resume a previously failed run, skipping already-completed tasks.
- agentflow --plan plan.json --skip-git-repo-check
  Forward trust/skip flags to each provider invocation.
- agentflow --plan plan.json --sandbox workspace-write
  Force worker sandbox mode for each task launch.
- agentflow --supervise state/mission_state.json
  Run one supervisor cycle (planner + plan QA + approved child plan execution).
- agentflow --supervise state/mission_state.json --validate
  Validate supervisor config inputs without executing a cycle.
`;
}

/**
 * Builds the extended plan schema help text.
 */
export function planHelpText() {
  return `Plan File Help

What this command gives you:
- A detailed plan schema reference.
- A mental model for how task/command/group/loop execution works.
- Copy/paste JSON examples.
- Common mistakes and exact error messages.

Mental model:
- task: one agent execution unit.
- command: one deterministic shell command execution unit.
- group: a container of child nodes; set parallel=false for sequential or parallel=true for concurrent.
- loop: repeats body until its gate passes (or max_iterations is exhausted).
- gate: loop evaluator, either deterministic (command) or ai (model output as JSON).

Minimal valid plan (JSON):
{
  "repos": { "main": "." },
  "flow": [
    { "type": "task", "id": "implement", "prompt": "Implement the feature." }
  ]
}

Full schema skeleton (all keys shown):
{
  "version": "1",
  "setup": "Global instructions for every task.",
  "objective": "Optional objective shared with agents and evaluators.",
  "persona": "You are a senior software engineer specializing in TypeScript.",
  "repos": { "main": "." },
  "provider": "codex",
  "model": "gpt-5-nano",
  "reasoning": "xhigh",
  "profile": null,
  "on_failure": "stop",
  "worktrees": false,
  "context_files": ["README.md"],
  "limits": {
    "max_retries": 0,
    "retry_on": ["FAILED", "TIMEOUT"],
    "max_iterations": null,
    "max_runtime_sec": null,
    "max_total_tasks": null,
    "max_failures": null,
    "worker_timeout_sec": 7200,
    "timeout_grace_sec": 20,
    "max_parallel_tasks": null
  },
  "options": {
    "run_root": "tmp/agentflow_runs",
    "run_id": null,
    "cleanup_worktrees": false,
    "worktree_branch_template": "agentflow/{run_id}-r{repo}-g{group}-{kind_short}{node}-a{attempt}"
  },
  "flow": [
    {
      "type": "group",
      "id": "build_and_test",
      "parallel": false,
      "steps": [
        { "type": "task", "id": "implement", "repo": "main", "prompt": "Implement feature X." },
        { "type": "task", "id": "test", "repo": "main", "prompt": "Run tests and summarize results.", "context_from": ["implement"], "context_from_artifact": "summary", "persona": "You are a QA engineer." }
      ]
    },
    {
      "type": "command",
      "id": "validate_child_plan",
      "repo": "main",
      "command": "/bin/zsh",
      "args": ["-lc", "agentflow --plan ./child.json --validate"],
      "cwd": ".",
      "timeout_sec": 600,
      "allow_failure": false
    },
    {
      "type": "loop",
      "id": "quality_loop",
      "max_iterations": 3,
      "gate": {
        "type": "deterministic",
        "repo": "main",
        "command": "node",
        "args": ["scripts/evaluate.js"]
      },
      "body": [
        { "type": "task", "id": "fix_issues", "prompt": "Address evaluator feedback." }
      ]
    }
  ]
}

Top-level keys:
- version (optional)
- setup (optional, default ""): global background/instructions injected into every task prompt
- objective (optional): overall goal shared with agents and loop evaluators
- persona (optional): default persona injected into task prompts and used as AI-gate persona fallback
- repos (required): object mapping alias names to repo root paths, resolved from plan directory
- provider (optional, default "codex"): "codex" or "cursor"
- model (optional, default "gpt-5-nano"): model identifier
- reasoning (optional, default "xhigh"): codex only; ignored by cursor
- profile (optional): codex only; ignored by cursor
- on_failure (optional, default "stop"): "stop" or "continue"
- worktrees (optional, default false): use git worktrees for per-step branch isolation (opt-in); successful sequential steps in same repo are snapshotted forward
- context_files (optional): files every task should read first
- limits (optional): resource limits, retries, and caps
- options (optional): rarely changed runtime settings
- flow (required, non-empty): workflow nodes

Limits keys:
- max_retries (default 0): retry count per failed task
- retry_on (default ["FAILED","TIMEOUT"]): which task outcomes trigger retry
- max_iterations (default null): global loop iteration cap
- max_runtime_sec (default null): max total run time in seconds
- max_total_tasks (default null): max total executable node executions (task + command)
- max_failures (default null): max allowed failures before abort
- worker_timeout_sec (default 7200): per-task timeout
- timeout_grace_sec (default 20): grace period between SIGTERM and SIGKILL
- max_parallel_tasks (default null): concurrency cap for parallel groups

Options keys:
- run_root (default "tmp/agentflow_runs"): output directory base
- run_id (default null): override auto-generated run id
- cleanup_worktrees (default false): remove worktrees/branches created during run
- worktree_branch_template (default "agentflow/{run_id}-r{repo}-g{group}-{kind_short}{node}-a{attempt}"): template for generated worktree branch names; must include {group}; rendered segments are slug-sanitized

Flow nodes:
- task:
  - type: "task"
  - id: required, globally unique
  - prompt: required
  - repo: optional when repos has one entry; required when multiple repos
  - provider: optional ("codex" or "cursor")
  - model: optional
  - persona: optional (overrides plan-level persona for this task)
  - context_files: optional
  - context_from: optional array of task IDs whose downstream context to inject (default: all prior tasks)
  - context_from_artifact: optional, "summary" (default) or "report"; chooses whether context_from injects worker_summary.md or worker_report.md content
- command:
  - type: "command"
  - id: required, globally unique (shares namespace with task ids)
  - repo: optional when repos has one entry; required when multiple repos
  - command: required executable name/path
  - args: required array (may be empty)
  - cwd: optional relative path from resolved repo root
  - timeout_sec: optional command-level timeout override
  - allow_failure: optional boolean (default false)
- group:
  - type: "group"
  - id: required
  - parallel: required boolean
  - steps: required, non-empty flow array
- loop:
  - type: "loop"
  - id: required
  - max_iterations: optional
  - gate: required object
  - body: required, non-empty flow array

Loop gate shapes:
- deterministic gate:
  { "type": "deterministic", "repo": "main", "command": "...", "args": [], "cwd": "...", "timeout_sec": 30, "score_threshold": 0.9, "required_artifacts": [] }
- ai gate:
  { "type": "ai", "repo": "main", "prompt": "...", "persona": "You are a strict QA evaluator.", "provider": "codex", "model": "gpt-5-nano", "reasoning": "xhigh", "profile": null, "include_recent_tasks": 20, "timeout_sec": 120, "score_threshold": 0.9, "required_artifacts": [] }

Gate output contract:
- JSON object with: passed (boolean), score (number|null), reasons (string[])
- if score_threshold exists, pass requires score >= threshold
- otherwise pass requires passed=true

Task completion contract:
- exit code 0 + report file exists = DONE
- anything else = FAILED

Command completion contract:
- exit code 0 = DONE
- non-zero exit, timeout, or spawn error = FAILED

Path resolution:
- --plan path: resolved from shell cwd
- repos values: each resolved from plan directory when relative
- context_files:
  - absolute path: used as-is
  - <alias>:<path>: resolved from the named repo root (alias must match a key in repos)
  - plan:<path>: resolved from plan directory
  - plain relative path: resolved from plan directory

Schema behavior + invariants:
- unknown keys hard-fail at every object level
- flow must be non-empty
- task/command ids must be unique across the entire workflow
- group.parallel is required and must be boolean
- group.steps and loop.body must be non-empty

Common mistakes (and actual error text):
- using old node type "parallel":
  - flow[0].type must be one of: task, command, group, loop.
- omitting group.parallel:
  - flow[0].parallel must be a boolean.
- unknown top-level key:
  - plan contains unknown key: "my_key".
- unknown nested key:
  - limits contains unknown key: "my_key".
- missing context file:
  - Configured context file(s) not found: ...

CLI options:
- --plan <file>: plan file path (JSON)
- --validate: validate plan schema and context files, then exit (no directories created)
- --resume <run_dir>: resume a previously failed run, skipping already-completed tasks
- --dry-run: force dry-run (live run is the default)
- --skip-git-repo-check: pass through to provider CLI for non-git/trust-check-blocked roots
- --sandbox <mode>: worker sandbox mode (read-only, workspace-write, danger-full-access); default is workspace-write. For cursor provider, maps to enabled/disabled.
`;
}
