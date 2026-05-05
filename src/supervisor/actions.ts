import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveExecutionArtifactsDirectory, resolveInterventionDirectory } from "../artifacts/paths.js";
import type { CompiledAgentNode } from "../graph/compiled.js";
import type { EffectiveSupervisorPolicy } from "../graph/profiles.js";
import type { HarnessName } from "../graph/schema.js";
import { listAttemptsForCompiledNode, type RuntimeNodeAttempt } from "../runtime/attempts.js";
import { renderHarnessPrompt, type AgentInvocation, type HarnessAdapter } from "../runtime/harness/types.js";
import type { RuntimeSession } from "../runtime/session.js";
import { prepareAgentTools } from "../runtime/tools/setup.js";
import type { SupervisorInterventionRecord } from "./types.js";

export interface MissingDeclaredArtifact {
  name: string;
  from: "output_dir" | "workspace";
  path: string;
  description: string;
  expected_path: string;
}

function createDefaultInterventionId(attempt: RuntimeNodeAttempt, repairAttempt: number): string {
  return `${attempt.execution_id}__repair_artifact_${repairAttempt}`;
}

async function collectStillMissing(
  missingArtifacts: MissingDeclaredArtifact[]
): Promise<MissingDeclaredArtifact[]> {
  const results = await Promise.all(
    missingArtifacts.map(async (artifact) => {
      try {
        await access(artifact.expected_path);
        return undefined;
      } catch {
        return artifact;
      }
    })
  );

  return results.filter((artifact): artifact is MissingDeclaredArtifact => artifact !== undefined);
}

async function readContextManifestContent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function existingPaths(paths: string[]): Promise<string[]> {
  const resolved = await Promise.all(
    paths.map(async (path) => {
      try {
        await access(path);
        return path;
      } catch {
        return undefined;
      }
    })
  );
  return resolved.filter((path): path is string => path !== undefined);
}

async function collectPreviousAttemptEvidencePaths(
  session: RuntimeSession,
  node: CompiledAgentNode,
  attempt: RuntimeNodeAttempt
): Promise<string[]> {
  if (!session.attempts?.by_compiled_id) {
    return [];
  }

  const priorAttempts = listAttemptsForCompiledNode(session.attempts, attempt.compiled_id)
    .filter((candidate) =>
      candidate.execution_id !== attempt.execution_id
      && candidate.attempt_index < attempt.attempt_index
    )
    .slice(-3);

  const candidatePaths = priorAttempts.flatMap((candidate) => {
    const outputDir = resolveExecutionArtifactsDirectory(candidate.execution_dir);
    const priorOutputArtifacts = Object.values(node.declared_artifacts)
      .filter((artifact) => artifact.from === "output_dir")
      .map((artifact) => join(outputDir, artifact.path));
    return [
      ...Object.values(candidate.artifacts),
      ...priorOutputArtifacts,
      ...(candidate.result_path ? [candidate.result_path] : []),
      ...(candidate.stdout_log_path ? [candidate.stdout_log_path] : []),
      ...(candidate.stderr_log_path ? [candidate.stderr_log_path] : [])
    ];
  });

  return [...new Set(await existingPaths(candidatePaths))];
}

const sandboxRank = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2
} as const;

function clampRepairSandbox(
  nodeSandbox: NonNullable<CompiledAgentNode["effective_policy"]["sandbox"]>,
  supervisorSandbox: EffectiveSupervisorPolicy["sandbox"] | undefined
): NonNullable<CompiledAgentNode["effective_policy"]["sandbox"]> {
  if (!supervisorSandbox) {
    return nodeSandbox;
  }
  return sandboxRank[supervisorSandbox] < sandboxRank[nodeSandbox]
    ? supervisorSandbox
    : nodeSandbox;
}

