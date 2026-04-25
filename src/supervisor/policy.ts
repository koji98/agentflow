import type {
  SupervisionPolicy,
  SupervisionRetryBudget
} from "../graph/authored.js";
import type { SupervisorActionKind } from "../graph/schema.js";
import type { SupervisorDecision } from "./types.js";

export interface SupervisorBudgetSpent {
  total: number;
  retry_node: number;
  repair_artifact: number;
  rebuild_context: number;
  refresh_workspace: number;
  run_diagnostic: number;
  semantic_evaluation: number;
  escalate: number;
}

export interface SupervisorBudgetState {
  remaining: SupervisionRetryBudget;
  spent: SupervisorBudgetSpent;
}

type BudgetField = keyof SupervisionRetryBudget;

const actionBudgetField: Partial<Record<SupervisorActionKind, BudgetField>> = {
  retry_node: "max_node_retries",
  repair_artifact: "max_artifact_repairs",
  rebuild_context: "max_context_rebuilds",
  refresh_workspace: "max_workspace_refreshes",
  run_diagnostic: "max_diagnostic_runs",
  semantic_evaluation: "max_semantic_evaluations"
};

function createEmptySpent(): SupervisorBudgetSpent {
  return {
    total: 0,
    retry_node: 0,
    repair_artifact: 0,
    rebuild_context: 0,
    refresh_workspace: 0,
    run_diagnostic: 0,
    semantic_evaluation: 0,
    escalate: 0
  };
}

export function createSupervisorBudget(policy: SupervisionPolicy): SupervisorBudgetState {
  return {
    remaining: { ...policy.retry_budget },
    spent: createEmptySpent()
  };
}

export function canSpendSupervisorAction(
  state: SupervisorBudgetState,
  action: SupervisorActionKind
): boolean {
  if (action === "escalate") {
    return true;
  }

  const field = actionBudgetField[action];
  return (
    state.remaining.max_total_interventions > 0 &&
    field !== undefined &&
    state.remaining[field] > 0
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

  const field = actionBudgetField[action];
  const remaining = { ...state.remaining };
  remaining.max_total_interventions = Math.max(0, remaining.max_total_interventions - 1);
  if (field) {
    remaining[field] = Math.max(0, remaining[field] - 1);
  }

  return {
    remaining,
    spent: {
      ...state.spent,
      total: state.spent.total + 1,
      [action]: state.spent[action] + 1
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
    kind: "escalate",
    classification: "policy_breach",
    ...(target.compiled_id ? { target_compiled_id: target.compiled_id } : {}),
    ...(target.execution_id ? { target_execution_id: target.execution_id } : {}),
    action: "escalate",
    reason: `Supervisor budget exhausted for action "${action}".`,
    budget_cost: {},
    created_at: now
  };
}
