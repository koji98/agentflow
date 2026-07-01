import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";

import {
  resolveExecutionHumanDebugToolDirectory,
  resolveExecutionRuntimeCompletionPacketPath
} from "../artifacts/paths.js";
import { staleAgentflowDirectoryName, taskRuntimeDirectoryName } from "../generated_state.js";
import {
  readCompiledGraph,
  readExecutionManifest,
  readRunEvents,
  readRunExecutionAttempts,
  readSupervisorInterventions,
  readRunRecord,
  readRunState
} from "../artifacts/reader.js";
import type { CompiledExecutableNode } from "../graph/compiled.js";
import type {
  EvalTraceArtifact,
  EvalTraceAttempt,
  EvalTracePacket,
  EvalTracePromptDiagnosticEntry,
  EvalTracePromptDiagnosticsSummary,
  EvalTraceRecoveryLearning,
  EvalTrajectoryEvent
} from "./types.js";

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function readJsonLines(path: string | undefined): Promise<Array<Record<string, unknown>>> {
  if (!path) {
    return [];
  }

  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
  } catch {
    return [];
  }
}

async function readArtifactContent(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return content.length > 8000 ? `${content.slice(0, 8000)}\n...[truncated]` : content;
  } catch {
    return undefined;
  }
}

function collectStringField(value: unknown, field: string, output: Set<string>): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectStringField(item, field, output));
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record[field] === "string") {
    output.add(record[field]);
  }

  Object.values(record).forEach((nested) => collectStringField(nested, field, output));
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

async function readAttemptToolInvocations(attempts: Array<{
  execution_id?: string;
  compiled_id?: string;
  authored_id?: string;
  execution_dir?: string;
}>): Promise<Array<{
  attempt: { execution_id?: string; compiled_id?: string; authored_id?: string };
  record: Record<string, unknown>;
}>> {
  const invocationGroups = await Promise.all(attempts.map(async (attempt) => {
    if (!attempt.execution_dir) {
      return [];
    }
    const records = await readJsonLines(join(resolveExecutionHumanDebugToolDirectory(attempt.execution_dir), "index.jsonl"));
    return records.map((record) => ({ attempt, record }));
  }));
  return invocationGroups.flat();
}

async function readAttemptCompletionPackets(attempts: Array<{
  execution_id?: string;
  compiled_id?: string;
  authored_id?: string;
  execution_dir?: string;
  metadata?: Record<string, unknown>;
}>): Promise<Array<{
  attempt: { execution_id?: string; compiled_id?: string; authored_id?: string };
  packet: Record<string, unknown>;
  packet_path: string;
}>> {
  const packetGroups = await Promise.all(attempts.map(async (attempt) => {
    const metadataCompletion = readRecord(attempt.metadata?.completion);
    const packetPath = typeof metadataCompletion?.packet_path === "string"
      ? metadataCompletion.packet_path
      : attempt.execution_dir
        ? resolveExecutionRuntimeCompletionPacketPath(attempt.execution_dir)
        : undefined;
    if (!packetPath) {
      return [];
    }
    const packet = readRecord(await readOptionalJson(packetPath));
    return packet ? [{ attempt, packet, packet_path: packetPath }] : [];
  }));
  return packetGroups.flat();
}

const promptDiagnosticsTraversalSkips = new Set([
  ".git",
  taskRuntimeDirectoryName,
  staleAgentflowDirectoryName,
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  "dist",
  "build",
  "coverage",
  "workspaces",
  "workspace",
  "repo"
]);

async function collectPromptDiagnosticsFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === "prompt-diagnostics.json") {
      return [path];
    }
    if (!entry.isDirectory() || promptDiagnosticsTraversalSkips.has(entry.name)) {
      return [];
    }
    return collectPromptDiagnosticsFiles(path);
  }));

  return nested.flat().sort((left, right) => left.localeCompare(right));
}

