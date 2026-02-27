/** Shared constants for the agentflow package. */

/** Timeout metadata values used in result payloads. */
export const TIMEOUT_CLASSIFICATION = 'timeout';
export const TIMEOUT_EXIT_CODE = 124;

/** Runtime defaults. */
export const DEFAULT_WORKER_TIMEOUT_SEC = 7200;
export const DEFAULT_TIMEOUT_GRACE_SEC = 20;
export const DEFAULT_REPORT_FILENAME = 'worker_report.md';
export const DEFAULT_SUMMARY_FILENAME = 'worker_summary.md';

/** Allowed reasoning effort values and common aliases. */
export const REASONING_EFFORT_VALUES = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
export const REASONING_EFFORT_ALIASES = new Map([
  ['extra_high', 'xhigh'],
  ['extra-high', 'xhigh'],
  ['x_high', 'xhigh'],
  ['x-high', 'xhigh'],
]);

/** Provider registry for per-task CLI adapters. */
export const PROVIDERS = new Set(['codex', 'cursor']);
