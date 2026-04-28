import type { RuntimeNodeAttempt } from "../attempts.js";
import type { RuntimeEventEnvelope } from "../events.js";
import type { RuntimeStateSnapshot } from "../session.js";
import type { DeliveryPackageManifest } from "./package.js";

export interface RunDiagnostic {
  label: string;
  summary: string;
}

function formatCounts(state: RuntimeStateSnapshot): string {
  const { counts } = state;
  return [
    `passed=${counts.passed}`,
    `failed=${counts.failed}`,
    `blocked=${counts.blocked}`,
    `canceled=${counts.canceled}`,
    `skipped=${counts.skipped}`
  ].join(" ");
}

function readEventSummary(event: RuntimeEventEnvelope): string | undefined {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? event.payload as Record<string, unknown>
      : {};

  switch (event.type) {
    case "run.preflight_failed":
      return typeof payload.message === "string" ? payload.message : "Run preflight failed.";
    case "check.evaluated":
      return payload.passed === false && typeof payload.summary === "string"
        ? payload.summary
        : payload.passed === false
          ? "Check failed."
          : undefined;
    case "verification.recorded":
      return payload.passed === false && typeof payload.summary === "string"
        ? payload.summary
        : payload.passed === false
          ? "Soft verification failed."
          : undefined;
    case "outcome.verified":
      if (payload.passed === false) {
        const blockers = typeof payload.blockers_count === "number" ? payload.blockers_count : 0;
        const findings = typeof payload.findings_count === "number" ? payload.findings_count : 0;
        return `Outcome verifier rejected the attempt (blockers=${blockers}, findings=${findings}).`;
      }
      return undefined;
    case "supervisor.intervention.failed":
      return typeof payload.summary === "string" ? payload.summary : "Supervisor intervention failed.";
    case "supervisor.paused":
      return typeof payload.summary === "string"
        ? payload.summary
        : typeof payload.reason === "string"
          ? payload.reason
          : "Supervisor paused for human input.";
    case "run.canceled":
      return typeof payload.reason === "string" ? `Run canceled: ${payload.reason}` : "Run canceled.";
    case "run.completed":
      return payload.outcome === "failed" && typeof payload.reason === "string"
        ? `Run failed: ${payload.reason}`
        : undefined;
    default:
      return undefined;
  }
}

function formatSoftVerificationCounts(state: RuntimeStateSnapshot): string {
  return [
    `passed=${state.soft_verification_counts.passed}`,
    `failed=${state.soft_verification_counts.failed}`
  ].join(" ");
}

interface AttemptOutcomeVerification {
  passed: boolean;
  summary?: string;
  findings_count?: number;
  blockers_count?: number;
  verify_outcome_markdown_path?: string;
}

function readOutcomeVerificationMetadata(attempt: RuntimeNodeAttempt): AttemptOutcomeVerification | undefined {
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
    ...(typeof candidate.summary === "string" ? { summary: candidate.summary } : {}),
    findings_count: findings.length,
    blockers_count: blockers.length
  };
}

