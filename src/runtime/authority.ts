export const authorityRequestKinds = [
  "missing_credential",
  "missing_harness_auth",
  "planned_checkpoint",
  "external_side_effect_approval",
  "operator_authored_pause"
] as const;

export type AuthorityRequestKind = (typeof authorityRequestKinds)[number];

export const authorityRequestSources = [
  "checkpoint",
  "credential",
  "harness",
  "plugin_tool",
  "operator"
] as const;

export type AuthorityRequestSource = (typeof authorityRequestSources)[number];

export interface AuthorityRequest {
  request_id: string;
  kind: AuthorityRequestKind;
  source: AuthorityRequestSource;
  summary: string;
  evidence?: Record<string, unknown>;
  created_at?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAuthorityRequest(value: unknown): value is AuthorityRequest {
  return isRecord(value) &&
    typeof value.request_id === "string" &&
    authorityRequestKinds.includes(value.kind as AuthorityRequestKind) &&
    authorityRequestSources.includes(value.source as AuthorityRequestSource) &&
    typeof value.summary === "string" &&
    value.summary.trim().length > 0 &&
    (value.evidence === undefined || isRecord(value.evidence)) &&
    (value.created_at === undefined || typeof value.created_at === "string");
}

export function normalizeAuthorityRequests(value: unknown): AuthorityRequest[] {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.filter(isAuthorityRequest);
}

export function createAuthorityRequest(input: {
  kind: AuthorityRequestKind;
  source: AuthorityRequestSource;
  summary: string;
  request_id?: string;
  evidence?: Record<string, unknown>;
  created_at?: string;
}): AuthorityRequest {
  const requestId = input.request_id ?? `${input.source}_${input.kind}`;
  return {
    request_id: requestId,
    kind: input.kind,
    source: input.source,
    summary: input.summary,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    created_at: input.created_at ?? new Date().toISOString()
  };
}
