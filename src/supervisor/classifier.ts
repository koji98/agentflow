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

  const verificationPayload = readOutcomeVerificationPayload(input.result);
  if (verificationPayload && verificationPayload.passed === false) {
    const summary =
      typeof verificationPayload.summary === "string" && verificationPayload.summary.trim().length > 0
        ? verificationPayload.summary.trim()
        : "Outcome verification rejected the agent's work.";
    return {
      class: "outcome_verification",
      summary,
      retryable: true,
      recommended_action: "retry_with_guidance",
      evidence: {
        ...evidence,
        outcome_verification: verificationPayload
      }
    };
  }

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

  if (
    lowerMessage.includes("produced no final response")
    || lowerMessage.includes("without a captured final response")
    || lowerMessage.includes("harness/no-op failure")
  ) {
    return {
      class: "harness",
      summary: message || "Agent harness completed without a usable final response.",
      retryable: false,
      recommended_action: "pause_for_human",
      evidence
    };
  }

  if (
    lowerMessage.includes("artifact contract")
    || lowerMessage.includes("missing declared artifact")
    || /required (output_dir|workspace) artifact "[^"]+" is missing at /u.test(lowerMessage)
  ) {
    return {
      class: "artifact",
      summary: message || "Declared artifact contract was not satisfied.",
      retryable: true,
      recommended_action: "repair_artifact",
      evidence
    };
  }

  if (isContextFailureMessage(lowerMessage)) {
    return {
      class: "context",
      summary: message || "Execution context could not be resolved.",
      retryable: true,
      recommended_action: "rebuild_context",
      evidence
    };
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
      summary: message || "Scope drift detected.",
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