function summarizePromptDiagnostic(path: string, value: unknown): EvalTracePromptDiagnosticEntry | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }
  const totalChars = readNumber(record.total_chars);
  const contextPointerCount = readNumber(record.context_pointer_count);
  const contextReadFirstCount = readNumber(record.context_read_first_count);
  const contextGlobSetCount = readNumber(record.context_glob_set_count);
  const contextGlobMatchCount = readNumber(record.context_glob_match_count);
  const contextGlobIncludedCount = readNumber(record.context_glob_included_count);
  const contextLimitedGlobCount = readNumber(record.context_limited_glob_count);

  return {
    path,
    ...(typeof record.prompt_kind === "string" ? { prompt_kind: record.prompt_kind } : {}),
    ...(typeof record.renderer === "string" ? { renderer: record.renderer } : {}),
    ...(totalChars !== undefined ? { total_chars: totalChars } : {}),
    ...(contextPointerCount !== undefined ? { context_pointer_count: contextPointerCount } : {}),
    ...(contextReadFirstCount !== undefined ? { context_read_first_count: contextReadFirstCount } : {}),
    ...(contextGlobSetCount !== undefined ? { context_glob_set_count: contextGlobSetCount } : {}),
    ...(contextGlobMatchCount !== undefined ? { context_glob_match_count: contextGlobMatchCount } : {}),
    ...(contextGlobIncludedCount !== undefined ? { context_glob_included_count: contextGlobIncludedCount } : {}),
    ...(contextLimitedGlobCount !== undefined ? { context_limited_glob_count: contextLimitedGlobCount } : {}),
    ...(typeof record.has_supervisor_recovery === "boolean" ? { has_supervisor_recovery: record.has_supervisor_recovery } : {}),
    warnings: readStringArray(record.warnings)
  };
}

async function collectPromptDiagnostics(runRoot: string): Promise<EvalTracePromptDiagnosticsSummary> {
  const files = await collectPromptDiagnosticsFiles(runRoot);
  const entries = (await Promise.all(files.map(async (path) =>
    summarizePromptDiagnostic(path, await readOptionalJson(path))
  ))).filter((entry): entry is EvalTracePromptDiagnosticEntry => entry !== undefined);
  const warningCounts: Record<string, number> = {};

  for (const warning of entries.flatMap((entry) => entry.warnings)) {
    warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
  }

  const totalChars = entries.reduce((sum, entry) => sum + (entry.total_chars ?? 0), 0);
  const maxPromptChars = entries.reduce((max, entry) => Math.max(max, entry.total_chars ?? 0), 0);

  return {
    count: entries.length,
    total_chars: totalChars,
    max_prompt_chars: maxPromptChars,
    context_pointer_count: entries.reduce((sum, entry) => sum + (entry.context_pointer_count ?? 0), 0),
    context_read_first_count: entries.reduce((sum, entry) => sum + (entry.context_read_first_count ?? 0), 0),
    context_glob_set_count: entries.reduce((sum, entry) => sum + (entry.context_glob_set_count ?? 0), 0),
    context_glob_match_count: entries.reduce((sum, entry) => sum + (entry.context_glob_match_count ?? 0), 0),
    context_glob_included_count: entries.reduce((sum, entry) => sum + (entry.context_glob_included_count ?? 0), 0),
    context_limited_glob_count: entries.reduce((sum, entry) => sum + (entry.context_limited_glob_count ?? 0), 0),
    warnings: Object.keys(warningCounts).sort((left, right) => left.localeCompare(right)),
    warning_counts: warningCounts,
    entries
  };
}

function summarizeRecoveryLearning(interventions: Array<{
  evidence?: unknown;
}>): EvalTraceRecoveryLearning[] {
  const records: EvalTraceRecoveryLearning[] = [];

  for (const intervention of interventions) {
    const evidence = readRecord(intervention.evidence);
    const learning = readRecord(evidence?.recovery_learning);
    if (!learning) {
      continue;
    }

    const record: EvalTraceRecoveryLearning = {};
    const diagnosis = readString(learning.diagnosis);
    const followedRequiredNextAction = readString(learning.followed_required_next_action);
    const followedValidationGate = readString(learning.followed_validation_gate);
    const materialDeltaUsed = readString(learning.material_delta_used);
    const repeatedForbiddenTactic = readString(learning.repeated_forbidden_tactic);

    if (diagnosis) {
      record.diagnosis = diagnosis;
    }
    if (followedRequiredNextAction) {
      record.followed_required_next_action = followedRequiredNextAction;
    }
    if (followedValidationGate) {
      record.followed_validation_gate = followedValidationGate;
    }
    if (materialDeltaUsed) {
      record.material_delta_used = materialDeltaUsed;
    }
    if (repeatedForbiddenTactic) {
      record.repeated_forbidden_tactic = repeatedForbiddenTactic;
    }

    records.push(record);
  }

  return records;
}

function afCommandFromInvocation(record: Record<string, unknown>): string | undefined {
  if (record.kind !== "af" || !Array.isArray(record.argv)) {
    return undefined;
  }
  const argv = record.argv.filter((item): item is string => typeof item === "string");
  return argv.length > 0 ? argv.join(" ") : undefined;
}