function buildRepairInvocation(options: {
  node: CompiledAgentNode;
  attempt: RuntimeNodeAttempt;
  execution_id?: string;
  run_id: string;
  graph_goal: string;
  graph_acceptance_criteria?: string[];
  graph_constraints?: string[];
  workspace_path: string;
  context_packet_path: string;
  context_manifest_path: string;
  context_manifest: string;
  artifacts_root: string;
  repair_attempt: number;
  max_attempts: number;
  missing_artifacts: MissingDeclaredArtifact[];
  previous_attempt_evidence_paths: string[];
  tool_bin_dir?: string;
  tool_env?: Record<string, string>;
  tools?: AgentInvocation["tools"];
  supervisor_policy?: EffectiveSupervisorPolicy;
  signal?: AbortSignal;
}): AgentInvocation {
  const priorResponsePath = join(options.artifacts_root, "agent-response.md");
  const supervisorPolicy = options.supervisor_policy;
  const sandbox = clampRepairSandbox(
    options.node.effective_policy.sandbox ?? "workspace-write",
    supervisorPolicy?.sandbox
  );
  return {
    promptKind: "artifact_repair",
    runId: options.run_id,
    executionId: options.execution_id ?? options.attempt.execution_id,
    repoAlias: options.node.repo,
    repoPath: options.workspace_path,
    sandbox,
    ...(supervisorPolicy?.skip_git_repo_check ?? options.node.effective_policy.skip_git_repo_check ? { skipGitRepoCheck: true } : {}),
    ...(supervisorPolicy?.harness_config ?? options.node.effective_policy.harness_config
      ? { harnessConfig: supervisorPolicy?.harness_config ?? options.node.effective_policy.harness_config }
      : {}),
    model: supervisorPolicy?.model ?? options.node.effective_policy.model,
    ...(supervisorPolicy?.reasoning_effort ?? options.node.effective_policy.reasoning_effort
      ? { reasoningEffort: supervisorPolicy?.reasoning_effort ?? options.node.effective_policy.reasoning_effort }
      : {}),
    graphGoal: options.graph_goal,
    ...(options.graph_acceptance_criteria ? { graphAcceptanceCriteria: options.graph_acceptance_criteria } : {}),
    ...(options.graph_constraints ? { graphConstraints: options.graph_constraints } : {}),
    nodeGoal: options.node.intent.goal
      ? `Produce the missing declared artifacts while preserving the original node intent goal:\n${options.node.intent.goal}`
      : "Produce the missing declared artifacts for the previously executed node.",
    ...(options.node.intent.acceptance_criteria ? { nodeAcceptanceCriteria: options.node.intent.acceptance_criteria } : {}),
    ...(options.node.intent.constraints ? { nodeConstraints: options.node.intent.constraints } : {}),
    contextPacketPath: options.context_packet_path,
    contextManifestPath: options.context_manifest_path,
    contextManifest: options.context_manifest,
    outputDir: options.artifacts_root,
    artifacts: options.node.declared_artifacts,
    timeoutSec: supervisorPolicy?.timeout_sec ?? options.node.effective_policy.timeout_sec,
    signal: options.signal,
    ...(options.tool_bin_dir ? { toolBinDir: options.tool_bin_dir } : {}),
    ...(options.tool_env ? { toolEnv: options.tool_env } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    repair: {
      repairAttempt: options.repair_attempt,
      maxAttempts: options.max_attempts,
      priorResponsePath,
      stdoutLogPath: options.attempt.stdout_log_path ?? join(options.attempt.execution_dir, "logs", "stdout.log"),
      stderrLogPath: options.attempt.stderr_log_path ?? join(options.attempt.execution_dir, "logs", "stderr.log"),
      previousAttemptEvidencePaths: options.previous_attempt_evidence_paths,
      missingArtifacts: options.missing_artifacts.map((artifact) => ({
        name: artifact.name,
        from: artifact.from,
        path: artifact.path,
        description: artifact.description,
        expectedPath: artifact.expected_path
      }))
    }
  };
}

export async function runRepairArtifactIntervention(options: {
  node: CompiledAgentNode;
  attempt: RuntimeNodeAttempt;
  missing_artifacts: MissingDeclaredArtifact[];
  session: RuntimeSession;
  workspace_path: string;
  context_packet_path: string;
  context_manifest_path: string;
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>;
  supervisor_policy?: EffectiveSupervisorPolicy;
  signal?: AbortSignal;
  decision_id?: string;
  intervention_id?: string;
  repair_attempt?: number;
  max_attempts?: number;
}): Promise<SupervisorInterventionRecord> {
  const repairAttempt = options.repair_attempt ?? 1;
  const maxAttempts = options.max_attempts ?? repairAttempt;
  const decisionId = options.decision_id ?? `${options.attempt.execution_id}__repair_artifact_decision_${repairAttempt}`;
  const interventionId = options.intervention_id ?? createDefaultInterventionId(options.attempt, repairAttempt);
  const interventionDir = resolveInterventionDirectory(options.attempt.execution_dir, interventionId);
  const startedAt = new Date().toISOString();
  const artifactsRoot = resolveExecutionArtifactsDirectory(options.attempt.execution_dir);
  const previousAttemptEvidencePaths = await collectPreviousAttemptEvidencePaths(
    options.session,
    options.node,
    options.attempt
  );
  const graphIntent = options.session.graph?.intent ?? {
    goal: "Repair the missing artifact without changing the authored task intent."
  };
  const promptPath = join(interventionDir, "prompt.md");
  const stdoutPath = join(interventionDir, "stdout.log");
  const stderrPath = join(interventionDir, "stderr.log");
  const resultPath = join(interventionDir, "result.json");

  await mkdir(interventionDir, { recursive: true });
  const contextManifest = await readContextManifestContent(options.context_manifest_path);

  const harnessName = options.supervisor_policy?.harness ?? options.node.effective_policy.harness;
  const harness = harnessName ? options.harnesses[harnessName] : undefined;

  if (!harnessName || !harness) {
    const unavailableInvocation = buildRepairInvocation({
      node: options.node,
      attempt: options.attempt,
      run_id: options.session.run_id,
      execution_id: `${options.attempt.execution_id}__${interventionId}`,
      graph_goal: graphIntent.goal,
      ...(graphIntent.acceptance_criteria
        ? { graph_acceptance_criteria: graphIntent.acceptance_criteria }
        : {}),
      ...(graphIntent.constraints ? { graph_constraints: graphIntent.constraints } : {}),
      workspace_path: options.workspace_path,
      context_packet_path: options.context_packet_path,
      context_manifest_path: options.context_manifest_path,
      context_manifest: contextManifest,
      artifacts_root: artifactsRoot,
      repair_attempt: repairAttempt,
      max_attempts: maxAttempts,
      missing_artifacts: options.missing_artifacts,
      previous_attempt_evidence_paths: previousAttemptEvidencePaths,
      tools: options.node.tools,
      ...(options.supervisor_policy ? { supervisor_policy: options.supervisor_policy } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    });
    await writeFile(promptPath, `${renderHarnessPrompt(unavailableInvocation)}\n`, "utf8");
    const stillMissing = await collectStillMissing(options.missing_artifacts);
    const reason = "Artifact repair could not run because the resolved harness adapter is unavailable.";
    await Promise.all([
      writeFile(stdoutPath, "", "utf8"),
      writeFile(stderrPath, reason, "utf8"),
      writeFile(
        resultPath,
        `${JSON.stringify({
          status: "unavailable",
          missing_artifacts_after: stillMissing.map((artifact) => artifact.name)
        }, null, 2)}\n`,
        "utf8"
      )
    ]);

    return {
      intervention_id: interventionId,
      decision_id: decisionId,
      action: "repair_artifact",
      status: "failed",
      target_compiled_id: options.node.compiled_id,
      target_execution_id: options.attempt.execution_id,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      reason,
      evidence: {
        repair_attempt: repairAttempt,
        max_attempts: maxAttempts,
        missing_artifacts_before: options.missing_artifacts.map((artifact) => artifact.name),
        missing_artifacts_after: stillMissing.map((artifact) => artifact.name),
        harness_status: "unavailable"
      },
      artifact_paths: {
        intervention_dir: interventionDir,
        prompt: promptPath,
        stdout: stdoutPath,
        stderr: stderrPath,
        result: resultPath
      }
    };
  }

  const repairToolSetup = await prepareAgentTools({
    node: options.node,
    execution_dir: options.attempt.execution_dir,
    workspace_path: options.workspace_path,
    artifacts_root: artifactsRoot,
    credential_specs: options.session.graph?.credential_specs ?? {}
  });
  const invocation = buildRepairInvocation({
    node: options.node,
    attempt: options.attempt,
    run_id: options.session.run_id,
    execution_id: `${options.attempt.execution_id}__${interventionId}`,
    graph_goal: graphIntent.goal,
    ...(graphIntent.acceptance_criteria
      ? { graph_acceptance_criteria: graphIntent.acceptance_criteria }
      : {}),
    ...(graphIntent.constraints ? { graph_constraints: graphIntent.constraints } : {}),
    workspace_path: options.workspace_path,
    context_packet_path: options.context_packet_path,
    context_manifest_path: options.context_manifest_path,
    context_manifest: contextManifest,
    artifacts_root: artifactsRoot,
    repair_attempt: repairAttempt,
    max_attempts: maxAttempts,
    missing_artifacts: options.missing_artifacts,
    previous_attempt_evidence_paths: previousAttemptEvidencePaths,
    tool_bin_dir: repairToolSetup.bin_dir,
    tool_env: repairToolSetup.env,
    tools: repairToolSetup.resolved_tools,
    ...(options.supervisor_policy ? { supervisor_policy: options.supervisor_policy } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  });
  await writeFile(promptPath, `${renderHarnessPrompt(invocation)}\n`, "utf8");
  const result = await harness.run(invocation);
  const stillMissing = await collectStillMissing(options.missing_artifacts);
  const status =
    result.status === "canceled"
      ? "canceled"
      : stillMissing.length === 0
        ? "passed"
        : "failed";
  const reason =
    status === "passed"
      ? "Artifact repair produced all missing declared artifacts."
      : result.status === "canceled"
        ? "Artifact repair was canceled."
        : `Artifact repair finished with status ${result.status}; missing artifacts remain: ${stillMissing.map((artifact) => artifact.name).join(", ")}.`;

  await Promise.all([
    writeFile(stdoutPath, result.stdout ?? "", "utf8"),
    writeFile(stderrPath, result.stderr ?? "", "utf8"),
    writeFile(
      resultPath,
      `${JSON.stringify({
        status: result.status,
        exit_code: result.exitCode,
        missing_artifacts_after: stillMissing.map((artifact) => artifact.name),
        ...(result.metadata ? { metadata: result.metadata } : {}),
        ...(result.outputJson ? { output_json: result.outputJson } : {}),
        ...(result.transcript?.last_message ? { last_message: result.transcript.last_message } : {})
      }, null, 2)}\n`,
      "utf8"
    )
  ]);

  return {
    intervention_id: interventionId,
    decision_id: decisionId,
    action: "repair_artifact",
    status,
    target_compiled_id: options.node.compiled_id,
    target_execution_id: options.attempt.execution_id,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    reason,
    evidence: {
      repair_attempt: repairAttempt,
      max_attempts: maxAttempts,
      missing_artifacts_before: options.missing_artifacts.map((artifact) => artifact.name),
      missing_artifacts_after: stillMissing.map((artifact) => artifact.name),
      harness_status: result.status,
      exit_code: result.exitCode
    },
    artifact_paths: {
      intervention_dir: interventionDir,
      prompt: promptPath,
      stdout: stdoutPath,
      stderr: stderrPath,
      result: resultPath
    }
  };
}
