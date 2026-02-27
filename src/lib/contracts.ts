import type { ContractResult } from './types.ts';

/**
 * Evaluates the completion contract for one executed task.
 * A task is DONE when: exit code is 0, it did not time out, and a report file exists.
 * Everything else is FAILED with a reason string.
 *
 * @param params Contract evaluation inputs.
 * @param params.exitCode Process exit code.
 * @param params.timedOut Whether the process was killed due to timeout.
 * @param params.reportExists Whether the worker report file was written.
 * @returns Contract result with status and optional failure reason.
 */
export function evaluateContract({
  exitCode,
  timedOut,
  reportExists,
}: {
  exitCode: number;
  timedOut: boolean;
  reportExists: boolean;
}): ContractResult {
  if (timedOut) return { status: 'FAILED', reason: 'timed_out' };
  if (exitCode !== 0) return { status: 'FAILED', reason: 'nonzero_exit' };
  if (!reportExists) return { status: 'FAILED', reason: 'missing_report' };
  return { status: 'DONE', reason: null };
}
