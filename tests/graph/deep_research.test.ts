import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";

describe("deep research managed workflow", () => {
  it("lowers deep_research into a generated workflow with fan-out and reduction rounds", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "deep-research-lowering",
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
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "deep_research",
            id: "market_scan",
            repo: "main",
            profile: "default",
            question: "How should Agentflow design deep research?",
            objective: "Produce a design recommendation for the first managed workflow.",
            orchestration: {
              track_count: 5,
              max_parallel_tracks: 4,
              summary_fan_in: 2
            },
            deliverable: {
              sections: ["patterns", "tradeoffs", "recommendation"]
            }
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "market_scan",
        managed_kind: "deep_research",
        lowered_to: "agent"
      }
    ]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected deep_research to lower into a sequence workflow.");
    }

    expect(workflow.id).toBe("market_scan__managed__deep_research__workflow");
    expect(workflow.steps.map((step) => step.id)).toEqual([
      "market_scan__managed__deep_research__clarify",
      "market_scan__managed__deep_research__plan",
      "market_scan__managed__deep_research__generate_tracks",
      "market_scan__managed__deep_research__track_fanout",
      "market_scan__managed__deep_research__contradiction_scan",
      "market_scan__managed__deep_research__reduce_round_1",
      "market_scan__managed__deep_research__reduce_round_2",
      "market_scan__managed__deep_research__reduce_round_3",
      "market_scan"
    ]);

    const trackFanout = workflow.steps[3];
    const reduceRoundOne = workflow.steps[5];

    if (!trackFanout || trackFanout.type !== "parallel") {
      throw new Error("Expected track fanout to be a parallel scope.");
    }

    if (!reduceRoundOne || reduceRoundOne.type !== "parallel") {
      throw new Error("Expected first reduction round to be a parallel scope.");
    }

    expect(trackFanout.max_concurrency).toBe(4);
    expect(trackFanout.steps).toHaveLength(5);
    expect(trackFanout.steps[0]).toEqual(
      expect.objectContaining({
        id: "market_scan__managed__deep_research__track_01",
        type: "agent"
      })
    );
    expect(reduceRoundOne.steps).toHaveLength(3);
    expect(workflow.steps.at(-1)).toEqual(
      expect.objectContaining({
        id: "market_scan",
        type: "agent",
        outputs: expect.arrayContaining([
          expect.objectContaining({
            name: "research_report",
            path: "final-report.md"
          })
        ])
      })
    );
  });

  it("compiles deep_research so downstream nodes can depend on the final synthesized result", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "deep-research-compile",
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
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "deep_research",
            id: "market_scan",
            question: "How should Agentflow design deep research?",
            objective: "Produce a design recommendation for the first managed workflow.",
            orchestration: {
              track_count: 4,
              max_parallel_tracks: 2,
              summary_fan_in: 2
            }
          },
          {
            type: "agent",
            id: "handoff",
            prompt: "Summarize the research recommendation for an engineer.",
            context_from: [
              {
                node: "market_scan",
                include: "summary"
              },
              {
                node: "market_scan",
                include: "output",
                output: "research_report"
              }
            ]
          }
        ]
      }
    });

    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(
      normalized.document!,
      launch,
      normalized.lowered_managed_nodes
    );

    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.compiled_graph).toBeDefined();

    const compiledGraph = compilation.compiled_graph!;
    const finalResearchNode = compiledGraph.nodes.find((node) => node.authored_id === "market_scan");
    const handoffNode = compiledGraph.nodes.find((node) => node.authored_id === "handoff");
    const trackScope = compiledGraph.scopes.find(
      (scope) => scope.authored_id === "market_scan__managed__deep_research__track_fanout"
    );

    expect(compiledGraph.authored_to_compiled.market_scan).toEqual([
      "root__market_scan__managed__deep_research__workflow__market_scan"
    ]);
    expect(finalResearchNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        lowered_from: "deep_research",
        compiled_id: "root__market_scan__managed__deep_research__workflow__market_scan"
      })
    );
    expect(trackScope).toEqual(
      expect.objectContaining({
        kind: "parallel",
        max_concurrency: 2
      })
    );
    expect(handoffNode).toEqual(
      expect.objectContaining({
        deps: ["root__market_scan__managed__deep_research__workflow__market_scan"]
      })
    );
  });

  it("omits the final critique gate when orchestration disables it", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "deep-research-no-critique",
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
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "deep_research",
            id: "market_scan",
            question: "How should Agentflow design deep research?",
            objective: "Produce a design recommendation for the first managed workflow.",
            orchestration: {
              track_count: 3,
              max_parallel_tracks: 2,
              summary_fan_in: 2,
              final_critique: false
            }
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected deep_research to lower into a sequence workflow.");
    }

    expect(workflow.steps.map((step) => step.id)).not.toContain(
      "market_scan__managed__deep_research__final_critique"
    );
  });
});
