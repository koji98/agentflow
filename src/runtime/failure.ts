export const runtimeFailureCodes = [
  "artifact_contract_failure",
  "context_contract_failure",
  "context_path_escape",
  "graph_contract_gap",
  "harness_configuration_unsupported",
  "harness_no_final_response",
  "harness_unavailable",
  "missing_plugin_credential",
  "non_recoverable_contract",
  "timeout",
  "tool_wrapper_unavailable",
  "unprovable_requirement",
  "unresolved_context",
  "verifier_unavailable",
  "workspace_pollution"
] as const;

export type RuntimeFailureCode = (typeof runtimeFailureCodes)[number];

export function isRuntimeFailureCode(value: unknown): value is RuntimeFailureCode {
  return typeof value === "string" && runtimeFailureCodes.includes(value as RuntimeFailureCode);
}

export interface RuntimeFailurePayload extends Record<string, unknown> {
  error: string;
  failure_code: RuntimeFailureCode;
  details?: Record<string, unknown>;
}

export class RuntimeFailureError extends Error {
  readonly failure_code: RuntimeFailureCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    failureCode: RuntimeFailureCode,
    summary: string,
    details?: Record<string, unknown>
  ) {
    super(summary);
    this.name = "RuntimeFailureError";
    this.failure_code = failureCode;
    this.details = details;
  }
}

export function runtimeFailurePayload(
  failureCode: RuntimeFailureCode,
  summary: string,
  details?: Record<string, unknown>
): RuntimeFailurePayload {
  return {
    error: summary,
    failure_code: failureCode,
    ...(details ? { details } : {})
  };
}

export function runtimeFailureMetadata(
  failureCode: RuntimeFailureCode,
  summary: string,
  details?: Record<string, unknown>
): RuntimeFailurePayload {
  return runtimeFailurePayload(failureCode, summary, details);
}