function formatOutcomeVerificationCounts(attempts: RuntimeNodeAttempt[]): string {
  let passed = 0;
  let failed = 0;
  for (const attempt of attempts) {
    const verification = readOutcomeVerificationMetadata(attempt);
    if (!verification) {
      continue;
    }
    if (verification.passed) {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  return `passed=${passed} failed=${failed}`;
}

export function collectRunDiagnostics(
  attempts: RuntimeNodeAttempt[],
  events: RuntimeEventEnvelope[],
  state?: RuntimeStateSnapshot
): RunDiagnostic[] {
  if (state?.status === "passed" && state.evidence_status === "clean") {
    return [];
  }

  const diagnostics: RunDiagnostic[] = [];
  const seen = new Set<string>();

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (!event) {
      continue;
    }

    if (
      state?.status === "passed"
      && state.evidence_status === "warnings"
      && event.type !== "verification.recorded"
    ) {
      continue;
    }

    const summary = readEventSummary(event);

    if (!summary) {
      continue;
    }

    const label = event.compiled_id ?? event.type;
    const key = `${label}\u0000${summary}`;

    if (seen.has(key)) {
      continue;
    }

    diagnostics.push({ label, summary });
    seen.add(key);

    if (diagnostics.length >= 4) {
      break;
    }
  }

  if (state?.status === "passed") {
    return diagnostics;
  }

  for (const attempt of [...attempts].reverse()) {
    const error =
      typeof attempt.metadata?.error === "string" && attempt.metadata.error.trim().length > 0
        ? attempt.metadata.error.trim()
        : undefined;

    if (!error) {
      continue;
    }

    const label = attempt.authored_id;
    const key = `${label}\u0000${error}`;

    if (seen.has(key)) {
      continue;
    }

    diagnostics.push({ label, summary: error });
    seen.add(key);

    if (diagnostics.length >= 4) {
      break;
    }
  }

  return diagnostics;
}

export function formatRunDiagnostic(diagnostic: RunDiagnostic): string {
  return `- \`${diagnostic.label}\`: ${diagnostic.summary}`;
}

export function selectPrimaryRunDiagnostic(
  attempts: RuntimeNodeAttempt[],
  events: RuntimeEventEnvelope[],
  state?: RuntimeStateSnapshot
): RunDiagnostic | undefined {
  const diagnostics = collectRunDiagnostics(attempts, events, state);
  return diagnostics.find((diagnostic) => !diagnostic.label.startsWith("run.")) ?? diagnostics[0];
}

export function renderRunSummary(
  state: RuntimeStateSnapshot,
  attempts: RuntimeNodeAttempt[],
  events: RuntimeEventEnvelope[],
  deliveryManifest?: DeliveryPackageManifest
): string {
  const lines = [
    `# Run Summary: ${state.run_id}`,
    "",
    `- Graph: \`${state.graph_id}\``,
    `- Control-flow status: \`${state.status}\``,
    `- Evidence status: \`${state.evidence_status}\``,
    `- Workspace backend: \`${state.workspace_backend}\``,
    `- Snapshot seq: \`${state.snapshot_seq}\``,
    `- Counts: \`${formatCounts(state)}\``,
    `- Soft verification counts: \`${formatSoftVerificationCounts(state)}\``,
    `- Outcome verification counts: \`${formatOutcomeVerificationCounts(attempts)}\``,
    ""
  ];
  const diagnostics = collectRunDiagnostics(attempts, events, state);

  if (deliveryManifest) {
    lines.push(
      "## Delivery Package",
      "",
      `- Manifest: \`${deliveryManifest.manifest_path}\``,
      `- Reviewer guide: \`${deliveryManifest.sections.reviewer_guide}\``,
      `- Intervention count: \`${deliveryManifest.intervention_count}\``,
      `- Failed evidence count: \`${deliveryManifest.failed_check_count}\``,
      ""
    );
  }

  if (diagnostics.length > 0) {
    lines.push("## Diagnostics", "", ...diagnostics.map(formatRunDiagnostic), "");
  }

  if (state.failed_soft_verifications.length > 0) {
    lines.push("## Failed Soft Verifications", "");

    for (const verification of state.failed_soft_verifications) {
      lines.push(
        `- \`${verification.authored_id}\`: ${verification.summary}`
      );
    }

    lines.push("");
  }

  const outcomeVerificationEntries = attempts.flatMap((attempt) => {
    const verification = readOutcomeVerificationMetadata(attempt);
    return verification
      ? [{ attempt, verification }]
      : [];
  });

  if (outcomeVerificationEntries.length > 0) {
    lines.push("## Outcome Verification", "");
    for (const { attempt, verification } of outcomeVerificationEntries) {
      lines.push(
        `- \`${attempt.compiled_id}\` (attempt=${attempt.attempt_index}${
          attempt.iteration_index !== undefined ? `, iteration=${attempt.iteration_index}` : ""
        }) -> \`${verification.passed ? "passed" : "failed"}\` (findings=${verification.findings_count ?? 0}, blockers=${verification.blockers_count ?? 0})${
          verification.summary ? ` - ${verification.summary}` : ""
        }`
      );
    }
    lines.push("");
  }

  const workspaceChangeArtifacts = Object.values(state.workspace_change_artifacts);

  if (workspaceChangeArtifacts.length > 0) {
    lines.push("## Workspace Changes", "");

    for (const artifact of workspaceChangeArtifacts) {
      lines.push(
        `- \`${artifact.repo_alias}\`: status=\`${artifact.status_file}\`, diff=\`${artifact.diff_file}\`, changed_files=\`${artifact.changed_files_file}\` (${artifact.changed_files.length} files)${
          artifact.capture_error_file ? `, capture_error=\`${artifact.capture_error_file}\`` : ""
        }`
      );
    }

    lines.push("");
  }

  if (attempts.length === 0) {
    lines.push("No node executions were recorded.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Latest Executions", "");

  for (const attempt of attempts) {
    const verification =
      attempt.metadata?.verification
      && typeof attempt.metadata.verification === "object"
      && attempt.metadata.verification !== null
        ? attempt.metadata.verification as {
            passed?: boolean;
          }
        : undefined;
    const outcomeVerification = readOutcomeVerificationMetadata(attempt);

    lines.push(
      `- \`${attempt.compiled_id}\` -> \`${attempt.status}\` (attempt=${attempt.attempt_index}${
        attempt.iteration_index !== undefined ? `, iteration=${attempt.iteration_index}` : ""
      })${
        verification
          ? ` · evidence=${verification.passed === false ? "failed" : "passed"}`
          : ""
      }${
        outcomeVerification
          ? ` · outcome=${outcomeVerification.passed ? "passed" : "failed"}`
          : ""
      }`
    );
  }

  return `${lines.join("\n")}\n`;
}
