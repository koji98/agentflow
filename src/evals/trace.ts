import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  readCompiledGraph,
  readExecutionManifest,
  readRunEvents,
  readRunExecutionAttempts,
  readRunRecord,
  readRunState
} from "../artifacts/reader.js";
import type { CompiledExecutableNode } from "../graph/compiled.js";
import type { EvalTraceArtifact, EvalTraceAttempt, EvalTracePacket } from "./types.js";

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
}): Promise<EvalTracePacket> {
  const [run, state, events, attempts] = await Promise.all([
    readRunRecord(options.run_root),
    readRunState(options.run_root),
    readRunEvents(options.run_root),
    readRunExecutionAttempts(options.run_root)
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

  const manifestPath = join(options.run_root, "delivery", "manifest.json");
  const manifest = await readOptionalJson(manifestPath);

  return {
    schema_version: "2",
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
      ...(manifest !== undefined ? { manifest } : {})
    },
    metrics: {
      attempts: attempts.length,
      events: events.length,
      artifacts: artifacts.length,
      recovery_cycles: interventionEvents.length
    }
  };
}
