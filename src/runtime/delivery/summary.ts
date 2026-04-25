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
    case "supervisor.intervention.failed":
      return typeof payload.summary === "string" ? payload.summary : "Supervisor intervention failed.";
    case "supervisor.escalated":
      return typeof payload.summary === "string"
        ? payload.summary
        : typeof payload.reason === "string"
          ? payload.reason
          : "Supervisor escalated.";
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
      typeof attempt.metadata.error === "string" && attempt.metadata.error.trim().length > 0
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
      attempt.metadata.verification
      && typeof attempt.metadata.verification === "object"
      && attempt.metadata.verification !== null
        ? attempt.metadata.verification as {
            passed?: boolean;
          }
        : undefined;

    lines.push(
      `- \`${attempt.compiled_id}\` -> \`${attempt.status}\` (attempt=${attempt.attempt_index}${
        attempt.iteration_index !== undefined ? `, iteration=${attempt.iteration_index}` : ""
      })${
        verification
          ? ` · evidence=${verification.passed === false ? "failed" : "passed"}`
          : ""
      }`
    );
  }

  return `${lines.join("\n")}\n`;
}
