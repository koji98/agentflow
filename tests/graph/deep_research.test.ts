import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";

const TEST_INTENT = {
  goal: "Research an accountable technical recommendation.",
  acceptance_criteria: ["The research package explains findings, uncertainty, and recommended action."]
};

function buildDocument(stepOverrides = {}) {
  return {
    version: "1",
    graph_id: "deep-research-test",
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
      steps: [
        {
          type: "pattern_deep_research",
          id: "market_scan",
          repo: "main",
          profile: "default",
          intent: {
            goal: "Produce a grounded recommendation for Agentflow managed pattern design.",
            acceptance_criteria: [
            "The research summary answers all authored angles.",
            "The packet preserves evidence, uncertainty, confidence, and next actions."
          ],
            constraints: ["Do not change the graph contract."]
          },
          research: {
            angles: [
              "Investigate whether the implementation follows established Agentflow architecture.",
              "Identify correctness, maintainability, and rollout risks in the managed pattern design.",
              "Compare whether the public artifact contract is easy for downstream nodes to consume."
            ]
          },
          artifacts: {
            evidence_map: {
              from: "output_dir",
              path: "evidence-map.json",
              description: "Evidence map for the research recommendation."
            }
          },
          ...stepOverrides
        }
      ]
    }
  };
}

describe("deep research managed pattern", () => {
  it("lowers authored angles into a parallel research fanout and public artifact publisher", () => {
    const normalized = normalizeAuthoredGraphDocument(buildDocument());

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "market_scan",
        managed_kind: "pattern_deep_research",
        lowered_to: "sequence"
      }
    ]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_deep_research to lower into a sequence workflow.");
    }

    expect(workflow.id).toBe("market_scan__managed__pattern_deep_research__workflow");
    expect(workflow.steps.map((step) => step.id)).toEqual([
      "market_scan__managed__pattern_deep_research__angle_fanout",
      "market_scan"
    ]);

    const fanout = workflow.steps[0];
    const finalNode = workflow.steps[1];

    if (!fanout || fanout.type !== "parallel") {
      throw new Error("Expected research fanout to be parallel.");
    }

    expect(fanout.max_concurrency).toBe(3);
    expect(fanout.steps.map((step) => step.id)).toEqual([
      "market_scan__managed__pattern_deep_research__angle_01",
      "market_scan__managed__pattern_deep_research__angle_02",
      "market_scan__managed__pattern_deep_research__angle_03"
    ]);
    expect(finalNode).toEqual(
      expect.objectContaining({
        id: "market_scan",
        type: "agent",
        artifacts: expect.objectContaining({
          summary: expect.objectContaining({ path: "summary.md" }),
          packet: expect.objectContaining({ path: "packet.json" }),
          evidence_map: expect.objectContaining({ path: "evidence-map.json" })
        })
      })
    );
  });

  it("adds balanced synthesis layers when more than three angle reports need synthesis", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument({
        research: {
          angles: [
            "Investigate the local architecture and extension points for managed patterns.",
            "Compare managed pattern behavior against the graph authoring contract.",
            "Identify runtime supervision implications for managed pattern internals.",
            "Assess how public artifacts should support downstream node consumption.",
            "Review whether generated context remains compact and useful.",
            "Evaluate validation strategy for implementation-oriented managed work.",
            "Identify documentation risks and rollout guidance for workflow authors."
          ]
        }
      })
    );

    expect(normalized.diagnostics).toEqual([]);

    const root = normalized.document?.graph;
    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];
    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_deep_research to lower into a sequence workflow.");
    }

    expect(workflow.steps.map((step) => step.id)).toEqual([
      "market_scan__managed__pattern_deep_research__angle_fanout",
      "market_scan__managed__pattern_deep_research__synthesis_layer_01",
      "market_scan"
    ]);

    const synthesisLayer = workflow.steps[1];
    if (!synthesisLayer || synthesisLayer.type !== "parallel") {
      throw new Error("Expected a parallel synthesis layer.");
    }

    expect(synthesisLayer.steps).toHaveLength(3);
    expect(synthesisLayer.steps.map((step) => step.id)).toEqual([
      "market_scan__managed__pattern_deep_research__synthesis_01_01",
      "market_scan__managed__pattern_deep_research__synthesis_01_02",
      "market_scan__managed__pattern_deep_research__synthesis_01_03"
    ]);
    expect(synthesisLayer.steps.map((step) => ("context" in step ? step.context?.length : 0))).toEqual([
      4,
      4,
      6
    ]);
  });

  it("compiles pattern_deep_research so downstream nodes depend on the final public artifacts", () => {
    const normalized = normalizeAuthoredGraphDocument({
      ...buildDocument(),
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          buildDocument().graph.steps[0],
          {
            type: "agent",
            id: "handoff",
            intent: {
              goal: "Summarize the research recommendation.",
              acceptance_criteria: [
              "The handoff uses the final managed summary and packet artifacts.",
              "The handoff preserves the recommendation and key uncertainty."
            ],
              constraints: []
            },
            context: [
              {
                ref: "market_scan.agent_response",
                name: "research_agent_response"
              },
              {
                ref: "market_scan.summary",
                name: "research_summary"
              },
              {
                ref: "market_scan.packet",
                name: "research_packet"
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
    const fanoutScope = compiledGraph.scopes.find(
      (scope) => scope.authored_id === "market_scan__managed__pattern_deep_research__angle_fanout"
    );

    expect(compiledGraph.authored_to_compiled.market_scan).toEqual([
      "root__market_scan__managed__pattern_deep_research__workflow__market_scan"
    ]);
    expect(finalResearchNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        lowered_from: "pattern_deep_research",
        compiled_id: "root__market_scan__managed__pattern_deep_research__workflow__market_scan"
      })
    );
    expect(fanoutScope).toEqual(
      expect.objectContaining({
        kind: "parallel"
      })
    );
    expect(handoffNode).toEqual(
      expect.objectContaining({
        deps: ["root__market_scan__managed__pattern_deep_research__workflow__market_scan"]
      })
    );
  });
});
