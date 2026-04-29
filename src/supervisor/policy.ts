import type { SupervisionPolicy } from "../graph/authored.js";
import type { SupervisorActionKind } from "../graph/schema.js";
import type { SupervisorDecision } from "./types.js";

export type SupervisorBudgetSpent = { total: number } & Partial<Record<SupervisorActionKind, number>>;

export interface SupervisorBudgetRemaining {
  max_total_interventions: number;
  actions: Partial<Record<SupervisorActionKind, number>>;
}

export interface SupervisorBudgetState {
  remaining: SupervisorBudgetRemaining;
  spent: SupervisorBudgetSpent;
}

function createEmptySpent(): SupervisorBudgetSpent {
  return {
    total: 0
  };
}

export function createSupervisorBudget(policy: SupervisionPolicy): SupervisorBudgetState {
  return {
    remaining: {
      max_total_interventions: policy.max_total_interventions,
      actions: Object.fromEntries(
        Object.entries(policy.actions).map(([action, config]) => [
          action,
          config?.max_uses ?? 0
        ])
      )
    },
    spent: createEmptySpent()
  };
}

export function canSpendSupervisorAction(
  state: SupervisorBudgetState,
  action: SupervisorActionKind
): boolean {
  return (
    state.remaining.max_total_interventions > 0 &&
    (state.remaining.actions[action] ?? 0) > 0
  );
}

export function spendSupervisorAction(
  state: SupervisorBudgetState,
  action: SupervisorActionKind
): SupervisorBudgetState {
  if (!canSpendSupervisorAction(state, action)) {
    return {
      remaining: { ...state.remaining },
      spent: { ...state.spent }
    };
  }

  const remaining: SupervisorBudgetRemaining = {
    max_total_interventions: state.remaining.max_total_interventions,
    actions: { ...state.remaining.actions }
  };
  remaining.max_total_interventions = Math.max(0, remaining.max_total_interventions - 1);
  remaining.actions[action] = Math.max(0, (remaining.actions[action] ?? 0) - 1);

  return {
    remaining,
    spent: {
      ...state.spent,
      total: state.spent.total + 1,
      [action]: (state.spent[action] ?? 0) + 1
    }
  };
}

export function buildBudgetExhaustedDecision(
  _state: SupervisorBudgetState,
  action: SupervisorActionKind,
  target: {
    compiled_id?: string;
    execution_id?: string;
  } = {}
): SupervisorDecision {
  const now = new Date().toISOString();
  return {
    decision_id: `decision_${Date.now()}`,
    kind: "fail_run",
    classification: "policy_or_scope_risk",
    ...(target.compiled_id ? { target_compiled_id: target.compiled_id } : {}),
    ...(target.execution_id ? { target_execution_id: target.execution_id } : {}),
    action: "fail",
    reason: `Supervisor budget exhausted for action "${action}".`,
    budget_cost: {},
    created_at: now
  };
}
