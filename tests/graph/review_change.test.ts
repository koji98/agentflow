import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";

describe("review change managed workflow", () => {
  it("lowers review_change into a reviewer panel, merge step, normalization gate, and final review", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "review-change-lowering",
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
            type: "review_change",
            id: "review_managed_nodes",
            repo: "main",
            profile: "default",
            review_source: {
              kind: "managed_node",
              node: "implement_managed_nodes"
            },
            criteria: {
              focus: ["correctness", "missing_tests"],
              require_file_references: true
            },
            orchestration: {
              reviewer_roles: ["correctness", "testing", "maintainability"],
              max_parallel_reviewers: 2
            }
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "review_managed_nodes",
        managed_kind: "review_change",
        lowered_to: "agent"
      }
    ]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected review_change to lower into a sequence workflow.");
    }

    expect(workflow.id).toBe("review_managed_nodes__managed__review_change__workflow");
    expect(workflow.steps.map((step) => step.id)).toEqual([
      "review_managed_nodes__managed__review_change__prepare_review_packet",
      "review_managed_nodes__managed__review_change__reviewer_panel",
      "review_managed_nodes__managed__review_change__merge_findings",
      "review_managed_nodes__managed__review_change__normalize_findings",
      "review_managed_nodes"
    ]);

    const reviewerPanel = workflow.steps[1];
    const normalizeGate = workflow.steps[3];

    if (!reviewerPanel || reviewerPanel.type !== "parallel") {
      throw new Error("Expected reviewer panel to be a parallel scope.");
    }

    expect(reviewerPanel.max_concurrency).toBe(2);
    expect(reviewerPanel.steps).toHaveLength(3);
    expect(reviewerPanel.steps[0]).toEqual(
      expect.objectContaining({
        id: "review_managed_nodes__managed__review_change__reviewer_correctness",
        type: "agent"
      })
    );
    expect(normalizeGate).toEqual(
      expect.objectContaining({
        id: "review_managed_nodes__managed__review_change__normalize_findings",
        type: "check",
        check_kind: "ai"
      })
    );
    expect(workflow.steps.at(-1)).toEqual(
      expect.objectContaining({
        id: "review_managed_nodes",
        type: "agent",
        outputs: expect.arrayContaining([
          expect.objectContaining({
            name: "review_report",
            path: "review.md"
          }),
          expect.objectContaining({
            name: "findings",
            path: "findings.json"
          })
        ])
      })
    );
  });

  it("maps artifact_bundle review sources into prepare inputs and managed-output context", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "review-change-artifact-bundle",
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
            id: "upstream_validation",
            prompt: "Write validation results.",
            outputs: [
              {
                name: "validation_results",
                from: "attempt",
                path: "validation.md",
                required: true
              }
            ]
          },
          {
            type: "review_change",
            id: "review_bundle",
            review_source: {
              kind: "artifact_bundle",
              diff: {
                kind: "file",
                path: "artifacts/change.patch"
              },
              summary: {
                kind: "file",
                path: "artifacts/change-summary.md"
              },
              validation_results: {
                kind: "managed_output",
                node: "upstream_validation",
                output: "validation_results"
              }
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
      throw new Error("Expected review_change to lower into a sequence workflow.");
    }

    const prepareNode = workflow.steps[0];

    expect(prepareNode).toEqual(
      expect.objectContaining({
        type: "agent",
        id: "review_bundle__managed__review_change__prepare_review_packet",
        inputs: expect.arrayContaining([
          expect.objectContaining({
            kind: "file",
            path: "artifacts/change.patch"
          }),
          expect.objectContaining({
            kind: "file",
            path: "artifacts/change-summary.md"
          })
        ]),
        context_from: expect.arrayContaining([
          expect.objectContaining({
            node: "upstream_validation",
            include: "output",
            output: "validation_results",
            optional: true
          })
        ])
      })
    );
  });

  it("compiles review_change so downstream nodes depend on the final published review", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "review-change-compile",
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
            type: "review_change",
            id: "review_bundle",
            review_source: {
              kind: "artifact_bundle",
              summary: {
                kind: "file",
                path: "artifacts/change-summary.md"
              }
            }
          },
          {
            type: "agent",
            id: "handoff",
            prompt: "Summarize the review result for an engineer.",
            context_from: [
              {
                node: "review_bundle",
                include: "summary"
              },
              {
                node: "review_bundle",
                include: "output",
                output: "review_report"
              },
              {
                node: "review_bundle",
                include: "output",
                output: "findings"
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
    const finalReviewNode = compiledGraph.nodes.find((node) => node.authored_id === "review_bundle");
    const reviewerScope = compiledGraph.scopes.find(
      (scope) => scope.authored_id === "review_bundle__managed__review_change__reviewer_panel"
    );
    const handoffNode = compiledGraph.nodes.find((node) => node.authored_id === "handoff");

    expect(compiledGraph.authored_to_compiled.review_bundle).toEqual([
      "root__review_bundle__managed__review_change__workflow__review_bundle"
    ]);
    expect(finalReviewNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        lowered_from: "review_change",
        compiled_id: "root__review_bundle__managed__review_change__workflow__review_bundle"
      })
    );
    expect(reviewerScope).toEqual(
      expect.objectContaining({
        kind: "parallel"
      })
    );
    expect(handoffNode).toEqual(
      expect.objectContaining({
        deps: ["root__review_bundle__managed__review_change__workflow__review_bundle"]
      })
    );
  });

  it("respects delivery flags and keeps the final findings schema explicit", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "review-change-delivery",
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
            type: "review_change",
            id: "review_bundle",
            review_source: {
              kind: "artifact_bundle",
              summary: {
                kind: "file",
                path: "artifacts/change-summary.md"
              }
            },
            delivery: {
              write_review_report: false,
              write_findings_json: true,
              write_findings_markdown: true
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
      throw new Error("Expected review_change to lower into a sequence workflow.");
    }

    const finalNode = workflow.steps.at(-1);

    expect(finalNode).toEqual(
      expect.objectContaining({
        type: "agent",
        outputs: [
          expect.objectContaining({
            name: "findings",
            path: "findings.json"
          }),
          expect.objectContaining({
            name: "findings_markdown",
            path: "findings.md"
          })
        ]
      })
    );

    expect(finalNode).not.toEqual(
      expect.objectContaining({
        outputs: expect.arrayContaining([
          expect.objectContaining({
            name: "review_report"
          })
        ])
      })
    );

    expect(finalNode).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining("preserve the exact reviewer findings schema used by `merged-findings.json`")
      })
    );
  });

  it("requires at least one final published artifact when delivery disables all managed outputs", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "review-change-delivery-contract",
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
            type: "review_change",
            id: "review_bundle",
            review_source: {
              kind: "artifact_bundle",
              summary: {
                kind: "file",
                path: "artifacts/change-summary.md"
              }
            },
            delivery: {
              write_review_report: false,
              write_findings_json: false,
              write_findings_markdown: false
            }
          }
        ]
      }
    });

    expect(normalized.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "$.graph.steps[0]",
        message:
          "review_change must publish at least one final artifact via delivery flags or explicit outputs."
      })
    );
  });
});
