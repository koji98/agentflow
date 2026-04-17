import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";

function buildDocument(stepOverrides = {}) {
  return {
    version: "1",
    graph_id: "spec-design-test",
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
          type: "pattern_spec_design",
          id: "managed_nodes_spec",
          repo: "main",
          profile: "default",
          brief: {
            problem: "Managed patterns need a clearer authored contract.",
            goal: "Produce an implementation-ready managed pattern model.",
            audience: "engineering",
            constraints: ["Keep primitive nodes stable."],
            decision_drivers: ["clarity", "maintainability"],
            scope: {
              paths: ["src/**", "docs/**"],
              areas: ["graph", "managed patterns"]
            }
          },
          context_policy: {
            repo_first: true,
            allow_web_fallback: true,
            web_triggers: ["missing product pattern"],
            allow_domains: ["openai.com", "developers.openai.com"]
          },
          approval_policy: {
            require_direction_approval: false
          },
          strategy: {
            alternatives: 3,
            critique_profiles: ["architecture", "implementation"],
            max_revision_cycles: 2
          },
          delivery: {
            format: "design_spec",
            sections: ["problem", "architecture", "implementation_readiness"]
          },
          ...stepOverrides
        }
      ]
    }
  };
}

describe("spec design managed pattern", () => {
  it("lowers to the repo-first design pattern with optional direction approval and a fixed design package", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument({
        approval_policy: {
          require_direction_approval: true
        },
        runtime: {
          max_concurrency: 2
        },
        strategy: {
          alternatives: 3,
          critique_profiles: ["architecture", "implementation"],
          max_revision_cycles: 3
        }
      })
    );

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "managed_nodes_spec",
        managed_kind: "pattern_spec_design",
        lowered_to: "sequence"
      }
    ]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_spec_design to lower into a sequence workflow.");
    }

    expect(workflow.steps.map((step) => step.id)).toEqual([
      "managed_nodes_spec__managed__pattern_spec_design__clarify_brief",
      "managed_nodes_spec__managed__pattern_spec_design__inspect_current_state",
      "managed_nodes_spec__managed__pattern_spec_design__identify_information_gaps",
      "managed_nodes_spec__managed__pattern_spec_design__targeted_external_research",
      "managed_nodes_spec__managed__pattern_spec_design__generate_options",
      "managed_nodes_spec__managed__pattern_spec_design__direction_loop",
      "managed_nodes_spec__managed__pattern_spec_design__draft_spec",
      "managed_nodes_spec__managed__pattern_spec_design__revision_loop",
      "managed_nodes_spec"
    ]);

    const externalResearch = workflow.steps[3];
    const optionFanout = workflow.steps[4];
    const directionLoop = workflow.steps[5];
    const revisionLoop = workflow.steps[7];
    const finalNode = workflow.steps[8];

    if (!externalResearch || externalResearch.type !== "parallel") {
      throw new Error("Expected external research fanout to be parallel.");
    }

    if (!optionFanout || optionFanout.type !== "parallel") {
      throw new Error("Expected option generation to be parallel.");
    }

    if (!directionLoop || directionLoop.type !== "repeat") {
      throw new Error("Expected direction approval to compile as a repeat loop.");
    }

    if (!revisionLoop || revisionLoop.type !== "repeat") {
      throw new Error("Expected revision loop to be repeat-based.");
    }

    expect(externalResearch.steps).toHaveLength(2);
    expect(optionFanout.steps).toHaveLength(3);
    expect(optionFanout.max_concurrency).toBe(2);
    expect(directionLoop.until.node).toBe("managed_nodes_spec__managed__pattern_spec_design__approve_direction");
    expect(revisionLoop.max_attempts).toBe(3);
    expect(revisionLoop.until.node).toBe("managed_nodes_spec__managed__pattern_spec_design__quality_review");

    if (revisionLoop.body.type !== "sequence") {
      throw new Error("Expected revision loop body to be a sequence.");
    }

    const critiquePanel = revisionLoop.body.steps[1];

    if (!critiquePanel || critiquePanel.type !== "parallel") {
      throw new Error("Expected critique panel to be parallel.");
    }

    expect(critiquePanel.max_concurrency).toBe(2);
    expect(finalNode).toEqual(
      expect.objectContaining({
        id: "managed_nodes_spec",
        type: "agent",
        artifacts: expect.objectContaining({
          design_spec: expect.objectContaining({ path: "design-spec.md" }),
          design_packet: expect.objectContaining({ path: "design-packet.json" }),
          direction_proposal: expect.objectContaining({ path: "direction-proposal.md" }),
          tradeoff_matrix: expect.objectContaining({ path: "tradeoff-matrix.md" }),
          decision_log: expect.objectContaining({ path: "decision-log.md" }),
          implementation_readiness: expect.objectContaining({ path: "implementation-readiness.md" }),
          critique_merged: expect.objectContaining({ path: "critique-merged.md" }),
          quality_review: expect.objectContaining({ path: "quality-review.json" })
        })
      })
    );
  });

  it("compiles pattern_spec_design so downstream nodes depend on the final published design package", () => {
    const normalized = normalizeAuthoredGraphDocument({
      ...buildDocument({
        context_policy: {
          repo_first: true,
          allow_web_fallback: false
        }
      }),
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          buildDocument({
            context_policy: {
              repo_first: true,
              allow_web_fallback: false
            }
          }).graph.steps[0],
          {
            type: "agent",
            id: "handoff",
            prompt: "Summarize the design package for an implementer.",
            context: [
              {
                name: "design_agent_response",
                from: "artifact",
                node: "managed_nodes_spec",
                artifact: "agent_response"
              },
              {
                name: "design_spec",
                from: "artifact",
                node: "managed_nodes_spec",
                artifact: "design_spec"
              },
              {
                name: "implementation_readiness",
                from: "artifact",
                node: "managed_nodes_spec",
                artifact: "implementation_readiness"
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
    const finalDesignNode = compiledGraph.nodes.find((node) => node.authored_id === "managed_nodes_spec");
    const handoffNode = compiledGraph.nodes.find((node) => node.authored_id === "handoff");

    expect(compiledGraph.authored_to_compiled.managed_nodes_spec).toEqual([
      "root__managed_nodes_spec__managed__pattern_spec_design__workflow__managed_nodes_spec"
    ]);
    expect(finalDesignNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        lowered_from: "pattern_spec_design",
        compiled_id: "root__managed_nodes_spec__managed__pattern_spec_design__workflow__managed_nodes_spec"
      })
    );
    expect(handoffNode).toEqual(
      expect.objectContaining({
        deps: ["root__managed_nodes_spec__managed__pattern_spec_design__workflow__managed_nodes_spec"]
      })
    );
  });
});
