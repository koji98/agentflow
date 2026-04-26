import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveExecutionArtifactsDirectory } from "../artifacts/paths.js";
import type { CompiledAgentNode } from "../graph/compiled.js";
import type { HarnessName } from "../graph/schema.js";
import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import { substituteAgentflowTokens } from "../runtime/harness/tokens.js";
import type { HarnessAdapter } from "../runtime/harness/types.js";
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

function formatMissingArtifactList(missingArtifacts: MissingDeclaredArtifact[]): string {
  return missingArtifacts
    .map((artifact) => [
      `- \`${artifact.name}\``,
      `  - from: \`${artifact.from}\``,
      `  - declared path: \`${artifact.path}\``,
      `  - expected absolute path: \`${artifact.expected_path}\``,
      `  - expected content: ${artifact.description}`
    ].join("\n"))
    .join("\n");
}

function formatBullets(values: string[] | undefined, emptyText: string): string[] {
  if (!values || values.length === 0) {
    return [`- ${emptyText}`];
  }

  return values.map((value) => `- ${value}`);
}

function buildArtifactRepairPrompt(options: {
  node: CompiledAgentNode;
  attempt: RuntimeNodeAttempt;
  graph_goal: string;
  graph_acceptance_criteria?: string[];
  graph_constraints?: string[];
  repair_attempt: number;
  max_attempts: number;
  missing_artifacts: MissingDeclaredArtifact[];
  workspace_path: string;
  context_packet_path: string;
  context_manifest_path: string;
  run_id: string;
}): string {
  const artifactsRoot = resolveExecutionArtifactsDirectory(options.attempt.execution_dir);
  const priorResponsePath = join(artifactsRoot, "agent-response.md");

  return [
    "## Agentflow Artifact Repair",
    "",
    "You already executed this Agentflow agent node, but the node did not satisfy its declared artifact contract.",
    "Do not redo unrelated work. Your only job is to produce the missing declared artifacts at the exact expected paths.",
    "",
    "## Graph Intent",
    "",
    options.graph_goal,
    "",
    "Acceptance criteria:",
    ...formatBullets(options.graph_acceptance_criteria, "No graph-level acceptance criteria were authored."),
    "",
    "Constraints:",
    ...formatBullets(options.graph_constraints, "No graph-level constraints were authored."),
    "",
    "## Node Intent",
    "",
    options.node.goal,
    "",
    "Acceptance criteria:",
    ...formatBullets(options.node.acceptance_criteria, "No node-level acceptance criteria were authored."),
    "",
    "Constraints:",
    ...formatBullets(options.node.constraints, "No node-level constraints were authored."),
    "",
    "## Missing Artifacts",
    formatMissingArtifactList(options.missing_artifacts),
    "",
    "## Available Evidence",
    `- Workspace: ${options.workspace_path}`,
    `- Output directory for output_dir artifacts: ${artifactsRoot}`,
    `- Context manifest: ${options.context_manifest_path}`,
    `- Context packet: ${options.context_packet_path}`,
    `- Prior final response artifact, if present: ${priorResponsePath}`,
    `- Prior stdout log: ${options.attempt.stdout_log_path ?? join(options.attempt.execution_dir, "logs", "stdout.log")}`,
    `- Prior stderr log: ${options.attempt.stderr_log_path ?? join(options.attempt.execution_dir, "logs", "stderr.log")}`,
    "",
    "## Repair Instructions",
    "- Inspect the workspace, git status, git diff, output directory, context, prior response, and logs as needed.",
    "- If the artifact content exists in the wrong location, move or copy it to the expected absolute path.",
    "- If the handoff was never written, write it now from the completed work, workspace changes, and available context.",
    "- Do not make unrelated source changes.",
    "- Finish only after every missing artifact exists at its exact expected absolute path.",
    "",
    "## Diagnostics",
    `- Repair attempt: ${options.repair_attempt} of ${options.max_attempts}`,
    `- Run ID: ${options.run_id}`,
    `- Execution ID: ${options.attempt.execution_id}`,
    `- Agent node: ${options.node.authored_id}`
  ].join("\n");
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

export async function runRepairArtifactIntervention(options: {
  node: CompiledAgentNode;
  attempt: RuntimeNodeAttempt;
  missing_artifacts: MissingDeclaredArtifact[];
  session: RuntimeSession;
  workspace_path: string;
  context_packet_path: string;
  context_manifest_path: string;
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>;
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
  const interventionDir = join(options.attempt.execution_dir, "interventions", interventionId);
  const startedAt = new Date().toISOString();
  const artifactsRoot = resolveExecutionArtifactsDirectory(options.attempt.execution_dir);
  const promptTokens: Record<string, string> = {
    AGENTFLOW_WORKSPACE: options.workspace_path,
    AGENTFLOW_OUTPUT_DIR: artifactsRoot,
    AGENTFLOW_CONTEXT_PACKET: options.context_packet_path,
    AGENTFLOW_CONTEXT_MANIFEST: options.context_manifest_path
  };
  const graphIntent = options.session.graph?.intent ?? {
    goal: "Repair the missing artifact without changing the authored task intent."
  };
  const composedPrompt = buildArtifactRepairPrompt({
    node: options.node,
    attempt: options.attempt,
    graph_goal: graphIntent.goal,
    ...(graphIntent.acceptance_criteria
      ? { graph_acceptance_criteria: graphIntent.acceptance_criteria }
      : {}),
    ...(graphIntent.constraints
      ? { graph_constraints: graphIntent.constraints }
      : {}),
    repair_attempt: repairAttempt,
    max_attempts: maxAttempts,
    missing_artifacts: options.missing_artifacts,
    workspace_path: options.workspace_path,
    context_packet_path: options.context_packet_path,
    context_manifest_path: options.context_manifest_path,
    run_id: options.session.run_id
  });
  const prompt = substituteAgentflowTokens(composedPrompt, promptTokens);
  const promptPath = join(interventionDir, "prompt.md");
  const stdoutPath = join(interventionDir, "stdout.log");
  const stderrPath = join(interventionDir, "stderr.log");
  const resultPath = join(interventionDir, "result.json");

  await mkdir(interventionDir, { recursive: true });
  await writeFile(promptPath, `${prompt}\n`, "utf8");

  const harnessName = options.node.effective_policy.harness;
  const harness = harnessName ? options.harnesses[harnessName] : undefined;

  if (!harnessName || !harness) {
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
  const contextManifest = await readContextManifestContent(options.context_manifest_path);
  const result = await harness.run({
    promptKind: "agent",
    runId: options.session.run_id,
    executionId: `${options.attempt.execution_id}__${interventionId}`,
    repoAlias: options.node.repo,
    repoPath: options.workspace_path,
    sandbox: options.node.effective_policy.sandbox ?? "workspace-write",
    ...(options.node.effective_policy.skip_git_repo_check ? { skipGitRepoCheck: true } : {}),
    model: options.node.effective_policy.model,
    ...(options.node.effective_policy.reasoning_effort
      ? { reasoningEffort: options.node.effective_policy.reasoning_effort }
      : {}),
    graphGoal: graphIntent.goal,
    ...(graphIntent.acceptance_criteria ? { graphAcceptanceCriteria: graphIntent.acceptance_criteria } : {}),
    ...(graphIntent.constraints ? { graphConstraints: graphIntent.constraints } : {}),
    nodeGoal: prompt,
    ...(options.node.acceptance_criteria ? { nodeAcceptanceCriteria: options.node.acceptance_criteria } : {}),
    ...(options.node.constraints ? { nodeConstraints: options.node.constraints } : {}),
    contextPacketPath: options.context_packet_path,
    contextManifestPath: options.context_manifest_path,
    contextManifest,
    outputDir: artifactsRoot,
    artifacts: options.node.declared_artifacts,
    timeoutSec: options.node.effective_policy.timeout_sec,
    signal: options.signal,
    toolBinDir: repairToolSetup.bin_dir,
    toolEnv: repairToolSetup.env,
    tools: repairToolSetup.resolved_tools
  });
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
