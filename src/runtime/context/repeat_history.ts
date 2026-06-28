import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type {
  CompiledExecutableNode,
  CompiledGraph,
  CompiledRepeatScope
} from "../../graph/compiled.js";
import type { AttemptRegistry, RuntimeNodeAttempt } from "../attempts.js";
import { listAttemptsForCompiledNode } from "../attempts.js";
import type { RuntimeRepeatHistoryContext } from "./packet.js";

const repeatHistoryDescription =
  "Deterministic summary of completed prior iterations in the enclosing repeat scope.";
const maxIncludedIterations = 5;
const maxAgentResponseChars = 4000;
const maxFeedbackChars = 4000;
const maxLogChars = 8000;

export interface RepeatHistoryBuildOptions {
  compiled_graph: CompiledGraph;
  node: CompiledExecutableNode;
  execution_id: string;
  attempts: AttemptRegistry;
}

export interface RepeatHistoryMaterial {
  source: RuntimeRepeatHistoryContext;
  description: string;
  text: string;
}

export interface RepeatHistoryOmission {
  source: RuntimeRepeatHistoryContext;
  description: string;
  reason: string;
}

export type RepeatHistoryBuildResult = RepeatHistoryMaterial | RepeatHistoryOmission;

function describeReservedArtifact(artifact: string): string | undefined {
  if (artifact === "agent_response") {
    return "Final response captured from the producer node.";
  }

  if (artifact === "verification_json") {
    return "Structured verification record captured from the producer node.";
  }

  return undefined;
}

function createSource(repeatScopeId: string, currentIteration: number): RuntimeRepeatHistoryContext {
  return {
    name: "repeat_history",
    from: "runtime_repeat_history",
    repeat_scope_id: repeatScopeId,
    current_iteration: currentIteration
  };
}

function findRepeatScope(graph: CompiledGraph, repeatScopeId: string): CompiledRepeatScope | undefined {
  return graph.scopes.find(
    (scope): scope is CompiledRepeatScope => scope.kind === "repeat" && scope.scope_id === repeatScopeId
  );
}

function findCurrentAttempt(options: RepeatHistoryBuildOptions): RuntimeNodeAttempt | undefined {
  return (
    options.attempts.active_by_execution_id.get(options.execution_id)
    ?? listAttemptsForCompiledNode(options.attempts, options.node.compiled_id)
      .find((attempt) => attempt.execution_id === options.execution_id)
  );
}

function terminalAttemptsForCompiledId(
  registry: AttemptRegistry,
  compiledId: string,
  repeatScopeId: string,
  iterationIndex: number
): RuntimeNodeAttempt[] {
  return listAttemptsForCompiledNode(registry, compiledId)
    .filter((attempt) =>
      attempt.repeat_scope_id === repeatScopeId
      && attempt.iteration_index === iterationIndex
      && attempt.status !== "running"
    );
}

function latestAttempt(attempts: RuntimeNodeAttempt[]): RuntimeNodeAttempt | undefined {
  return attempts.reduce<RuntimeNodeAttempt | undefined>((latest, attempt) => {
    if (!latest) {
      return attempt;
    }

    return attempt.attempt_index > latest.attempt_index ? attempt : latest;
  }, undefined);
}

function collectPriorIterationIndexes(
  graph: CompiledGraph,
  scope: CompiledRepeatScope,
  registry: AttemptRegistry,
  currentIteration: number
): number[] {
  const indexes = new Set<number>();

  for (const compiledId of scope.compiled_node_ids) {
    for (const attempt of listAttemptsForCompiledNode(registry, compiledId)) {
      if (
        attempt.repeat_scope_id === scope.scope_id
        && attempt.iteration_index !== undefined
        && attempt.iteration_index < currentIteration
        && attempt.status !== "running"
        && graph.nodes.some((node) => node.compiled_id === compiledId)
      ) {
        indexes.add(attempt.iteration_index);
      }
    }
  }

  return [...indexes].sort((left, right) => left - right);
}

