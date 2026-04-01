export type RunStateLike = {
  isActive?: unknown;
  totalFailureCount?: unknown;
  totalRunFailureCount?: unknown;
  runFailureReasons?: unknown;
  groups?: unknown;
  tasks?: unknown;
  decisionTrace?: unknown;
};

type LifecycleRowLike = {
  status?: unknown;
};

type DecisionTraceEntryLike = Record<string, unknown>;

function normalizeTraceEntries(trace: unknown): DecisionTraceEntryLike[] {
  if (!Array.isArray(trace)) return [];
  return trace.filter((entry): entry is DecisionTraceEntryLike => (
    Boolean(entry) && typeof entry === 'object'
  ));
}

export function collectLifecycleRows(state: RunStateLike | null): LifecycleRowLike[] {
  if (!state) return [];
  const taskRows = Object.values((state.tasks as Record<string, LifecycleRowLike>) || {});
  const groupRows = Object.values((state.groups as Record<string, LifecycleRowLike>) || {});
  return [...taskRows, ...groupRows];
}

export function hasRecordedFailure(state: RunStateLike | null): boolean {
  if (!state) return false;
  if (Number(state.totalFailureCount || 0) > 0) return true;
  if (Number(state.totalRunFailureCount || 0) > 0) return true;
  if (Array.isArray(state.runFailureReasons) && state.runFailureReasons.length > 0) return true;
  return collectLifecycleRows(state).some((row) => String(row.status || '') === 'FAILED');
}

function inferActiveVerdictFromDecisionTrace(trace: unknown): boolean | null {
  const entries = normalizeTraceEntries(trace);

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const type = String(entry.type || '');

    if (type === 'while_gate_evaluation') {
      const detail = (
        entry.detail && typeof entry.detail === 'object'
          ? entry.detail
          : {}
      ) as Record<string, unknown>;
      if (typeof detail.passed === 'boolean') return true;
    }

    if (type === 'while_iteration_started') return true;

    if (type === 'while_satisfied'
      || type === 'while_exhausted'
      || type === 'termination_guard'
      || type === 'run_failed') {
      return false;
    }
  }

  return null;
}

export function inferActiveFromDecisionTrace(trace: unknown): boolean {
  const verdict = inferActiveVerdictFromDecisionTrace(trace);
  return verdict === true;
}

function rowsLookTerminal(rows: LifecycleRowLike[]): boolean {
  if (rows.length === 0) return false;
  return rows.every((row) => {
    const status = String(row.status || '');
    return status === 'DONE' || status === 'FAILED';
  });
}

export function inferActiveFromStateSnapshot(
  state: RunStateLike | null,
  trace: unknown = state?.decisionTrace,
): boolean {
  if (!state) return false;

  const rows = collectLifecycleRows(state);
  if (rows.some((row) => String(row.status || '') === 'RUNNING')) {
    return true;
  }

  const traceVerdict = inferActiveVerdictFromDecisionTrace(trace);
  if (traceVerdict !== null) return traceVerdict;

  if (typeof state.isActive === 'boolean') {
    if (state.isActive && rowsLookTerminal(rows)) {
      return false;
    }
    return state.isActive;
  }

  if (rows.length > 0) return false;
  return false;
}

export function inferResumableFromStateSnapshot(
  state: RunStateLike | null,
  trace: unknown = state?.decisionTrace,
): boolean {
  if (!state || inferActiveFromStateSnapshot(state, trace)) return false;
  if (hasRecordedFailure(state)) return true;

  const rows = collectLifecycleRows(state);
  if (rows.length === 0) return false;
  return rows.some((row) => String(row.status || '') !== 'DONE');
}
