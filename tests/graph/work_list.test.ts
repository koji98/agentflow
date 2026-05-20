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
          "The item handoff records evidence, risks, and downstream implications."
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
  it("lowers an agent item worker into plan, freeze, run, verify, and publish phases", () => {
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
      "deliver_stack__managed__pattern_work_list__finalize",
      "deliver_stack"
    ]);

    const planNode = workflow.steps[0];
    const freezeNode = workflow.steps[1];
    const runItemsNode = workflow.steps[2];
    const finalizeNode = workflow.steps[3];
    const publishNode = workflow.steps[4];
    const planPrompt = JSON.stringify(planNode);
    const runPrompt = JSON.stringify(runItemsNode);
    const publishPrompt = JSON.stringify(publishNode);

    expect(planNode).toEqual(expect.objectContaining({
      type: "agent",
      id: "deliver_stack__managed__pattern_work_list__plan",
      artifacts: expect.objectContaining({
        work_list_md: expect.objectContaining({ path: "work-list.md" }),
        work_list_json: expect.objectContaining({ path: "work-list.json" })
      })
    }));
    expect(planPrompt).toContain("runtime will freeze this list before execution");
    expect(planPrompt).toContain("Use sequential ids starting at `w1`");

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
      artifacts: expect.objectContaining({
        item_handoffs: expect.objectContaining({ path: "item-handoffs.md" }),
        item_results: expect.objectContaining({ path: "item-results.json" }),
        item_validation: expect.objectContaining({ path: "item-validation.md" })
      })
    }));
    expect(runPrompt).toContain("Worker kind: agent.");
    expect(runPrompt).toContain("runtime owns item status");
    expect(runPrompt).toContain("Do not add, remove, split, merge, or reorder");

    expect(finalizeNode).toEqual(expect.objectContaining({
      type: "exec",
      command: "node",
      artifacts: expect.objectContaining({
        work_items: expect.objectContaining({ path: "work-items.json" })
      })
    }));
    expect(JSON.stringify(finalizeNode)).toContain("not completed");

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
    expect(publishPrompt).toContain("stable artifacts, not the internal item attempts");
    expect(publishPrompt).toContain("The `work_items` artifact is forwarded by the runtime");
    expect(publishPrompt).not.toContain("The `packet` artifact");
  });

  it("supports a deep_work item worker with item handoff and ledger rubric targets", () => {
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
                  rubric: "The item handoff cites evidence and risks.",
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
    const workLoop = workflow.steps[2];
    expect(workLoop).toEqual(expect.objectContaining({
      type: "repeat",
      id: "deliver_stack__managed__pattern_work_list__work_loop",
      max_attempts: 2,
      until: {
        node: "deliver_stack__managed__pattern_work_list__completion_gate"
      }
    }));
    if (!workLoop || workLoop.type !== "repeat" || workLoop.body.type !== "sequence") {
      throw new Error("Expected deep_work item worker to lower into a repeat loop.");
    }
    const runItemsNode = workLoop.body.steps[0];
    const criteriaPanel = workLoop.body.steps[1];
    const gateNode = workLoop.body.steps[2];
    const prompt = JSON.stringify(workLoop);
    expect(criteriaPanel).toEqual(expect.objectContaining({
      type: "parallel",
      id: "deliver_stack__managed__pattern_work_list__criteria_panel"
    }));
    expect(gateNode).toEqual(expect.objectContaining({
      type: "check",
      id: "deliver_stack__managed__pattern_work_list__completion_gate",
      check_kind: "deterministic",
      artifacts: expect.objectContaining({
        work_list_scorecard: expect.objectContaining({ path: "scorecard.json" })
      })
    }));
    expect(prompt).toContain("Worker kind: deep_work.");
    expect(prompt).toContain("Maximum frozen-list cycles: 2");
    expect(prompt).toContain("target item_handoff");
    expect(prompt).toContain("target work_list_ledger");
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
