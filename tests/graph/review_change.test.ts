import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";

function buildReviewStep(stepOverrides = {}) {
  return {
    type: "review_change",
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
        areas: ["graph", "managed workflows"]
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
      write_review_summary: true,
      write_raw_findings: true,
      write_calibrated_findings: true
    },
    ...stepOverrides
  };
}

function buildDocument(steps) {
  return {
    version: "1",
    graph_id: "review-change-test",
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

describe("review change managed workflow", () => {
  it("lowers to the v2 review workflow with review planning, reviewer fanout, merge, and calibration", () => {
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
        managed_kind: "review_change",
        lowered_to: "sequence"
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

    expect(workflow.steps.map((step) => step.id)).toEqual([
      "review_managed_nodes__managed__review_change__prepare_review_packet",
      "review_managed_nodes__managed__review_change__plan_review",
      "review_managed_nodes__managed__review_change__reviewer_panel",
      "review_managed_nodes__managed__review_change__aggregate_raw_findings",
      "review_managed_nodes__managed__review_change__merge_findings",
      "review_managed_nodes__managed__review_change__calibrate_findings",
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
          expect.objectContaining({ name: "raw_findings", path: "raw-findings.json" }),
          expect.objectContaining({
            name: "calibrated_findings",
            path: "calibrated-findings.json"
          }),
          expect.objectContaining({ name: "merged_findings", path: "merged-findings.json" }),
          expect.objectContaining({ name: "workflow_status", path: "workflow-status.json" }),
          expect.objectContaining({ name: "workflow_events", path: "workflow-events.jsonl" })
        ])
      })
    );
  });

  it("maps artifact_bundle review sources into prepare inputs and managed-output context", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument([
        {
          type: "agent",
          id: "upstream_validation",
          prompt: "Write validation ledger output.",
          outputs: [
            {
              name: "validation_ledger",
              from: "attempt",
              path: "validation-ledger.json",
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
            validation_ledger: {
              kind: "managed_output",
              node: "upstream_validation",
              output: "validation_ledger"
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
      throw new Error("Expected review_change to lower into a sequence workflow.");
    }

    const prepareNode = workflow.steps[0];

    expect(prepareNode).toEqual(
      expect.objectContaining({
        type: "agent",
        id: "review_bundle__managed__review_change__prepare_review_packet",
        inputs: expect.arrayContaining([
          expect.objectContaining({ kind: "file", path: "artifacts/change.patch" }),
          expect.objectContaining({ kind: "file", path: "artifacts/change-summary.md" }),
          expect.objectContaining({ kind: "file", path: "artifacts/notes.md" })
        ]),
        context_from: expect.arrayContaining([
          expect.objectContaining({
            node: "upstream_validation",
            include: "output",
            output: "validation_ledger",
            optional: true
          })
        ])
      })
    );
  });

  it("compiles review_change so downstream nodes depend on the final published review", () => {
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
              output: "calibrated_findings"
            }
          ]
        }
      ])
    );

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
    const reviewerScope = compiledGraph.scopes.find(
      (scope) => scope.authored_id === "review_managed_nodes__managed__review_change__reviewer_panel"
    );
    const handoffNode = compiledGraph.nodes.find((node) => node.authored_id === "handoff");

    expect(compiledGraph.authored_to_compiled.review_managed_nodes).toEqual([
      "root__review_managed_nodes__managed__review_change__workflow__review_managed_nodes"
    ]);
    expect(finalReviewNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        lowered_from: "review_change",
        compiled_id: "root__review_managed_nodes__managed__review_change__workflow__review_managed_nodes"
      })
    );
    expect(reviewerScope).toEqual(
      expect.objectContaining({
        kind: "parallel"
      })
    );
    expect(handoffNode).toEqual(
      expect.objectContaining({
        deps: ["root__review_managed_nodes__managed__review_change__workflow__review_managed_nodes"]
      })
    );
  });
});
