import type { CompiledExecutableNode, CompiledGraph } from "../graph/compiled.js";
import type { RuntimeEventEnvelope } from "../runtime/events.js";

interface WritableStreamLike {
  write(chunk: string): unknown;
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || Number.isNaN(durationMs)) {
    return "0ms";
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const totalSeconds = Math.round(durationMs / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function summarizeNode(node: CompiledExecutableNode | undefined): string {
  if (!node) {
    return "unknown-node";
  }

  return node.label ?? node.authored_id;
}

function summarizeScope(
  scopeById: Map<string, { authored_id: string }>,
  repeatScopeId: string | undefined
): string {
  if (!repeatScopeId) {
    return "unknown-repeat";
  }

  return scopeById.get(repeatScopeId)?.authored_id ?? repeatScopeId;
}

export interface RuntimeProgressReporter {
  onEvent(event: RuntimeEventEnvelope): void;
}

export function createRuntimeProgressReporter(
  graph: CompiledGraph,
  stream: WritableStreamLike = process.stderr
): RuntimeProgressReporter {
  const nodeByCompiledId = new Map(graph.nodes.map((node) => [node.compiled_id, node]));
  const scopeById = new Map(graph.scopes.map((scope) => [scope.scope_id, scope]));
  const nodeStatuses = new Map(graph.nodes.map((node) => [node.compiled_id, "pending"]));
  const totalNodes = graph.nodes.length;
  let preservedTerminalCount = 0;

  const terminalStatuses = new Set(["passed", "failed", "blocked", "canceled", "skipped"]);

  function countTerminalNodes(): number {
    return preservedTerminalCount + [...nodeStatuses.values()].filter((status) => terminalStatuses.has(status)).length;
  }

  function writeLine(line: string): void {
    try {
      stream.write(`${line}\n`);
    } catch {
      // CLI progress is best-effort.
    }
  }

  return {
    onEvent(event) {
      switch (event.type) {
        case "graph.compiled": {
          writeLine(
            `agentflow: compiled graph "${graph.graph_id}" with ${totalNodes} executable nodes`
          );
          return;
        }

        case "run.started": {
          const payload = event.payload as {
            resumed?: boolean;
            previous_status?: string;
            preserved_node_count?: number;
            restarted_node_count?: number;
            workspace_backend?: string;
          };

          if (payload.resumed) {
            preservedTerminalCount = payload.preserved_node_count ?? 0;
            writeLine(
              `agentflow: resumed run from ${payload.previous_status ?? "unknown"} · preserved=${payload.preserved_node_count ?? 0} restarted=${payload.restarted_node_count ?? 0} · workspace=${payload.workspace_backend ?? "unknown"}`
            );
            return;
          }

          writeLine(
            `agentflow: started run · workspace=${payload.workspace_backend ?? "unknown"}`
          );
          return;
        }

        case "repeat.iteration.started": {
          const payload = event.payload as { max_attempts?: number };
          writeLine(
            `agentflow: repeat ${summarizeScope(scopeById, event.repeat_scope_id)} iteration ${event.iteration_index ?? "?"}/${payload.max_attempts ?? "?"}`
          );
          return;
        }

        case "node.started": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { kind?: string; repo_alias?: string };
          if (event.compiled_id) {
            nodeStatuses.set(event.compiled_id, "running");
          }
          writeLine(
            `[${countTerminalNodes()}/${totalNodes}] start ${payload.kind ?? node?.kind ?? "node"} ${summarizeNode(node)} · repo=${payload.repo_alias ?? node?.repo ?? "unknown"}`
          );
          return;
        }

        case "supervisor.decision": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { kind?: string; action?: string; reason?: string };
          writeLine(
            `agentflow: supervisor ${payload.kind ?? "decision"} ${summarizeNode(node)}${payload.action ? ` · ${payload.action}` : ""}${payload.reason ? ` · ${payload.reason}` : ""}`
          );
          return;
        }

        case "supervisor.intervention.started": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { action?: string; summary?: string };
          writeLine(
            `agentflow: intervention started ${summarizeNode(node)}${payload.action ? ` · ${payload.action}` : ""}${payload.summary ? ` · ${payload.summary}` : ""}`
          );
          return;
        }

        case "supervisor.intervention.completed": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { action?: string; summary?: string };
          writeLine(
            `agentflow: intervention completed ${summarizeNode(node)}${payload.action ? ` · ${payload.action}` : ""}${payload.summary ? ` · ${payload.summary}` : ""}`
          );
          return;
        }

        case "supervisor.intervention.failed": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { action?: string; summary?: string };
          writeLine(
            `agentflow: intervention failed ${summarizeNode(node)}${payload.action ? ` · ${payload.action}` : ""}${payload.summary ? ` · ${payload.summary}` : ""}`
          );
          return;
        }

        case "supervisor.paused": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { reason?: string; summary?: string };
          writeLine(
            `agentflow: supervisor paused ${summarizeNode(node)}${payload.summary ? ` · ${payload.summary}` : payload.reason ? ` · ${payload.reason}` : ""}`
          );
          return;
        }

        case "check.evaluated": {
          const payload = event.payload as { passed?: boolean; score?: number; summary?: string };

          if (payload.passed === false) {
            const node = nodeByCompiledId.get(event.compiled_id ?? "");
            const scoreText =
              payload.score !== undefined ? ` · score=${payload.score.toFixed(2)}` : "";
            writeLine(
              `agentflow: check failed ${summarizeNode(node)}${scoreText}${payload.summary ? ` · ${payload.summary}` : ""}`
            );
          }
          return;
        }

        case "verification.recorded": {
          const payload = event.payload as {
            passed?: boolean;
            summary?: string;
            verifier_kind?: string;
          };

          if (payload.passed === false) {
            const node = nodeByCompiledId.get(event.compiled_id ?? "");
            writeLine(
              `agentflow: soft verification failed ${summarizeNode(node)}${payload.summary ? ` · ${payload.summary}` : payload.verifier_kind ? ` · ${payload.verifier_kind}` : ""}`
            );
          }
          return;
        }

        case "node.completed": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { outcome?: string; duration_ms?: number };
          if (event.compiled_id) {
            nodeStatuses.set(event.compiled_id, payload.outcome ?? "failed");
          }
          writeLine(
            `[${countTerminalNodes()}/${totalNodes}] ${payload.outcome ?? "failed"} ${node?.kind ?? "node"} ${summarizeNode(node)} · ${formatDuration(payload.duration_ms)}`
          );
          return;
        }

        case "node.canceled": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          if (event.compiled_id) {
            nodeStatuses.set(event.compiled_id, "canceled");
          }
          writeLine(
            `[${countTerminalNodes()}/${totalNodes}] canceled ${node?.kind ?? "node"} ${summarizeNode(node)}`
          );
          return;
        }

        case "node.blocked": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { reason?: string };
          if (event.compiled_id) {
            nodeStatuses.set(event.compiled_id, "blocked");
          }
          writeLine(
            `[${countTerminalNodes()}/${totalNodes}] blocked ${node?.kind ?? "node"} ${summarizeNode(node)}${payload.reason ? ` · ${payload.reason}` : ""}`
          );
          return;
        }

        case "node.skipped": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { reason?: string };
          if (event.compiled_id) {
            nodeStatuses.set(event.compiled_id, "skipped");
          }
          writeLine(
            `[${countTerminalNodes()}/${totalNodes}] skipped ${node?.kind ?? "node"} ${summarizeNode(node)}${payload.reason ? ` · ${payload.reason}` : ""}`
          );
          return;
        }

        case "run.preflight_failed": {
          const payload = event.payload as { reason?: string; message?: string };
          writeLine(
            `agentflow: preflight failed${payload.reason ? ` (${payload.reason})` : ""}${payload.message ? ` · ${payload.message}` : ""}`
          );
          return;
        }

        case "run.canceled": {
          const payload = event.payload as { reason?: string };
          writeLine(`agentflow: run canceled${payload.reason ? ` · ${payload.reason}` : ""}`);
          return;
        }

        case "run.completed": {
          const payload = event.payload as { outcome?: string; duration_ms?: number; reason?: string };
          writeLine(
            `agentflow: run ${payload.outcome ?? "completed"} · ${countTerminalNodes()}/${totalNodes} terminal nodes · ${formatDuration(payload.duration_ms)}${payload.reason ? ` · ${payload.reason}` : ""}`
          );
          return;
        }

        case "delivery.package.completed": {
          const payload = event.payload as { manifest_path?: string; reviewer_guide?: string };
          writeLine(
            `agentflow: delivery package ready${payload.manifest_path ? ` · ${payload.manifest_path}` : ""}${payload.reviewer_guide ? ` · reviewer=${payload.reviewer_guide}` : ""}`
          );
          return;
        }

        default:
          return;
      }
    }
  };
}
