import type { CompiledExecutableNode } from "../graph/compiled.js";
import { createAuthorityRequest, normalizeAuthorityRequests, type AuthorityRequest } from "../runtime/authority.js";
import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import type { RuntimeNodeExecutionResult } from "../runtime/core/engine.js";
import { isRuntimeFailureCode, type RuntimeFailureCode } from "../runtime/failure.js";
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

function readRuntimeFailureCode(input: {
  attempt: RuntimeNodeAttempt;
  result?: RuntimeNodeExecutionResult;
}): RuntimeFailureCode | undefined {
  const candidates = [
    isRecord(input.result?.metadata) ? input.result.metadata.failure_code : undefined,
    isRecord(input.result?.result) ? input.result.result.failure_code : undefined,
    isRecord(input.attempt.metadata) ? input.attempt.metadata.failure_code : undefined
  ];
  return candidates.find(isRuntimeFailureCode);
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

interface CompletionFailurePayloadShape {
  completion_status: "incomplete" | "blocked";
  blocking_reasons?: unknown;
  authority_requests?: unknown;
  packet_path?: unknown;
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

function readCompletionFailurePayload(input: {
  attempt: RuntimeNodeAttempt;
  result?: RuntimeNodeExecutionResult;
}): CompletionFailurePayloadShape | undefined {
  const payload = isRecord(input.result?.result) && isRecord(input.result.result.completion)
    ? input.result.result.completion
    : isRecord(input.attempt.metadata?.completion)
      ? input.attempt.metadata.completion
      : undefined;

  if (!payload) {
    return undefined;
  }

  if (payload.completion_status !== "incomplete" && payload.completion_status !== "blocked") {
    return undefined;
  }

  return payload as unknown as CompletionFailurePayloadShape;
}

function completionReasons(payload: CompletionFailurePayloadShape): string[] {
  if (!Array.isArray(payload.blocking_reasons)) {
    return [];
  }
  return payload.blocking_reasons.filter((reason): reason is string =>
    typeof reason === "string" && reason.trim().length > 0
  );
}

function readAuthorityRequestValues(value: unknown): AuthorityRequest[] {
  if (!isRecord(value)) {
    return [];
  }
  return normalizeAuthorityRequests(value.authority_requests);
}

function trustedAuthorityRequests(input: {
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  result?: RuntimeNodeExecutionResult;
  completionPayload?: CompletionFailurePayloadShape;
  message: string;
}): AuthorityRequest[] {
  const resultMetadata = isRecord(input.result?.metadata) ? input.result.metadata : {};
  const attemptMetadata = isRecord(input.attempt.metadata) ? input.attempt.metadata : {};
  const completionRequests = normalizeAuthorityRequests(input.completionPayload?.authority_requests);
  const explicit = [
    ...completionRequests,
    ...readAuthorityRequestValues(resultMetadata),
    ...readAuthorityRequestValues(attemptMetadata)
  ];

  if (input.node.kind === "checkpoint") {
    explicit.push(createAuthorityRequest({
      kind: "planned_checkpoint",
      source: "checkpoint",
      summary: input.message || "Planned checkpoint requires operator input.",
      request_id: `${input.attempt.execution_id}__planned_checkpoint`
    }));
  }

  return [...new Map(explicit.map((request) => [request.request_id, request])).values()];
}

function collectOutcomeFindingCategories(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const categories: string[] = [];
  for (const key of ["findings", "blockers"]) {
    const entries = value[key];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.category === "string") {
        categories.push(entry.category.toLowerCase());
      }
    }
  }
  return categories;
}

function containsDependencyDocsGap(value: unknown): boolean {
  return collectOutcomeFindingCategories(value).some((category) =>
    category === "missing_dependency_docs"
    || category === "dependency_docs_gap"
    || category === "missing_dependency_metadata"
  );
}

function containsOutcomeCategory(value: unknown, categories: string[]): boolean {
  const allowed = new Set(categories);
  return collectOutcomeFindingCategories(value).some((category) => allowed.has(category));
}

