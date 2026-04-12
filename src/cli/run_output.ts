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
} {
  const durationMs = computeDurationMs(state);
  const diagnostics = collectRunDiagnostics(attempts, events, state).map((diagnostic) =>
    formatTerminalDiagnostic(diagnostic.label, diagnostic.summary)
  );
  const primary = selectPrimaryRunDiagnostic(attempts, events, state);

  return {
    evidence_status: state.evidence_status,
    soft_verification_counts: state.soft_verification_counts,
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
