import { readFile } from "node:fs/promises";

import type { CompiledGraph } from "../../graph/compiled.js";
import type { RuntimeNodeAttempt } from "../attempts.js";
import type { RuntimeEventEnvelope, VerificationRecordedPayload } from "../events.js";
import type { RuntimeStateSnapshot, WorkspaceChangeArtifacts } from "../session.js";
import type { SupervisorInterventionRecord } from "../../supervisor/types.js";

export interface DeliveryEvidence {
  graph_id: string;
  run_id: string;
  status: RuntimeStateSnapshot["status"];
  intent: CompiledGraph["intent"];
  attempts: RuntimeNodeAttempt[];
  events: RuntimeEventEnvelope[];
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

function readVerification(attempt: RuntimeNodeAttempt): VerificationRecordedPayload | undefined {
  return (
    attempt.metadata.verification &&
    typeof attempt.metadata.verification === "object" &&
    attempt.metadata.verification !== null
      ? attempt.metadata.verification as VerificationRecordedPayload
      : undefined
  );
}

export async function collectDeliveryEvidence(options: {
  graph: CompiledGraph;
  state: RuntimeStateSnapshot;
  attempts: RuntimeNodeAttempt[];
  events: RuntimeEventEnvelope[];
  interventions: SupervisorInterventionRecord[];
}): Promise<DeliveryEvidence> {
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

  return {
    graph_id: options.graph.graph_id,
    run_id: options.state.run_id,
    status: options.state.status,
    intent: options.graph.intent,
    attempts: options.attempts,
    events: options.events,
    interventions: options.interventions,
    failed_checks: failedChecks,
    agent_responses: agentResponses,
    declared_artifacts: declaredArtifacts,
    tool_invocations: toolInvocations,
    workspace_changes: Object.values(options.state.workspace_change_artifacts)
  };
}
