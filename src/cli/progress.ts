import type { CompiledExecutableNode, CompiledGraph } from "../graph/compiled.js";
import type { RuntimeEventEnvelope } from "../runtime/events.js";

interface WritableStreamLike {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

type AnsiColor = "cyan" | "dim" | "green" | "red" | "yellow";

const SUB_EVENT_INDENT = "  ";
const STATUS_WIDTH = 8;
const COLOR_CODES: Record<AnsiColor, number> = {
  cyan: 36,
  dim: 2,
  green: 32,
  red: 31,
  yellow: 33
};

function shouldUseColor(stream: WritableStreamLike): boolean {
  return stream.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

function paint(enabled: boolean, color: AnsiColor, text: string): string {
  if (!enabled || text.length === 0) {
    return text;
  }

  return `\u001b[${COLOR_CODES[color]}m${text}\u001b[0m`;
}

function statusColor(label: string): AnsiColor {
  switch (label) {
    case "PASS":
      return "green";
    case "FAIL":
      return "red";
    case "BLOCK":
    case "CANCEL":
    case "SKIP":
    case "PAUSE":
    case "RETRY":
      return "yellow";
    default:
      return "cyan";
  }
}

function formatStatus(enabled: boolean, label: string): string {
  const padded = label.padEnd(STATUS_WIDTH, " ");
  return paint(enabled, statusColor(label), padded);
}

function formatMutedDetail(enabled: boolean, text: string | undefined): string {
  if (!text) {
    return "";
  }

  return paint(enabled, "dim", text);
}

function formatNodeLine(
  colorEnabled: boolean,
  count: number,
  total: number,
  status: string,
  kind: string,
  label: string,
  detail?: string
): string {
  return `[${count}/${total}] ${formatStatus(colorEnabled, status)} ${kind} ${label}${formatMutedDetail(colorEnabled, detail)}`;
}

function formatSubEventLine(
  colorEnabled: boolean,
  status: string,
  subject: string,
  detail?: string,
  options?: { muteDetail?: boolean }
): string {
  const renderedDetail = options?.muteDetail ? formatMutedDetail(colorEnabled, detail) : detail ?? "";
  return `${SUB_EVENT_INDENT}${formatStatus(colorEnabled, status)} ${subject}${renderedDetail}`;
}

function formatRunLine(
  colorEnabled: boolean,
  status: string,
  subject: string,
  detail?: string
): string {
  return `agentflow: ${formatStatus(colorEnabled, status)} ${subject}${formatMutedDetail(colorEnabled, detail)}`;
}

function statusForOutcome(outcome: string | undefined): string {
  switch (outcome) {
    case "passed":
      return "PASS";
    case "failed":
      return "FAIL";
    case "blocked":
      return "BLOCK";
    case "canceled":
      return "CANCEL";
    case "skipped":
      return "SKIP";
    default:
      return "FAIL";
  }
}

function statusForRunOutcome(outcome: string | undefined): string {
  if (outcome === undefined || outcome === "completed" || outcome === "passed") {
    return "PASS";
  }

  return statusForOutcome(outcome);
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
  const colorEnabled = shouldUseColor(stream);

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
              formatRunLine(
                colorEnabled,
                "RUN",
                "resume",
                ` · from=${payload.previous_status ?? "unknown"} · preserved=${payload.preserved_node_count ?? 0} restarted=${payload.restarted_node_count ?? 0} · workspace=${payload.workspace_backend ?? "unknown"}`
              )
            );
            return;
          }