function truncateHead(text: string, maxChars: number): string {
  const trimmed = text.trim();

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars).trimEnd()}\n[Later content omitted by the runtime.]`;
}

function truncateTail(text: string, maxChars: number): string {
  const trimmed = text.trim();

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `[Earlier output omitted by the runtime.]\n${trimmed.slice(-maxChars).trimStart()}`;
}

async function readTextSnippet(
  path: string | undefined,
  maxChars: number,
  direction: "head" | "tail"
): Promise<string | undefined> {
  if (!path) {
    return undefined;
  }

  try {
    const text = await readFile(path, "utf8");
    return direction === "head" ? truncateHead(text, maxChars) : truncateTail(text, maxChars);
  } catch {
    return undefined;
  }
}

async function readJsonRecord(path: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!path) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function formatScalar(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function resultSummaryLines(result: Record<string, unknown> | undefined): string[] {
  if (!result) {
    return [];
  }

  const keys = ["summary", "error", "exit_code", "timed_out", "passed", "score"] as const;
  const lines: string[] = [];

  for (const key of keys) {
    const value = formatScalar(result[key]);

    if (value !== undefined) {
      lines.push(`- ${key}: ${value}`);
    }
  }

  return lines;
}

function artifactDescription(node: CompiledExecutableNode, artifact: string): string {
  return node.declared_artifacts[artifact]?.description
    ?? describeReservedArtifact(artifact)
    ?? "Declared artifact.";
}

function pushFenced(lines: string[], label: string, text: string): void {
  if (text.trim().length === 0) {
    return;
  }

  lines.push(label, "", "```text", text.trimEnd(), "```", "");
}

async function renderAttemptSection(
  graph: CompiledGraph,
  node: CompiledExecutableNode,
  attempt: RuntimeNodeAttempt
): Promise<string[]> {
  const lines = [
    `### ${node.authored_id} (${node.kind})`,
    "",
    `- Outcome: ${attempt.outcome ?? attempt.status}`,
    `- Attempt: ${attempt.attempt_index}${attempt.iteration_attempt_index !== undefined ? `, iteration attempt ${attempt.iteration_attempt_index}` : ""}`
  ];

  const artifacts = Object.keys(attempt.artifacts).sort();

  if (artifacts.length > 0) {
    lines.push("- Artifacts:");
    for (const artifact of artifacts) {
      lines.push(`  - ${artifact}: ${artifactDescription(node, artifact)} (${basename(attempt.artifacts[artifact]!)})`);
    }
  }

  const result = await readJsonRecord(
    attempt.kind === "check"
      ? (attempt.artifacts.verification_json ?? attempt.result_path)
      : attempt.result_path
  );
  const resultLines = resultSummaryLines(result);

  if (resultLines.length > 0) {
    lines.push("", "Result facts:", ...resultLines);
  }

  if (node.kind === "agent") {
    const agentResponse = await readTextSnippet(attempt.artifacts.agent_response, maxAgentResponseChars, "head");

    if (agentResponse) {
      lines.push("");
      pushFenced(lines, "Agent response:", agentResponse);
    }
  }

  if (node.kind === "checkpoint") {
    const feedback = await readTextSnippet(attempt.artifacts.operator_feedback, maxFeedbackChars, "head");

    if (feedback) {
      lines.push("");
      pushFenced(lines, "Operator feedback:", feedback);
    }
  }

  if ((node.kind === "exec" || node.kind === "check") && attempt.outcome === "failed") {
    const stderr = await readTextSnippet(attempt.stderr_log_path, maxLogChars, "tail");
    const stdout = await readTextSnippet(attempt.stdout_log_path, maxLogChars, "tail");

    if (stderr) {
      lines.push("");
      pushFenced(lines, "stderr excerpt:", stderr);
    }

    if (stdout) {
      lines.push("");
      pushFenced(lines, "stdout excerpt:", stdout);
    }
  }

  if (node.kind === "check") {
    const untilScopes = graph.scopes
      .filter((scope): scope is CompiledRepeatScope => scope.kind === "repeat")
      .filter((scope) => scope.until_compiled_id === node.compiled_id)
      .map((scope) => scope.authored_id);

    if (untilScopes.length > 0) {
      lines.push("", `Repeat gate for: ${untilScopes.map((scope) => `\`${scope}\``).join(", ")}`);
    }
  }

  return lines;
}

function renderRetryCause(
  graph: CompiledGraph,
  scope: CompiledRepeatScope,
  registry: AttemptRegistry,
  previousIteration: number
): string[] {
  const gateNode = graph.nodes.find((node) => node.compiled_id === scope.until_compiled_id);
  const gateAttempt = latestAttempt(
    terminalAttemptsForCompiledId(registry, scope.until_compiled_id, scope.scope_id, previousIteration)
  );

  if (!gateNode || !gateAttempt) {
    return [
      "## Why This Iteration Is Running",
      "",
      `- Previous iteration: ${previousIteration}`,
      "- Retry cause: no completed repeat gate attempt was recorded.",
      ""
    ];
  }

  const lines = [
    "## Why This Iteration Is Running",
    "",
    `- Previous iteration: ${previousIteration}`,
    `- Repeat gate: ${gateNode.authored_id}`,
    `- Gate outcome: ${gateAttempt.outcome ?? gateAttempt.status}`
  ];

  if (gateAttempt.outcome === "failed") {
    lines.push(`- Loop continued because \`${gateNode.authored_id}\` failed.`);
  }

  lines.push("");
  return lines;
}

