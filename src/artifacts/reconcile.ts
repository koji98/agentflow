import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import { renderRunSummary } from "../runtime/delivery/summary.js";
import type { RuntimeEventEnvelope } from "../runtime/events.js";
import { summarizeSoftVerifications } from "../runtime/session.js";
import type {
  LatestExecutionSummary,
  RuntimeNodeStatus,
  RuntimeRunStatus,
  RuntimeStateSnapshot
} from "../runtime/session.js";
import { isRecordedRunOwnerActive } from "./owner.js";
import {
  readRunEvents,
  readRunExecutionAttempts,
  readRunRecord,
  readRunState,
  type RunRecord
} from "./reader.js";
import { resolveRunArtifactPaths } from "./paths.js";

type TerminalRunStatus = Exclude<RuntimeRunStatus, "pending" | "running">;

function isTerminalRunStatus(status: string): status is TerminalRunStatus {
  return status === "passed" || status === "failed" || status === "canceled";
}

function computeDurationMs(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function countNodeStatuses(statuses: Iterable<RuntimeNodeStatus>): RuntimeStateSnapshot["counts"] {
  const counts: RuntimeStateSnapshot["counts"] = {
    total: 0,
    pending: 0,
    ready: 0,
    running: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    canceled: 0,
    skipped: 0
  };

  for (const status of statuses) {
    counts.total += 1;
    counts[status] += 1;
  }

  return counts;
}

function inferTerminalOutcome(
  event: RuntimeEventEnvelope
): TerminalRunStatus | undefined {
  if (event.type === "run.canceled") {
    return "canceled";
  }

  if (event.type === "run.preflight_failed") {
    return "failed";
  }

  if (event.type === "run.completed") {
    const payload =
      typeof event.payload === "object" && event.payload !== null
        ? event.payload as Record<string, unknown>
        : {};
    const outcome = payload.outcome;

    return typeof outcome === "string" && isTerminalRunStatus(outcome) ? outcome : undefined;
  }

  return undefined;
}

function latestTerminalEvent(
  events: RuntimeEventEnvelope[]
): RuntimeEventEnvelope | undefined {
  return [...events].reverse().find((event) => inferTerminalOutcome(event) !== undefined);
}

function coerceNodeStatus(
  status: RuntimeNodeStatus,
  outcome: TerminalRunStatus
): RuntimeNodeStatus {
  if (status === "running") {
    return outcome === "passed" ? "passed" : "canceled";
  }

  if ((status === "pending" || status === "ready") && outcome === "failed") {
    return "blocked";
  }

  if ((status === "pending" || status === "ready") && outcome === "canceled") {
    return "skipped";
  }

  return status;
}

function buildLatestExecutionSummary(
  attempt: RuntimeNodeAttempt
): LatestExecutionSummary {
  const status =
    attempt.status === "canceled"
      ? "canceled"
      : (attempt.outcome ?? attempt.status) as LatestExecutionSummary["status"];

  return {
    execution_id: attempt.execution_id,
    compiled_id: attempt.compiled_id,
    authored_id: attempt.authored_id,
    kind: attempt.kind,
    status,
    attempt_index: attempt.attempt_index,
    ...(attempt.repeat_scope_id ? { repeat_scope_id: attempt.repeat_scope_id } : {}),
    ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
    ...(attempt.iteration_attempt_index !== undefined
      ? { iteration_attempt_index: attempt.iteration_attempt_index }
      : {}),
    started_at: attempt.started_at,
    ...(attempt.ended_at ? { ended_at: attempt.ended_at } : {}),
    ...(attempt.duration_ms !== undefined ? { duration_ms: attempt.duration_ms } : {})
  };
}

function buildSyntheticLatestExecution(
  activeExecution: RuntimeStateSnapshot["active_executions"][string],
  outcome: TerminalRunStatus,
  endedAt: string
): LatestExecutionSummary {
  return {
    execution_id: activeExecution.execution_id,
    compiled_id: activeExecution.compiled_id,
    authored_id: activeExecution.authored_id,
    kind: activeExecution.kind,
    status: outcome === "passed" ? "passed" : "canceled",
    attempt_index: activeExecution.attempt_index,
    ...(activeExecution.repeat_scope_id ? { repeat_scope_id: activeExecution.repeat_scope_id } : {}),
    ...(activeExecution.iteration_index !== undefined
      ? { iteration_index: activeExecution.iteration_index }
      : {}),
    ...(activeExecution.iteration_attempt_index !== undefined
      ? { iteration_attempt_index: activeExecution.iteration_attempt_index }
      : {}),
    started_at: activeExecution.started_at,
    ended_at: endedAt,
    duration_ms: computeDurationMs(activeExecution.started_at, endedAt)
  };
}

function sealTerminalState(
  state: RuntimeStateSnapshot,
  outcome: TerminalRunStatus,
  endedAt: string,
  snapshotSeq: number,
  attempts: RuntimeNodeAttempt[]
): RuntimeStateSnapshot {
  const node_statuses = Object.fromEntries(
    Object.entries(state.node_statuses).map(([compiledId, status]) => [
      compiledId,
      coerceNodeStatus(status, outcome)
    ])
  ) as RuntimeStateSnapshot["node_statuses"];
  const latest_execution_by_compiled_id = {
    ...state.latest_execution_by_compiled_id
  };

  for (const attempt of attempts) {
    if (attempt.status === "running") {
      latest_execution_by_compiled_id[attempt.compiled_id] = {
        execution_id: attempt.execution_id,
        compiled_id: attempt.compiled_id,
        authored_id: attempt.authored_id,
        kind: attempt.kind,
        status: outcome === "passed" ? "passed" : "canceled",
        attempt_index: attempt.attempt_index,
        ...(attempt.repeat_scope_id ? { repeat_scope_id: attempt.repeat_scope_id } : {}),
        ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
        ...(attempt.iteration_attempt_index !== undefined
          ? { iteration_attempt_index: attempt.iteration_attempt_index }
          : {}),
        started_at: attempt.started_at,
        ended_at: endedAt,
        duration_ms: computeDurationMs(attempt.started_at, endedAt)
      };
      node_statuses[attempt.compiled_id] = outcome === "passed" ? "passed" : "canceled";
      continue;
    }

    latest_execution_by_compiled_id[attempt.compiled_id] = buildLatestExecutionSummary(attempt);
    node_statuses[attempt.compiled_id] = attempt.status === "canceled"
      ? "canceled"
      : (attempt.outcome ?? attempt.status) as RuntimeNodeStatus;
  }

  for (const activeExecution of Object.values(state.active_executions)) {
    latest_execution_by_compiled_id[activeExecution.compiled_id] = buildSyntheticLatestExecution(
      activeExecution,
      outcome,
      endedAt
    );
    node_statuses[activeExecution.compiled_id] = outcome === "passed" ? "passed" : "canceled";
  }

  const repeat_scopes = Object.fromEntries(
    Object.entries(state.repeat_scopes).map(([scopeId, scope]) => [
      scopeId,
      {
        ...scope,
        ...(scope.active_iteration_index !== undefined
          ? {
              active_iteration_index: undefined,
              status: outcome === "passed" ? "passed" : "failed"
            }
          : {})
      }
    ])
  ) as RuntimeStateSnapshot["repeat_scopes"];
  const softVerificationSummary = summarizeSoftVerifications(
    Object.values(latest_execution_by_compiled_id)
  );

  return {
    ...state,
    status: outcome,
    snapshot_seq: snapshotSeq,
    ended_at: endedAt,
    evidence_status: softVerificationSummary.evidence_status,
    node_statuses,
    active_executions: {},
    latest_execution_by_compiled_id,
    repeat_scopes,
    counts: countNodeStatuses(Object.values(node_statuses)),
    soft_verification_counts: softVerificationSummary.soft_verification_counts,
    failed_soft_verifications: softVerificationSummary.failed_soft_verifications
  };
}

async function reconcileRunningAttempts(
  attempts: RuntimeNodeAttempt[],
  endedAt: string,
  reason: string
): Promise<RuntimeNodeAttempt[]> {
  await Promise.all(
    attempts
      .filter((attempt) => attempt.status === "running")
      .map(async (attempt) => {
        const updatedAttempt: RuntimeNodeAttempt = {
          ...attempt,
          status: "canceled",
          ended_at: endedAt,
          duration_ms: computeDurationMs(attempt.started_at, endedAt),
          metadata: {
            ...attempt.metadata,
            reconciled_reason: reason
          }
        };

        Object.assign(attempt, updatedAttempt);
        await writeFile(
          join(attempt.execution_dir, "execution.json"),
          `${JSON.stringify(updatedAttempt, null, 2)}\n`
        );
      })
  );

  return attempts;
}

function buildRunRecord(
  runRecord: RunRecord,
  state: RuntimeStateSnapshot
): RunRecord {
  const {
    owner_pid: _ownerPid,
    owner_started_at: _ownerStartedAt,
    owner_hostname: _ownerHostname,
    ...recordWithoutOwnerFields
  } = runRecord;

  return {
    ...recordWithoutOwnerFields,
    status: state.status,
    started_at: state.started_at,
    ...(state.ended_at ? { ended_at: state.ended_at } : {})
  };
}

function needsStateRepair(
  state: RuntimeStateSnapshot,
  outcome: TerminalRunStatus,
  endedAt: string,
  snapshotSeq: number
): boolean {
  return (
    state.status !== outcome
    || state.ended_at !== endedAt
    || state.snapshot_seq !== snapshotSeq
    || Object.keys(state.active_executions).length > 0
    || Object.values(state.node_statuses).some((status) => {
      if (outcome === "passed") {
        return status === "running";
      }

      return status === "running" || status === "pending" || status === "ready";
    })
  );
}

function needsRunRecordRepair(
  runRecord: RunRecord,
  outcome: TerminalRunStatus,
  endedAt: string
): boolean {
  return (
    runRecord.status !== outcome
    || runRecord.ended_at !== endedAt
    || runRecord.owner_pid !== undefined
    || runRecord.owner_started_at !== undefined
    || runRecord.owner_hostname !== undefined
  );
}

export async function reconcileRunArtifacts(runRoot: string): Promise<void> {
  const paths = resolveRunArtifactPaths(runRoot);
  const [runRecord, state, events] = await Promise.all([
    readRunRecord(runRoot),
    readRunState(runRoot),
    readRunEvents(runRoot)
  ]);
  const terminalEvent = latestTerminalEvent(events);
  const stateOutcome = isTerminalRunStatus(state.status) ? state.status : undefined;
  const recordOutcome = isTerminalRunStatus(runRecord.status) ? runRecord.status : undefined;
  let desiredOutcome = stateOutcome
    ?? recordOutcome
    ?? (terminalEvent ? inferTerminalOutcome(terminalEvent) : undefined);
  let endedAt = state.ended_at
    ?? runRecord.ended_at
    ?? terminalEvent?.ts;
  let snapshotSeq = Math.max(
    state.snapshot_seq,
    terminalEvent?.seq ?? state.snapshot_seq,
    events.at(-1)?.seq ?? state.snapshot_seq
  );
  let reason: string | undefined;
  let syntheticTerminalEvent: RuntimeEventEnvelope | undefined;
  let attempts: RuntimeNodeAttempt[] = [];

  if (!desiredOutcome) {
    const activeOwner = await isRecordedRunOwnerActive(runRecord);

    if (
      activeOwner === false
      && ["pending", "running"].includes(state.status)
      && ["pending", "running"].includes(runRecord.status)
    ) {
      desiredOutcome = "failed";
      endedAt = new Date().toISOString();
      reason = "Recorded runtime owner was no longer active before writing a terminal snapshot.";
      attempts = await reconcileRunningAttempts(await readRunExecutionAttempts(runRoot), endedAt, reason);
      syntheticTerminalEvent = {
        seq: (events.at(-1)?.seq ?? 0) + 1,
        ts: endedAt,
        run_id: state.run_id,
        type: "run.completed",
        payload: {
          outcome: "failed",
          duration_ms: computeDurationMs(state.started_at, endedAt),
          reason
        }
      };
      snapshotSeq = syntheticTerminalEvent.seq;
    }
  }

  if (!desiredOutcome) {
    return;
  }

  if (!endedAt) {
    endedAt = new Date().toISOString();
  }

  if (attempts.length === 0) {
    attempts = await readRunExecutionAttempts(runRoot);
  }

  const repairedState = needsStateRepair(state, desiredOutcome, endedAt, snapshotSeq)
    ? sealTerminalState(state, desiredOutcome, endedAt, snapshotSeq, attempts)
    : state;
  const repairedRunRecord = needsRunRecordRepair(runRecord, desiredOutcome, endedAt)
    ? buildRunRecord(runRecord, repairedState)
    : runRecord;

  if (
    repairedState === state
    && repairedRunRecord === runRecord
    && syntheticTerminalEvent === undefined
  ) {
    return;
  }

  await writeFile(paths.run_file, `${JSON.stringify(repairedRunRecord, null, 2)}\n`);
  await writeFile(paths.state_file, `${JSON.stringify(repairedState, null, 2)}\n`);

  const updatedEvents = syntheticTerminalEvent ? [...events, syntheticTerminalEvent] : events;

  if (syntheticTerminalEvent) {
    await appendFile(paths.events_file, `${JSON.stringify(syntheticTerminalEvent)}\n`);
  }

  await writeFile(
    paths.summary_file,
    renderRunSummary(repairedState, attempts, updatedEvents)
  );
}