          writeLine(
            formatRunLine(
              colorEnabled,
              "RUN",
              "run",
              ` · workspace=${payload.workspace_backend ?? "unknown"}`
            )
          );
          return;
        }

        case "repeat.iteration.started": {
          const payload = event.payload as { max_attempts?: number };
          writeLine(
            formatSubEventLine(
              colorEnabled,
              "REPEAT",
              summarizeScope(scopeById, event.repeat_scope_id),
              ` · iteration=${event.iteration_index ?? "?"}/${payload.max_attempts ?? "?"}`,
              { muteDetail: true }
            )
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
            formatNodeLine(
              colorEnabled,
              countTerminalNodes(),
              totalNodes,
              "RUN",
              payload.kind ?? node?.kind ?? "node",
              summarizeNode(node),
              ` · repo=${payload.repo_alias ?? node?.repo ?? "unknown"}`
            )
          );
          return;
        }

        case "supervisor.decision": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { kind?: string; action?: string; reason?: string };
          writeLine(
            formatSubEventLine(
              colorEnabled,
              payload.action?.includes("retry") ? "RETRY" : "MANAGED",
              `supervisor ${payload.kind ?? "decision"} ${summarizeNode(node)}`,
              `${payload.action ? ` · ${payload.action}` : ""}${payload.reason ? ` · ${payload.reason}` : ""}`
            )
          );
          return;
        }

        case "supervisor.intervention.started": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { action?: string; summary?: string };
          writeLine(
            formatSubEventLine(
              colorEnabled,
              "RETRY",
              `intervention started ${summarizeNode(node)}`,
              `${payload.action ? ` · ${payload.action}` : ""}${payload.summary ? ` · ${payload.summary}` : ""}`
            )
          );
          return;
        }

        case "supervisor.intervention.retry": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as {
            action?: string;
            attempt?: number;
            max_attempts?: number;
            delay_ms?: number;
            summary?: string;
          };
          writeLine(
            formatSubEventLine(
              colorEnabled,
              "RETRY",
              `intervention ${summarizeNode(node)}`,
              `${payload.action ? ` · ${payload.action}` : ""} · attempt=${payload.attempt ?? "?"}/${payload.max_attempts ?? "?"} · delay=${formatDuration(payload.delay_ms ?? 0)}${payload.summary ? ` · ${payload.summary}` : ""}`
            )
          );
          return;
        }

        case "supervisor.intervention.completed": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { action?: string; summary?: string };
          writeLine(
            formatSubEventLine(
              colorEnabled,
              "PASS",
              `intervention completed ${summarizeNode(node)}`,
              `${payload.action ? ` · ${payload.action}` : ""}${payload.summary ? ` · ${payload.summary}` : ""}`
            )
          );
          return;
        }

        case "supervisor.intervention.failed": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { action?: string; summary?: string };
          writeLine(
            formatSubEventLine(
              colorEnabled,
              "FAIL",
              `intervention failed ${summarizeNode(node)}`,
              `${payload.action ? ` · ${payload.action}` : ""}${payload.summary ? ` · ${payload.summary}` : ""}`
            )
          );
          return;
        }

        case "supervisor.paused": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { reason?: string; summary?: string };
          writeLine(
            formatSubEventLine(
              colorEnabled,
              "PAUSE",
              `supervisor paused ${summarizeNode(node)}`,
              payload.summary ? ` · ${payload.summary}` : payload.reason ? ` · ${payload.reason}` : ""
            )
          );
          return;
        }

        case "managed.progress": {
          const payload = event.payload as {
            managed_kind?: string;
            managed_authored_id?: string;
            phase?: string;
            status?: string;
            item_id?: string;
            attempt?: number;
            max_attempts?: number;
            summary?: string;
          };
          if (payload.status !== "healthy_progress") {
            const detailParts = [
              payload.status ?? "unknown",
              ...(payload.item_id ? [`item=${payload.item_id}`] : []),
              ...(payload.attempt !== undefined || payload.max_attempts !== undefined
                ? [`attempt=${payload.attempt ?? "?"}/${payload.max_attempts ?? "?"}`]
                : []),
              ...(payload.summary ? [payload.summary] : [])
            ];
            writeLine(
              formatSubEventLine(
                colorEnabled,
                payload.status?.includes("failed") ? "FAIL" : payload.status?.includes("retry") || payload.status?.includes("recover") ? "RETRY" : "MANAGED",
                `${payload.managed_kind ?? "pattern"} ${payload.managed_authored_id ?? "workflow"} ${payload.phase ?? "progress"}`,
                ` · ${detailParts.join(" · ")}`,
                { muteDetail: true }
              )
            );
          }
          return;
        }

        case "check.evaluated": {
          const payload = event.payload as { passed?: boolean; score?: number; summary?: string };

          if (payload.passed === false) {
            const node = nodeByCompiledId.get(event.compiled_id ?? "");
            const scoreText =
              payload.score !== undefined ? ` · score=${payload.score.toFixed(2)}` : "";
            writeLine(
              formatSubEventLine(
                colorEnabled,
                "FAIL",
                `check ${summarizeNode(node)}`,
                `${scoreText}${payload.summary ? ` · ${payload.summary}` : ""}`
              )
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
              formatSubEventLine(
                colorEnabled,
                "FAIL",
                `verification recorded ${summarizeNode(node)}`,
                payload.summary ? ` · ${payload.summary}` : payload.verifier_kind ? ` · ${payload.verifier_kind}` : ""
              )
            );
          }
          return;
        }

        case "verification.started": {
          const payload = event.payload as { verifier_kind?: string; check_kind?: string };
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          writeLine(
            formatSubEventLine(
              colorEnabled,
              "VERIFY",
              `start ${summarizeNode(node)}`,
              ` · ${payload.check_kind ?? payload.verifier_kind ?? "verification"}`
            )
          );
          return;
        }

        case "verification.retry": {
          const payload = event.payload as { verifier_kind?: string; check_kind?: string; attempt?: number; summary?: string };
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          writeLine(
            formatSubEventLine(
              colorEnabled,
              "RETRY",
              `verification ${summarizeNode(node)}`,
              `${payload.attempt !== undefined ? ` · attempt=${payload.attempt}` : ""}${payload.summary ? ` · ${payload.summary}` : payload.check_kind ?? payload.verifier_kind ? ` · ${payload.check_kind ?? payload.verifier_kind}` : ""}`
            )
          );
          return;
        }

        case "verification.completed": {
          const payload = event.payload as { passed?: boolean; verifier_kind?: string; check_kind?: string; summary?: string };
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          writeLine(
            formatSubEventLine(
              colorEnabled,
              payload.passed === false ? "FAIL" : "PASS",
              `verification ${summarizeNode(node)}`,
              payload.summary ? ` · ${payload.summary}` : payload.check_kind ?? payload.verifier_kind ? ` · ${payload.check_kind ?? payload.verifier_kind}` : ""
            )
          );
          return;
        }

        case "node.completed": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          const payload = event.payload as { outcome?: string; duration_ms?: number };
          if (event.compiled_id) {
            nodeStatuses.set(event.compiled_id, payload.outcome ?? "failed");
          }
          writeLine(
            formatNodeLine(
              colorEnabled,
              countTerminalNodes(),
              totalNodes,
              statusForOutcome(payload.outcome),
              node?.kind ?? "node",
              summarizeNode(node),
              ` · ${formatDuration(payload.duration_ms)}`
            )
          );
          return;
        }

        case "node.canceled": {
          const node = nodeByCompiledId.get(event.compiled_id ?? "");
          if (event.compiled_id) {
            nodeStatuses.set(event.compiled_id, "canceled");
          }
          writeLine(
            formatNodeLine(
              colorEnabled,
              countTerminalNodes(),
              totalNodes,
              "CANCEL",
              node?.kind ?? "node",
              summarizeNode(node)
            )
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
            formatNodeLine(
              colorEnabled,
              countTerminalNodes(),
              totalNodes,
              "BLOCK",
              node?.kind ?? "node",
              summarizeNode(node),
              payload.reason ? ` · ${payload.reason}` : ""
            )
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
            formatNodeLine(
              colorEnabled,
              countTerminalNodes(),
              totalNodes,
              "SKIP",
              node?.kind ?? "node",
              summarizeNode(node),
              payload.reason ? ` · ${payload.reason}` : ""
            )
          );
          return;
        }

        case "run.preflight_failed": {
          const payload = event.payload as { reason?: string; message?: string };
          writeLine(
            formatRunLine(
              colorEnabled,
              "FAIL",
              "preflight",
              `${payload.reason ? ` · reason=${payload.reason}` : ""}${payload.message ? ` · ${payload.message}` : ""}`
            )
          );
          return;
        }

        case "run.canceled": {
          const payload = event.payload as { reason?: string };
          writeLine(formatRunLine(colorEnabled, "CANCEL", "run", payload.reason ? ` · ${payload.reason}` : ""));
          return;
        }

        case "run.completed": {
          const payload = event.payload as { outcome?: string; duration_ms?: number; reason?: string };
          writeLine(
            formatRunLine(
              colorEnabled,
              statusForRunOutcome(payload.outcome),
              "run",
              ` · ${countTerminalNodes()}/${totalNodes} terminal nodes · ${formatDuration(payload.duration_ms)}${payload.reason ? ` · ${payload.reason}` : ""}`
            )
          );
          return;
        }

        case "delivery.package.completed": {
          const payload = event.payload as { manifest_path?: string; review_brief?: string };
          writeLine(
            formatSubEventLine(
              colorEnabled,
              "PASS",
              "delivery package ready",
              `${payload.manifest_path ? ` · ${payload.manifest_path}` : ""}${payload.review_brief ? ` · review=${payload.review_brief}` : ""}`,
              { muteDetail: true }
            )
          );
          return;
        }

        case "delivery.curation.started": {
          writeLine(formatSubEventLine(colorEnabled, "DELIVERY", "curation started"));
          return;
        }

        case "delivery.curation.completed": {
          const payload = event.payload as { verdict_path?: string };
          writeLine(
            formatSubEventLine(
              colorEnabled,
              "PASS",
              "delivery curation",
              payload.verdict_path ? ` · ${payload.verdict_path}` : "",
              { muteDetail: true }
            )
          );
          return;
        }

        case "delivery.curation.failed": {
          const payload = event.payload as { verdict_path?: string; reason?: string };
          writeLine(
            formatSubEventLine(
              colorEnabled,
              "FAIL",
              "delivery curation",
              `${payload.verdict_path ? ` · ${payload.verdict_path}` : ""}${payload.reason ? ` · ${payload.reason}` : ""}`,
              { muteDetail: true }
            )
          );
          return;
        }

        default:
          return;
      }
    }
  };
}
