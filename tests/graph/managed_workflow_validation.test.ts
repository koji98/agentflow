import { describe, expect, it } from "vitest";

import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";

describe("managed workflow normalization edges", () => {
  it("falls back through deep_research optional objects while surfacing diagnostics", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "deep-research-validation-edges",
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
            type: "deep_research",
            id: "market_scan",
            question: "How should Agentflow design deep research?",
            objective: "Produce a design recommendation.",
            sources: "bad",
            deliverable: "bad",
            orchestration: {
              track_count: 2,
              max_parallel_tracks: 5,
              summary_fan_in: 1
            }
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].sources",
          message: "deep_research.sources must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].deliverable",
          message: "deep_research.deliverable must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].orchestration.summary_fan_in",
          message: "deep_research.orchestration.summary_fan_in must be at least 2."
        })
      ])
    );
  });

  it("falls back through spec_design optional objects while surfacing diagnostics", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "spec-design-validation-edges",
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
            scope: "bad",
            research_policy: "bad",
            deliverable: "bad",
            orchestration: "bad"
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].scope",
          message: "spec_design.scope must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].research_policy",
          message: "spec_design.research_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].deliverable",
          message: "spec_design.deliverable must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].orchestration",
          message: "spec_design.orchestration must be an object."
        })
      ])
    );
  });

  it("surfaces execute_spec validation and optional-object diagnostics while still lowering the node", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "execute-spec-validation-edges",
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
            scope: "bad",
            execution_policy: "bad",
            validation: "bad",
            implementation_research: "bad",
            delivery: "bad"
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].scope",
          message: "execute_spec.scope must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].execution_policy",
          message: "execute_spec.execution_policy must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].validation",
          message: "execute_spec.validation must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].implementation_research",
          message: "execute_spec.implementation_research must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].delivery",
          message: "execute_spec.delivery must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].validation.commands",
          message: "execute_spec.validation.commands must include at least one command."
        })
      ])
    );
  });

  it("rejects invalid execute_spec source kinds and source reference kinds", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "execute-spec-invalid-source-kinds",
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
            id: "bad_kind",
            spec_source: {
              kind: "unsupported"
            },
            validation: {
              commands: ["npm test"]
            }
          },
          {
            type: "execute_spec",
            id: "bad_ref",
            spec_source: {
              kind: "artifact_bundle",
              design_spec: {
                kind: "unsupported"
              }
            },
            validation: {
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

  it("surfaces review_change source and optional-object diagnostics", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "review-change-validation-edges",
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
              additional_context: "bad"
            },
            scope: "bad",
            criteria: "bad",
            orchestration: "bad",
            delivery: "bad",
            outputs: [
              {
                name: "custom_review",
                from: "attempt",
                path: "custom-review.md",
                required: true
              }
            ]
          }
        ]
      }
    });

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
          path: "$.graph.steps[0].scope",
          message: "review_change.scope must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].criteria",
          message: "review_change.criteria must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].orchestration",
          message: "review_change.orchestration must be an object."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].delivery",
          message: "review_change.delivery must be an object."
        })
      ])
    );
  });

  it("rejects invalid review_change source kinds and source reference kinds", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "review-change-invalid-source-kinds",
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
            id: "bad_kind",
            review_source: {
              kind: "unsupported"
            },
            outputs: [
              {
                name: "custom_review",
                from: "attempt",
                path: "custom-review.md",
                required: true
              }
            ]
          },
          {
            type: "review_change",
            id: "bad_ref",
            review_source: {
              kind: "artifact_bundle",
              summary: {
                kind: "unsupported"
              }
            },
            outputs: [
              {
                name: "custom_review",
                from: "attempt",
                path: "custom-review.md",
                required: true
              }
            ]
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].review_source.kind",
          message: 'review_change.review_source.kind must be "managed_node" or "artifact_bundle".'
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].review_source.summary.kind",
          message: 'review_change source reference kind must be "file" or "managed_output".'
        })
      ])
    );
  });
});
