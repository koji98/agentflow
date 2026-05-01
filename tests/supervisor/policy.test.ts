import { describe, expect, it } from "vitest";

import {
  buildBudgetExhaustedDecision,
  canSpendSupervisorAction,
  createSupervisorBudget,
  spendSupervisorAction
} from "../../src/supervisor/policy.js";
import type { SupervisionPolicy } from "../../src/graph/authored.js";

const policy: SupervisionPolicy = {
  actions: {
    retry_with_guidance: { max_uses: 1 },
    repair_artifact: { max_uses: 1 }
  },
  max_total_interventions: 2,
  policy: {
    pause_on_policy_risk: true,
    pause_on_repeated_recovery: true,
    drift_score_threshold: 0.8
  }
};

describe("supervisor policy", () => {
  it("creates budget state from graph supervision policy", () => {
    expect(createSupervisorBudget(policy)).toEqual({
      remaining: {
        max_total_interventions: 2,
        actions: {
          retry_with_guidance: 1,
          repair_artifact: 1
        }
      },
      spent: {
        total: 0
      }
    });
  });

  it("spends both total and action-specific budget", () => {
    const state = spendSupervisorAction(createSupervisorBudget(policy), "retry_with_guidance");

    expect(state.remaining.max_total_interventions).toBe(1);
    expect(state.remaining.actions.retry_with_guidance).toBe(0);
    expect(state.spent.total).toBe(1);
    expect(state.spent.retry_with_guidance).toBe(1);
    expect(canSpendSupervisorAction(state, "retry_with_guidance")).toBe(false);
    expect(canSpendSupervisorAction(state, "repair_artifact")).toBe(true);
  });

  it("builds an escalation decision when budget is exhausted", () => {
    const state = spendSupervisorAction(createSupervisorBudget(policy), "retry_with_guidance");
    const decision = buildBudgetExhaustedDecision(state, "retry_with_guidance", {
      compiled_id: "root__fix",
      execution_id: "exec__root__fix__attempt_1"
    });

    expect(decision).toEqual(
      expect.objectContaining({
        kind: "fail_run",
        classification: "policy_or_scope_risk",
        action: "fail",
        target_compiled_id: "root__fix",
        target_execution_id: "exec__root__fix__attempt_1"
      })
    );
    expect(decision.reason).toContain("retry_with_guidance");
  });
});
