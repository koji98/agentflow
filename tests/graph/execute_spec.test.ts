import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";

describe("execute spec managed workflow", () => {
  it("lowers execute_spec into a single-writer workflow with readiness, repair loop, and final handoff", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "execute-spec-lowering",
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
            type: "execute_spec",
            id: "implement_managed_nodes",
            repo: "main",
            profile: "default",
            objective: "Implement the managed workflow model.",
            spec_source: {
              kind: "managed_node",
              node: "managed_nodes_spec"
            },
            scope: {
              paths: ["src/**", "docs/**", "tests/**"],
              areas: ["graph", "runtime", "docs"]
            },
            execution_policy: {
              max_repair_rounds: 3
            },
            validation: {
              commands: ["npm run typecheck", "npm test"]
            },
            implementation_research: {
              allow_official_docs_fallback: true,
              max_external_lookup_tasks: 2
            }
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "implement_managed_nodes",
        managed_kind: "execute_spec",
        lowered_to: "agent"
      }
    ]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected execute_spec to lower into a sequence workflow.");
    }

    expect(workflow.id).toBe("implement_managed_nodes__managed__execute_spec__workflow");
    expect(workflow.steps.map((step) => step.id)).toEqual([
      "implement_managed_nodes__managed__execute_spec__ingest_spec",
      "implement_managed_nodes__managed__execute_spec__assess_spec_readiness",
      "implement_managed_nodes__managed__execute_spec__inspect_repo_for_execution",
      "implement_managed_nodes__managed__execute_spec__targeted_implementation_research",
      "implement_managed_nodes__managed__execute_spec__plan_execution",
      "implement_managed_nodes__managed__execute_spec__implement_spec",
      "implement_managed_nodes__managed__execute_spec__stabilization_loop",
      "implement_managed_nodes"
    ]);

    const readinessGate = workflow.steps[1];
    const implementNode = workflow.steps[5];
    const repairLoop = workflow.steps[6];

    expect(readinessGate).toEqual(
      expect.objectContaining({
        type: "check",
        check_kind: "ai",
        id: "implement_managed_nodes__managed__execute_spec__assess_spec_readiness"
      })
    );
    expect(implementNode).toEqual(
      expect.objectContaining({
        type: "agent",
        sandbox: "workspace-write",
        id: "implement_managed_nodes__managed__execute_spec__implement_spec"
      })
    );

    if (!repairLoop || repairLoop.type !== "repeat") {
      throw new Error("Expected a repeat-based repair loop.");
    }

    expect(repairLoop.max_attempts).toBe(3);
    expect(repairLoop.until.node).toBe("implement_managed_nodes__managed__execute_spec__validation_gate");

    if (repairLoop.body.type !== "sequence") {
      throw new Error("Expected the repair loop body to be a sequence.");
    }

    expect(repairLoop.body.steps.map((step) => step.id)).toEqual([
      "implement_managed_nodes__managed__execute_spec__stabilize_implementation",
      "implement_managed_nodes__managed__execute_spec__validation_gate"
    ]);

    expect(workflow.steps.at(-1)).toEqual(
      expect.objectContaining({
        id: "implement_managed_nodes",
        type: "agent",
        outputs: expect.arrayContaining([
          expect.objectContaining({
            name: "change_summary",
            path: "change-summary.md"
          }),
          expect.objectContaining({
            name: "validation_results",
            path: "validation-results.md"
          }),
          expect.objectContaining({
            name: "implementation_plan",
            path: "implementation-plan.md"
          })
        ])
      })
    );
  });

  it("maps artifact_bundle spec sources into ingest inputs and managed-output context", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "execute-spec-artifact-bundle",
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
            type: "agent",
            id: "upstream_plan",
            prompt: "Write an acceptance criteria artifact.",
            outputs: [
              {
                name: "acceptance_criteria",
                from: "attempt",
                path: "acceptance.md",
                required: true
              }
            ]
          },
          {
            type: "execute_spec",
            id: "implement_from_bundle",
            spec_source: {
              kind: "artifact_bundle",
              design_spec: {
                kind: "file",
                path: "docs/spec.md"
              },
              file_plan: {
                kind: "file",
                path: "docs/file-plan.md"
              },
              acceptance_criteria: {
                kind: "managed_output",
                node: "upstream_plan",
                output: "acceptance_criteria"
              }
            },
            validation: {
              commands: ["npm test"]
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

    const workflow = root.steps[1];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected execute_spec to lower into a sequence workflow.");
    }

    const ingestNode = workflow.steps[0];

    expect(ingestNode).toEqual(
      expect.objectContaining({
        type: "agent",
        id: "implement_from_bundle__managed__execute_spec__ingest_spec",
        inputs: expect.arrayContaining([
          expect.objectContaining({
            kind: "file",
            path: "docs/spec.md"
          }),
          expect.objectContaining({
            kind: "file",
            path: "docs/file-plan.md"
          })
        ]),
        context_from: expect.arrayContaining([
          expect.objectContaining({
            node: "upstream_plan",
            include: "output",
            output: "acceptance_criteria",
            optional: true
          })
        ])
      })
    );
  });

  it("compiles execute_spec so downstream nodes depend on the final published handoff", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "execute-spec-compile",
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
            type: "execute_spec",
            id: "implement_managed_nodes",
            spec_source: {
              kind: "managed_node",
              node: "managed_nodes_spec"
            },
            validation: {
              commands: ["npm run typecheck", "npm test"]
            }
          },
          {
            type: "agent",
            id: "handoff",
            prompt: "Summarize the implementation result for an operator.",
            context_from: [
              {
                node: "implement_managed_nodes",
                include: "summary"
              },
              {
                node: "implement_managed_nodes",
                include: "output",
                output: "change_summary"
              },
              {
                node: "implement_managed_nodes",
                include: "output",
                output: "validation_results"
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
    const finalExecuteNode = compiledGraph.nodes.find((node) => node.authored_id === "implement_managed_nodes");
    const implementNode = compiledGraph.nodes.find(
      (node) => node.authored_id === "implement_managed_nodes__managed__execute_spec__implement_spec"
    );
    const repairScope = compiledGraph.scopes.find(
      (scope) => scope.authored_id === "implement_managed_nodes__managed__execute_spec__stabilization_loop"
    );
    const handoffNode = compiledGraph.nodes.find((node) => node.authored_id === "handoff");

    expect(compiledGraph.authored_to_compiled.implement_managed_nodes).toEqual([
      "root__implement_managed_nodes__managed__execute_spec__workflow__implement_managed_nodes"
    ]);
    expect(finalExecuteNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        lowered_from: "execute_spec",
        compiled_id: "root__implement_managed_nodes__managed__execute_spec__workflow__implement_managed_nodes"
      })
    );
    expect(implementNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        effective_policy: expect.objectContaining({
          sandbox: "workspace-write"
        })
      })
    );
    expect(repairScope).toEqual(
      expect.objectContaining({
        kind: "repeat",
        max_attempts: 2
      })
    );
    expect(handoffNode).toEqual(
      expect.objectContaining({
        deps: ["root__implement_managed_nodes__managed__execute_spec__workflow__implement_managed_nodes"]
      })
    );
  });

  it("requires at least one final published artifact when delivery disables all managed outputs", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "execute-spec-delivery-contract",
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
            type: "execute_spec",
            id: "implement_from_bundle",
            spec_source: {
              kind: "artifact_bundle",
              design_spec: {
                kind: "file",
                path: "docs/spec.md"
              }
            },
            validation: {
              commands: ["npm test"]
            },
            delivery: {
              write_change_summary: false,
              write_validation_results: false,
              write_residual_risks: false,
              write_files_touched: false,
              write_implementation_plan: false
            }
          }
        ]
      }
    });

    expect(normalized.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "$.graph.steps[0]",
        message:
          "execute_spec must publish at least one final artifact via delivery flags or explicit outputs."
      })
    );
  });
});
