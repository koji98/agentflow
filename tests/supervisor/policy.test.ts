import { describe, expect, it } from "vitest";

import {
  buildBudgetExhaustedDecision,
  canSpendSupervisorAction,
  createSupervisorBudget,
  spendSupervisorAction
} from "../../src/supervisor/policy.js";
import type { SupervisionPolicy } from "../../src/graph/authored.js";

const policy: SupervisionPolicy = {
  allowed_actions: ["retry_node", "repair_artifact", "escalate"],
  retry_budget: {
    max_total_interventions: 2,
    max_node_retries: 1,
    max_artifact_repairs: 1,
    max_context_rebuilds: 0,
    max_workspace_refreshes: 0,
    max_diagnostic_runs: 0,
    max_semantic_evaluations: 0
  },
  drift_detection: {
    score_threshold: 0.8
  },
  escalation: {
    require_human_on_policy_breach: true,
    require_human_on_scope_drift: true
  }
};

describe("supervisor policy", () => {
  it("creates budget state from graph supervision policy", () => {
    expect(createSupervisorBudget(policy)).toEqual({
      remaining: policy.retry_budget,
      spent: {
        total: 0,
        retry_node: 0,
        repair_artifact: 0,
        rebuild_context: 0,
        refresh_workspace: 0,
        run_diagnostic: 0,
        semantic_evaluation: 0,
        escalate: 0
      }
    });
  });

  it("spends both total and action-specific budget", () => {
    const state = spendSupervisorAction(createSupervisorBudget(policy), "retry_node");

    expect(state.remaining.max_total_interventions).toBe(1);
    expect(state.remaining.max_node_retries).toBe(0);
    expect(state.spent.total).toBe(1);
    expect(state.spent.retry_node).toBe(1);
    expect(canSpendSupervisorAction(state, "retry_node")).toBe(false);
    expect(canSpendSupervisorAction(state, "repair_artifact")).toBe(true);
  });

  it("builds an escalation decision when budget is exhausted", () => {
    const state = spendSupervisorAction(createSupervisorBudget(policy), "retry_node");
    const decision = buildBudgetExhaustedDecision(state, "retry_node", {
      compiled_id: "root__fix",
      execution_id: "exec__root__fix__attempt_1"
    });

    expect(decision).toEqual(
      expect.objectContaining({
        kind: "escalate",
        classification: "policy_breach",
        action: "escalate",
        target_compiled_id: "root__fix",
        target_execution_id: "exec__root__fix__attempt_1"
      })
    );
    expect(decision.reason).toContain("retry_node");
  });
});
