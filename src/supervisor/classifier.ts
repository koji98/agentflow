import type { CompiledExecutableNode } from "../graph/compiled.js";
import type { SupervisionPolicy } from "../graph/authored.js";
import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import type { RuntimeNodeExecutionResult } from "../runtime/core/engine.js";
import type { SupervisorActionKind } from "../graph/schema.js";
import type { FailureClass } from "./types.js";

export interface FailureClassification {
  class: FailureClass;
  summary: string;
  retryable: boolean;
  recommended_action: SupervisorActionKind;
  evidence: Record<string, unknown>;
}

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
  const metadataError =
    typeof input.attempt.metadata.error === "string"
      ? input.attempt.metadata.error
      : undefined;
  return input.error_message ?? resultError ?? metadataError ?? "";
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

export function classifyNodeFailure(input: {
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  result?: RuntimeNodeExecutionResult;
  error_message?: string;
  policy: SupervisionPolicy;
}): FailureClassification {
  const message = readMessage(input);
  const lowerMessage = message.toLowerCase();
  const evidence: Record<string, unknown> = {
    compiled_id: input.node.compiled_id,
    execution_id: input.attempt.execution_id,
    ...(message ? { message } : {})
  };

  if (
    lowerMessage.includes("must be a relative path that stays within") ||
    lowerMessage.includes("escapes the workspace") ||
    lowerMessage.includes("escapes the repo")
  ) {
    return {
      class: "policy_breach",
      summary: message || "Execution attempted to access a path outside the allowed workspace scope.",
      retryable: false,
      recommended_action: "pause_for_human",
      evidence
    };
  }

  if (lowerMessage.includes("artifact contract") || lowerMessage.includes("missing declared artifact")) {
    return {
      class: "artifact",
      summary: message || "Declared artifact contract was not satisfied.",
      retryable: true,
      recommended_action: "repair_artifact",
      evidence
    };
  }

  if (lowerMessage.includes("context")) {
    return {
      class: "context",
      summary: message || "Execution context could not be resolved.",
      retryable: true,
      recommended_action: "rebuild_context",
      evidence
    };
  }

  if (lowerMessage.includes("harness") || lowerMessage.includes("binary") || lowerMessage.includes("unavailable")) {
    return {
      class: "harness",
      summary: message || "Required harness is unavailable.",
      retryable: false,
      recommended_action: "pause_for_human",
      evidence
    };
  }

  if (resultTimedOut(input.result) || lowerMessage.includes("timed out") || lowerMessage.includes("timeout")) {
    return {
      class: "timeout",
      summary: message || "Node execution timed out.",
      retryable: true,
      recommended_action: "retry_with_guidance",
      evidence
    };
  }

  const scopeDriftScore = readScopeDriftScore(input.result);
  if (scopeDriftScore !== undefined && scopeDriftScore < input.policy.policy.drift_score_threshold) {
    return {
      class: "scope_drift",
      summary: message || "Semantic evaluation detected scope drift.",
      retryable: false,
      recommended_action: "pause_for_human",
      evidence: {
        ...evidence,
        scope_drift_score: scopeDriftScore,
        threshold: input.policy.policy.drift_score_threshold
      }
    };
  }

  if (input.node.kind === "check" && input.node.check_kind === "deterministic") {
    return {
      class: "deterministic_evaluation",
      summary: message || "Deterministic evaluation failed.",
      retryable: true,
      recommended_action: "retry_with_guidance",
      evidence
    };
  }

  if (input.node.kind === "check" && input.node.check_kind === "ai") {
    return {
      class: "semantic_evaluation",
      summary: message || "Semantic evaluation failed.",
      retryable: true,
      recommended_action: "semantic_evaluation",
      evidence
    };
  }

  if (input.node.kind === "checkpoint") {
    return {
      class: "operator",
      summary: message || "Operator checkpoint did not pass.",
      retryable: false,
      recommended_action: "pause_for_human",
      evidence
    };
  }

  return {
    class: "unknown",
    summary: message || "Node failed without a recognized failure class.",
    retryable: true,
    recommended_action: "retry_with_guidance",
    evidence
  };
}