export async function writeEvalTrace(options: {
  run_root: string;
  trace_file: string;
}): Promise<void> {
  const [run, compiledGraph, executionManifest, state, events, attempts] = await Promise.all([
    readRunRecord(options.run_root),
    readCompiledGraph(options.run_root),
    readExecutionManifest(options.run_root),
    readRunState(options.run_root),
    readRunEvents(options.run_root),
    readRunExecutionAttempts(options.run_root)
  ]);
  const nodesByCompiledId = new Map<string, CompiledExecutableNode>(
    compiledGraph.nodes.map((node) => [node.compiled_id, node])
  );
  const lines: string[] = [];

  lines.push(jsonLine({
    kind: "run",
    run,
    state: {
      status: state.status,
      counts: state.counts,
      soft_verification_counts: state.soft_verification_counts,
      failed_soft_verifications: state.failed_soft_verifications
    },
    execution_manifest: executionManifest
  }));

  for (const node of compiledGraph.nodes) {
    lines.push(jsonLine({
      kind: "node",
      compiled_id: node.compiled_id,
      authored_id: node.authored_id,
      label: node.label,
      node_kind: node.kind,
      repo_alias: node.repo,
      lowered_from: node.lowered_from,
      declared_artifacts: node.declared_artifacts,
      effective_policy: node.effective_policy
    }));
  }

  for (const event of events) {
    const node = event.compiled_id ? nodesByCompiledId.get(event.compiled_id) : undefined;

    lines.push(jsonLine({
      kind: "event",
      ...event,
      ...(node
        ? {
            authored_id: node.authored_id,
            node_label: node.label,
            node_kind: node.kind
          }
        : {})
    }));
  }

  for (const attempt of attempts) {
    const node = nodesByCompiledId.get(attempt.compiled_id);

    lines.push(jsonLine({
      ...attempt,
      kind: "attempt",
      ...(node
        ? {
            authored_id: node.authored_id,
            node_label: node.label,
            attempt_node_kind: node.kind
          }
        : {})
    }));
  }

  await mkdir(dirname(options.trace_file), { recursive: true });
  await writeFile(options.trace_file, lines.join(""), "utf8");
}