export async function buildRepeatHistory(
  options: RepeatHistoryBuildOptions
): Promise<RepeatHistoryBuildResult | undefined> {
  const repeatScopeId = options.node.repeat_scope_id;

  if (!repeatScopeId) {
    return undefined;
  }

  const currentAttempt = findCurrentAttempt(options);
  const currentIteration = currentAttempt?.iteration_index ?? 0;
  const source = createSource(repeatScopeId, currentIteration);

  if (!currentAttempt || currentIteration === 0) {
    return {
      source,
      description: repeatHistoryDescription,
      reason: "Repeat history is unavailable because the current repeat iteration is unknown."
    };
  }

  if (currentIteration === 1) {
    return {
      source,
      description: repeatHistoryDescription,
      reason: "No prior repeat iterations have completed."
    };
  }

  const repeatScope = findRepeatScope(options.compiled_graph, repeatScopeId);

  if (!repeatScope) {
    return {
      source,
      description: repeatHistoryDescription,
      reason: `Repeat scope "${repeatScopeId}" was not found.`
    };
  }

  const priorIterations = collectPriorIterationIndexes(
    options.compiled_graph,
    repeatScope,
    options.attempts,
    currentIteration
  );

  if (priorIterations.length === 0) {
    return {
      source,
      description: repeatHistoryDescription,
      reason: "No prior repeat iteration attempts are available."
    };
  }

  const includedIterations = priorIterations.slice(-maxIncludedIterations);
  const omittedCount = priorIterations.length - includedIterations.length;
  const lines = [
    "# Repeat History",
    "",
    "This context is generated from completed prior repeat iterations. Use it to avoid repeating unsuccessful work.",
    "",
    `- Repeat: ${repeatScope.authored_id}`,
    `- Repeat scope: ${repeatScope.scope_id}`,
    `- Current iteration: ${currentIteration} of ${repeatScope.max_attempts}`,
    `- Included prior iterations: ${includedIterations.join(", ")}`
  ];

  if (omittedCount > 0) {
    lines.push(`- Earlier iterations omitted from this history: ${omittedCount}`);
  }

  lines.push("", ...renderRetryCause(options.compiled_graph, repeatScope, options.attempts, currentIteration - 1));

  const nodeById = new Map(options.compiled_graph.nodes.map((node) => [node.compiled_id, node]));

  for (const iteration of includedIterations) {
    lines.push(`## Iteration ${iteration}`, "");

    const gateAttempt = latestAttempt(
      terminalAttemptsForCompiledId(options.attempts, repeatScope.until_compiled_id, repeatScope.scope_id, iteration)
    );

    if (gateAttempt) {
      lines.push(`- Iteration outcome: ${gateAttempt.outcome ?? gateAttempt.status}`, "");
    }

    for (const compiledId of repeatScope.compiled_node_ids) {
      const node = nodeById.get(compiledId);
      const attempt = latestAttempt(
        terminalAttemptsForCompiledId(options.attempts, compiledId, repeatScope.scope_id, iteration)
      );

      if (!node || !attempt) {
        continue;
      }

      lines.push(...await renderAttemptSection(options.compiled_graph, node, attempt), "");
    }
  }

  return {
    source,
    description: repeatHistoryDescription,
    text: `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`
  };
}
