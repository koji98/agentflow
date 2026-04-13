import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  readCompiledGraph,
  readExecutionManifest,
  readRunEvents,
  readRunExecutionAttempts,
  readRunRecord,
  readRunState
} from "../artifacts/reader.js";
import type { CompiledExecutableNode } from "../graph/compiled.js";

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
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
      declared_outputs: node.declared_outputs,
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
