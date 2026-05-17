import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CompiledExecutableNode } from "../../src/graph/compiled.js";
import { resolveExecutionHumanDebugToolDirectory } from "../../src/artifacts/paths.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { RuntimeNodeExecutorContext } from "../../src/runtime/core/engine.js";
import type { AgentInvocation, HarnessResult } from "../../src/runtime/harness/types.js";

interface RuntimeReadyTarget {
  runRoot: string;
  runId: string;
  graphId: string;
  executionId: string;
  executionDir: string;
  runtimeDir: string;
  toolInvocationsPath?: string;
  workspacePath: string;
  nodeId?: string;
  compiledId?: string;
  goal?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeRuntimeStateSegment(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "execution";
  if (sanitized.length <= 120) {
    return sanitized;
  }
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 16);
  const prefix = sanitized.slice(0, 96).replace(/_+$/g, "") || "execution";
  return `${prefix}_${hash}`;
}

async function writeOrientInvocation(target: RuntimeReadyTarget): Promise<void> {
  const toolInvocationsPath = target.toolInvocationsPath ?? join(resolveExecutionHumanDebugToolDirectory(target.executionDir), "index.jsonl");
  await mkdir(dirname(toolInvocationsPath), { recursive: true });
  await appendFile(toolInvocationsPath, `${JSON.stringify({
    ts: nowIso(),
    run_id: target.runId,
    graph_id: target.graphId,
    agent_id: target.executionId,
    execution_id: target.executionId,
    node_id: target.nodeId ?? target.executionId,
    compiled_id: target.compiledId ?? target.executionId,
    kind: "af",
    tool: "af",
    argv: ["orient"],
    cwd: target.workspacePath,
    exit_code: 0,
    duration_ms: 1,
    redaction: "secret-looking argv values redacted"
  })}\n`, "utf8");
}

async function hasMilestones(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { milestones?: unknown[] };
    return Array.isArray(parsed.milestones) && parsed.milestones.length > 0;
  } catch {
    return false;
  }
}

async function writeCompletedMilestone(target: RuntimeReadyTarget): Promise<void> {
  const milestonePath = join(target.runtimeDir, "milestones", `${safeRuntimeStateSegment(target.executionId)}.json`);
  if (await hasMilestones(milestonePath)) {
    return;
  }
  const timestamp = nowIso();
  await mkdir(dirname(milestonePath), { recursive: true });
  await writeFile(milestonePath, `${JSON.stringify({
    version: "1",
    execution_id: target.executionId,
    milestones: [
      {
        id: "m1",
        run_id: target.runId,
        graph_id: target.graphId,
        agent_id: target.executionId,
        execution_id: target.executionId,
        node_id: target.nodeId ?? target.executionId,
        compiled_id: target.compiledId ?? target.executionId,
        title: "Complete node contract",
        goal: target.goal ?? "Satisfy the node contract.",
        status: "completed",
        logs: [
          {
            log_id: "m1.l1",
            kind: "validation",
            summary: "Test harness simulated a completed agent runtime loop.",
            command: "test harness",
            result: "pass",
            created_at: timestamp
          }
        ],
        completion_evidence: "The test harness produced the expected node result and artifacts.",
        created_at: timestamp,
        updated_at: timestamp,
        completed_at: timestamp
      }
    ]
  }, null, 2)}\n`, "utf8");
}

export async function markRuntimeReady(target: RuntimeReadyTarget): Promise<void> {
  await writeOrientInvocation(target);
  await writeCompletedMilestone(target);
}

export async function markInvocationRuntimeReady(
  invocation: AgentInvocation,
  result?: HarnessResult
): Promise<void> {
  if (invocation.promptKind !== undefined && invocation.promptKind !== "agent") {
    return;
  }
  if (result && result.status !== "passed") {
    return;
  }
  if (!invocation.promptPath || !invocation.runtimeDir) {
    return;
  }

  await markRuntimeReady({
    runRoot: dirname(dirname(invocation.runtimeDir)),
    runId: invocation.runId,
    graphId: "test-graph",
    executionId: invocation.executionId,
    executionDir: dirname(invocation.promptPath),
    runtimeDir: invocation.runtimeDir,
    toolInvocationsPath: invocation.toolEnv?.AGENTFLOW_TOOL_INVOCATIONS,
    workspacePath: invocation.repoPath,
    nodeId: invocation.executionId,
    compiledId: invocation.executionId,
    goal: invocation.nodeGoal
  });
}

export async function markExecutorRuntimeReady(
  context: RuntimeNodeExecutorContext<CompiledExecutableNode>,
  result?: { status: string }
): Promise<void> {
  if (result && result.status !== "passed") {
    return;
  }

  await markRuntimeReady({
    runRoot: context.run_root,
    runId: context.run_id,
    graphId: context.graph_id,
    executionId: context.attempt.execution_id,
    executionDir: context.execution_dir,
    runtimeDir: join(context.run_root, "runtime"),
    workspacePath: context.workspace_path,
    nodeId: context.node.authored_id,
    compiledId: context.node.compiled_id,
    goal: context.node.intent.goal
  });
}

export async function markAttemptRuntimeReady(options: {
  runRoot: string;
  runId: string;
  graphId: string;
  attempt: RuntimeNodeAttempt;
  workspacePath: string;
}): Promise<void> {
  await markRuntimeReady({
    runRoot: options.runRoot,
    runId: options.runId,
    graphId: options.graphId,
    executionId: options.attempt.execution_id,
    executionDir: options.attempt.execution_dir,
    runtimeDir: join(options.runRoot, "runtime"),
    workspacePath: options.workspacePath,
    nodeId: options.attempt.authored_id,
    compiledId: options.attempt.compiled_id,
    goal: options.attempt.authored_id
  });
}
