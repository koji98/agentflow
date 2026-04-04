import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";

describe("spec design managed workflow", () => {
  it("lowers spec_design into a generated repo-first workflow with external research and revision loop", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "spec-design-lowering",
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
            type: "spec_design",
            id: "managed_nodes_spec",
            repo: "main",
            profile: "default",
            problem: "Managed aliases are too thin.",
            goal: "Design a real managed workflow model.",
            constraints: ["Keep primitive nodes stable."],
            decision_drivers: ["clarity", "reliability"],
            scope: {
              paths: ["src/**", "docs/**"],
              areas: ["graph", "runtime"]
            },
            research_policy: {
              allow_web_fallback: true,
              max_external_research_tasks: 2
            },
            orchestration: {
              option_count: 3,
              max_parallel_options: 2,
              critique_roles: ["architecture", "implementation"],
              revision_rounds: 2
            }
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "managed_nodes_spec",
        managed_kind: "spec_design",
        lowered_to: "agent"
      }
    ]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected spec_design to lower into a sequence workflow.");
    }

    expect(workflow.id).toBe("managed_nodes_spec__managed__spec_design__workflow");
    expect(workflow.steps.map((step) => step.id)).toEqual([
      "managed_nodes_spec__managed__spec_design__clarify",
      "managed_nodes_spec__managed__spec_design__inspect_repo",
      "managed_nodes_spec__managed__spec_design__assess_information_gap",
      "managed_nodes_spec__managed__spec_design__external_research",
      "managed_nodes_spec__managed__spec_design__synthesize_constraints",
      "managed_nodes_spec__managed__spec_design__generate_options",
      "managed_nodes_spec__managed__spec_design__compare_tradeoffs",
      "managed_nodes_spec__managed__spec_design__draft_initial_spec",
      "managed_nodes_spec__managed__spec_design__revision_loop",
      "managed_nodes_spec"
    ]);

    const externalResearch = workflow.steps[3];
    const optionFanout = workflow.steps[5];
    const revisionLoop = workflow.steps[8];
    const initialDraft = workflow.steps[7];

    if (!externalResearch || externalResearch.type !== "parallel") {
      throw new Error("Expected external research fanout to be parallel.");
    }

    if (!optionFanout || optionFanout.type !== "parallel") {
      throw new Error("Expected option generation to be parallel.");
    }

    if (!revisionLoop || revisionLoop.type !== "repeat") {
      throw new Error("Expected a repeat-based revision loop.");
    }

    if (!initialDraft || initialDraft.type !== "agent") {
      throw new Error("Expected initial draft step to be an agent.");
    }

    expect(externalResearch.steps).toHaveLength(2);
    expect(optionFanout.steps).toHaveLength(3);
    expect(revisionLoop.until.node).toBe("managed_nodes_spec__managed__spec_design__quality_check");
    expect(initialDraft.prompt).toContain("The spec must be implementation-ready and self-contained");
    expect(initialDraft.prompt).toContain("Required sections:");

    if (revisionLoop.body.type !== "sequence") {
      throw new Error("Expected revision loop body to be a sequence.");
    }

    const reviseNode = revisionLoop.body.steps[0];
    const qualityCheck = revisionLoop.body.steps.at(-1);

    if (!reviseNode || reviseNode.type !== "agent") {
      throw new Error("Expected revise step to be an agent.");
    }

    if (!qualityCheck || qualityCheck.type !== "check") {
      throw new Error("Expected quality check to be a check node.");
    }

    expect(reviseNode.prompt).toContain("implementation-ready design spec draft");
    expect(reviseNode.prompt).toContain("Do not leave repo-specific UI boundaries");
    expect(qualityCheck.prompt).toContain("direct input contract for execute_spec");
    expect(qualityCheck.rubric).toContain("migration or compatibility unresolved");
    expect(workflow.steps.at(-1)).toEqual(
      expect.objectContaining({
        id: "managed_nodes_spec",
        type: "agent",
        outputs: expect.arrayContaining([
          expect.objectContaining({
            name: "design_spec",
            path: "design-spec.md"
          })
        ])
      })
    );
  });

  it("compiles spec_design so downstream nodes depend on the final published spec", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "spec-design-compile",
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
            type: "spec_design",
            id: "managed_nodes_spec",
            problem: "Managed aliases are too thin.",
            goal: "Design a real managed workflow model.",
            research_policy: {
              allow_web_fallback: false,
              max_external_research_tasks: 0
            },
            orchestration: {
              option_count: 2,
              max_parallel_options: 2,
              critique_roles: ["architecture"],
              revision_rounds: 2
            }
          },
          {
            type: "agent",
            id: "handoff",
            prompt: "Summarize the final design spec for an implementer.",
            context_from: [
              {
                node: "managed_nodes_spec",
                include: "summary"
              },
              {
                node: "managed_nodes_spec",
                include: "output",
                output: "design_spec"
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
    const finalSpecNode = compiledGraph.nodes.find((node) => node.authored_id === "managed_nodes_spec");
    const handoffNode = compiledGraph.nodes.find((node) => node.authored_id === "handoff");
    const revisionScope = compiledGraph.scopes.find(
      (scope) => scope.authored_id === "managed_nodes_spec__managed__spec_design__revision_loop"
    );

    expect(compiledGraph.authored_to_compiled.managed_nodes_spec).toEqual([
      "root__managed_nodes_spec__managed__spec_design__workflow__managed_nodes_spec"
    ]);
    expect(finalSpecNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        lowered_from: "spec_design",
        compiled_id: "root__managed_nodes_spec__managed__spec_design__workflow__managed_nodes_spec"
      })
    );
    expect(revisionScope).toEqual(
      expect.objectContaining({
        kind: "repeat",
        max_attempts: 2
      })
    );
    expect(handoffNode).toEqual(
      expect.objectContaining({
        deps: ["root__managed_nodes_spec__managed__spec_design__workflow__managed_nodes_spec"]
      })
    );
  });

  it("omits external research fanout when repo context is required to stay local", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "spec-design-local-only",
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
            type: "spec_design",
            id: "managed_nodes_spec",
            problem: "Managed aliases are too thin.",
            goal: "Design a real managed workflow model.",
            research_policy: {
              allow_web_fallback: false,
              max_external_research_tasks: 0
            },
            orchestration: {
              option_count: 2,
              max_parallel_options: 2,
              critique_roles: ["architecture"],
              revision_rounds: 1
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
      throw new Error("Expected spec_design to lower into a sequence workflow.");
    }

    expect(workflow.steps.map((step) => step.id)).not.toContain(
      "managed_nodes_spec__managed__spec_design__external_research"
    );
  });
});
