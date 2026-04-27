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
      }
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
          brief: {
            question: "How should Agentflow evolve managed patterns?",
            objective: "Produce a grounded recommendation for the workflow surface.",
            audience: "engineering",
            scope_cues: ["managed patterns", "compiled subgraphs"],
            success_bar: ["cover competing patterns", "preserve uncertainty"]
          },
          context_policy: {
            web: true,
            files: true,
            apps: false,
            allow_domains: ["openai.com", "anthropic.com", "perplexity.ai"]
          },
          approval_policy: {
            require_plan_approval: false
          },
          strategy: {
            depth: "standard",
            coverage_mode: "balanced",
            followup_passes: 1,
            final_critique: false
          },
          delivery: {
            format: "report",
            citation_style: "inline",
            sections: ["findings", "recommendation", "uncertainties"]
          },
          ...stepOverrides
        }
      ]
    }
  };
}

describe("deep research managed pattern", () => {
  it("lowers to the research pattern with optional plan approval and fixed research package outputs", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument({
        approval_policy: {
          require_plan_approval: true
        },
        strategy: {
          depth: "shallow",
          coverage_mode: "breadth",
          followup_passes: 1,
          final_critique: true
        },
        runtime: {
          max_concurrency: 2
        }
      })
    );

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
      "market_scan__managed__pattern_deep_research__clarify_brief",
      "market_scan__managed__pattern_deep_research__planning_loop",
      "market_scan__managed__pattern_deep_research__derive_tracks",
      "market_scan__managed__pattern_deep_research__investigation_fanout",
      "market_scan__managed__pattern_deep_research__scan_contradictions",
      "market_scan__managed__pattern_deep_research__followup_plan_01",
      "market_scan__managed__pattern_deep_research__followup_fanout_01",
      "market_scan__managed__pattern_deep_research__consolidate_findings",
      "market_scan",
      "market_scan__managed__pattern_deep_research__final_critique"
    ]);

    const planningLoop = workflow.steps[1];
    const investigationFanout = workflow.steps[3];
    const followupFanout = workflow.steps[6];
    const finalNode = workflow.steps[8];
    const finalCritique = workflow.steps[9];

    if (!planningLoop || planningLoop.type !== "repeat") {
      throw new Error("Expected a repeat-based planning loop.");
    }

    if (!investigationFanout || investigationFanout.type !== "parallel") {
      throw new Error("Expected investigation fanout to be parallel.");
    }

    if (!followupFanout || followupFanout.type !== "parallel") {
      throw new Error("Expected follow-up fanout to be parallel.");
    }

    expect(planningLoop.until.node).toBe("market_scan__managed__pattern_deep_research__approve_research_plan");
    expect(investigationFanout.max_concurrency).toBe(2);
    expect(investigationFanout.steps).toHaveLength(3);
    expect(followupFanout.max_concurrency).toBe(2);
    expect(followupFanout.steps).toHaveLength(3);
    expect(finalNode).toEqual(
      expect.objectContaining({
        id: "market_scan",
        type: "agent",
        artifacts: expect.objectContaining({
          research_report: expect.objectContaining({ path: "research-report.md" }),
          research_packet: expect.objectContaining({ path: "research-packet.json" }),
          source_ledger: expect.objectContaining({ path: "source-ledger.json" }),
          uncertainties: expect.objectContaining({ path: "uncertainties.md" }),
          interim_findings: expect.objectContaining({ path: "interim-findings.jsonl" })
        })
      })
    );
    expect(finalCritique).toEqual(
      expect.objectContaining({
        type: "check",
        check_kind: "ai",
        id: "market_scan__managed__pattern_deep_research__final_critique"
      })
    );
  });

  it("compiles pattern_deep_research so downstream nodes depend on the final published research package", () => {
    const normalized = normalizeAuthoredGraphDocument({
      ...buildDocument({
        strategy: {
          depth: "deep",
          coverage_mode: "balanced",
          followup_passes: 0,
          final_critique: false
        },
        runtime: {
          max_concurrency: 1
        }
      }),
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          buildDocument({
            strategy: {
              depth: "deep",
              coverage_mode: "balanced",
              followup_passes: 0,
              final_critique: false
            },
            runtime: {
              max_concurrency: 1
            }
          }).graph.steps[0],
          {
            type: "agent",
            id: "handoff",
            goal: "Summarize the research recommendation.",
            context: [
              {
                ref: "market_scan.agent_response",
                name: "research_agent_response"
              },
              {
                ref: "market_scan.research_report",
                name: "research_report"
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
      (scope) => scope.authored_id === "market_scan__managed__pattern_deep_research__investigation_fanout"
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
    expect(trackScope).toEqual(
      expect.objectContaining({
        kind: "parallel",
        max_concurrency: 1
      })
    );
    expect(handoffNode).toEqual(
      expect.objectContaining({
        deps: ["root__market_scan__managed__pattern_deep_research__workflow__market_scan"]
      })
    );
  });
});
