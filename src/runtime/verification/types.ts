export const outcomeVerificationFindingSeverities = ["blocker", "high", "medium", "low"] as const;
export type OutcomeVerificationFindingSeverity = (typeof outcomeVerificationFindingSeverities)[number];

export interface OutcomeVerificationFinding {
  severity: OutcomeVerificationFindingSeverity;
  category: string;
  evidence: string;
  recommendation: string;
  references?: string[];
}

export interface OutcomeVerificationVerifierMetadata {
  harness: string;
  model?: string;
  duration_ms: number;
  prompt_path: string;
  response_path: string;
  attempt_count: number;
  truncated_artifacts: string[];
  workspace_diff_status: "captured" | "degraded" | "absent";
  decision_log_count?: number;
  parse_status: "ok" | "recovered" | "unparseable";
  parse_error?: string;
  raw_response_excerpt?: string;
}

export interface OutcomeVerificationResult {
  passed: boolean;
  summary: string;
  findings: OutcomeVerificationFinding[];
  blockers: OutcomeVerificationFinding[];
  verifier_metadata: OutcomeVerificationVerifierMetadata;
}
