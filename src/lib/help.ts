/**
 * Builds the short CLI usage text.
 * @returns Multi-line usage string shown for `--help` and arg errors.
 */
export function usageText() {
  return `agentflow

TLDR:
- File-driven workflow orchestrator for coding agents.
- Run a JSON plan with task/group/loop nodes and deterministic artifacts.

Usage:
- agentflow --plan <plan_file> [--dry-run] [--skip-git-repo-check] [--sandbox <mode>]
- agentflow <plan_file>
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
- agentflow --plan plan.json --skip-git-repo-check
  Forward trust/skip flags to each provider invocation.
- agentflow --plan plan.json --sandbox workspace-write
  Force worker sandbox mode for each task launch.
`;
}

/**
 * Builds the extended plan schema help text.
 * @returns Multi-line help content shown for `--plan-help`.
 */
export function planHelpText() {
  return `Plan File Help

What this command gives you:
- A detailed plan schema reference.
- A mental model for how task/group/loop execution works.
- Copy/paste JSON examples.
- Common mistakes and exact error messages.

Mental model:
- task: one agent execution unit.
- group: a container of child nodes; set parallel=false for sequential or parallel=true for concurrent.
- loop: repeats body until its gate passes (or max_iterations is exhausted).
- gate: loop evaluator, either deterministic (command) or ai (model output as JSON).

Minimal valid plan (JSON):
{
  "setup": "Implement the requested change with tests.",
  "target": { "repo_root": "." },
  "flow": [
    { "type": "task", "id": "implement", "prompt": "Implement the feature." }
  ]
}

Full schema skeleton (all top-level objects shown):
{
  "version": "1",
  "setup": "Global instructions for every task.",
  "objective": "Optional objective for loops and evaluators.",
  "target": {
    "repo_root": ".",
    "use_worktrees": true
  },
  "defaults": {
    "provider": "codex",        // or "cursor"
    "model": "gpt-5-nano",
    "reasoning": "xhigh",       // codex only; ignored by cursor
    "profile": null              // codex only; ignored by cursor
  },
  "policy": {
    "fail_mode": "stop",
    "max_runtime_sec": null,
    "max_iterations": null,
    "max_total_tasks": null,
    "max_failures": null,
    "retry": {
      "max_retries": 0,
      "retry_on": ["FAILED", "TIMEOUT"]
    }
  },
  "runtime": {
    "run_root": "tmp/agentflow_runs",
    "run_id": null,
    "cleanup_worktrees": true,
    "dry_run": false,
    "worker_timeout_sec": 7200,
    "timeout_grace_sec": 20,
    "max_parallel_tasks": null
  },
  "context_files": ["README.md"],
  "flow": [
    {
      "type": "group",
      "id": "build_and_test",
      "parallel": false,
      "steps": [
        { "type": "task", "id": "implement", "prompt": "Implement feature X." },
        { "type": "task", "id": "test", "prompt": "Run tests and summarize results." }
      ]
    },
    {
      "type": "loop",
      "id": "quality_loop",
      "max_iterations": 3,
      "gate": {
        "type": "deterministic",
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
- setup (required)
- objective (optional)
- target (required): repo_root, use_worktrees
- defaults (optional): provider ("codex" or "cursor"), model, reasoning, profile
- policy (optional): fail_mode, max_runtime_sec, max_iterations, max_total_tasks, max_failures, retry
- runtime (optional): run_root, run_id, cleanup_worktrees, dry_run, worker_timeout_sec, timeout_grace_sec, max_parallel_tasks
- context_files (optional)
- flow (required, non-empty)

Flow nodes:
- task:
  - type: "task"
  - id: required, globally unique
  - prompt: required
  - provider: optional ("codex" or "cursor")
  - model: optional
  - context_files: optional
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
  { "type": "deterministic", "command": "...", "args": [], "cwd": "...", "timeout_sec": 30, "score_threshold": 0.9, "required_artifacts": [] }
- ai gate:
  { "type": "ai", "prompt": "...", "provider": "codex", "model": "gpt-5-nano", "reasoning": "xhigh", "profile": null, "include_recent_tasks": 20, "timeout_sec": 120, "score_threshold": 0.9, "required_artifacts": [] }
  (provider may also be "cursor"; reasoning/profile are codex-only)

Gate output contract:
- JSON object with: passed (boolean), score (number|null), reasons (string[])
- if score_threshold exists, pass requires score >= threshold
- otherwise pass requires passed=true

Path resolution:
- --plan path: resolved from shell cwd
- target.repo_root: resolved from plan directory when relative
- context_files:
  - absolute path: used as-is
  - repo:<path>: resolved from target.repo_root
  - plan:<path>: resolved from plan directory
  - plain relative path: resolved from plan directory

Schema behavior + invariants:
- unknown keys hard-fail at every object level
- flow must be non-empty
- task ids must be unique across the entire workflow
- group.parallel is required and must be boolean
- group.steps and loop.body must be non-empty

Common mistakes (and actual error text):
- using old node type "parallel":
  - flow[0].type must be one of: task, group, loop.
- omitting group.parallel:
  - flow[0].parallel must be a boolean.
- unknown top-level key:
  - plan contains unknown key: "my_key".
- unknown nested key:
  - target contains unknown key: "my_key".
- missing context file:
  - Configured context file(s) not found: ...

CLI options:
- --plan <file>: plan file path (JSON)
- --dry-run: force dry-run (live run is the default)
- --skip-git-repo-check: pass through to provider CLI for non-git/trust-check-blocked roots
- --sandbox <mode>: worker sandbox mode (read-only, workspace-write, danger-full-access); default is workspace-write. For cursor provider, maps to enabled/disabled.
`;
}