function unsafePriorProgressCategories(value: unknown): string[] {
  const unsafe = new Set([
    "wrong_direction",
    "bad_plan_premise",
    "overengineered_solution",
    "broad_rewrite",
    "ai_slop",
    "contaminated_progress"
  ]);
  return collectOutcomeFindingCategories(value).filter((category) => unsafe.has(category));
}

function classifyRuntimeFailureCode(input: {
  code: RuntimeFailureCode;
  message: string;
  evidence: Record<string, unknown>;
}): FailureClassification {
  const evidence = {
    ...input.evidence,
    failure_code: input.code
  };
  switch (input.code) {
    case "context_path_escape":
    case "graph_contract_gap":
      return classifyResult({
        class: "graph_context_gap",
        summary: input.message || "Runtime reported a graph context or authority contract gap.",
        retryable: false,
        recommended_action: "fail",
        gather_plan: noGatherPlan(),
        evidence
      });
    case "context_contract_failure":
      return classifyResult({
        class: "context_contract_failure",
        summary: input.message || "Runtime could not package execution context within the node context contract.",
        retryable: true,
        recommended_action: "rebuild_context",
        gather_plan: gatherPlan([
          gather("local_context", "Analyze the failed context package and build a bounded repair overlay.", 1),
          gather("pattern_mining", "Identify relevant local files that should be sampled in the repaired context.", 2)
        ]),
        evidence
      });
    case "unresolved_context":
      return classifyResult({
        class: "missing_context",
        summary: input.message || "Runtime could not resolve required node context.",
        retryable: true,
        recommended_action: "rebuild_context",
        gather_plan: gatherPlan([
          gather("local_context", "Rebuild the failed node's agent context brief and provenance.", 1),
          gather("pattern_mining", "Find nearby successful patterns or upstream artifacts that clarify intent.", 2)
        ]),
        evidence
      });
    case "harness_no_final_response":
      return classifyResult({
        class: "harness_unavailable",
        summary: input.message || "Agent harness completed without a usable final response.",
        retryable: true,
        recommended_action: "run_diagnostic",
        gather_plan: gatherPlan([
          gather("diagnostic_probe", "Inspect the harness no-op failure and determine whether a retry can produce required artifacts.", 1),
          gather("local_context", "Collect the node contract and current execution logs.", 2)
        ]),
        evidence
      });
    case "harness_unavailable":
    case "verifier_unavailable":
    case "harness_configuration_unsupported":
      return classifyResult({
        class: "harness_unavailable",
        summary: input.message || "Required harness is unavailable.",
        retryable: false,
        recommended_action: "fail",
        gather_plan: noGatherPlan(),
        evidence
      });
    case "tool_wrapper_unavailable":
      return classifyResult({
        class: "harness_unavailable",
        summary: input.message || "Runtime tool or PATH setup is unavailable.",
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
    case "workspace_pollution":
      return classifyResult({
        class: "wrong_local_pattern",
        summary: input.message || "The failed attempt changed workspace files outside the intended scope.",
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
    case "artifact_contract_failure":
      return classifyResult({
        class: "artifact_contract_failure",
        summary: input.message || "Declared artifact contract was not satisfied.",
        retryable: true,
        recommended_action: "repair_artifact",
        gather_plan: gatherPlan([
          gather("local_context", "Collect the node contract and artifact declaration that failed.", 1),
          gather("investigate_failure", "Inspect failed output and logs to identify why the artifact was missing.", 2)
        ]),
        evidence
      });
    case "timeout":
      return classifyResult({
        class: "diagnostic_needed",
        summary: input.message || "Node execution timed out.",
        retryable: true,
        recommended_action: "run_diagnostic",
        gather_plan: gatherPlan([
          gather("diagnostic_probe", "Collect timeout-specific diagnostics and identify a smaller retry strategy.", 1)
        ]),
        evidence
      });
    case "verification_substrate_failure":
      return classifyResult({
        class: "diagnostic_needed",
        summary: input.message || "Verification failed before it could produce a trusted verdict.",
        retryable: true,
        recommended_action: "run_diagnostic",
        gather_plan: gatherPlan([
          gather("diagnostic_probe", "Inspect the verification substrate failure and rerun only the failed verification when possible.", 1),
          gather("local_context", "Collect the verifier/check contract and current artifact state without rerunning completed worker progress.", 2)
        ]),
        evidence: {
          ...evidence,
          verification_substrate_failure: true
        }
      });
    case "missing_plugin_credential":
      return classifyResult({
        class: "harness_unavailable",
        summary: input.message || "Managed plugin tool credentials are missing.",
        retryable: true,
        recommended_action: "run_diagnostic",
        gather_plan: gatherPlan([
          gather("diagnostic_probe", "Inspect the trusted authority request attached to runtime metadata.", 1)
        ]),
        evidence
      });
    case "unprovable_requirement":
      return classifyResult({
        class: "unprovable_requirement",
        summary: input.message || "The requirement cannot be proven from the current graph evidence.",
        retryable: false,
        recommended_action: "fail",
        gather_plan: noGatherPlan(),
        evidence
      });
    case "non_recoverable_contract":
      return classifyResult({
        class: "non_recoverable",
        summary: input.message || "Failure cannot be recovered without changing graph intent or contract.",
        retryable: false,
        recommended_action: "fail",
        gather_plan: noGatherPlan(),
        evidence
      });
  }
}

export function classifyNodeFailure(input: {
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  result?: RuntimeNodeExecutionResult;
  error_message?: string;
  repeated_fingerprint_count?: number;
}): FailureClassification {
  const message = readMessage(input);
  const evidence: Record<string, unknown> = {
    compiled_id: input.node.compiled_id,
    execution_id: input.attempt.execution_id,
    ...(message ? { message } : {})
  };
  const completionPayload = readCompletionFailurePayload(input);
  const authorityRequests = trustedAuthorityRequests({
    node: input.node,
    attempt: input.attempt,
    ...(completionPayload ? { completionPayload } : {}),
    ...(input.result ? { result: input.result } : {}),
    message
  });

  if (authorityRequests.length > 0) {
    return classifyResult({
      class: "authority_required",
      summary: authorityRequests[0]?.summary ?? "Runtime authority is required.",
      retryable: false,
      recommended_action: "pause_for_authority",
      gather_plan: noGatherPlan(),
      evidence: {
        ...evidence,
        authority_requests: authorityRequests
      }
    });
  }

  const runtimeFailureCode = readRuntimeFailureCode(input);
  if (runtimeFailureCode) {
    return classifyRuntimeFailureCode({
      code: runtimeFailureCode,
      message,
      evidence
    });
  }

  if (completionPayload?.completion_status === "blocked") {
    const reasons = completionReasons(completionPayload);
    return classifyResult({
      class: "completion_contract_failure",
      summary: reasons[0] ?? "Completion packet reports a supported blocker.",
      retryable: true,
      recommended_action: "run_diagnostic",
      gather_plan: gatherPlan([
        gather("local_context", "Inspect the blocked completion packet and determine whether the blocker is recoverable under the current node contract.", 1),
        gather("investigate_failure", "Identify a concrete material delta or terminal contract gap without asking for human input.", 2)
      ]),
      evidence: {
        ...evidence,
        completion: {
          completion_status: completionPayload.completion_status,
          blocking_reasons: reasons,
          ...(typeof completionPayload.packet_path === "string"
            ? { packet_path: completionPayload.packet_path }
            : {})
        }
      }
    });
  }

  if (completionPayload?.completion_status === "incomplete") {
    const reasons = completionReasons(completionPayload);
    return classifyResult({
      class: "completion_contract_failure",
      summary: reasons[0] ?? "Completion packet is incomplete.",
      retryable: true,
      recommended_action: "run_diagnostic",
      gather_plan: gatherPlan([
        gather("local_context", "Inspect the completion packet, node contract, current-attempt artifacts, and runtime logs.", 1),
        gather("investigate_failure", "Identify the concrete missing artifact, placeholder artifact, validation gap, or unresolved blocker.", 2)
      ]),
      evidence: {
        ...evidence,
        completion: {
          completion_status: completionPayload.completion_status,
          blocking_reasons: reasons,
          ...(typeof completionPayload.packet_path === "string"
            ? { packet_path: completionPayload.packet_path }
            : {})
        }
      }
    });
  }

  const verificationPayload = readOutcomeVerificationPayload(input.result);
  if (verificationPayload && verificationPayload.passed === false) {
    const summary =
      typeof verificationPayload.summary === "string" && verificationPayload.summary.trim().length > 0
        ? verificationPayload.summary.trim()
        : "Outcome verification rejected the agent's work.";
    const unsafeCategories = unsafePriorProgressCategories(verificationPayload);
    if (unsafeCategories.length > 0) {
      return classifyResult({
        class: "semantic_misalignment",
        summary,
        retryable: true,
        recommended_action: "run_diagnostic",
        gather_plan: gatherPlan([
          gather("local_context", "Inspect the failed attempt workspace diff and preserve only trustworthy prior evidence.", 1),
          gather("investigate_failure", "Determine the earliest safe restart boundary for the unchanged node contract.", 2),
          gather("semantic_rejudge", "Rejudge the unsafe-progress finding before retrying from a clean boundary.", 3)
        ]),
        evidence: {
          ...evidence,
          outcome_verification: verificationPayload,
          prior_progress_unsafe: true,
          unsafe_progress_categories: unsafeCategories,
          workspace_repair_candidate: true
        }
      });
    }
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
    if (containsOutcomeCategory(verificationPayload, ["unprovable_requirement"])) {
      return classifyResult({
        class: "unprovable_requirement",
        summary,
        retryable: false,
        recommended_action: "fail",
        gather_plan: noGatherPlan(),
        evidence: {
          ...evidence,
          outcome_verification: verificationPayload
        }
      });
    }
    if (containsOutcomeCategory(verificationPayload, ["graph_context_gap", "graph_contract_gap"])) {
      return classifyResult({
        class: "graph_context_gap",
        summary,
        retryable: false,
        recommended_action: "fail",
        gather_plan: noGatherPlan(),
        evidence: {
          ...evidence,
          outcome_verification: verificationPayload
        }
      });
    }
    if (containsOutcomeCategory(verificationPayload, ["workspace_pollution"])) {
      return classifyResult({
        class: "wrong_local_pattern",
        summary,
        retryable: true,
        recommended_action: "run_diagnostic",
        gather_plan: gatherPlan([
          gather("local_context", "Inspect the failed attempt workspace diff and node scope.", 1),
          gather("investigate_failure", "Determine which edits should be removed before retry.", 2)
        ]),
        evidence: {
          ...evidence,
          outcome_verification: verificationPayload,
          workspace_repair_candidate: true
        }
      });
    }
    if (containsOutcomeCategory(verificationPayload, ["policy_or_scope_risk"])) {
      return classifyResult({
        class: "policy_or_scope_risk",
        summary,
        retryable: false,
        recommended_action: "fail",
        gather_plan: noGatherPlan(),
        evidence: {
          ...evidence,
          outcome_verification: verificationPayload
        }
      });
    }
    if (containsOutcomeCategory(verificationPayload, ["non_recoverable_contract"])) {
      return classifyResult({
        class: "non_recoverable",
        summary,
        retryable: false,
        recommended_action: "fail",
        gather_plan: noGatherPlan(),
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

  if (resultTimedOut(input.result)) {
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
      recommended_action: "fail",
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

  return classifyResult({
    class: "unknown",
    summary: message || "Node failed without a recognized failure class.",
    retryable: true,
    recommended_action: "run_diagnostic",
    gather_plan: gatherPlan([
      gather("investigate_failure", "Inspect failed attempt logs, output, artifacts, and context.", 1),
      gather("local_context", "Recover local context that should guide the retry.", 2)
    ]),
    evidence
  });
}
