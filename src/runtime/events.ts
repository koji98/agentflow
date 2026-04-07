import type { ExecutableNodeKind, GraphOutcome } from "../graph/schema.js";

export const runtimeEventTypes = [
  "graph.compiled",
  "run.preflight_failed",
  "run.started",
  "node.ready",
  "repeat.iteration.started",
  "node.started",
  "check.evaluated",
  "node.completed",
  "node.blocked",
  "node.skipped",
  "node.canceled",
  "repeat.iteration.completed",
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

export interface RepeatIterationStartedPayload {
  max_attempts: number;
}

export interface RepeatIterationCompletedPayload {
  outcome: GraphOutcome;
  iteration_index: number;
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
