import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
import type { EvalTraceArtifact, EvalTraceAttempt, EvalTracePacket, EvalTrajectoryEvent } from "./types.js";

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
    const records = await readJsonLines(join(attempt.execution_dir, "tool-invocations.jsonl"));
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
        ? join(attempt.execution_dir, "completion-packet.json")
        : undefined;
    if (!packetPath) {
      return [];
    }
    const packet = readRecord(await readOptionalJson(packetPath));
    return packet ? [{ attempt, packet, packet_path: packetPath }] : [];
  }));
  return packetGroups.flat();
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

  const manifestPath = join(options.run_root, "delivery", "manifest.json");
  const reviewBriefPath = join(options.run_root, "delivery", "01-review-brief.md");
  const manifest = await readOptionalJson(manifestPath);
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
      intervention_count: interventionEvents.length,
      recovery_count: interventionEvents.filter((event) =>
        typeof event.type === "string" && event.type.includes("intervention")
      ).length
    },
    delivery: {
      manifest_path: manifestPath,
      review_brief_path: reviewBriefPath,
      ...(manifest !== undefined ? { manifest } : {})
    },
    metrics: {
      attempts: attempts.length,
      events: events.length,
      artifacts: artifacts.length,
      recovery_cycles: interventionEvents.length,
      simulation_events: simulationEvents.length,
      trajectory_events: trajectory.length
    }
  };
}
