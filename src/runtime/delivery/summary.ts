import type { RuntimeNodeAttempt } from "../attempts.js";
import type { RuntimeEventEnvelope } from "../events.js";
import type { RuntimeStateSnapshot } from "../session.js";

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

function collectDiagnostics(
  attempts: RuntimeNodeAttempt[],
  events: RuntimeEventEnvelope[]
): string[] {
  const diagnostics: string[] = [];
  const seen = new Set<string>();

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (!event) {
      continue;
    }

    const summary = readEventSummary(event);

    if (!summary) {
      continue;
    }

    const label = event.compiled_id ?? event.type;
    const line = `- \`${label}\`: ${summary}`;

    if (seen.has(line)) {
      continue;
    }

    diagnostics.push(line);
    seen.add(line);

    if (diagnostics.length >= 4) {
      break;
    }
  }

  for (const attempt of [...attempts].reverse()) {
    const error =
      typeof attempt.metadata.error === "string" && attempt.metadata.error.trim().length > 0
        ? attempt.metadata.error.trim()
        : undefined;

    if (!error) {
      continue;
    }

    const line = `- \`${attempt.compiled_id}\`: ${error}`;

    if (seen.has(line)) {
      continue;
    }

    diagnostics.push(line);
    seen.add(line);

    if (diagnostics.length >= 4) {
      break;
    }
  }

  return diagnostics;
}

export function renderRunSummary(
  state: RuntimeStateSnapshot,
  attempts: RuntimeNodeAttempt[],
  events: RuntimeEventEnvelope[]
): string {
  const lines = [
    `# Run Summary: ${state.run_id}`,
    "",
    `- Graph: \`${state.graph_id}\``,
    `- Status: \`${state.status}\``,
    `- Workspace backend: \`${state.workspace_backend}\``,
    `- Snapshot seq: \`${state.snapshot_seq}\``,
    `- Counts: \`${formatCounts(state)}\``,
    ""
  ];
  const diagnostics = collectDiagnostics(attempts, events);

  if (diagnostics.length > 0) {
    lines.push("## Diagnostics", "", ...diagnostics, "");
  }

  if (attempts.length === 0) {
    lines.push("No node executions were recorded.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Latest Executions", "");

  for (const attempt of attempts) {
    lines.push(
      `- \`${attempt.compiled_id}\` -> \`${attempt.status}\` (attempt=${attempt.attempt_index}${
        attempt.iteration_index !== undefined ? `, iteration=${attempt.iteration_index}` : ""
      })`
    );
  }

  return `${lines.join("\n")}\n`;
}
