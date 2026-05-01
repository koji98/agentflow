import type { CompiledExecutableNode } from "../graph/compiled.js";
import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import type { RuntimeNodeExecutionResult } from "../runtime/core/engine.js";
import type { FailureClass, SupervisorActionKind, SupervisorEvidenceGatherKind, SupervisorEvidenceGatherPlan } from "./types.js";

export interface FailureClassification {
  class: FailureClass;
  summary: string;
  retryable: boolean;
  recommended_action: SupervisorActionKind;
  gather_plan: SupervisorEvidenceGatherPlan;
  evidence: Record<string, unknown>;
}

const maxGatherConcurrency = 4;
const scopeDriftThreshold = 0.8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMessage(input: {
  attempt: RuntimeNodeAttempt;
  result?: RuntimeNodeExecutionResult;
  error_message?: string;
}): string {
  const resultError =
    isRecord(input.result?.result) && typeof input.result.result.error === "string"
      ? input.result.result.error
      : undefined;
  const resultMetadataError =
    isRecord(input.result?.metadata) && typeof input.result.metadata.error === "string"
      ? input.result.metadata.error
      : undefined;
  const nestedResultMetadataError =
    isRecord(input.result?.result) &&
    isRecord(input.result.result.metadata) &&
    typeof input.result.result.metadata.error === "string"
      ? input.result.result.metadata.error
      : undefined;
  const metadataError =
    typeof input.attempt.metadata?.error === "string"
      ? input.attempt.metadata.error
      : undefined;
  const resultStderr =
    typeof input.result?.stderr === "string" && input.result.stderr.trim().length > 0
      ? input.result.stderr.trim()
      : undefined;
  const resultAgentResponse =
    typeof input.result?.agent_response === "string" && input.result.agent_response.trim().length > 0
      ? input.result.agent_response.trim()
      : undefined;
  const resultStdout =
    typeof input.result?.stdout === "string" && input.result.stdout.trim().length > 0
      ? input.result.stdout.trim()
      : undefined;
  return input.error_message
    ?? resultError
    ?? resultMetadataError
    ?? nestedResultMetadataError
    ?? metadataError
    ?? resultStderr
    ?? resultAgentResponse
    ?? resultStdout
    ?? "";
}

function resultTimedOut(result: RuntimeNodeExecutionResult | undefined): boolean {
  return isRecord(result?.result) && result.result.timed_out === true;
}

function readScopeDriftScore(result: RuntimeNodeExecutionResult | undefined): number | undefined {
  if (!isRecord(result?.result) || !isRecord(result.result.scope_drift)) {
    return undefined;
  }
  return typeof result.result.scope_drift.score === "number"
    ? result.result.scope_drift.score
    : undefined;
}

function isContextFailureMessage(lowerMessage: string): boolean {
  return [
    "required context",
    "context item",
    "context packet",
    "context manifest",
    "context provenance",
    "context could not be resolved",
    "execution context could not be resolved",
    "materialized context",
    "context material"
  ].some((fragment) => lowerMessage.includes(fragment));
}

function isContextContractFailureMessage(lowerMessage: string): boolean {
  return (
    lowerMessage.includes("would exceed max_total_tokens")
    || lowerMessage.includes("max_total_tokens")
    || lowerMessage.includes("context materialization")
    || lowerMessage.includes("materializing context")
    || lowerMessage.includes("non-tokenizable context")
    || lowerMessage.includes("could not be materialized")
  );
}

function gather(
  kind: SupervisorEvidenceGatherKind,
  reason: string,
  priority: number
): SupervisorEvidenceGatherPlan["gathers"][number] {
  return {
    gather_id: `${String(priority).padStart(2, "0")}__${kind}`,
    kind,
    reason,
    priority
  };
}

function gatherPlan(gathers: Array<SupervisorEvidenceGatherPlan["gathers"][number]>): SupervisorEvidenceGatherPlan {
  const ordered = gathers
    .slice()
    .sort((left, right) => left.priority - right.priority)
    .slice(0, maxGatherConcurrency);
  return {
    max_parallel: Math.min(maxGatherConcurrency, ordered.length),
    gathers: ordered
  };
}

function noGatherPlan(): SupervisorEvidenceGatherPlan {
  return {
    max_parallel: 0,
    gathers: []
  };
}

