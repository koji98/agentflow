/**
 * Builds the short CLI usage text.
 * @returns Multi-line usage string shown for `--help` and arg errors.
 */
export function usageText() {
  return [
    'Usage: agentflow --plan <plan_file> [--dry-run]',
    '       agentflow <plan_file>',
    '       agentflow --plan-help',
  ].join('\n');
}

/**
 * Builds the extended plan schema help text.
 * @returns Multi-line help content shown for `--plan-help`.
 */
export function planHelpText() {
  return `Plan File Help\n\nCLI options:\n- --plan <file>: plan file path (JSON)\n- --dry-run: force dry-run (live run is the default)\n\nPath resolution:\n- --plan: relative to shell cwd\n- target.repo_root: relative to the plan file directory\n- context_files: relative to the plan file directory by default\n- absolute paths are always supported\n- optional prefixes in plan paths: repo:<path> and plan:<path>\n\nSchema behavior:\n- unknown keys hard-fail at every object level\n\nTop-level fields:\n- version (optional, \"1\")\n- setup (required)\n- objective\n- target { repo_root (required), use_worktrees }\n- defaults { provider, model, reasoning, profile }\n- policy { fail_mode, max_runtime_sec, max_iterations, max_total_tasks, max_failures, retry }\n- runtime { run_root, run_id, cleanup_worktrees, worker_timeout_sec, timeout_grace_sec, max_parallel_tasks }\n- context_files\n- flow (required)\n\nFlow node types:\n- task\n- group\n- loop\n\nTask node fields:\n- type: \"task\"\n- id (required)\n- prompt (required)\n- provider (optional; currently \"codex\" only)\n- model (optional; defaults to defaults.model)\n- context_files\n\nGroup node fields:\n- type: \"group\"\n- id (required)\n- parallel (required boolean)\n- steps (required non-empty flow[])\n\nLoop node fields:\n- type: \"loop\"\n- id\n- max_iterations\n- gate (required object)\n  - deterministic gate:\n    { type: \"deterministic\", command, args?, cwd?, timeout_sec?, score_threshold?, required_artifacts? }\n  - ai gate:\n    { type: \"ai\", prompt, provider?, model?, reasoning?, profile?, include_recent_tasks?, timeout_sec?, score_threshold?, required_artifacts? }\n  - ai gate auto-injects recent loop-task context into evaluation prompts.\n- body (flow[])\n\nGate output contract (both gate types):\n- JSON object: { \"passed\": boolean, \"score\": number | null, \"reasons\": string[] }\n- score_threshold: when present, gate passes only if score >= threshold\n\nProvider notes:\n- codex is implemented now\n- additional providers can be added in future adapter wiring\n`;
}
