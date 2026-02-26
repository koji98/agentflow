import { STATUS_LINE_RE } from './constants.ts';
import type { ContractResult, PromptContract } from './types.ts';

/** Parses worker-declared status line from last message. */
export function parseDeclaredStatus(lastMessageText: string): {
  declaredStatus: string | null;
  parseError: string | null;
} {
  const matches = [];
  for (const match of lastMessageText.matchAll(STATUS_LINE_RE)) {
    matches.push(String(match[1]).toUpperCase());
  }
  if (matches.length === 0) return { declaredStatus: null, parseError: 'missing_status_line' };
  if (new Set(matches).size !== 1) return { declaredStatus: null, parseError: 'ambiguous_status_lines' };
  return { declaredStatus: matches[matches.length - 1], parseError: null };
}

/** Evaluates completion contract state for one task run. */
export function evaluateContract({
  exitCode,
  timedOut,
  lastMessageText,
  reportExists,
  promptContract,
}: {
  exitCode: number;
  timedOut: boolean;
  lastMessageText: string;
  reportExists: boolean;
  promptContract: PromptContract;
}): ContractResult {
  const parsed = promptContract.require_status_line
    ? parseDeclaredStatus(lastMessageText)
    : { declaredStatus: null, parseError: null };

  const errors = [];
  const allowed = new Set(promptContract.allowed_statuses);

  if (parsed.parseError) errors.push(parsed.parseError);
  if (parsed.declaredStatus && !allowed.has(parsed.declaredStatus)) errors.push('unexpected_status_value');
  if (promptContract.require_report_for_done && parsed.declaredStatus === 'DONE' && !reportExists) {
    errors.push('missing_report_for_done');
  }
  if (Number(exitCode) !== 0) errors.push('nonzero_exit_code');
  if (timedOut) errors.push('timed_out');

  let status;
  if (parsed.declaredStatus === 'DONE' && errors.length === 0) status = 'DONE';
  else if (parsed.declaredStatus === 'BLOCKED' && parsed.parseError === null) status = 'BLOCKED';
  else if (parsed.declaredStatus && allowed.has(parsed.declaredStatus) && Number(exitCode) === 0 && !timedOut) {
    status = parsed.declaredStatus;
  } else {
    status = 'FAILED';
  }

  return {
    status,
    declaredStatus: parsed.declaredStatus,
    statusParseError: parsed.parseError,
    completionContractErrors: errors,
    completionContractSatisfied: status === 'DONE',
  };
}
