import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import {
  collectRunDiagnostics,
  selectPrimaryRunDiagnostic
} from "../runtime/delivery/summary.js";
import type { RuntimeEventEnvelope } from "../runtime/events.js";
import type { RuntimeStateSnapshot } from "../runtime/session.js";

function computeDurationMs(state: RuntimeStateSnapshot): number | undefined {
  if (!state.ended_at) {
    return undefined;
  }

  const durationMs = Math.max(0, Date.parse(state.ended_at) - Date.parse(state.started_at));
  return Number.isNaN(durationMs) ? undefined : durationMs;
}

function formatTerminalDiagnostic(label: string, summary: string): string {
  return label.startsWith("run.") ? summary : `${label}: ${summary}`;
}

export interface AttemptOutcomeVerificationCounts {
  passed: number;
  failed: number;
  attempts_with_verification: number;
  failed_attempts: Array<{
    compiled_id: string;
    attempt_index: number;
    iteration_index?: number;
    summary: string;
    blockers_count: number;
    findings_count: number;
    verify_outcome_markdown_path: string;
  }>;
}

export interface AttemptNodeWorkspaceCounts {
  attempts_with_changes: number;
  diff_paths: string[];
}

function readOutcomeVerificationFromAttempt(attempt: RuntimeNodeAttempt): {
  passed: boolean;
  summary: string;
  findings: number;
  blockers: number;
} | undefined {
  const value = attempt.metadata?.outcome_verification;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.passed !== "boolean") {
    return undefined;
  }
  const findings = Array.isArray(candidate.findings) ? candidate.findings : [];
  const blockers = Array.isArray(candidate.blockers) ? candidate.blockers : [];
  return {
    passed: candidate.passed,
    summary: typeof candidate.summary === "string" ? candidate.summary : "",
    findings: findings.length,
    blockers: blockers.length
  };
}

function readNodeWorkspaceDiffPath(attempt: RuntimeNodeAttempt): string | undefined {
  const value = attempt.metadata?.node_workspace_changes;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.diff_patch_path === "string" ? candidate.diff_patch_path : undefined;
}

function summarizeOutcomeVerifications(attempts: RuntimeNodeAttempt[]): AttemptOutcomeVerificationCounts {
  let passed = 0;
  let failed = 0;
  let attemptsWithVerification = 0;
  const failedAttempts: AttemptOutcomeVerificationCounts["failed_attempts"] = [];

  for (const attempt of attempts) {
    const verification = readOutcomeVerificationFromAttempt(attempt);
    if (!verification) {
      continue;
    }
    attemptsWithVerification += 1;
    if (verification.passed) {
      passed += 1;
    } else {
      failed += 1;
      failedAttempts.push({
        compiled_id: attempt.compiled_id,
        attempt_index: attempt.attempt_index,
        ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
        summary: verification.summary,
        blockers_count: verification.blockers,
        findings_count: verification.findings,
        verify_outcome_markdown_path: `${attempt.execution_dir}/verify-outcome.md`
      });
    }
  }

  return {
    passed,
    failed,
    attempts_with_verification: attemptsWithVerification,
    failed_attempts: failedAttempts
  };
}

function summarizeNodeWorkspaceChanges(attempts: RuntimeNodeAttempt[]): AttemptNodeWorkspaceCounts {
  const diffPaths: string[] = [];
  for (const attempt of attempts) {
    const path = readNodeWorkspaceDiffPath(attempt);
    if (path) {
      diffPaths.push(path);
    }
  }
  return {
    attempts_with_changes: diffPaths.length,
    diff_paths: diffPaths
  };
}

export function createRunTerminalFields(
  state: RuntimeStateSnapshot,
  attempts: RuntimeNodeAttempt[],
  events: RuntimeEventEnvelope[]
): {
  duration_ms?: number;
  terminal_error?: string;
  terminal_warning?: string;
  terminal_diagnostics?: string[];
  evidence_status: RuntimeStateSnapshot["evidence_status"];
  soft_verification_counts: RuntimeStateSnapshot["soft_verification_counts"];
  outcome_verification_counts: AttemptOutcomeVerificationCounts;
  node_workspace_change_counts: AttemptNodeWorkspaceCounts;
} {
  const durationMs = computeDurationMs(state);
  const diagnostics = collectRunDiagnostics(attempts, events, state).map((diagnostic) =>
    formatTerminalDiagnostic(diagnostic.label, diagnostic.summary)
  );
  const primary = selectPrimaryRunDiagnostic(attempts, events, state);

  return {
    evidence_status: state.evidence_status,
    soft_verification_counts: state.soft_verification_counts,
    outcome_verification_counts: summarizeOutcomeVerifications(attempts),
    node_workspace_change_counts: summarizeNodeWorkspaceChanges(attempts),
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(primary && state.status !== "passed"
      ? { terminal_error: formatTerminalDiagnostic(primary.label, primary.summary) }
      : {}),
    ...(primary && state.status === "passed"
      ? { terminal_warning: formatTerminalDiagnostic(primary.label, primary.summary) }
      : {}),
    ...(diagnostics.length > 0 ? { terminal_diagnostics: diagnostics } : {})
  };
}