function classifyResult(input: {
  class: FailureClass;
  summary: string;
  retryable: boolean;
  recommended_action: SupervisorActionKind;
  evidence: Record<string, unknown>;
  gather_plan: SupervisorEvidenceGatherPlan;
}): FailureClassification {
  return input;
}

interface OutcomeVerificationPayloadShape {
  passed: boolean;
  summary?: unknown;
  blockers?: unknown;
  findings?: unknown;
  verifier_metadata?: unknown;
}

function readOutcomeVerificationPayload(
  result: RuntimeNodeExecutionResult | undefined
): OutcomeVerificationPayloadShape | undefined {
  if (!result || !isRecord(result.result)) {
    return undefined;
  }
  const payload = result.result.outcome_verification;
  if (!isRecord(payload) || typeof payload.passed !== "boolean") {
    return undefined;
  }
  return payload as unknown as OutcomeVerificationPayloadShape;
}

function containsDependencyDocsGap(value: unknown): boolean {
  const text = JSON.stringify(value ?? "").toLowerCase();
  return text.includes("dependency docs")
    || text.includes("package docs")
    || text.includes("api changed")
    || text.includes("official docs")
    || text.includes("release notes");
}

export function classifyNodeFailure(input: {
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  result?: RuntimeNodeExecutionResult;
  error_message?: string;
  repeated_fingerprint_count?: number;
}): FailureClassification {
  const message = readMessage(input);
  const lowerMessage = message.toLowerCase();
  const evidence: Record<string, unknown> = {
    compiled_id: input.node.compiled_id,
    execution_id: input.attempt.execution_id,
    ...(message ? { message } : {})
  };

  if (
    lowerMessage.includes("non-recoverable") ||
    lowerMessage.includes("nonrecoverable") ||
    lowerMessage.includes("cannot recover") ||
    lowerMessage.includes("graph contract violation")
  ) {
    return classifyResult({
      class: "non_recoverable",
      summary: message || "Failure cannot be recovered without changing graph intent or contract.",
      retryable: false,
      recommended_action: "fail",
      gather_plan: noGatherPlan(),
      evidence
    });
  }

  const verificationPayload = readOutcomeVerificationPayload(input.result);
  if (verificationPayload && verificationPayload.passed === false) {
    const summary =
      typeof verificationPayload.summary === "string" && verificationPayload.summary.trim().length > 0
        ? verificationPayload.summary.trim()
        : "Outcome verification rejected the agent's work.";
    if (containsDependencyDocsGap(verificationPayload)) {
      return classifyResult({
        class: "missing_dependency_docs",
        summary,
        retryable: true,
        recommended_action: "rebuild_context",
        gather_plan: gatherPlan([
          gather("dependency_metadata", "Inspect local package metadata, versions, and dependency names.", 1),
          gather("external_context", "Gather read-only official docs, release notes, or public examples.", 2),
          gather("semantic_rejudge", "Rejudge the verifier failure against the unchanged contract after gathering docs.", 3)
        ]),
        evidence: {
          ...evidence,
          outcome_verification: verificationPayload
        }
      });
    }
    return classifyResult({
      class: "semantic_misalignment",
      summary,
      retryable: true,
      recommended_action: "semantic_evaluation",
      gather_plan: gatherPlan([
        gather("semantic_rejudge", "Re-evaluate the verifier rejection against the unchanged node contract.", 1),
        gather("local_context", "Collect the local evidence the retry must inspect before claiming completion.", 2),
        gather("investigate_failure", "Summarize the failed attempt and any missing validation evidence.", 3)
      ]),
      evidence: {
        ...evidence,
        outcome_verification: verificationPayload
      }
    });
  }

  if (
    lowerMessage.includes("must be a relative path that stays within") ||
    lowerMessage.includes("escapes the workspace") ||
    lowerMessage.includes("escapes the repo")
  ) {
    return classifyResult({
      class: "policy_or_scope_risk",
      summary: message || "Execution attempted to access a path outside the allowed workspace scope.",
      retryable: false,
      recommended_action: "pause_for_human",
      gather_plan: noGatherPlan(),
      evidence
    });
  }

  if (
    lowerMessage.includes("produced no final response")
    || lowerMessage.includes("without a captured final response")
    || lowerMessage.includes("harness/no-op failure")
  ) {
    return classifyResult({
      class: "harness_unavailable",
      summary: message || "Agent harness completed without a usable final response.",
      retryable: false,
      recommended_action: "pause_for_human",
      gather_plan: noGatherPlan(),
      evidence
    });
  }

  if (
    lowerMessage.includes("agentflow tool wrapper")
    || lowerMessage.includes("tool wrapper")
    || lowerMessage.includes("runtime path metadata")
    || lowerMessage.includes("runtime metadata")
    || lowerMessage.includes("path refresh")
    || lowerMessage.includes("command not found")
  ) {
    return classifyResult({
      class: "harness_unavailable",
      summary: message || "Runtime tool or PATH setup appears unavailable.",
      retryable: true,
      recommended_action: "run_diagnostic",
      gather_plan: gatherPlan([
        gather("diagnostic_probe", "Inspect the local runtime/tool wrapper failure and refresh safe runtime metadata.", 1),
        gather("local_context", "Collect the node tool contract and execution environment paths.", 2)
      ]),
      evidence: {
        ...evidence,
        environment_repair_candidate: true
      }
    });
  }

  if (
    lowerMessage.includes("harness")
    || lowerMessage.includes("binary")
    || lowerMessage.includes("required harness is unavailable")
    || lowerMessage.includes("harness binary")
    || lowerMessage.includes("authentication required")
    || lowerMessage.includes("cursor agent login")
    || lowerMessage.includes("cursor_api_key")
  ) {
    return classifyResult({
      class: "harness_unavailable",
      summary: message || "Required harness is unavailable.",
      retryable: false,
      recommended_action: "pause_for_human",
      gather_plan: noGatherPlan(),
      evidence
    });
  }

  if (
    lowerMessage.includes("forbidden edit")
    || lowerMessage.includes("forbidden file")
    || lowerMessage.includes("unexpected file changed")
    || lowerMessage.includes("unexpected workspace change")
    || lowerMessage.includes("unrelated edit")
    || lowerMessage.includes("workspace pollution")
  ) {
    return classifyResult({
      class: "wrong_local_pattern",
      summary: message || "The failed attempt made workspace changes outside the intended scope.",
      retryable: true,
      recommended_action: "run_diagnostic",
      gather_plan: gatherPlan([
        gather("local_context", "Inspect the failed attempt workspace diff and node scope.", 1),
        gather("investigate_failure", "Determine which edits should be removed before retry.", 2)
      ]),
      evidence: {
        ...evidence,
        workspace_repair_candidate: true
      }
    });
  }

  if ((input.repeated_fingerprint_count ?? 0) >= 2) {
    return classifyResult({
      class: "repeated_failure",
      summary: message || "The same failure fingerprint repeated after supervisor recovery.",
      retryable: true,
      recommended_action: "run_diagnostic",
      gather_plan: gatherPlan([
        gather("local_context", "Widen the local causal search across upstream context, artifacts, and workspace diffs.", 1),
        gather("diagnostic_probe", "Run focused diagnostics that change the next repair tactic instead of repeating it.", 2),
        gather("semantic_rejudge", "Rejudge the failure against the unchanged graph and node intent before selecting the next target.", 3),
        gather("external_context", "Gather read-only external context if missing public docs or service behavior may explain the repeated symptom.", 4)
      ]),
      evidence: {
        ...evidence,
        repeated_fingerprint_count: input.repeated_fingerprint_count,
        causal_search_required: true
      }
    });
  }

  if (
    lowerMessage.includes("artifact contract")
    || lowerMessage.includes("missing declared artifact")
    || /required (output_dir|workspace) artifact "[^"]+" is missing at /u.test(lowerMessage)
  ) {
    return classifyResult({
      class: "artifact_contract_failure",
      summary: message || "Declared artifact contract was not satisfied.",
      retryable: true,
      recommended_action: "repair_artifact",
      gather_plan: gatherPlan([
        gather("local_context", "Collect the node contract and artifact declaration that failed.", 1),
        gather("investigate_failure", "Inspect failed output and logs to identify why the artifact was missing.", 2)
      ]),
      evidence
    });
  }

  if (
    lowerMessage.includes("dependency docs")
    || lowerMessage.includes("package docs")
    || lowerMessage.includes("api changed")
    || lowerMessage.includes("release notes")
    || lowerMessage.includes("official docs")
  ) {
    return classifyResult({
      class: "missing_dependency_docs",
      summary: message || "The node appears blocked on missing dependency or API documentation.",
      retryable: true,
      recommended_action: "rebuild_context",
      gather_plan: gatherPlan([
        gather("dependency_metadata", "Inspect local package metadata, versions, and dependency names.", 1),
        gather("external_context", "Gather read-only official docs, release notes, or public examples.", 2)
      ]),
      evidence
    });
  }

  if (isContextContractFailureMessage(lowerMessage)) {
    return classifyResult({
      class: "context_contract_failure",
      summary: message || "Execution context could not be packaged within the node context contract.",
      retryable: true,
      recommended_action: "rebuild_context",
      gather_plan: gatherPlan([
        gather("local_context", "Analyze the failed context package and build a bounded repair overlay.", 1),
        gather("pattern_mining", "Identify relevant local files that should be sampled in the repaired context.", 2)
      ]),
      evidence
    });
  }

  if (isContextFailureMessage(lowerMessage)) {
    return classifyResult({
      class: "missing_context",
      summary: message || "Execution context could not be resolved.",
      retryable: true,
      recommended_action: "rebuild_context",
      gather_plan: gatherPlan([
        gather("local_context", "Rebuild the failed node's context manifest and provenance.", 1),
        gather("pattern_mining", "Find nearby successful patterns or upstream artifacts that clarify intent.", 2)
      ]),
      evidence
    });
  }

  if (resultTimedOut(input.result) || lowerMessage.includes("timed out") || lowerMessage.includes("timeout")) {
    return classifyResult({
      class: "diagnostic_needed",
      summary: message || "Node execution timed out.",
      retryable: true,
      recommended_action: "run_diagnostic",
      gather_plan: gatherPlan([
        gather("diagnostic_probe", "Collect timeout-specific diagnostics and identify a smaller retry strategy.", 1)
      ]),
      evidence
    });
  }

  const scopeDriftScore = readScopeDriftScore(input.result);
  if (scopeDriftScore !== undefined && scopeDriftScore < scopeDriftThreshold) {
    return classifyResult({
      class: "policy_or_scope_risk",
      summary: message || "Scope drift detected.",
      retryable: false,
      recommended_action: "pause_for_human",
      gather_plan: noGatherPlan(),
      evidence: {
        ...evidence,
        scope_drift_score: scopeDriftScore,
        threshold: scopeDriftThreshold
      }
    });
  }

  if (input.node.kind === "check" && input.node.check_kind === "deterministic") {
    return classifyResult({
      class: "diagnostic_needed",
      summary: message || "Deterministic evaluation failed.",
      retryable: true,
      recommended_action: "run_diagnostic",
      gather_plan: gatherPlan([
        gather("diagnostic_probe", "Inspect the failed deterministic gate and identify the narrowest failing condition.", 1),
        gather("local_context", "Collect upstream artifacts, context provenance, and workspace state checked by the gate.", 2),
        gather("investigate_failure", "Determine whether the check failure is caused by the check itself or an upstream producer.", 3)
      ]),
      evidence: {
        ...evidence,
        deterministic_check_failed: true
      }
    });
  }

  if (input.node.kind === "check" && input.node.check_kind === "ai") {
    return classifyResult({
      class: "semantic_misalignment",
      summary: message || "Semantic evaluation failed.",
      retryable: true,
      recommended_action: "semantic_evaluation",
      gather_plan: gatherPlan([
        gather("semantic_rejudge", "Rejudge the semantic failure against the unchanged rubric and artifacts.", 1),
        gather("local_context", "Collect artifacts and context the semantic check evaluated.", 2)
      ]),
      evidence
    });
  }

  if (input.node.kind === "checkpoint") {
    return classifyResult({
      class: "operator_pause",
      summary: message || "Operator checkpoint did not pass.",
      retryable: false,
      recommended_action: "pause_for_human",
      gather_plan: noGatherPlan(),
      evidence
    });
  }

  return classifyResult({
    class: "unknown",
    summary: message || "Node failed without a recognized failure class.",
    retryable: true,
    recommended_action: "retry_with_guidance",
    gather_plan: gatherPlan([
      gather("investigate_failure", "Inspect failed attempt logs, output, artifacts, and context.", 1),
      gather("local_context", "Recover local context that should guide the retry.", 2)
    ]),
    evidence
  });
}
