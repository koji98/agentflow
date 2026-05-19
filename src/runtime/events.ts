import type { ExecutableNodeKind, GraphOutcome } from "../graph/schema.js";

export const runtimeEventTypes = [
  "graph.compiled",
  "run.preflight_failed",
  "run.started",
  "node.ready",
  "repeat.iteration.started",
  "node.started",
  "managed.progress",
  "supervisor.decision",
  "supervisor.intervention.started",
  "supervisor.intervention.retry",
  "supervisor.intervention.completed",
  "supervisor.intervention.failed",
  "supervisor.retry_scheduled",
  "supervisor.gate_rerun_scheduled",
  "supervisor.paused",
  "check.evaluated",
  "verification.started",
  "verification.retry",
  "verification.completed",
  "verification.recorded",
  "outcome.verified",
  "node.completed",
  "node.blocked",
  "node.skipped",
  "node.canceled",
  "repeat.iteration.completed",
  "sequence.cleanup.started",
  "sequence.cleanup.step_failed",
  "sequence.cleanup.completed",
  "sequence.cleanup.canceled",
  "delivery.curation.started",
  "delivery.curation.completed",
  "delivery.curation.failed",
  "delivery.package.completed",
  "run.canceled",
  "run.completed"
] as const;

export type RuntimeEventType = (typeof runtimeEventTypes)[number];

export interface RuntimeEventEnvelope<TPayload = unknown> {
  seq: number;
  ts: string;
  run_id: string;
  type: RuntimeEventType;
  compiled_id?: string;
  execution_id?: string;
  repeat_scope_id?: string;
  iteration_index?: number;
  attempt_index?: number;
  payload: TPayload;
}

export interface RuntimeEventContext {
  compiled_id: string | undefined;
  execution_id: string | undefined;
  repeat_scope_id: string | undefined;
  iteration_index: number | undefined;
  attempt_index: number | undefined;
}

export interface NodeStartedPayload {
  kind: ExecutableNodeKind;
  repo_alias: string;
  profile_name: string;
}

export interface NodeCompletedPayload {
  outcome: GraphOutcome;
  duration_ms: number;
}

export interface CheckEvaluatedPayload {
  check_kind: "deterministic" | "ai";
  passed: boolean;
  score?: number;
  summary?: string;
}

export interface VerificationRecordedPayload {
  verifier_kind: "exec" | "check";
  passed: boolean;
  summary: string;
  check_kind?: "deterministic" | "ai";
  exit_code?: number;
}

export interface VerificationPhasePayload {
  verifier_kind: "exec" | "check" | "outcome";
  passed?: boolean;
  summary?: string;
  check_kind?: "deterministic" | "ai";
  attempt?: number;
}

export interface OutcomeVerifiedPayload {
  passed: boolean;
  findings_count: number;
  blockers_count: number;
  verify_outcome_path: string;
  verifier_harness: string;
  parse_status: "ok" | "recovered" | "unparseable";
  duration_ms: number;
}

export interface RepeatIterationStartedPayload {
  max_attempts: number;
}

export interface RepeatIterationCompletedPayload {
  outcome: GraphOutcome;
  iteration_index: number;
}

export interface SequenceCleanupStartedPayload {
  sequence_authored_id: string;
  cleanup_step_count: number;
  body_outcome: "passed" | "failed" | "canceled";
}

export interface SequenceCleanupStepFailedPayload {
  compiled_id: string;
  message: string;
}

export interface SequenceCleanupCompletedPayload {
  sequence_authored_id: string;
  steps_attempted: number;
  steps_passed: number;
  steps_failed: number;
  steps_skipped: number;
}

export interface SequenceCleanupCanceledPayload {
  sequence_authored_id: string;
  reason: string;
}

export function createRuntimeEvent<TPayload>(
  seq: number,
  runId: string,
  type: RuntimeEventType,
  payload: TPayload,
  context: RuntimeEventContext = {
    compiled_id: undefined,
    execution_id: undefined,
    repeat_scope_id: undefined,
    iteration_index: undefined,
    attempt_index: undefined
  }
): RuntimeEventEnvelope<TPayload> {
  return {
    seq,
    ts: new Date().toISOString(),
    run_id: runId,
    type,
    ...(context.compiled_id ? { compiled_id: context.compiled_id } : {}),
    ...(context.execution_id ? { execution_id: context.execution_id } : {}),
    ...(context.repeat_scope_id ? { repeat_scope_id: context.repeat_scope_id } : {}),
    ...(context.iteration_index !== undefined ? { iteration_index: context.iteration_index } : {}),
    ...(context.attempt_index !== undefined ? { attempt_index: context.attempt_index } : {}),
    payload
  };
}
