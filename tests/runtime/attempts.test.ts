import { describe, expect, it } from "vitest";

import type { CompiledExecNode } from "../../src/graph/compiled.js";
import {
  buildExecutionId,
  closeNodeAttempt,
  createAttemptRegistry,
  latestOutcomeForIteration,
  listAttemptsForCompiledNode,
  openNodeAttempt,
  peekNextAttemptIndex,
  selectAttempt
} from "../../src/runtime/attempts.js";

const execNode: CompiledExecNode = {
  compiled_id: "root__task",
  authored_id: "task",
  kind: "exec",
  repo: "main",
  deps: [],
  scope_stack: ["scope__root"],
  effective_policy: {
    profile_name: "default",
    workspace_backend: "inplace",
    timeout_sec: 30,
    input_rules: {
      max_files: 4,
      max_total_bytes: 4096,
      max_bytes_per_item: 1024
    }
  },
  inputs: [],
  context_from: [],
  declared_outputs: [],
  command: "true",
  args: []
};

describe("runtime attempts", () => {
  it("builds stable execution ids and increments attempt indexes across repeat iterations", () => {
    const registry = createAttemptRegistry();

    expect(buildExecutionId(execNode.compiled_id, 1)).toBe("exec__root__task__attempt_1");
    expect(buildExecutionId(execNode.compiled_id, 1, {
      repeat_scope_id: "scope__retry"
    })).toBe("exec__root__task__attempt_1");
    expect(buildExecutionId(execNode.compiled_id, 1, {
      iteration_index: 2
    })).toBe("exec__root__task__attempt_1");
    expect(buildExecutionId(execNode.compiled_id, 2, {
      repeat_scope_id: "scope__retry",
      iteration_index: 3
    })).toBe("exec__root__task__attempt_2__repeat_scope__retry__iter_3");

    expect(peekNextAttemptIndex(registry, execNode.compiled_id)).toBe(1);

    const first = openNodeAttempt(registry, execNode, "/tmp/attempt-1", {
      repeat_scope_id: "scope__retry",
      iteration_index: 1
    });
    closeNodeAttempt(registry, first.execution_id, {
      status: "failed",
      outcome: "failed",
      result_path: "/tmp/result-1.json"
    });

    const second = openNodeAttempt(registry, execNode, "/tmp/attempt-2", {
      repeat_scope_id: "scope__retry",
      iteration_index: 2
    });
    closeNodeAttempt(registry, second.execution_id, {
      status: "failed",
      outcome: "failed",
      result_path: "/tmp/result-2.json"
    });

    const third = openNodeAttempt(registry, execNode, "/tmp/attempt-3", {
      repeat_scope_id: "scope__retry",
      iteration_index: 2
    });
    closeNodeAttempt(registry, third.execution_id, {
      status: "passed",
      outcome: "passed",
      result_path: "/tmp/result-3.json",
      output_artifacts: {
        report: "/tmp/report-3.md"
      }
    });

    expect(peekNextAttemptIndex(registry, execNode.compiled_id)).toBe(4);
    expect(listAttemptsForCompiledNode(registry, execNode.compiled_id).map((attempt) => ({
      execution_id: attempt.execution_id,
      attempt_index: attempt.attempt_index,
      iteration_index: attempt.iteration_index,
      outcome: attempt.outcome
    }))).toEqual([
      {
        execution_id: first.execution_id,
        attempt_index: 1,
        iteration_index: 1,
        outcome: "failed"
      },
      {
        execution_id: second.execution_id,
        attempt_index: 2,
        iteration_index: 2,
        outcome: "failed"
      },
      {
        execution_id: third.execution_id,
        attempt_index: 3,
        iteration_index: 2,
        outcome: "passed"
      }
    ]);
  });

  it("selects attempts by global attempt id and latest outcome within an iteration", () => {
    const registry = createAttemptRegistry();
    const attempts = [
      {
        status: "failed" as const,
        outcome: "failed" as const,
        iteration_index: 1
      },
      {
        status: "failed" as const,
        outcome: "failed" as const,
        iteration_index: 2
      },
      {
        status: "passed" as const,
        outcome: "passed" as const,
        iteration_index: 2
      }
    ].map((update, index) => {
      const attempt = openNodeAttempt(registry, execNode, `/tmp/select-${index + 1}`, {
        repeat_scope_id: "scope__retry",
        iteration_index: update.iteration_index
      });

      return closeNodeAttempt(registry, attempt.execution_id, {
        status: update.status,
        outcome: update.outcome,
        result_path: `/tmp/select-${index + 1}.json`
      });
    });

    expect(selectAttempt(attempts, "latest")?.execution_id).toBe(attempts[2]?.execution_id);
    expect(selectAttempt(attempts, "latest_failed")?.execution_id).toBe(attempts[1]?.execution_id);
    expect(selectAttempt(attempts, "latest_passed")?.execution_id).toBe(attempts[2]?.execution_id);
    expect(selectAttempt(attempts, 2)?.execution_id).toBe(attempts[1]?.execution_id);
    expect(latestOutcomeForIteration(registry, execNode.compiled_id, 1)).toBe("failed");
    expect(latestOutcomeForIteration(registry, execNode.compiled_id, 2)).toBe("passed");
    expect(latestOutcomeForIteration(registry, execNode.compiled_id, 3)).toBeUndefined();
  });
});
