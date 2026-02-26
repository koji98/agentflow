/** CLI usage text. */
export function usageText() {
  return [
    'Usage: agentflow --plan <plan_file> [--repo <repo_root>] [--plan-doc <path>] [--dry-run|--no-dry-run]',
    '       agentflow <plan_file>',
    '       agentflow --plan-help',
  ].join('\n');
}

/** Extended plan help shown via --plan-help. */
export function planHelpText() {
  return `Plan File Help\n\nCLI options:\n- --plan <file>: plan file path (JSON or markdown with one fenced json block)\n- --repo <path>: override target repository root for this run\n- --plan-doc <path>: override plan_doc file for this run\n- --dry-run / --no-dry-run: override runtime.dry_run for this run\n\nPath resolution:\n- --plan: relative to shell cwd\n- target.repo_root: relative to the plan file directory\n- plan_doc + context_files: relative to the plan file directory by default\n- absolute paths are always supported\n- optional prefixes in plan paths: repo:<path> and plan:<path>\n\nTop-level fields:\n- version (optional, \"1\")\n- setup (required)\n- objective\n- target { repo_root (required), use_worktrees }\n- defaults { provider, model, reasoning, profile }\n- policy { fail_mode, max_runtime_sec, max_iterations, max_total_tasks, max_failures, retry }\n- runtime { run_root, run_id, dry_run, cleanup_worktrees, worker_timeout_sec, timeout_grace_sec, max_parallel_tasks }\n- plan_doc\n- context_files\n- flow (required)\n\nFlow node types:\n- task\n- parallel\n- loop\n\nTask node fields:\n- type: \"task\"\n- id (required)\n- prompt (required)\n- provider (codex|cursor, default from defaults.provider)\n- model\n- reasoning (minimal|low|medium|high|xhigh)\n- profile\n- notes\n- context_files\n- report_filename\n- retry { max_retries, retry_on }\n\nParallel node fields:\n- type: \"parallel\"\n- id\n- steps (flow[])\n\nLoop node fields:\n- type: \"loop\"\n- id\n- max_iterations\n- gate (required object)\n  - deterministic gate:\n    { type: \"deterministic\", command, args?, cwd?, timeout_sec?, score_threshold?, required_artifacts? }\n  - ai gate:\n    { type: \"ai\", prompt, provider?, model?, reasoning?, profile?, include_recent_tasks?, timeout_sec?, score_threshold?, required_artifacts? }\n  - ai gate auto-injects recent loop-task context into evaluation prompts.\n- body (flow[])\n\nGate output contract (both gate types):\n- JSON object: { \"passed\": boolean, \"score\": number | null, \"reasons\": string[] }\n- score_threshold: when present, gate passes only if score >= threshold\n\nProvider notes:\n- codex is implemented now\n- cursor is schema-supported and reserved for future adapter wiring\n`;
}
