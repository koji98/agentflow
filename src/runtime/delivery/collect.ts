import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveRunArtifactPaths } from "../../artifacts/paths.js";
import type { CompiledGraph } from "../../graph/compiled.js";
import type { RuntimeNodeAttempt } from "../attempts.js";
import type { RuntimeEventEnvelope, VerificationRecordedPayload } from "../events.js";
import type { RuntimeStateSnapshot, WorkspaceChangeArtifacts } from "../session.js";
import type { SupervisorDecision, SupervisorInterventionRecord } from "../../supervisor/types.js";
import type { OutcomeVerificationResult } from "../verification/types.js";
import type { NodeWorkspaceChangeArtifacts } from "../workspace/types.js";
import { readOperatorObservations } from "../observations/index.js";
import type { OperatorObservation } from "../completion/index.js";
import type { RuntimeMilestone } from "../completion/types.js";

export interface DeliveryEvidence {
  graph_id: string;
  run_id: string;
  status: RuntimeStateSnapshot["status"];
  evidence_status: RuntimeStateSnapshot["evidence_status"];
  started_at: RuntimeStateSnapshot["started_at"];
  ended_at?: RuntimeStateSnapshot["ended_at"];
  intent: CompiledGraph["intent"];
  node_statuses: RuntimeStateSnapshot["node_statuses"];
  latest_execution_by_compiled_id: RuntimeStateSnapshot["latest_execution_by_compiled_id"];
  attempts: RuntimeNodeAttempt[];
  events: RuntimeEventEnvelope[];
  supervisor_timeline: SupervisorDecision[];
  runtime_logs: Array<Record<string, unknown>>;
  operator_observations: OperatorObservation[];
  interventions: SupervisorInterventionRecord[];
  failed_checks: Array<{
    authored_id: string;
    compiled_id: string;
    execution_id: string;
    summary: string;
  }>;
  agent_responses: Array<{
    authored_id: string;
    compiled_id: string;
    execution_id: string;
    content: string;
  }>;
  declared_artifacts: Array<{
    authored_id: string;
    compiled_id: string;
    execution_id: string;
    name: string;
    path: string;
    description: string;
    artifact_path: string;
    content?: string;
  }>;
  tool_invocations: Array<{
    authored_id: string;
    compiled_id: string;
    execution_id: string;
    invocation_path: string;
    records: Array<Record<string, unknown>>;
  }>;
  workspace_changes: WorkspaceChangeArtifacts[];
  outcome_verifications: Array<{
    authored_id: string;
    compiled_id: string;
    execution_id: string;
    attempt_index: number;
    iteration_index?: number;
    passed: boolean;
    summary: string;
    findings_count: number;
    blockers_count: number;
    verify_outcome_json_path: string;
    verify_outcome_markdown_path: string;
    verifier_metadata: OutcomeVerificationResult["verifier_metadata"];
  }>;
  node_workspace_changes: Array<{
    authored_id: string;
    compiled_id: string;
    execution_id: string;
    attempt_index: number;
    iteration_index?: number;
    artifacts: NodeWorkspaceChangeArtifacts;
  }>;
  milestone_states: Array<{
    execution_id: string;
    path: string;
    milestones: RuntimeMilestone[];
  }>;
}

async function readTextArtifact(path: string | undefined): Promise<string | undefined> {
  if (!path) {
    return undefined;
  }

  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readJsonlRecords(path: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readTextArtifact(path);
  if (!contents) {
    return [];
  }

  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

async function readMilestoneStates(runRoot: string): Promise<DeliveryEvidence["milestone_states"]> {
  const milestoneDir = join(runRoot, "runtime", "milestones");
  let entries: string[];
  try {
    entries = await readdir(milestoneDir);
  } catch {
    return [];
  }

  const states = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const path = join(milestoneDir, entry);
        const contents = await readTextArtifact(path);
        if (!contents) {
          return undefined;
        }
        try {
          const parsed = JSON.parse(contents) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return undefined;
          }
          const candidate = parsed as Record<string, unknown>;
          if (typeof candidate.execution_id !== "string" || !Array.isArray(candidate.milestones)) {
            return undefined;
          }
          return {
            execution_id: candidate.execution_id,
            path,
            milestones: candidate.milestones as RuntimeMilestone[]
          };
        } catch {
          return undefined;
        }
      })
  );

  return states.filter((state): state is NonNullable<typeof state> => state !== undefined);
}

function readVerification(attempt: RuntimeNodeAttempt): VerificationRecordedPayload | undefined {
  return (
    attempt.metadata?.verification &&
    typeof attempt.metadata.verification === "object" &&
    attempt.metadata.verification !== null
      ? attempt.metadata.verification as VerificationRecordedPayload
      : undefined
  );
}

function readOutcomeVerification(attempt: RuntimeNodeAttempt): OutcomeVerificationResult | undefined {
  const value = attempt.metadata?.outcome_verification;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.passed !== "boolean") {
    return undefined;
  }
  return value as OutcomeVerificationResult;
}

function readNodeWorkspaceChanges(attempt: RuntimeNodeAttempt): NodeWorkspaceChangeArtifacts | undefined {
  const value = attempt.metadata?.node_workspace_changes;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.diff_patch_path !== "string") {
    return undefined;
  }
  return value as NodeWorkspaceChangeArtifacts;
}

