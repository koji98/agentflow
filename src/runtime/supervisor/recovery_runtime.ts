import type { CompiledExecutableNode } from "../../graph/compiled.js";
import { ArtifactWriter } from "../../artifacts/writer.js";
import type { RuntimeNodeAttempt } from "../attempts.js";
import type { RuntimeEventContext, RuntimeEventEnvelope } from "../events.js";
import type { RuntimeSession } from "../session.js";
import { restoreNodeWorkspaceChangesFromSnapshot } from "../workspace/node-snapshot.js";
import type { FailureClassification } from "../../supervisor/classifier.js";
import { runSupervisorRecoveryCycle } from "../../supervisor/recovery.js";
import type { SupervisorActionKind, SupervisorInterventionRecord } from "../../supervisor/types.js";
import {
  runSupervisorRecoveryCycleWithBackoff,
  type SupervisorRecoveryCycleRetryResult
} from "../core/supervisor_recovery_retry.js";

type SupervisorRecoveryCycleResult = Awaited<ReturnType<typeof runSupervisorRecoveryCycle>>;
type FailedSupervisorRecoveryCycleResult = Extract<
  SupervisorRecoveryCycleRetryResult<SupervisorRecoveryCycleResult>,
  { status: "failed" }
>;

export type RuntimeSupervisorEventEmitter = (
  type: RuntimeEventEnvelope["type"],
  payload: unknown,
  context?: RuntimeEventContext
) => Promise<RuntimeEventEnvelope>;

function retryDelayBaseMs(): number {
  const configured = Number.parseInt(process.env.AGENTFLOW_RETRY_BASE_DELAY_MS ?? "", 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return process.env.NODE_ENV === "test" || process.env.VITEST || process.env.VITEST_WORKER_ID ? 0 : 10_000;
}

function retryDelayMaxMs(): number {
  const configured = Number.parseInt(process.env.AGENTFLOW_RETRY_MAX_DELAY_MS ?? "", 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return 120_000;
}

export function computeRetryDelayMs(repeatedFingerprintCount: number): number {
  const base = retryDelayBaseMs();
  const max = retryDelayMaxMs();
  const exponent = Math.max(0, repeatedFingerprintCount - 1);
  return Math.min(max, base * (2 ** exponent));
}

export async function sleepForRetryDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolveSleep, reject) => {
    const timer = setTimeout(resolveSleep, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Retry delay canceled."));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function supervisorRecoveryCycleMaxAttempts(): number {
  const configured = Number.parseInt(process.env.AGENTFLOW_SUPERVISOR_RECOVERY_MAX_ATTEMPTS ?? "", 10);
  if (Number.isFinite(configured) && configured >= 1) {
    return configured;
  }
  return 3;
}

export async function runSupervisorRecoveryCycleWithRuntimeBackoff(options: {
  signal: AbortSignal | undefined;
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  action: SupervisorActionKind;
  interventionId: string;
  decisionId: string;
  targetCompiledId: string;
  emitEvent: RuntimeSupervisorEventEmitter;
  run: () => Promise<SupervisorRecoveryCycleResult>;
}): Promise<SupervisorRecoveryCycleRetryResult<SupervisorRecoveryCycleResult>> {
  return runSupervisorRecoveryCycleWithBackoff({
    maxAttempts: supervisorRecoveryCycleMaxAttempts(),
    run: options.run,
    delayForAttempt: computeRetryDelayMs,
    sleep: (delayMs) => sleepForRetryDelay(delayMs, options.signal),
    onRetry: async (retry) => {
      await options.emitEvent(
        "supervisor.intervention.retry",
        {
          intervention_id: options.interventionId,
          decision_id: options.decisionId,
          action: options.action,
          target_compiled_id: options.targetCompiledId,
          ...retry
        },
        {
          compiled_id: options.node.compiled_id,
          execution_id: options.attempt.execution_id,
          repeat_scope_id: options.attempt.repeat_scope_id,
          iteration_index: options.attempt.iteration_index,
          attempt_index: options.attempt.attempt_index
        }
      );
    }
  });
}

export async function appendFailedSupervisorRecoveryCycle(options: {
  session: RuntimeSession;
  writer: ArtifactWriter;
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  action: SupervisorActionKind;
  decisionId: string;
  interventionId: string;
  recoveryTargetNode: CompiledExecutableNode;
  targetExecutionId: string;
  failureFingerprint: string;
  repeatedFingerprintCount: number;
  classification: FailureClassification;
  retryResult: FailedSupervisorRecoveryCycleResult;
  finalSupervisorStatus: "exhausted" | "paused";
  emitEvent: RuntimeSupervisorEventEmitter;
}): Promise<void> {
  const reason = `Supervisor recovery cycle failed after ${options.retryResult.attempts} attempt(s): ${options.retryResult.summary}`;
  const now = new Date().toISOString();
  const intervention: SupervisorInterventionRecord = {
    intervention_id: options.interventionId,
    decision_id: options.decisionId,
    action: options.action,
    status: "failed",
    target_compiled_id: options.recoveryTargetNode.compiled_id,
    target_execution_id: options.targetExecutionId,
    started_at: now,
    ended_at: now,
    reason,
    evidence: {
      supervisor_recovery_error: true,
      attempts: options.retryResult.attempts,
      errors: options.retryResult.errors,
      failure_fingerprint: options.failureFingerprint,
      repeated_fingerprint_count: options.repeatedFingerprintCount,
      symptom_compiled_id: options.node.compiled_id,
      symptom_execution_id: options.attempt.execution_id,
      classification: options.classification.class
    },
    artifact_paths: {}
  };

  options.session.supervisor.status = options.finalSupervisorStatus;
  if (options.finalSupervisorStatus !== "paused" && options.session.status === "paused") {
    options.session.status = "failed";
  }

  await options.writer.appendSupervisorIntervention(intervention);
  await options.emitEvent(
    "supervisor.intervention.failed",
    {
      intervention_id: intervention.intervention_id,
      decision_id: intervention.decision_id,
      action: intervention.action,
      target_compiled_id: intervention.target_compiled_id,
      summary: intervention.reason,
      attempts: options.retryResult.attempts,
      errors: options.retryResult.errors
    },
    {
      compiled_id: options.node.compiled_id,
      execution_id: options.attempt.execution_id,
      repeat_scope_id: options.attempt.repeat_scope_id,
      iteration_index: options.attempt.iteration_index,
      attempt_index: options.attempt.attempt_index
    }
  );
}

export async function applyRuntimeOverlayBeforeRetry(options: {
  recovery: SupervisorRecoveryCycleResult;
  attempt: RuntimeNodeAttempt;
  workspacePath: string;
}): Promise<boolean> {
  const overlay = options.recovery.recovery_plan.runtime_overlay;
  if (!overlay) {
    return false;
  }

  if (overlay.apply_action === "repair_workspace") {
    const patch = overlay.workspace_repair;
    if (!patch) {
      return false;
    }
    const result = await restoreNodeWorkspaceChangesFromSnapshot({
      workspacePath: options.workspacePath,
      attemptDir: options.attempt.execution_dir,
      ...(patch.result_path ? { resultPath: patch.result_path } : {})
    });
    return result.status === "passed" || result.status === "partial";
  }

  return true;
}
