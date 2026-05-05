import { describe, expect, it } from "vitest";

import type { CompiledCheckNode, CompiledExecutableNode } from "../../src/graph/compiled.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { RuntimeNodeExecutionResult } from "../../src/runtime/core/engine.js";
import { classifyNodeFailure } from "../../src/supervisor/classifier.js";

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
  intent: {
    goal: "Do work.",
    acceptance_criteria: ["The node satisfies its acceptance criteria."],
    constraints: []
  },
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
    ...(overrides.error_message ? { error_message: overrides.error_message } : {})
  });
}

describe("supervisor failure classifier", () => {
  it("classifies context token budget failures as context contract failures", () => {
    expect(
      classify({
        result: {
          status: "failed",
          outcome: "failed",
          result: {
            error:
              'Materializing context_2 (workspace glob "**/*eval*") match ".venv/noisy-eval.py" would exceed max_total_tokens 100. Current tokens: 99. Next item tokens: 50.'
          },
          stderr:
            'Materializing context_2 (workspace glob "**/*eval*") match ".venv/noisy-eval.py" would exceed max_total_tokens 100. Current tokens: 99. Next item tokens: 50.'
        }
      })
    ).toEqual(
      expect.objectContaining({
        class: "context_contract_failure",
        retryable: true,
        recommended_action: "rebuild_context"
      })
    );
  });

  it("classifies missing declared artifacts as artifact failures", () => {
    expect(classify({ error_message: "Required artifact contract is missing: summary at summary.md" })).toEqual(
      expect.objectContaining({
        class: "artifact_contract_failure",
        retryable: true,
        recommended_action: "repair_artifact",
        gather_plan: expect.objectContaining({
          max_parallel: 2,
          gathers: expect.arrayContaining([
            expect.objectContaining({ kind: "local_context" }),
            expect.objectContaining({ kind: "investigate_failure" })
          ])
        })
      })
    );
    expect(classify({ error_message: 'Required output_dir artifact "implementation_summary" is missing at agent-implementation-summary.md.' })).toEqual(
      expect.objectContaining({
        class: "artifact_contract_failure",
        retryable: true,
        recommended_action: "repair_artifact"
      })
    );
  });

  it("classifies incomplete completion packets as current-node retry failures", () => {
    expect(classify({
      result: {
        status: "failed",
        outcome: "failed",
        result: {
          completion: {
            completion_status: "incomplete",
            blocking_reasons: ["Missing expected artifact: handoff"],
            packet_path: "/tmp/execution/completion-packet.json"
          }
        }
      }
    })).toEqual(
      expect.objectContaining({
        class: "completion_contract_failure",
        retryable: true,
        recommended_action: "retry_with_guidance",
        summary: "Missing expected artifact: handoff",
        evidence: expect.objectContaining({
          completion: expect.objectContaining({
            completion_status: "incomplete",
            packet_path: "/tmp/execution/completion-packet.json"
          })
        })
      })
    );
  });

  it("classifies blocked completion packets as human-authority pauses", () => {
    expect(classify({
      result: {
        status: "failed",
        outcome: "failed",
        result: {
          completion: {
            completion_status: "blocked",
            blocking_reasons: ["Export proof requires operator-managed backend worker."],
            packet_path: "/tmp/execution/completion-packet.json"
          }
        }
      }
    })).toEqual(
      expect.objectContaining({
        class: "operator_pause",
        retryable: false,
        recommended_action: "pause_for_human",
        summary: "Export proof requires operator-managed backend worker."
      })
    );
  });

  it("classifies harness no-op artifact misses as harness failures", () => {
    expect(classify({
      error_message: "Agent harness produced no final response while required declared artifacts are missing: implementation_summary at agent-implementation-summary.md. This is a harness/no-op failure, not an artifact repair candidate."
    })).toEqual(
      expect.objectContaining({
        class: "harness_unavailable",
        retryable: false,
        recommended_action: "pause_for_human"
      })
    );
  });

  it("classifies Cursor authentication failures as harness failures", () => {
    expect(classify({
      result: {
        status: "failed",
        outcome: "failed",
        result: { exit_code: 1 },
        stderr: "Error: Authentication required. Please run 'cursor agent login' first, or set CURSOR_API_KEY environment variable."
      }
    })).toEqual(
      expect.objectContaining({
        class: "harness_unavailable",
        retryable: false,
        recommended_action: "pause_for_human"
      })
    );
  });

  it("classifies Cursor sandbox availability failures as harness failures before completion repair", () => {
    expect(classify({
      result: {
        status: "failed",
        outcome: "failed",
        result: {
          exit_code: 1,
          metadata: {
            error:
              "Cursor CLI structured output failed: stdout was not a JSON object.\nCursor CLI stderr:\nError: Sandbox mode is enabled but not available on this system. Sandbox is unavailable."
          },
          completion: {
            completion_status: "incomplete",
            blocking_reasons: ["Missing expected artifact: mcp_glean_handoff"],
            packet_path: "/tmp/execution/completion-packet.json"
          }
        }
      }
    })).toEqual(
      expect.objectContaining({
        class: "harness_unavailable",
        retryable: false,
        recommended_action: "pause_for_human",
        summary: expect.stringContaining("Sandbox mode is enabled")
      })
    );
  });

  it("classifies workspace pollution as a workspace repair candidate", () => {
    expect(classify({ error_message: "Forbidden edit: unexpected workspace change in docs/generated.md" })).toEqual(
      expect.objectContaining({
        class: "wrong_local_pattern",
        retryable: true,
        recommended_action: "run_diagnostic",
        evidence: expect.objectContaining({
          workspace_repair_candidate: true
        })
      })
    );
  });

  it("classifies transient runtime wrapper failures as environment repair candidates", () => {
    expect(classify({ error_message: "Agentflow tool wrapper failed: command not found" })).toEqual(
      expect.objectContaining({
        class: "harness_unavailable",
        retryable: true,
        recommended_action: "run_diagnostic",
        evidence: expect.objectContaining({
          environment_repair_candidate: true
        })
      })
    );
  });

  it("classifies context resolution errors as context failures", () => {
    expect(classify({ error_message: "Required context item could not be resolved." })).toEqual(
      expect.objectContaining({
        class: "missing_context",
        recommended_action: "rebuild_context",
        gather_plan: expect.objectContaining({
          max_parallel: 2,
          gathers: expect.arrayContaining([
            expect.objectContaining({ kind: "local_context" }),
            expect.objectContaining({ kind: "pattern_mining" })
          ])
        })
      })
    );
  });

  it("classifies workspace path escapes as policy breaches instead of retryable context failures", () => {
    expect(classify({
      error_message: 'Context path "../secret.txt" must be a relative path that stays within its repo or workspace root.'
    })).toEqual(
      expect.objectContaining({
        class: "policy_or_scope_risk",
        retryable: false,
        recommended_action: "pause_for_human"
      })
    );
  });

  it("does not classify incidental context mentions as context-resolution failures", () => {
    expect(classify({ error_message: "Model failed because the context window was exhausted." })).toEqual(
      expect.objectContaining({
        class: "unknown",
        recommended_action: "retry_with_guidance"
      })
    );
  });

  it("uses failed harness stderr when no structured error is available", () => {
    expect(classify({
      result: {
        status: "failed",
        outcome: "failed",
        result: {
          exit_code: 1,
          metadata: {}
        },
        stderr: "operation escapes the workspace\n"
      }
    })).toEqual(
      expect.objectContaining({
        class: "policy_or_scope_risk",
        retryable: false,
        recommended_action: "pause_for_human"
      })
    );
  });

  it("classifies harness readiness errors as harness failures", () => {
    expect(classify({ error_message: 'codex-cli harness binary "codex" is unavailable.' })).toEqual(
      expect.objectContaining({
        class: "harness_unavailable",
        recommended_action: "pause_for_human"
      })
    );
  });

  it("does not classify generic unavailable resources as harness failures", () => {
    expect(classify({ error_message: "Package mirror is temporarily unavailable." })).toEqual(
      expect.objectContaining({
        class: "unknown",
        recommended_action: "retry_with_guidance"
      })
    );
  });

  it("classifies timeouts as diagnostic-needed failures", () => {
    expect(classify({ result: { status: "failed", outcome: "failed", result: { timed_out: true } } as RuntimeNodeExecutionResult })).toEqual(
      expect.objectContaining({
        class: "diagnostic_needed",
        recommended_action: "run_diagnostic",
        gather_plan: expect.objectContaining({
          gathers: expect.arrayContaining([
            expect.objectContaining({ kind: "diagnostic_probe" })
          ])
        })
      })
    );
  });

  it("classifies failed deterministic checks as diagnostic-needed failures", () => {
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
        class: "diagnostic_needed",
        recommended_action: "run_diagnostic"
      })
    );
  });

  it("classifies generic AI check failures as semantic misalignment", () => {
    const node: CompiledCheckNode = {
      ...baseNode,
      kind: "check",
      check_kind: "ai",
      on_failure: "fail",
      intent: {
        goal: "Evaluate whether the implementation satisfies the rubric.",
        acceptance_criteria: ["The node satisfies its acceptance criteria."],
        constraints: []
      },
    };

    expect(classify({
      node,
      error_message: "AI evaluator returned a failing judgment."
    })).toEqual(
      expect.objectContaining({
        class: "semantic_misalignment",
        recommended_action: "semantic_evaluation",
        gather_plan: expect.objectContaining({
          gathers: expect.arrayContaining([
            expect.objectContaining({ kind: "semantic_rejudge" })
          ])
        })
      })
    );
  });

  it("classifies semantic scope drift below threshold as policy or scope risk", () => {
    const node: CompiledCheckNode = {
      ...baseNode,
      kind: "check",
      check_kind: "ai",
      on_failure: "fail",
      intent: {
        goal: "Evaluate scope.",
        acceptance_criteria: ["The node satisfies its acceptance criteria."],
        constraints: []
      },
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
        class: "policy_or_scope_risk",
        recommended_action: "pause_for_human"
      })
    );
  });

  it("classifies outcome verifier failures as semantic misalignment with semantic rejudge evidence", () => {
    const result: RuntimeNodeExecutionResult = {
      status: "passed",
      outcome: "failed",
      result: {
        outcome_verification: {
          passed: false,
          summary: "Verifier rejected the agent attempt because the rubric is unmet.",
          findings: [
            {
              severity: "blocker",
              category: "incorrect_output",
              evidence: "agent claims success but the failing test still fails.",
              recommendation: "Fix the function so the test suite passes."
            },
            {
              severity: "high",
              category: "missing_evidence",
              evidence: "no captured test run.",
              recommendation: "Run the test suite and capture the output."
            }
          ],
          blockers: [
            {
              severity: "blocker",
              category: "incorrect_output",
              evidence: "agent claims success but the failing test still fails.",
              recommendation: "Fix the function so the test suite passes."
            }
          ],
          verifier_metadata: {
            harness: "codex-cli",
            duration_ms: 1234,
            prompt_path: "/tmp/execution/verify-outcome.prompt.md",
            response_path: "/tmp/execution/verify-outcome.raw-response.md",
            attempt_count: 1,
            truncated_artifacts: [],
            workspace_diff_status: "captured",
            parse_status: "ok"
          }
        }
      }
    };

    const classification = classify({ result });

    expect(classification).toEqual(
      expect.objectContaining({
        class: "semantic_misalignment",
        retryable: true,
        recommended_action: "semantic_evaluation",
        summary: "Verifier rejected the agent attempt because the rubric is unmet.",
        gather_plan: expect.objectContaining({
          max_parallel: 3,
          gathers: expect.arrayContaining([
            expect.objectContaining({ kind: "semantic_rejudge" }),
            expect.objectContaining({ kind: "local_context" })
          ])
        })
      })
    );
    expect(classification.evidence).toEqual(
      expect.objectContaining({
        outcome_verification: expect.objectContaining({
          findings: expect.arrayContaining([
            expect.objectContaining({ category: "incorrect_output" }),
            expect.objectContaining({ category: "missing_evidence" })
          ]),
          blockers: expect.arrayContaining([
            expect.objectContaining({ category: "incorrect_output" })
          ])
        })
      })
    );
  });

  it("ignores an outcome_verification payload that says the verifier passed", () => {
    const result: RuntimeNodeExecutionResult = {
      status: "passed",
      outcome: "failed",
      result: {
        outcome_verification: {
          passed: true,
          summary: "Verifier accepted, but the node still failed for an unrelated reason.",
          findings: [],
          blockers: [],
          verifier_metadata: {
            harness: "codex-cli",
            duration_ms: 1234,
            prompt_path: "/tmp/execution/verify-outcome.prompt.md",
            response_path: "/tmp/execution/verify-outcome.raw-response.md",
            attempt_count: 1,
            truncated_artifacts: [],
            workspace_diff_status: "captured",
            parse_status: "ok"
          }
        }
      },
      stderr: "operation escapes the workspace\n"
    };

    expect(classify({ result }).class).not.toBe("outcome_verification");
  });

  it("classifies checkpoint failures as operator decisions that need human pause handling", () => {
    const node: CompiledExecutableNode = {
      ...baseNode,
      kind: "checkpoint",
      review_from: {
        node: "draft",
        artifact: "draft_spec"
      }
    };

    expect(classify({
      node,
      error_message: "Operator denied the checkpoint."
    })).toEqual(
      expect.objectContaining({
        class: "operator_pause",
        retryable: false,
        recommended_action: "pause_for_human"
      })
    );
  });

  it("classifies dependency documentation gaps into external and metadata gathers", () => {
    expect(classify({
      error_message: "Build failed because the zod v4 API changed; missing dependency docs for package zod."
    })).toEqual(
      expect.objectContaining({
        class: "missing_dependency_docs",
        recommended_action: "rebuild_context",
        gather_plan: expect.objectContaining({
          max_parallel: 2,
          gathers: expect.arrayContaining([
            expect.objectContaining({ kind: "dependency_metadata" }),
            expect.objectContaining({ kind: "external_context" })
          ])
        })
      })
    );
  });

  it("escalates repeated same-fingerprint failures to stronger parallel gathers", () => {
    expect(classifyNodeFailure({
      node: baseNode,
      attempt: {
        ...baseAttempt,
        attempt_index: 3
      },
      error_message: "Required context item could not be resolved.",
      repeated_fingerprint_count: 2
    })).toEqual(
      expect.objectContaining({
        class: "repeated_failure",
        recommended_action: "run_diagnostic",
        gather_plan: expect.objectContaining({
          max_parallel: 4,
          gathers: expect.arrayContaining([
            expect.objectContaining({ kind: "local_context" }),
            expect.objectContaining({ kind: "diagnostic_probe" }),
            expect.objectContaining({ kind: "semantic_rejudge" }),
            expect.objectContaining({ kind: "external_context" })
          ])
        })
      })
    );
  });

  it("classifies explicitly non-recoverable failures without evidence gathers", () => {
    expect(classify({
      error_message: "Non-recoverable graph contract violation: declared artifact target is impossible without changing graph intent."
    })).toEqual(
      expect.objectContaining({
        class: "non_recoverable",
        retryable: false,
        recommended_action: "fail",
        gather_plan: expect.objectContaining({
          max_parallel: 0,
          gathers: []
        })
      })
    );
  });
});
