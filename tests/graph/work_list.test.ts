import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";

const TEST_INTENT = {
  goal: "Deliver a bounded list of accountable work.",
  acceptance_criteria: ["The managed work-list pattern plans, freezes, executes, verifies, and publishes stable handoffs."]
};

function buildPatternStep(overrides = {}) {
  return {
    type: "pattern_work_list",
    id: "deliver_stack",
    runtime: {
      repo: "main",
      profile: "default"
    },
    intent: {
      goal: "Deliver the bounded work needed for the stack.",
      acceptance_criteria: [
        "The work list is frozen before execution starts.",
        "Every completed item has evidence and validation.",
        "The final handoff includes downstream constraints."
      ],
      constraints: ["Do not add unrelated cleanup."]
    },
    work_list: {
      planning_goal: "Discover the ordered work items needed to satisfy this node contract.",
      item_guidance: {
        what_counts_as_one_item: "One coherent reviewable unit of work with its own evidence handoff.",
        done_when: [
          "The item goal is satisfied.",
          "Relevant validation has been run or clearly explained.",
          "The item result records evidence, risks, and downstream implications."
        ]
      },
      item_worker: {
        kind: "agent"
      }
    },
    ...overrides
  };
}

function buildDocument(steps: unknown[]) {
  return {
    version: "1",
    graph_id: "pattern-work-list-test",
    intent: TEST_INTENT,
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
        harness: "codex-cli",
        sandbox: "read-only"
      },
      supervisor: {
        harness: "codex-cli",
        sandbox: "read-only"
      }
    },
    supervision: {
      profile: "supervisor",
      max_total_interventions: 3
    },
    graph: {
      type: "sequence",
      id: "root",
      steps
    }
  };
}