export async function buildEvalTracePacket(options: {
  run_root: string;
  simulation_events_file?: string;
}): Promise<EvalTracePacket> {
  const [run, state, events, attempts, interventions, simulationEvents] = await Promise.all([
    readRunRecord(options.run_root),
    readRunState(options.run_root),
    readRunEvents(options.run_root),
    readRunExecutionAttempts(options.run_root),
    readSupervisorInterventions(options.run_root),
    readJsonLines(options.simulation_events_file)
  ]);
  const [toolInvocations, completionPackets] = await Promise.all([
    readAttemptToolInvocations(attempts),
    readAttemptCompletionPackets(attempts)
  ]);
  const [promptDiagnostics] = await Promise.all([
    collectPromptDiagnostics(options.run_root)
  ]);
  const artifacts: EvalTraceArtifact[] = [];

  for (const attempt of attempts) {
    for (const [name, path] of Object.entries(attempt.artifacts ?? {})) {
      const content = await readArtifactContent(path);
      artifacts.push({
        name,
        path,
        ...(content !== undefined ? { content } : {})
      });
    }
  }

  const eventRecords = events as unknown as Array<Record<string, unknown>>;
  const classifications = new Set<string>();
  const gatherers = new Set<string>();
  const applyActions = new Set<string>();
  const resumeDecisions: EvalTracePacket["supervisor"]["resume_decisions"] = [];
  const interventionDecisions: EvalTracePacket["supervisor"]["intervention_decisions"] = [];
  const recoveryLearning = summarizeRecoveryLearning(interventions);
  const interventionEvents = eventRecords.filter((event) =>
    typeof event.type === "string" && (event.type.includes("intervention") || event.type.includes("supervisor"))
  );

  collectStringField(eventRecords, "classification", classifications);
  collectStringField(eventRecords, "failure_class", classifications);
  collectStringField(eventRecords, "gather_kind", gatherers);
  collectStringField(eventRecords, "gatherer", gatherers);
  collectStringField(eventRecords, "apply_action", applyActions);
  collectStringField(eventRecords, "action", applyActions);
  collectStringField(interventions, "apply_action", applyActions);
  collectStringField(
    interventions.map((intervention) => readRecord(intervention.evidence.gather_plan)?.gathers),
    "kind",
    gatherers
  );
  for (const event of eventRecords) {
    const payload = readRecord(event.payload);
    const decision = readRecord(payload?.resume_decision);
    if (decision) {
      resumeDecisions.push({
        ...(typeof decision.resume_point === "string" ? { resume_point: decision.resume_point } : {}),
        ...(typeof decision.restart_boundary === "string" ? { restart_boundary: decision.restart_boundary } : {}),
        ...(typeof decision.workspace_decision === "string" ? { workspace_decision: decision.workspace_decision } : {}),
        ...(typeof decision.reason_code === "string" ? { reason_code: decision.reason_code } : {})
      });
    }
    const interventionDecision = readRecord(payload?.intervention_decision);
    if (interventionDecision) {
      const materialDelta = Array.isArray(interventionDecision.material_delta)
        ? interventionDecision.material_delta
        : undefined;
      interventionDecisions.push({
        ...(typeof interventionDecision.selected_strategy === "string" ? { selected_strategy: interventionDecision.selected_strategy } : {}),
        ...(typeof interventionDecision.prior_strategy === "string" ? { prior_strategy: interventionDecision.prior_strategy } : {}),
        ...(typeof interventionDecision.restart_boundary === "string" ? { restart_boundary: interventionDecision.restart_boundary } : {}),
        ...(typeof interventionDecision.workspace_decision === "string" ? { workspace_decision: interventionDecision.workspace_decision } : {}),
        ...(materialDelta ? { material_delta_count: materialDelta.length } : {}),
        ...(typeof interventionDecision.fallback_if_repeated === "string" ? { fallback_if_repeated: interventionDecision.fallback_if_repeated } : {})
      });
    }
  }

  const manifestPath = join(options.run_root, "delivery", "manifest.json");
  const reviewBriefPath = join(options.run_root, "delivery", "01-review-brief.md");
  const curationVerdictPath = join(options.run_root, "delivery", "evidence", "curation-verdict.json");
  const manifest = await readOptionalJson(manifestPath);
  const manifestRecord = readRecord(manifest);
  const curationVerdict = await readOptionalJson(curationVerdictPath);
  const trajectory: EvalTrajectoryEvent[] = [];
  let order = 1;

  for (const event of eventRecords) {
    trajectory.push({
      order,
      kind: "run_event",
      source: "agentflow",
      ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}),
      ...(typeof event.type === "string" ? { type: event.type } : {}),
      ...(typeof event.compiled_id === "string" ? { node_id: event.compiled_id } : {}),
      ...(typeof event.node_label === "string" ? { node_label: event.node_label } : {}),
      ...(typeof event.status === "string" ? { status: event.status } : {}),
      ...(typeof event.action === "string" ? { action: event.action } : {}),
      ...event
    });
    order += 1;
  }

  for (const attempt of attempts) {
    trajectory.push({
      order,
      kind: "node_attempt",
      source: "agentflow",
      ...(attempt.compiled_id ? { node_id: attempt.compiled_id } : {}),
      ...(attempt.authored_id ? { authored_id: attempt.authored_id } : {}),
      ...(attempt.status ? { status: attempt.status } : {}),
      ...(attempt.kind ? { node_kind: attempt.kind } : {}),
      ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
      ...(attempt.execution_id ? { execution_id: attempt.execution_id } : {}),
      ...(attempt.attempt_index !== undefined ? { attempt_index: attempt.attempt_index } : {})
    });
    order += 1;
  }

  for (const entry of completionPackets) {
    trajectory.push({
      order,
      kind: "completion_packet",
      source: "agentflow",
      ...(entry.attempt.compiled_id ? { node_id: entry.attempt.compiled_id } : {}),
      ...(entry.attempt.authored_id ? { authored_id: entry.attempt.authored_id } : {}),
      ...(entry.attempt.execution_id ? { execution_id: entry.attempt.execution_id } : {}),
      ...(typeof entry.packet.completion_status === "string"
        ? { completion_status: entry.packet.completion_status }
        : {}),
      ...(typeof entry.packet.ready_for_verification === "boolean"
        ? { ready_for_verification: entry.packet.ready_for_verification }
        : {}),
      packet_path: entry.packet_path
    });
    order += 1;
  }

  for (const invocation of toolInvocations) {
    const afCommand = afCommandFromInvocation(invocation.record);
    if (!afCommand) {
      continue;
    }
    trajectory.push({
      order,
      kind: "af_tool_call",
      source: "agentflow",
      command: `af ${afCommand}`,
      af_command: afCommand,
      ...(invocation.attempt.compiled_id ? { node_id: invocation.attempt.compiled_id } : {}),
      ...(invocation.attempt.authored_id ? { authored_id: invocation.attempt.authored_id } : {}),
      ...(invocation.attempt.execution_id ? { execution_id: invocation.attempt.execution_id } : {}),
      ...(typeof invocation.record.exit_code === "number" ? { exit_code: invocation.record.exit_code } : {}),
      ...(typeof invocation.record.duration_ms === "number" ? { duration_ms: invocation.record.duration_ms } : {})
    });
    order += 1;
  }

  for (const simulationEvent of simulationEvents) {
    trajectory.push({
      order,
      kind: "simulation_tool_call",
      source: "simulation",
      ...(typeof simulationEvent.timestamp === "string" ? { timestamp: simulationEvent.timestamp } : {}),
      ...(typeof simulationEvent.command === "string" ? { command: simulationEvent.command } : {}),
      ...(typeof simulationEvent.rule_id === "string" ? { rule_id: simulationEvent.rule_id } : {}),
      ...(typeof simulationEvent.matched === "boolean" ? { matched: simulationEvent.matched } : {}),
      ...(typeof simulationEvent.exit_code === "number" ? { exit_code: simulationEvent.exit_code } : {}),
      ...simulationEvent
    });
    order += 1;
  }

  for (const artifact of artifacts) {
    trajectory.push({
      order,
      kind: "artifact_write",
      source: "agentflow",
      artifact: artifact.name,
      path: artifact.path
    });
    order += 1;
  }

  if (manifest !== undefined) {
    trajectory.push({
      order,
      kind: "delivery",
      source: "agentflow",
      path: manifestPath
    });
  }

  return {
    schema_version: "1",
    run_root: options.run_root,
    outcome: {
      status: state.status,
      counts: state.counts
    },
    attempts: attempts.map((attempt) => {
      const summary: EvalTraceAttempt = {
        execution_id: attempt.execution_id,
        compiled_id: attempt.compiled_id,
        authored_id: attempt.authored_id,
        kind: attempt.kind,
        status: attempt.status,
        attempt_index: attempt.attempt_index,
        artifacts: attempt.artifacts
      };

      if (attempt.outcome !== undefined) {
        summary.outcome = attempt.outcome;
      }

      if (attempt.duration_ms !== undefined) {
        summary.duration_ms = attempt.duration_ms;
      }

      return summary;
    }),
    artifacts,
    events: eventRecords,
    trajectory,
    simulation_events: simulationEvents,
    supervisor: {
      classifications: [...classifications],
      gatherers: [...gatherers],
      apply_actions: [...applyActions],
      resume_decisions: resumeDecisions,
      intervention_decisions: interventionDecisions,
      recovery_learning: recoveryLearning,
      intervention_count: interventionEvents.length,
      recovery_count: interventionEvents.filter((event) =>
        typeof event.type === "string" && event.type.includes("intervention")
      ).length
    },
    prompt_diagnostics: promptDiagnostics,
    delivery: {
      manifest_path: manifestPath,
      review_brief_path: reviewBriefPath,
      curation_verdict_path: curationVerdictPath,
      ...(typeof manifestRecord?.graph_status === "string" ? { graph_status: manifestRecord.graph_status } : {}),
      ...(typeof manifestRecord?.delivery_status === "string" ? { delivery_status: manifestRecord.delivery_status } : {}),
      ...(typeof manifestRecord?.review_ready === "boolean" ? { review_ready: manifestRecord.review_ready } : {}),
      ...(curationVerdict !== undefined ? { curation_verdict: curationVerdict } : {}),
      ...(manifest !== undefined ? { manifest } : {})
    },
    metrics: {
      attempts: attempts.length,
      events: events.length,
      artifacts: artifacts.length,
      recovery_cycles: interventionEvents.length,
      simulation_events: simulationEvents.length,
      trajectory_events: trajectory.length,
      prompt_diagnostics_count: promptDiagnostics.count,
      prompt_diagnostics_warnings: promptDiagnostics.warnings.length,
      prompt_diagnostics_total_chars: promptDiagnostics.total_chars,
      prompt_diagnostics_max_chars: promptDiagnostics.max_prompt_chars,
      recovery_learning_records: recoveryLearning.length
    }
  };
}
