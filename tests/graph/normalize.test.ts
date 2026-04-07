import { describe, expect, it } from "vitest";

import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";

describe("graph normalization", () => {
  it("preserves primitive agent nodes and authored selectors", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "primitive-agents",
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
          harness: "codex-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "inspect",
            prompt: "Inspect the repository."
          },
          {
            type: "parallel",
            id: "fanout",
            steps: [
              {
                type: "agent",
                id: "fix",
                prompt: "Repair the issue."
              },
              {
                type: "agent",
                id: "handoff",
                prompt: "Summarize the work.",
                context_from: [
                  {
                    node: "inspect",
                    include: "summary",
                    iteration: 1,
                    attempt: "latest_failed",
                    optional: true
                  }
                ]
              }
            ]
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([]);

    const graph = normalized.document?.graph;
    expect(graph?.type).toBe("sequence");

    if (!graph || graph.type !== "sequence") {
      throw new Error("Expected normalized graph to be a sequence.");
    }

    const inspect = graph.steps[0];
    const fanout = graph.steps[1];

    expect(inspect).toEqual(
      expect.objectContaining({
        type: "agent",
        id: "inspect",
        prompt: "Inspect the repository."
      })
    );

    if (!fanout || fanout.type !== "parallel") {
      throw new Error("Expected second normalized node to be a parallel container.");
    }

    expect(fanout.steps[0]).toEqual(
      expect.objectContaining({
        type: "agent",
        id: "fix",
        prompt: "Repair the issue."
      })
    );
    expect(fanout.steps[1]).toEqual(
      expect.objectContaining({
        type: "agent",
        id: "handoff",
        context_from: [
          {
            node: "inspect",
            include: "summary",
            iteration: 1,
            attempt: "latest_failed",
            optional: true
          }
        ]
      })
    );
  });

  it("rejects executable top-level graphs instead of producing a document", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "top-level-exec",
      repos: {
        main: {
          path: "."
        }
      },
      profiles: {
        default: {
          harness: "codex-cli"
        }
      },
      graph: {
        type: "exec",
        id: "run_tests",
        command: "npm"
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.lowered_managed_nodes).toEqual([]);
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.type",
          message: "Top-level graph must be a container node."
        })
      ])
    );
  });

  it("rejects unknown node kinds and non-object graph documents", () => {
    const unknownNode = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "unknown-node",
      repos: {
        main: {
          path: "."
        }
      },
      profiles: {
        default: {
          harness: "codex-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "mystery_node",
            id: "bad"
          }
        ]
      }
    });

    expect(unknownNode.document).toBeUndefined();
    expect(unknownNode.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].type",
          message:
            "Node type must be one of: agent, exec, check, checkpoint, sequence, parallel, repeat, deep_research, spec_design, execute_spec, review_change."
        })
      ])
    );

    const nonObject = normalizeAuthoredGraphDocument(null);

    expect(nonObject.document).toBeUndefined();
    expect(nonObject.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$",
          message: "Graph document must be a JSON object."
        })
      ])
    );
  });

  it("accepts xhigh as a supported reasoning effort", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "xhigh-reasoning",
      repos: {
        main: {
          path: "."
        }
      },
      profiles: {
        default: {
          harness: "codex-cli",
          reasoning_effort: "xhigh"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "inspect",
            prompt: "Inspect the repository.",
            reasoning_effort: "xhigh"
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document?.profiles?.default?.reasoning_effort).toBe("xhigh");

    const graph = normalized.document?.graph;
    if (!graph || graph.type !== "sequence" || graph.steps[0]?.type !== "agent") {
      throw new Error("Expected normalized graph to contain an agent step.");
    }

    expect(graph.steps[0].reasoning_effort).toBe("xhigh");
  });

  it("rejects input_rules.max_files and points authors to byte budgets or glob-local caps", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "reject-input-max-files",
      repos: {
        main: {
          path: "."
        }
      },
      profiles: {
        default: {
          harness: "codex-cli",
          input_rules: {
            max_files: 8,
            max_total_bytes: 262144
          }
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "inspect",
            prompt: "Inspect the repo."
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.profiles.default.input_rules.max_files",
          message:
            "input_rules.max_files is no longer supported. Use input_rules.max_total_bytes for global context budgets and glob.max_files to cap specific globs."
        })
      ])
    );
  });
});