describe("pattern work list", () => {
  it("lowers an agent item worker into plan, freeze, run, and deterministic finalization phases", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([buildPatternStep()])));
    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "deliver_stack",
        managed_kind: "pattern_work_list",
        lowered_to: "sequence"
      }
    ]);

    const root = normalized.document?.graph;
    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }
    const workflow = root.steps[0];
    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_work_list to lower into a sequence workflow.");
    }

    expect(workflow.steps.map((step) => step.id)).toEqual([
      "deliver_stack__managed__pattern_work_list__plan",
      "deliver_stack__managed__pattern_work_list__freeze",
      "deliver_stack__managed__pattern_work_list__run_items",
      "deliver_stack"
    ]);

    const planNode = workflow.steps[0];
    const freezeNode = workflow.steps[1];
    const runItemsNode = workflow.steps[2];
    const finalizeNode = workflow.steps[3];
    const planPrompt = JSON.stringify(planNode);
    const runPrompt = JSON.stringify(runItemsNode);

    expect(planNode).toEqual(expect.objectContaining({
      type: "agent",
      id: "deliver_stack__managed__pattern_work_list__plan",
      managed_runtime: expect.objectContaining({
        kind: "pattern_work_list",
        root_id: "deliver_stack",
        phase: "plan"
      }),
      artifacts: expect.objectContaining({
        work_list_json: expect.objectContaining({ path: "work-list.json" })
      })
    }));
    expect(planNode.artifacts).not.toHaveProperty("work_list_md");
    expect(planPrompt).toContain("runtime will freeze this list before execution");
    expect(planPrompt).toContain("Do not run or log implementation validation as blocked during planning");
    expect(planPrompt).toContain("Use sequential ids starting at `w1`");
    expect(planPrompt).toContain("planning_summary");
    expect(planPrompt).toContain("ordering_rationale");
    expect(planPrompt).not.toContain("managed work-list pattern");
    expect(planPrompt).not.toContain("managed node");
    expect(planPrompt).not.toContain("runtime coordinator");

    expect(freezeNode).toEqual(expect.objectContaining({
      type: "exec",
      command: "node",
      artifacts: expect.objectContaining({
        frozen_work_list: expect.objectContaining({ path: "work-list-frozen.json" }),
        work_list_ledger: expect.objectContaining({ path: "work-list-ledger.json" })
      })
    }));
    expect(JSON.stringify(freezeNode)).toContain("must use sequential id");

    expect(runItemsNode).toEqual(expect.objectContaining({
      type: "agent",
      managed_runtime: expect.objectContaining({
        kind: "pattern_work_list",
        root_id: "deliver_stack",
        phase: "run_items",
        config: expect.objectContaining({
          parent_intent: expect.objectContaining({
            goal: "Deliver the bounded work needed for the stack."
          }),
          item_worker: { kind: "agent" }
        })
      }),
      artifacts: expect.objectContaining({
        item_results: expect.objectContaining({ path: "item-results.json" })
      })
    }));
    expect(runItemsNode.artifacts).not.toHaveProperty("item_handoffs");
    expect(runItemsNode.artifacts).not.toHaveProperty("item_validation");
    expect(runPrompt).toContain("Worker kind: agent.");
    expect(runPrompt).toContain("owns item status and aggregation");
    expect(runPrompt).toContain("Do not add, remove, split, merge, or reorder");
    expect(runPrompt).toContain("writes one structured item result artifact");
    expect(runPrompt).not.toContain("runtime coordinator");
    expect(runPrompt).not.toContain("managed work-list pattern");
    expect(runPrompt).not.toContain("internal item attempts");

    expect(finalizeNode).toEqual(expect.objectContaining({
      id: "deliver_stack",
      type: "exec",
      command: "node",
      artifacts: expect.objectContaining({
        work_items: expect.objectContaining({ path: "work-items.json" })
      })
    }));
    expect(finalizeNode.artifacts).not.toHaveProperty("summary");
    expect(JSON.stringify(finalizeNode)).toContain("not completed");
  });

  it("supports a deep_work item worker with item-result and ledger rubric evidence", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep({
        work_list: {
          planning_goal: "Discover the ordered work items needed to satisfy this node contract.",
          item_guidance: {
            what_counts_as_one_item: "One coherent reviewable unit of work with its own evidence handoff.",
            done_when: ["The item is complete with validation evidence."]
          },
          item_worker: {
            kind: "deep_work",
            completion: {
              max_cycles: 2,
              pass_threshold: 0.9,
              criteria: [
                {
                  id: "item_contract",
                  kind: "rubric",
                  target: "workspace",
                  rubric: "The item satisfies its frozen contract.",
                  weight: 0.5,
                  required: true
                },
                {
                  id: "handoff_quality",
                  kind: "rubric",
                  target: "item_handoff",
                  rubric: "The item result cites evidence and risks.",
                  weight: 0.3
                },
                {
                  id: "ledger_integrity",
                  kind: "rubric",
                  target: "work_list_ledger",
                  rubric: "The ledger reflects the frozen item state.",
                  weight: 0.2
                }
              ]
            }
          }
        }
      })
    ])));
    expect(normalized.diagnostics).toEqual([]);
    const root = normalized.document?.graph;
    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }
    const workflow = root.steps[0];
    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_work_list to lower into a sequence workflow.");
    }
    const runItemsNode = workflow.steps[2];
    expect(runItemsNode).toEqual(expect.objectContaining({
      type: "agent",
      id: "deliver_stack__managed__pattern_work_list__run_items",
      managed_runtime: expect.objectContaining({
        kind: "pattern_work_list",
        root_id: "deliver_stack",
        phase: "run_items",
        config: expect.objectContaining({
          parent_intent: expect.objectContaining({
            goal: "Deliver the bounded work needed for the stack."
          }),
          item_worker: expect.objectContaining({
            kind: "deep_work",
            completion: expect.objectContaining({
              max_cycles: 2,
              pass_threshold: 0.9,
              criteria: expect.arrayContaining([
                expect.objectContaining({ id: "item_contract", target: "workspace" }),
                expect.objectContaining({ id: "handoff_quality", target: "item_handoff" }),
                expect.objectContaining({ id: "ledger_integrity", target: "work_list_ledger" })
              ])
            })
          })
        })
      }),
      artifacts: expect.objectContaining({
        item_results: expect.objectContaining({ path: "item-results.json" })
      })
    }));
    expect(runItemsNode.artifacts).not.toHaveProperty("item_handoffs");
    expect(runItemsNode.artifacts).not.toHaveProperty("item_validation");
    const prompt = JSON.stringify(runItemsNode);
    expect(prompt).toContain("Worker kind: deep_work.");
    expect(prompt).toContain("Maximum item cycles: 2");
    expect(prompt).toContain("Pass threshold for each item gate: 0.9");
    expect(prompt).toContain("target item_handoff");
    expect(prompt).toContain("target work_list_ledger");
    expect(workflow.steps.map((step) => step.id)).not.toContain("deliver_stack__managed__pattern_work_list__completion_gate");
  });

  it("keeps the work-list publisher only for explicitly authored final artifacts", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep({
        artifacts: {
          summary: {
            from: "output_dir",
            path: "summary.md",
            description: "Human-readable summary explicitly requested by this graph."
          }
        }
      })
    ])));
    expect(normalized.diagnostics).toEqual([]);
    const root = normalized.document?.graph;
    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }
    const workflow = root.steps[0];
    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_work_list to lower into a sequence workflow.");
    }

    expect(workflow.steps.map((step) => step.id)).toEqual([
      "deliver_stack__managed__pattern_work_list__plan",
      "deliver_stack__managed__pattern_work_list__freeze",
      "deliver_stack__managed__pattern_work_list__run_items",
      "deliver_stack__managed__pattern_work_list__finalize",
      "deliver_stack"
    ]);
    const finalizeNode = workflow.steps[3];
    const publishNode = workflow.steps[4];
    expect(finalizeNode).toEqual(expect.objectContaining({
      type: "exec",
      artifacts: {
        work_items: expect.objectContaining({ path: "work-items.json" })
      }
    }));
    expect(publishNode).toEqual(expect.objectContaining({
      id: "deliver_stack",
      type: "agent",
      artifacts: expect.objectContaining({
        summary: expect.objectContaining({ path: "summary.md" }),
        work_items: expect.objectContaining({ path: "work-items.json" })
      }),
      managed_artifact_forwards: {
        work_items: {
          node: "deliver_stack__managed__pattern_work_list__finalize",
          artifact: "work_items"
        }
      }
    }));
    expect(JSON.stringify(publishNode)).toContain("Write only user-authored final artifacts");
  });

  it("carries deep_work item phase overrides in the managed runtime config", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep({
        work_list: {
          planning_goal: "Discover the ordered work items needed to satisfy this node contract.",
          item_guidance: {
            what_counts_as_one_item: "One coherent reviewable unit of work with its own evidence handoff.",
            done_when: ["The item is complete with validation evidence."]
          },
          item_worker: {
            kind: "deep_work",
            phases: {
              plan: {
                intent: {
                  goal: "Map item evidence before implementation."
                },
                model: "planner-model"
              },
              execute: {
                intent: {
                  goal: "Apply only the planned item delta."
                },
                reasoning_effort: "high"
              },
              verify: {
                intent: {
                  goal: "Check item evidence against the rubric."
                },
                sandbox: "read-only"
              },
              publish: {
                intent: {
                  goal: "Publish only accepted item evidence."
                }
              }
            },
            completion: {
              max_cycles: 2,
              pass_threshold: 1,
              criteria: [
                {
                  id: "item_contract",
                  kind: "rubric",
                  target: "workspace",
                  rubric: "The item satisfies its frozen contract.",
                  weight: 1,
                  required: true
                }
              ]
            }
          }
        }
      })
    ])));
    expect(normalized.diagnostics).toEqual([]);
    const root = normalized.document?.graph;
    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }
    const workflow = root.steps[0];
    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_work_list to lower into a sequence workflow.");
    }
    const runItemsNode = workflow.steps[2];
    expect(runItemsNode).toEqual(expect.objectContaining({
      type: "agent",
      managed_runtime: expect.objectContaining({
        config: expect.objectContaining({
          item_worker: expect.objectContaining({
            kind: "deep_work",
            phases: expect.objectContaining({
              plan: expect.objectContaining({
                intent: expect.objectContaining({ goal: "Map item evidence before implementation." }),
                model: "planner-model"
              }),
              execute: expect.objectContaining({
                intent: expect.objectContaining({ goal: "Apply only the planned item delta." }),
                reasoning_effort: "high"
              }),
              verify: expect.objectContaining({
                intent: expect.objectContaining({ goal: "Check item evidence against the rubric." }),
                sandbox: "read-only"
              }),
              publish: expect.objectContaining({
                intent: expect.objectContaining({ goal: "Publish only accepted item evidence." })
              })
            })
          })
        })
      })
    }));
    const prompt = JSON.stringify(runItemsNode);
    expect(prompt).toContain("Item deep-work phases may add phase-specific intent, support, model, reasoning effort, sandbox, or profile policy.");
  });

  it("rejects phases on agent item workers", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep({
        work_list: {
          planning_goal: "Discover the ordered work items needed to satisfy this node contract.",
          item_guidance: {
            what_counts_as_one_item: "One coherent reviewable unit of work with its own evidence handoff.",
            done_when: ["The item is complete with validation evidence."]
          },
          item_worker: {
            kind: "agent",
            phases: {
              plan: {
                intent: {
                  goal: "This should not be accepted for agent workers."
                }
              }
            }
          }
        }
      })
    ])));
    expect(normalized.diagnostics).toEqual([
      expect.objectContaining({
        path: "$.graph.steps[0].work_list.item_worker.phases",
        message: "Unknown field \"phases\" is not part of the graph contract."
      })
    ]);
  });

  it("rejects stale deep_work item phase fields and phase repo overrides", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep({
        work_list: {
          planning_goal: "Discover the ordered work items needed to satisfy this node contract.",
          item_guidance: {
            what_counts_as_one_item: "One coherent reviewable unit of work with its own evidence handoff.",
            done_when: ["The item is complete with validation evidence."]
          },
          item_worker: {
            kind: "deep_work",
            stages: {},
            directions: "old field",
            validation_focus: "old field",
            phases: {
              inspect: {},
              plan: {
                runtime: {
                  repo: "other"
                }
              }
            },
            completion: {
              max_cycles: 1,
              pass_threshold: 1,
              criteria: [
                {
                  id: "item_contract",
                  kind: "rubric",
                  target: "workspace",
                  rubric: "The item satisfies its frozen contract.",
                  weight: 1,
                  required: true
                }
              ]
            }
          }
        }
      })
    ])));
    expect(normalized.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "$.graph.steps[0].work_list.item_worker.stages",
        message: "Unknown field \"stages\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].work_list.item_worker.directions",
        message: "Unknown field \"directions\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].work_list.item_worker.validation_focus",
        message: "Unknown field \"validation_focus\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].work_list.item_worker.phases.inspect",
        message: "Unknown field \"inspect\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].work_list.item_worker.phases.plan.runtime.repo",
        message: "Unknown field \"repo\" is not part of the graph contract."
      })
    ]));
  });

  it("compiles downstream refs against stable public artifacts only", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep(),
      {
        type: "agent",
        id: "handoff",
        intent: {
          goal: "Summarize the completed work list.",
          acceptance_criteria: ["The handoff uses stable work-list artifacts."],
          constraints: []
        },
        support: {
          context: [
            {
              kind: "artifact",
              ref: "deliver_stack.work_items",
              name: "work_items",
              what: "Stable work item index from the managed work-list node.",
              why: "The handoff must cite completed item outcomes."
            }
          ]
        }
      }
    ])));
    expect(normalized.diagnostics).toEqual([]);
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
    expect(compilation.diagnostics).toEqual([]);
    const compiledGraph = compilation.compiled_graph!;
    expect(compiledGraph.authored_to_compiled.deliver_stack).toEqual([
      "root__deliver_stack__managed__pattern_work_list__workflow__deliver_stack"
    ]);
    expect(compiledGraph.nodes.find((node) => node.authored_id === "deliver_stack")).toEqual(expect.objectContaining({
      lowered_from: "pattern_work_list",
      declared_artifacts: expect.objectContaining({
        work_items: expect.objectContaining({ path: "work-items.json" })
      })
    }));
    expect(compiledGraph.nodes.find((node) => node.authored_id === "handoff")).toEqual(expect.objectContaining({
      deps: ["root__deliver_stack__managed__pattern_work_list__workflow__deliver_stack"]
    }));
  });
});
