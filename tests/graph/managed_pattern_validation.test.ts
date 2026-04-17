import { describe, expect, it } from "vitest";

import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";

function buildEnvelope(step) {
  return {
    version: "1",
    graph_id: "managed-pattern-validation",
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
      steps: [step]
    }
  };
}

describe("managed pattern normalization edges", () => {
  it("falls back through pattern_deep_research optional objects while surfacing diagnostics", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "pattern_deep_research",
        id: "market_scan",
        brief: {
          question: "How should Agentflow design deep research?",
          objective: "Produce a design recommendation."
        },
        context_policy: "bad",
        approval_policy: "bad",
        strategy: "bad",
        delivery: "bad",
        runtime: "bad"
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].context_policy",
          message: "pattern_deep_research.context_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].approval_policy",
          message: "pattern_deep_research.approval_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].strategy",
          message: "pattern_deep_research.strategy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].delivery",
          message: "pattern_deep_research.delivery must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].runtime",
          message: "managed pattern runtime must be an object."
        })
      ])
    );
  });

  it("falls back through pattern_spec_design optional objects while surfacing diagnostics", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "pattern_spec_design",
        id: "managed_nodes_spec",
        brief: {
          problem: "Managed patterns are too thin.",
          goal: "Design a real pattern model.",
          scope: "bad"
        },
        context_policy: "bad",
        approval_policy: "bad",
        strategy: "bad",
        delivery: "bad"
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].brief.scope",
          message: "pattern_spec_design.scope must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].context_policy",
          message: "pattern_spec_design.context_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].approval_policy",
          message: "pattern_spec_design.approval_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].strategy",
          message: "pattern_spec_design.strategy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].delivery",
          message: "pattern_spec_design.delivery must be an object."
        })
      ])
    );
  });

  it("surfaces deprecated execute-spec style fields on pattern_generate_evaluate_fix while still lowering a valid node", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "pattern_generate_evaluate_fix",
        id: "implement_from_bundle",
        brief: {
          objective: "Implement the supplied task packet."
        },
        task_source: {
          kind: "artifact_bundle",
          design_packet: {
            kind: "file",
            path: "artifacts/design-packet.json"
          }
        },
        context_policy: {
          allow_official_docs_fallback: true
        },
        strategy: {
          max_fix_cycles: 2,
          single_writer: false
        },
        evaluation: {
          commands: ["npm test"]
        },
        approval_policy: {
          require_execution_plan_approval: false
        },
        delivery: {
          write_handoff: false
        }
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "implement_from_bundle",
        managed_kind: "pattern_generate_evaluate_fix",
        lowered_to: "sequence"
      }
    ]);
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].approval_policy",
          message: 'Unknown field "approval_policy" is not part of the graph contract.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].delivery",
          message: 'Unknown field "delivery" is not part of the graph contract.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].strategy.single_writer",
          message: 'Unknown field "single_writer" is not part of the graph contract.'
        })
      ])
    );
  });

  it("rejects invalid pattern_generate_evaluate_fix source kinds and source reference kinds", () => {
    const normalized = normalizeAuthoredGraphDocument({
      ...buildEnvelope({
        type: "pattern_generate_evaluate_fix",
        id: "bad_kind",
        brief: {
          objective: "Implement the supplied task packet."
        },
        task_source: {
          kind: "unsupported"
        },
        context_policy: {},
        strategy: {},
        evaluation: {
          commands: ["npm test"]
        }
      }),
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "pattern_generate_evaluate_fix",
            id: "bad_kind",
            brief: {
              objective: "Implement the supplied task packet."
            },
            task_source: {
              kind: "unsupported"
            },
            context_policy: {},
            strategy: {},
            evaluation: {
              commands: ["npm test"]
            }
          },
          {
            type: "pattern_generate_evaluate_fix",
            id: "bad_ref",
            brief: {
              objective: "Implement the supplied task packet."
            },
            task_source: {
              kind: "artifact_bundle",
              design_packet: {
                kind: "unsupported"
              }
            },
            context_policy: {},
            strategy: {},
            evaluation: {
              commands: ["npm test"]
            }
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].task_source.kind",
          message: 'pattern_generate_evaluate_fix.task_source.kind must be "managed_node" or "artifact_bundle".'
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].task_source.design_packet.kind",
          message: 'pattern_generate_evaluate_fix task source reference kind must be "file" or "artifact".'
        })
      ])
    );
  });

  it("surfaces pattern_review_change source and delivery diagnostics", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "pattern_review_change",
        id: "review_bundle",
        review_source: {
          kind: "artifact_bundle",
          additional_context: "bad"
        },
        brief: {
          review_goal: "Review the change."
        },
        context_policy: "bad",
        strategy: "bad",
        delivery: {
          write_review_summary: false
        }
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].review_source.additional_context",
          message: "pattern_review_change.review_source.additional_context must be an array."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].review_source",
          message:
            "pattern_review_change.review_source artifact_bundle must include at least one of diff, summary, or additional_context."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].context_policy",
          message: "pattern_review_change.context_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].strategy",
          message: "pattern_review_change.strategy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].delivery.write_review_summary",
          message: 'Unknown field "write_review_summary" is not part of the graph contract.'
        })
      ])
    );
  });
});
