import { describe, expect, it } from "vitest";

import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";

function buildEnvelope(step) {
  return {
    version: "1",
    graph_id: "managed-pattern-validation",
    intent: {
      goal: "Validate managed pattern contracts.",
      acceptance_criteria: ["Managed pattern diagnostics match the authored contract."]
    },
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
      },
      supervisor: {
        harness: "codex-cli",
        sandbox: "read-only"
      }
    },
    supervision: {
      profile: "supervisor",
      max_total_interventions: 3
    },
    graph: {
      type: "sequence",
      id: "root",
      steps: [step]
    }
  };
}

describe("managed pattern normalization edges", () => {
  it("rejects old managed pattern kinds instead of keeping compatibility shims", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "pattern_generate_evaluate_fix",
        id: "legacy",
        goal: "Legacy pattern should be rejected."
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].type",
          message:
            "Node type must be one of: agent, exec, check, checkpoint, sequence, parallel, repeat, pattern_deep_research, pattern_deep_work."
        })
      ])
    );
  });

  it("validates deep research angles as required sentence-style prompts", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "pattern_deep_research",
        id: "market_scan",
        intent: {
          goal: "Research a managed pattern change.",
          acceptance_criteria: ["The node satisfies its acceptance criteria."],
          constraints: []
        },
        research: {
          angles: ["architecture"]
        }
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].research.angles[0]",
          message: "Research angles should be sentence-style prompts, not one-word axes."
        })
      ])
    );
  });

  it("rejects obsolete deep research public axis artifact references", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "pattern_deep_research",
        id: "market_scan",
        intent: {
          goal: "Research a managed pattern change.",
          acceptance_criteria: ["The node satisfies its acceptance criteria."],
          constraints: []
        },
        research: {
          angles: [
            {
              id: "architecture",
              prompt: "Assess whether the implementation follows the local architecture.",
              public_artifact: "missing_axis"
            }
          ]
        }
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].research.angles[0].public_artifact",
          message: 'Unknown field "public_artifact" is not part of the graph contract.'
        })
      ])
    );
  });

  it("rejects authored artifacts on deep research managed patterns", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "pattern_deep_research",
        id: "market_scan",
        intent: {
          goal: "Research a managed pattern change.",
          acceptance_criteria: ["The node satisfies its acceptance criteria."],
          constraints: []
        },
        research: {
          angles: [
            {
              id: "architecture",
              prompt: "Assess whether the implementation follows the local architecture.",
              as_artifact: true
            }
          ]
        },
        artifacts: {
          custom: {
            from: "output_dir",
            path: "custom.md",
            description: "Custom deep research artifact."
          }
        }
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].artifacts",
          message: "pattern_deep_research publishes only summary, packet, and angle reports selected with as_artifact."
        })
      ])
    );
  });

  it("validates deep work completion criteria and public artifact references", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "pattern_deep_work",
        id: "implement",
        intent: {
          goal: "Implement a change.",
          acceptance_criteria: ["The managed deep work node publishes a valid summary and packet."],
          constraints: []
        },
        completion: {
          pass_threshold: 0.9,
          criteria: [
            {
              id: "focused_tests",
              kind: "command",
              command: "npm test",
              weight: 0.7,
              required: true
            },
            {
              id: "handoff_quality",
              kind: "rubric",
              target: "artifact:missing",
              rubric: "The artifact explains the result.",
              weight: 0.2
            }
          ]
        }
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].completion.criteria[1].target",
          message: 'rubric criterion target references unknown public artifact "missing".'
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].completion.criteria",
          message: "Completion criterion weights must sum to 1. Current total is 0.7."
        })
      ])
    );
  });

  it("accepts default public artifacts for targeted deep work rubrics", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "pattern_deep_work",
        id: "implement",
        intent: {
          goal: "Implement a change.",
          acceptance_criteria: ["The managed deep work node publishes a valid summary and packet."],
          constraints: []
        },
        completion: {
          criteria: [
            {
              id: "focused_tests",
              kind: "command",
              command: "npm test",
              weight: 0.5,
              required: true
            },
            {
              id: "summary_quality",
              kind: "rubric",
              target: "artifact:summary",
              rubric: "The summary explains validation evidence.",
              weight: 0.5
            }
          ]
        }
      })
    );

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "implement",
        managed_kind: "pattern_deep_work",
        lowered_to: "sequence"
      }
    ]);
  });

  it("rejects removed deep work artifact_rubric criteria", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildEnvelope({
        type: "pattern_deep_work",
        id: "implement",
        intent: {
          goal: "Implement a change.",
          acceptance_criteria: ["The managed deep work node publishes a valid summary and packet."],
          constraints: []
        },
        completion: {
          criteria: [
            {
              id: "focused_tests",
              kind: "command",
              command: "npm test",
              weight: 0.5,
              required: true
            },
            {
              id: "summary_quality",
              kind: "artifact_rubric",
              artifact: "summary",
              rubric: "The summary explains validation evidence.",
              weight: 0.5
            }
          ]
        }
      })
    );

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].completion.criteria[1].kind",
          message: "Expected one of: command, rubric."
        })
      ])
    );
  });
});
