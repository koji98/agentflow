import { describe, expect, it } from "vitest";

import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";

function buildEnvelope(step) {
  return {
    version: "1",
    graph_id: "managed-validation",
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

describe("managed workflow normalization edges", () => {
  it("falls back through deep_research optional objects while surfacing diagnostics", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "deep_research",
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
          message: "deep_research.context_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].approval_policy",
          message: "deep_research.approval_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].strategy",
          message: "deep_research.strategy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].delivery",
          message: "deep_research.delivery must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].runtime",
          message: "managed workflow runtime must be an object."
        })
      ])
    );
  });

  it("falls back through spec_design optional objects while surfacing diagnostics", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "spec_design",
        id: "managed_nodes_spec",
        brief: {
          problem: "Managed workflows are too thin.",
          goal: "Design a real workflow model.",
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
          message: "spec_design.scope must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].context_policy",
          message: "spec_design.context_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].approval_policy",
          message: "spec_design.approval_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].strategy",
          message: "spec_design.strategy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].delivery",
          message: "spec_design.delivery must be an object."
        })
      ])
    );
  });

  it("surfaces execute_spec strategy and delivery diagnostics while still lowering the node", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "execute_spec",
        id: "implement_from_bundle",
        brief: {
          objective: "Implement the supplied spec."
        },
        spec_source: {
          kind: "artifact_bundle",
          design_spec: {
            kind: "file",
            path: "docs/spec.md"
          }
        },
        context_policy: {
          allow_official_docs_fallback: true
        },
        approval_policy: {
          require_execution_plan_approval: false
        },
        strategy: {
          single_writer: false,
          allow_readonly_recon: true,
          max_repair_cycles: 2
        },
        validation: {
          commands: ["npm test"]
        },
        delivery: {
          write_handoff: false,
          write_validation_ledger: false,
          write_repair_log: false
        }
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].strategy.single_writer",
          message:
            "execute_spec currently supports only single_writer = true; the workflow will still compile as a single-writer executor."
        })
      ])
    );
  });

  it("rejects invalid execute_spec source kinds and source reference kinds", () => {
    const normalized = normalizeAuthoredGraphDocument({
      ...buildEnvelope({
        type: "execute_spec",
        id: "bad_kind",
        brief: {
          objective: "Implement the supplied spec."
        },
        spec_source: {
          kind: "unsupported"
        },
        context_policy: {},
        approval_policy: {},
        strategy: {},
        validation: {
          commands: ["npm test"]
        },
        delivery: {
          write_handoff: true
        }
      }),
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "execute_spec",
            id: "bad_kind",
            brief: {
              objective: "Implement the supplied spec."
            },
            spec_source: {
              kind: "unsupported"
            },
            context_policy: {},
            approval_policy: {},
            strategy: {},
            validation: {
              commands: ["npm test"]
            },
            delivery: {
              write_handoff: true
            }
          },
          {
            type: "execute_spec",
            id: "bad_ref",
            brief: {
              objective: "Implement the supplied spec."
            },
            spec_source: {
              kind: "artifact_bundle",
              design_spec: {
                kind: "unsupported"
              }
            },
            context_policy: {},
            approval_policy: {},
            strategy: {},
            validation: {
              commands: ["npm test"]
            },
            delivery: {
              write_handoff: true
            }
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].spec_source.kind",
          message: 'execute_spec.spec_source.kind must be "managed_node" or "artifact_bundle".'
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].spec_source.design_spec.kind",
          message: 'execute_spec spec source reference kind must be "file" or "managed_output".'
        })
      ])
    );
  });

  it("surfaces review_change source and delivery diagnostics", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "review_change",
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
          write_review_summary: false,
          write_raw_findings: false,
          write_calibrated_findings: false
        }
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].review_source.additional_context",
          message: "review_change.review_source.additional_context must be an array."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].review_source",
          message:
            "review_change.review_source artifact_bundle must include at least one of diff, summary, or additional_context."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].context_policy",
          message: "review_change.context_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].strategy",
          message: "review_change.strategy must be an object."
        })
      ])
    );
  });
});
