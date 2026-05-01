import { describe, expect, it } from "vitest";

import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";
import {
  buildSchedulerTopology,
  createReadyNodeKey,
  getIncomingEdges,
  getNodeParallelScopes,
  getOutgoingEdges,
  getRepeatScopeForBodyEntryNode,
  isRepeatBodyEntryNode
} from "../../src/runtime/core/scheduler.js";
import { createRuntimeEvent } from "../../src/runtime/core/events.js";
import { createRuntimeSession } from "../../src/runtime/core/state.js";

const TEST_INTENT = {
  goal: "Exercise scheduler topology for supervised graph execution.",
  acceptance_criteria: ["Scheduler topology preserves sequence, parallel, and repeat flow edges."]
};

function compileGraph(document: AuthoredGraphDocument) {
  const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults({
    intent: TEST_INTENT,
    ...document
  }));
  expect(normalized.diagnostics).toEqual([]);

  const launch = resolveLaunchConfig(normalized.document!);
  const compilation = compileAuthoredGraph(
    normalized.document!,
    launch,
    normalized.lowered_managed_nodes
  );

  expect(compilation.diagnostics).toEqual([]);
  expect(compilation.compiled_graph).toBeDefined();
  return compilation.compiled_graph!;
}

describe("runtime scheduler topology", () => {
  it("indexes repeat entry nodes, parallel ancestry, and flow edges deterministically", () => {
    const graph = compileGraph({
      version: "1",
      graph_id: "scheduler-topology",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {
          harness: "codex-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "parallel",
            id: "outer",
            max_concurrency: 2,
            steps: [
              {
                type: "exec",
                id: "a",
                command: "placeholder"
              },
              {
                type: "sequence",
                id: "branch",
                steps: [
                  {
                    type: "parallel",
                    id: "inner",
                    max_concurrency: 1,
                    steps: [
                      {
                        type: "exec",
                        id: "b",
                        command: "placeholder"
                      },
                      {
                        type: "exec",
                        id: "c",
                        command: "placeholder"
                      }
                    ]
                  },
                  {
                    type: "repeat",
                    id: "retry",
                    max_attempts: 2,
                    body: {
                      type: "sequence",
                      id: "body",
                      steps: [
                        {
                          type: "exec",
                          id: "repair",
                          command: "placeholder"
                        },
                        {
                          type: "check",
                          id: "verify",
                          check_kind: "deterministic",
                          command: "placeholder"
                        }
                      ]
                    },
                    until: {
                      node: "verify"
                    }
                  },
                  {
                    type: "exec",
                    id: "report",
                    command: "placeholder"
                  }
                ]
              }
            ]
          }
        ]
      }
    });

    const topology = buildSchedulerTopology(graph);
    const repeatScopeId = "scope__root__outer__branch__retry";
    const repairId = "root__outer__branch__retry__body__repair";
    const verifyId = "root__outer__branch__retry__body__verify";
    const branchReportId = "root__outer__branch__report";

    expect(getRepeatScopeForBodyEntryNode(topology, repairId)).toBe(repeatScopeId);
    expect(isRepeatBodyEntryNode(topology, repairId, repeatScopeId)).toBe(true);
    expect(isRepeatBodyEntryNode(topology, verifyId, repeatScopeId)).toBe(false);

    expect(getNodeParallelScopes(topology, "root__outer__branch__inner__b").map((scope) => scope.scope_id)).toEqual([
      "scope__root__outer",
      "scope__root__outer__branch__inner"
    ]);
    expect(getNodeParallelScopes(topology, branchReportId).map((scope) => scope.scope_id)).toEqual([
      "scope__root__outer"
    ]);

    expect(getIncomingEdges(topology, branchReportId).map((edge) => edge.from)).toEqual([verifyId]);
    expect(getOutgoingEdges(topology, verifyId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "repeat-back",
          on: "failed",
          to: repairId,
          repeat_scope_id: repeatScopeId
        }),
        expect.objectContaining({
          kind: "flow",
          on: "passed",
          to: branchReportId
        })
      ])
    );
  });

  it("keys ready nodes by compiled id and iteration only", () => {
    expect(createReadyNodeKey({
      compiled_id: "root__task",
      deps_satisfied: ["root__setup"],
      repeat_scope_id: undefined,
      iteration_index: undefined
    })).toBe("root__task::0");
    expect(createReadyNodeKey({
      compiled_id: "root__task",
      deps_satisfied: ["root__setup", "root__other"],
      repeat_scope_id: "scope__retry",
      iteration_index: 2
    })).toBe("root__task::2");
    expect(createReadyNodeKey({
      compiled_id: "root__task",
      deps_satisfied: [],
      repeat_scope_id: "scope__retry",
      iteration_index: 3
    })).toBe("root__task::3");
  });

  it("returns empty topology lookups for unknown compiled ids", () => {
    const graph = compileGraph({
      version: "1",
      graph_id: "scheduler-empty-lookups",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {}
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "only",
            command: "placeholder"
          }
        ]
      }
    });

    const topology = buildSchedulerTopology(graph);

    expect(getIncomingEdges(topology, "missing")).toEqual([]);
    expect(getOutgoingEdges(topology, "missing")).toEqual([]);
    expect(getNodeParallelScopes(topology, "missing")).toEqual([]);
    expect(getRepeatScopeForBodyEntryNode(topology, "missing")).toBeUndefined();
    expect(isRepeatBodyEntryNode(topology, "missing", "scope__missing")).toBe(false);
  });

  it("keeps runtime core event and state barrels executable", () => {
    expect(createRuntimeEvent(1, "run-test", "run.started", {}).run_id).toBe("run-test");
    expect(typeof createRuntimeSession).toBe("function");
  });
});
