/** Shared constants for the agentflow package. */

/** Classification string attached to task results killed by timeout. */
export const TIMEOUT_CLASSIFICATION = 'timeout';

/** Exit code used when a task is terminated due to timeout (matches Unix `timeout` convention). */
export const TIMEOUT_EXIT_CODE = 124;

/** Default per-task timeout in seconds (2 hours). */
export const DEFAULT_WORKER_TIMEOUT_SEC = 7200;

/** Default grace period in seconds between SIGTERM and SIGKILL when killing a timed-out worker. */
export const DEFAULT_TIMEOUT_GRACE_SEC = 20;

/** Default filename for the detailed task report written by the agent. */
export const DEFAULT_REPORT_FILENAME = 'worker_report.md';

/** Default filename for the concise task summary used as downstream context. */
export const DEFAULT_SUMMARY_FILENAME = 'worker_summary.md';

/** Canonical set of allowed reasoning effort values passed to the codex provider. */
export const REASONING_EFFORT_VALUES = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

/** Maps common alternative spellings to the canonical reasoning effort value. */
export const REASONING_EFFORT_ALIASES = new Map([
  ['extra_high', 'xhigh'],
  ['extra-high', 'xhigh'],
  ['x_high', 'xhigh'],
  ['x-high', 'xhigh'],
]);

/** Set of supported provider identifiers for per-task CLI adapters. */
export const PROVIDERS = new Set(['codex', 'cursor']);

/** Default template for naming per-step worktree branches. */
export const DEFAULT_WORKTREE_BRANCH_TEMPLATE =
  'agentflow/{run_id}-r{repo}-g{group}-{kind_short}{node}-a{attempt}';

/** Allowed placeholders in options.worktree_branch_template. */
export const WORKTREE_BRANCH_TEMPLATE_TOKENS = new Set([
  'run_id',
  'repo',
  'group',
  'node',
  'attempt',
  'kind',
  'kind_short',
]);
