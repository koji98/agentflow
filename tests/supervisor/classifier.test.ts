import { describe, expect, it } from "vitest";

import type { CompiledCheckNode, CompiledExecutableNode } from "../../src/graph/compiled.js";
import type { SupervisionPolicy } from "../../src/graph/authored.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { RuntimeNodeExecutionResult } from "../../src/runtime/core/engine.js";
import { classifyNodeFailure } from "../../src/supervisor/classifier.js";

const policy: SupervisionPolicy = {
  actions: {
    retry_with_guidance: { max_uses: 1 },
    repair_artifact: { max_uses: 1 },
    rebuild_context: { max_uses: 1 },
    pause_for_human: { max_uses: 1 },
    semantic_evaluation: { max_uses: 1 }
  },
  max_total_interventions: 5,
  policy: {
    pause_on_policy_risk: true,
    pause_on_repeated_recovery: true,
    drift_score_threshold: 0.8
  }
};

const baseNode: CompiledExecutableNode = {
  compiled_id: "root__node",
  authored_id: "node",
  kind: "agent",
  repo: "main",
  deps: [],
  scope_stack: ["scope__root"],
  effective_policy: {
    profile_name: "default",
    sandbox: "workspace-write",
    timeout_sec: 60,
    input_rules: {},
    artifact_repair: { max_attempts: 1 }
  },
  context: [],
  declared_artifacts: {},
  goal: "Do work.",
  tools: []
};

const baseAttempt: RuntimeNodeAttempt = {
  execution_id: "exec__root__node__attempt_1",
  compiled_id: "root__node",
  authored_id: "node",
  kind: "agent",
  repo_alias: "main",
  execution_dir: "/tmp/execution",
  attempt_index: 1,
  status: "failed",
  outcome: "failed",
  started_at: "2026-04-24T00:00:00.000Z",
  ended_at: "2026-04-24T00:00:01.000Z",
  duration_ms: 1000,
  artifacts: {},
  metadata: {}
};

function classify(
  overrides: {
    node?: CompiledExecutableNode;
    attempt?: RuntimeNodeAttempt;
    result?: RuntimeNodeExecutionResult;
    error_message?: string;
  }
) {
  return classifyNodeFailure({
    node: overrides.node ?? baseNode,
    attempt: overrides.attempt ?? baseAttempt,
    ...(overrides.result ? { result: overrides.result } : {}),
    ...(overrides.error_message ? { error_message: overrides.error_message } : {}),
    policy
  });
}

describe("supervisor failure classifier", () => {
  it("classifies missing declared artifacts as artifact failures", () => {
    expect(classify({ error_message: "Required artifact contract is missing: summary at summary.md" })).toEqual(
      expect.objectContaining({
        class: "artifact",
        retryable: true,
        recommended_action: "repair_artifact"
      })
    );
  });

  it("classifies context resolution errors as context failures", () => {
    expect(classify({ error_message: "Required context item could not be resolved." })).toEqual(
      expect.objectContaining({
        class: "context",
        recommended_action: "rebuild_context"
      })
    );
  });

  it("classifies workspace path escapes as policy breaches instead of retryable context failures", () => {
    expect(classify({
      error_message: 'Context path "../secret.txt" must be a relative path that stays within its repo or workspace root.'
    })).toEqual(
      expect.objectContaining({
        class: "policy_breach",
        retryable: false,
        recommended_action: "pause_for_human"
      })
    );
  });

  it("classifies harness readiness errors as harness failures", () => {
    expect(classify({ error_message: 'codex-cli harness binary "codex" is unavailable.' })).toEqual(
      expect.objectContaining({
        class: "harness",
        recommended_action: "pause_for_human"
      })
    );
  });

  it("classifies timeouts as timeout failures", () => {
    expect(classify({ result: { status: "failed", outcome: "failed", result: { timed_out: true } } as RuntimeNodeExecutionResult })).toEqual(
      expect.objectContaining({
        class: "timeout",
        recommended_action: "retry_with_guidance"
      })
    );
  });

  it("classifies failed deterministic checks as deterministic evaluation failures", () => {
    const node: CompiledCheckNode = {
      ...baseNode,
      kind: "check",
      check_kind: "deterministic",
      on_failure: "fail",
      command: "npm",
      args: ["test"]
    };

    expect(classify({ node })).toEqual(
      expect.objectContaining({
        class: "deterministic_evaluation",
        recommended_action: "retry_with_guidance"
      })
    );
  });

  it("classifies semantic scope drift below threshold as scope drift", () => {
    const node: CompiledCheckNode = {
      ...baseNode,
      kind: "check",
      check_kind: "ai",
      on_failure: "fail",
      goal: "Evaluate scope."
    };

    expect(
      classify({
        node,
        result: {
          status: "failed",
          outcome: "failed",
          result: {
            scope_drift: {
              score: 0.4,
              summary: "Out of scope."
            }
          }
        } as RuntimeNodeExecutionResult
      })
    ).toEqual(
      expect.objectContaining({
        class: "scope_drift",
        recommended_action: "pause_for_human"
      })
    );
  });
});
