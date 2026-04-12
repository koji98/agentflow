import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";

function buildReviewStep(stepOverrides = {}) {
  return {
    type: "pattern_review_change",
    id: "review_managed_nodes",
    repo: "main",
    profile: "default",
    review_source: {
      kind: "managed_node",
      node: "implement_managed_nodes"
    },
    brief: {
      review_goal: "Find the highest-signal risks in the implementation.",
      focus: ["correctness", "testing", "maintainability"],
      audience: "engineering",
      scope: {
        paths: ["src/**", "docs/**", "tests/**"],
        areas: ["graph", "managed patterns"]
      }
    },
    context_policy: {
      include_surrounding_code: true,
      include_tests: true,
      include_docs: false,
      include_validation: true
    },
    strategy: {
      reviewer_profiles: ["correctness", "testing", "maintainability"],
      severity_policy: "balanced",
      include_surrounding_context: true,
      false_positive_challenge: true,
      require_file_references: true
    },
    delivery: {
      format: "review_summary",
      sections: ["findings", "severity_summary", "recommended_actions"]
    },
    ...stepOverrides
  };
}

function buildDocument(steps) {
  return {
    version: "1",
    graph_id: "pattern-review-change-test",
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
      steps
    }
  };
}

describe("pattern review change", () => {
  it("lowers to the review pattern with review planning, reviewer fanout, merge, and calibration", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument([
        buildReviewStep({
          runtime: {
            max_concurrency: 2
          }
        })
      ])
    );

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "review_managed_nodes",
        managed_kind: "pattern_review_change",
        lowered_to: "sequence"
      }
    ]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_review_change to lower into a sequence workflow.");
    }

    expect(workflow.steps.map((step) => step.id)).toEqual([
      "review_managed_nodes__managed__pattern_review_change__prepare_review_packet",
      "review_managed_nodes__managed__pattern_review_change__plan_review",
      "review_managed_nodes__managed__pattern_review_change__reviewer_panel",
      "review_managed_nodes__managed__pattern_review_change__aggregate_raw_findings",
      "review_managed_nodes__managed__pattern_review_change__merge_findings",
      "review_managed_nodes__managed__pattern_review_change__calibrate_findings",
      "review_managed_nodes"
    ]);

    const reviewerPanel = workflow.steps[2];
    const finalNode = workflow.steps[6];

    if (!reviewerPanel || reviewerPanel.type !== "parallel") {
      throw new Error("Expected reviewer panel to be a parallel scope.");
    }

    expect(reviewerPanel.max_concurrency).toBe(2);
    expect(reviewerPanel.steps).toHaveLength(3);
    expect(finalNode).toEqual(
      expect.objectContaining({
        id: "review_managed_nodes",
        type: "agent",
        outputs: expect.arrayContaining([
          expect.objectContaining({ name: "review_summary", path: "review-summary.md" }),
          expect.objectContaining({ name: "review_bundle", path: "review-bundle.json" }),
          expect.objectContaining({ name: "raw_findings", path: "raw-findings.json" }),
          expect.objectContaining({ name: "merged_findings", path: "merged-findings.json" }),
          expect.objectContaining({ name: "calibrated_findings", path: "calibrated-findings.json" })
        ])
      })
    );
  });

  it("maps artifact_bundle review sources into prepare inputs and managed-output context", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument([
        {
          type: "agent",
          id: "upstream_evaluation",
          prompt: "Write evaluation ledger output.",
          outputs: [
            {
              name: "evaluation_ledger",
              from: "attempt",
              path: "evaluation-ledger.json",
              required: true
            }
          ]
        },
        buildReviewStep({
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
            evaluation_ledger: {
              kind: "managed_output",
              node: "upstream_evaluation",
              output: "evaluation_ledger"
            },
            additional_context: [
              {
                kind: "file",
                path: "artifacts/notes.md"
              }
            ]
          }
        })
      ])
    );

    expect(normalized.diagnostics).toEqual([]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[1];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_review_change to lower into a sequence workflow.");
    }

    const prepareNode = workflow.steps[0];

    expect(prepareNode).toEqual(
      expect.objectContaining({
        type: "agent",
        id: "review_bundle__managed__pattern_review_change__prepare_review_packet",
        inputs: expect.arrayContaining([
          expect.objectContaining({ kind: "file", path: "artifacts/change.patch" }),
          expect.objectContaining({ kind: "file", path: "artifacts/change-summary.md" }),
          expect.objectContaining({ kind: "file", path: "artifacts/notes.md" })
        ]),
        context_from: expect.arrayContaining([
          expect.objectContaining({
            node: "upstream_evaluation",
            include: "output",
            output: "evaluation_ledger",
            optional: true
          })
        ])
      })
    );
  });

  it("compiles pattern_review_change so downstream nodes depend on the final published review package", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument([
        buildReviewStep({
          review_source: {
            kind: "artifact_bundle",
            summary: {
              kind: "file",
              path: "artifacts/change-summary.md"
            }
          }
        }),
        {
          type: "agent",
          id: "handoff",
          prompt: "Summarize the review result for an engineer.",
          context_from: [
            {
              node: "review_managed_nodes",
              include: "summary"
            },
            {
              node: "review_managed_nodes",
              include: "output",
              output: "review_summary"
            },
            {
              node: "review_managed_nodes",
              include: "output",
              output: "review_bundle"
            }
          ]
        }
      ])
    );

    expect(normalized.diagnostics).toEqual([]);

    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(
      normalized.document!,
      launch,
      normalized.lowered_managed_nodes
    );

    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.compiled_graph).toBeDefined();

    const compiledGraph = compilation.compiled_graph!;
    const finalReviewNode = compiledGraph.nodes.find((node) => node.authored_id === "review_managed_nodes");
    const handoffNode = compiledGraph.nodes.find((node) => node.authored_id === "handoff");
    const reviewerScope = compiledGraph.scopes.find(
      (scope) => scope.authored_id === "review_managed_nodes__managed__pattern_review_change__reviewer_panel"
    );

    expect(reviewerScope).toEqual(
      expect.objectContaining({
        kind: "parallel"
      })
    );
    expect(compiledGraph.authored_to_compiled.review_managed_nodes).toEqual([
      "root__review_managed_nodes__managed__pattern_review_change__workflow__review_managed_nodes"
    ]);
    expect(finalReviewNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        lowered_from: "pattern_review_change",
        compiled_id: "root__review_managed_nodes__managed__pattern_review_change__workflow__review_managed_nodes"
      })
    );
    expect(handoffNode).toEqual(
      expect.objectContaining({
        deps: ["root__review_managed_nodes__managed__pattern_review_change__workflow__review_managed_nodes"]
      })
    );
  });
});