export async function collectDeliveryEvidence(options: {
  graph: CompiledGraph;
  run_root: string;
  state: RuntimeStateSnapshot;
  attempts: RuntimeNodeAttempt[];
  events: RuntimeEventEnvelope[];
  interventions: SupervisorInterventionRecord[];
}): Promise<DeliveryEvidence> {
  const runPaths = resolveRunArtifactPaths(options.run_root);
  const agentResponses = await Promise.all(
    options.attempts
      .filter((attempt) => attempt.artifacts.agent_response)
      .map(async (attempt) => ({
        authored_id: attempt.authored_id,
        compiled_id: attempt.compiled_id,
        execution_id: attempt.execution_id,
        content: (await readTextArtifact(attempt.artifacts.agent_response)) ?? ""
      }))
  );
  const nodesByCompiledId = new Map(options.graph.nodes.map((node) => [node.compiled_id, node]));
  const declaredArtifacts = (
    await Promise.all(
      options.attempts.flatMap((attempt) => {
        const node = nodesByCompiledId.get(attempt.compiled_id);
        if (!node) {
          return [];
        }

        return Object.entries(node.declared_artifacts).flatMap(([name, definition]) => {
          const artifactPath = attempt.artifacts[name];
          if (!artifactPath) {
            return [];
          }

          return [readTextArtifact(artifactPath).then((content) => ({
            authored_id: attempt.authored_id,
            compiled_id: attempt.compiled_id,
            execution_id: attempt.execution_id,
            name,
            path: definition.path,
            description: definition.description,
            artifact_path: artifactPath,
            ...(content !== undefined ? { content } : {})
          }))];
        });
      })
    )
  );

  const failedChecks = options.attempts.flatMap((attempt) => {
    if (attempt.kind !== "check") {
      return [];
    }

    const verification = readVerification(attempt);
    if (verification?.passed !== false && attempt.outcome !== "failed") {
      return [];
    }

    return [{
      authored_id: attempt.authored_id,
      compiled_id: attempt.compiled_id,
      execution_id: attempt.execution_id,
      summary: verification?.summary ?? "Check failed."
    }];
  });
  const toolInvocations = (
    await Promise.all(
      options.attempts.map(async (attempt) => {
        const invocationPath = `${attempt.execution_dir}/tool-invocations.jsonl`;
        const records = await readJsonlRecords(invocationPath);

        return records.length > 0
          ? {
              authored_id: attempt.authored_id,
              compiled_id: attempt.compiled_id,
              execution_id: attempt.execution_id,
              invocation_path: invocationPath,
              records
            }
          : undefined;
      })
    )
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const runtimeLogs = await readJsonlRecords(runPaths.runtime_log_file);
  const operatorObservations = await readOperatorObservations(options.run_root);
  const supervisorTimeline = options.state.supervisor.timeline;

  const outcomeVerifications = options.attempts.flatMap((attempt) => {
    const verification = readOutcomeVerification(attempt);
    if (!verification) {
      return [];
    }

    return [{
      authored_id: attempt.authored_id,
      compiled_id: attempt.compiled_id,
      execution_id: attempt.execution_id,
      attempt_index: attempt.attempt_index,
      ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
      passed: verification.passed,
      summary: verification.summary,
      findings_count: verification.findings.length,
      blockers_count: verification.blockers.length,
      verify_outcome_json_path: `${attempt.execution_dir}/verify-outcome.json`,
      verify_outcome_markdown_path: `${attempt.execution_dir}/verify-outcome.md`,
      verifier_metadata: verification.verifier_metadata
    }];
  });

  const nodeWorkspaceChanges = options.attempts.flatMap((attempt) => {
    const artifacts = readNodeWorkspaceChanges(attempt);
    if (!artifacts) {
      return [];
    }

    return [{
      authored_id: attempt.authored_id,
      compiled_id: attempt.compiled_id,
      execution_id: attempt.execution_id,
      attempt_index: attempt.attempt_index,
      ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
      artifacts
    }];
  });
  const milestoneStates = await readMilestoneStates(options.run_root);

  return {
    graph_id: options.graph.graph_id,
    run_id: options.state.run_id,
    status: options.state.status,
    evidence_status: options.state.evidence_status,
    started_at: options.state.started_at,
    ...(options.state.ended_at ? { ended_at: options.state.ended_at } : {}),
    intent: options.graph.intent,
    node_statuses: options.state.node_statuses,
    latest_execution_by_compiled_id: options.state.latest_execution_by_compiled_id,
    attempts: options.attempts,
    events: options.events,
    supervisor_timeline: supervisorTimeline,
    runtime_logs: runtimeLogs,
    operator_observations: operatorObservations,
    interventions: options.interventions,
    failed_checks: failedChecks,
    agent_responses: agentResponses,
    declared_artifacts: declaredArtifacts,
    tool_invocations: toolInvocations,
    workspace_changes: Object.values(options.state.workspace_change_artifacts),
    outcome_verifications: outcomeVerifications,
    node_workspace_changes: nodeWorkspaceChanges,
    milestone_states: milestoneStates
  };
}
