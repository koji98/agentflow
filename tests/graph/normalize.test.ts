import { describe, expect, it } from "vitest";

import { normalizeAuthoredGraphDocument as normalizeRawAuthoredGraphDocument } from "../../src/graph/normalize.js";

function normalizeAuthoredGraphDocument(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || "intent" in value) {
    return normalizeRawAuthoredGraphDocument(value);
  }

  return normalizeRawAuthoredGraphDocument({
    intent: {
      goal: "Test supervised graph contract."
    },
    ...value
  });
}

describe("graph normalization", () => {
  it("normalizes supervised v1 intent and supervision defaults", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "ship-trusted-change",
      intent: {
        goal: "Ship checkout timeout handling.",
        constraints: ["Keep public API names stable inside this repo."],
        acceptance_criteria: ["Targeted checkout tests pass.", "Reviewer guide names risky files."]
      },
      repos: {
        main: {
          path: "."
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "echo",
            command: "node",
            args: ["--version"]
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document).toEqual(
      expect.objectContaining({
        intent: {
          goal: "Ship checkout timeout handling.",
          constraints: ["Keep public API names stable inside this repo."],
          acceptance_criteria: ["Targeted checkout tests pass.", "Reviewer guide names risky files."]
        },
        supervision: { max_total_interventions: 3 }
      })
    );
  });

  it("rejects legacy supervision action and policy fields", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "legacy-supervision",
      supervision: {
        actions: {
          retry_with_guidance: { max_uses: 1 }
        },
        max_total_interventions: 3,
        policy: {
          pause_on_policy_risk: true
        }
      },
      repos: {
        main: {
          path: "."
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "echo",
            command: "node",
            args: ["--version"]
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        {
          path: "$.supervision.actions",
          message: 'Unknown field "actions" is not part of the graph contract.'
        },
        {
          path: "$.supervision.policy",
          message: 'Unknown field "policy" is not part of the graph contract.'
        }
      ])
    );
  });

  it("rejects supervision profiles that do not exist", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "unknown-supervisor-profile",
      supervision: {
        profile: "supervisor",
        max_total_interventions: 3
      },
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
            type: "exec",
            id: "echo",
            command: "node",
            args: ["--version"]
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        {
          path: "$.supervision.profile",
          message: 'supervision.profile references unknown profile "supervisor".'
        }
      ])
    );
  });

  it("rejects graphs without supervised intent", () => {
    const normalized = normalizeRawAuthoredGraphDocument({
      version: "1",
      graph_id: "missing-intent",
      repos: {
        main: {
          path: "."
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: []
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        {
          path: "$.intent.goal",
          message: "Expected a non-empty string."
        }
      ])
    );
  });

  it("rejects removed prompt and delivery authoring fields", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "removed-fields",
      delivery: {
        required_sections: ["task_brief"]
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "legacy",
            prompt: "Do the old thing."
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        {
          path: "$.delivery",
          message: 'Unknown field "delivery" is not part of the graph contract.'
        },
        {
          path: "$.graph.steps[0].prompt",
          message: 'Unknown field "prompt" is not part of the graph contract.'
        },
        {
          path: "$.graph.steps[0].goal",
          message: "Agent nodes require goal."
        }
      ])
    );
  });

  it("normalizes agent node goals and acceptance criteria without requiring a prompt", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "node-intent-contract",
      repos: {
        main: {
          path: "."
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "implement",
            goal: "Implement timeout handling with clear reviewer evidence.",
            acceptance_criteria: [
              "Checkout timeout tests pass.",
              "The handoff explains changed files and residual risks."
            ],
            artifacts: {
              handoff: {
                from: "output_dir",
                path: "handoff.md",
                description: "Human review handoff."
              }
            }
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document?.graph).toEqual(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            type: "agent",
            id: "implement",
            goal: "Implement timeout handling with clear reviewer evidence.",
            acceptance_criteria: [
              "Checkout timeout tests pass.",
              "The handoff explains changed files and residual risks."
            ]
          })
        ]
      })
    );
  });

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
            goal: "Inspect the repository."
          },
          {
            type: "parallel",
            id: "fanout",
            steps: [
              {
                type: "agent",
                id: "fix",
                goal: "Repair the issue."
              },
              {
                type: "agent",
                id: "handoff",
                goal: "Summarize the work.",
                context: [
                  {
                    ref: "inspect.agent_response",
                    name: "inspect_response",
                    iteration: 1,
                    attempt: "latest_failed",
                    if_available: true
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
        goal: "Inspect the repository."
      })
    );

    if (!fanout || fanout.type !== "parallel") {
      throw new Error("Expected second normalized node to be a parallel container.");
    }

    expect(fanout.steps[0]).toEqual(
      expect.objectContaining({
        type: "agent",
        id: "fix",
        goal: "Repair the issue."
      })
    );
    expect(fanout.steps[1]).toEqual(
      expect.objectContaining({
        type: "agent",
        id: "handoff",
        context: [
          {
            ref: "inspect.agent_response",
            name: "inspect_response",
            node: "inspect",
            artifact: "agent_response",
            iteration: 1,
            attempt: "latest_failed",
            if_available: true
          }
        ]
      })
    );
  });

  it("rejects unsupported data-flow fields as unknown graph syntax", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "removed-data-flow",
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
            type: "agent",
            id: "bad",
            goal: "Legacy fields.",
            inputs: [],
            context_from: [],
            outputs: []
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].inputs",
          message: 'Unknown field "inputs" is not part of the graph contract.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].context_from",
          message: 'Unknown field "context_from" is not part of the graph contract.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].outputs",
          message: 'Unknown field "outputs" is not part of the graph contract.'
        })
      ])
    );
  });

  it("rejects unsupported data-flow fields on managed patterns too", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "removed-managed-data-flow",
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
            type: "pattern_deep_work",
            id: "implement",
            goal: "Implement the requested change.",
            completion: {
              criteria: [
                {
                  id: "focused_tests",
                  kind: "command",
                  command: "npm test",
                  weight: 1
                }
              ]
            },
            inputs: [],
            context_from: [],
            outputs: []
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].inputs",
          message: 'Unknown field "inputs" is not part of the graph contract.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].context_from",
          message: 'Unknown field "context_from" is not part of the graph contract.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].outputs",
          message: 'Unknown field "outputs" is not part of the graph contract.'
        })
      ])
    );
  });

  it("rejects optional on artifact context as unknown graph syntax", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "removed-artifact-context-optional",
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
            type: "agent",
            id: "consume",
            goal: "Consume a prior response.",
            context: [
              {
                ref: "inspect.agent_response",
                name: "prior_response",
                node: "inspect",
                artifact: "agent_response",
                // @ts-expect-error optional was removed from the artifact context contract
                optional: true
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
          path: "$.graph.steps[0].context[0].optional",
          message: 'Unknown field "optional" is not part of the graph contract.'
        })
      ])
    );
  });

  it("rejects user-declared artifacts that collide with reserved automatic artifacts", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "reserved-artifacts",
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
            type: "agent",
            id: "bad",
            goal: "Try to redefine automatic artifacts.",
            artifacts: {
              agent_response: {
                from: "output_dir",
                path: "agent-response.md"
              },
              verification_json: {
                from: "output_dir",
                path: "verification.json",
                description: "Reserved verification payload."
              }
            }
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].artifacts.agent_response",
          message: 'Artifact name "agent_response" is reserved by Agentflow.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].artifacts.verification_json",
          message: 'Artifact name "verification_json" is reserved by Agentflow.'
        })
      ])
    );
  });

  it("requires artifact descriptions and rejects removed artifact required flags", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "artifact-descriptions",
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
            type: "agent",
            id: "bad",
            goal: "Write a packet.",
            artifacts: {
              packet: {
                from: "output_dir",
                path: "packet.json",
                required: true
              }
            }
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].artifacts.packet.required",
          message: 'Unknown field "required" is not part of the graph contract.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].artifacts.packet.description",
          message: "Expected a non-empty string."
        })
      ])
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
            "Node type must be one of: agent, exec, check, checkpoint, sequence, parallel, repeat, pattern_deep_research, pattern_deep_work."
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
            goal: "Inspect the repository.",
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

  it("normalizes artifact repair policy on profiles and agent nodes", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "artifact-repair-policy",
      repos: {
        main: {
          path: "."
        }
      },
      profiles: {
        default: {
          harness: "codex-cli",
          artifact_repair: {
            max_attempts: 2
          }
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "write_handoff",
            goal: "Write the handoff.",
            artifact_repair: {
              max_attempts: 0
            }
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document?.profiles?.default.artifact_repair).toEqual({
      max_attempts: 2
    });

    const graph = normalized.document?.graph;
    if (!graph || graph.type !== "sequence" || graph.steps[0]?.type !== "agent") {
      throw new Error("Expected normalized graph to contain an agent step.");
    }

    expect(graph.steps[0].artifact_repair).toEqual({
      max_attempts: 0
    });
  });

  it("rejects invalid artifact repair policy syntax", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "bad-artifact-repair-policy",
      repos: {
        main: {
          path: "."
        }
      },
      profiles: {
        default: {
          harness: "codex-cli",
          artifact_repair: {
            max_attempts: 4
          }
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "write_handoff",
            goal: "Write the handoff.",
            artifact_repair: {
              max_attempts: -1
            }
          },
          {
            type: "exec",
            id: "run_tests",
            command: "npm",
            artifact_repair: {
              max_attempts: 1
            }
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.profiles.default.artifact_repair.max_attempts",
          message: "Expected an integer between 0 and 3."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].artifact_repair.max_attempts",
          message: "Expected an integer between 0 and 3."
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].artifact_repair",
          message: 'Unknown field "artifact_repair" is not part of the graph contract.'
        })
      ])
    );
  });

  it("normalizes prerequisites and soft verification settings", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "soft-verify-prereqs",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {}
      },
      prerequisites: {
        checks: [
          {
            kind: "command",
            command: "git"
          },
          {
            kind: "file",
            path: "main:README.md",
            required: false
          },
          {
            kind: "env",
            name: "HOME"
          },
          {
            kind: "repo",
            repo: "main"
          }
        ]
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "capture_command",
            command: "sh",
            on_failure: "continue"
          },
          {
            type: "check",
            id: "capture_check",
            check_kind: "deterministic",
            command: "sh",
            on_failure: "continue"
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document?.prerequisites).toEqual({
      checks: [
        {
          kind: "command",
          command: "git"
        },
        {
          kind: "file",
          path: "main:README.md",
          required: false
        },
        {
          kind: "env",
          name: "HOME"
        },
        {
          kind: "repo",
          repo: "main"
        }
      ]
    });

    const graph = normalized.document?.graph;
    if (!graph || graph.type !== "sequence") {
      throw new Error("Expected normalized graph to be a sequence.");
    }

    expect(graph.steps[0]).toEqual(
      expect.objectContaining({
        type: "exec",
        id: "capture_command",
        on_failure: "continue"
      })
    );
    expect(graph.steps[1]).toEqual(
      expect.objectContaining({
        type: "check",
        id: "capture_check",
        on_failure: "continue"
      })
    );
  });

  it("normalizes env_files on profiles and local command nodes", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "env-files",
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
          env_files: [".env", ".env.development"]
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "run_script",
            command: "npm",
            args: ["test"],
            env_files: [".env.test"]
          },
          {
            type: "check",
            id: "verify",
            check_kind: "deterministic",
            command: "npm",
            args: ["test"],
            env_files: []
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document?.profiles?.default.env_files).toEqual([".env", ".env.development"]);

    const graph = normalized.document?.graph;
    if (!graph || graph.type !== "sequence") {
      throw new Error("Expected normalized graph to be a sequence.");
    }

    expect(graph.steps[0]).toEqual(
      expect.objectContaining({
        env_files: [".env.test"]
      })
    );
    expect(graph.steps[1]).toEqual(
      expect.objectContaining({
        env_files: []
      })
    );
  });

  it("rejects env_files on AI checks", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "ai-env-files",
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
            type: "check",
            id: "judge",
            check_kind: "ai",
            goal: "Judge it.",
            env_files: [".env"]
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].env_files",
          message: 'Field "env_files" does not apply to AI checks.'
        })
      ])
    );
  });

  it("rejects byte-based input_rules fields", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "reject-byte-input-rules",
      repos: {
        main: {
          path: "."
        }
      },
      profiles: {
        default: {
          harness: "codex-cli",
          input_rules: {
            max_total_bytes: 262144,
            max_bytes_per_item: 131072
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
            goal: "Inspect the repo."
          }
        ]
      }
    });

    expect(normalized.document).toBeUndefined();
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.profiles.default.input_rules.max_bytes_per_item",
          message: 'Unknown field "max_bytes_per_item" is not part of the graph contract.'
        }),
        expect.objectContaining({
          path: "$.profiles.default.input_rules.max_total_bytes",
          message: 'Unknown field "max_total_bytes" is not part of the graph contract.'
        })
      ])
    );
  });

  it("rejects input_rules.max_files and points authors to token budgets or glob-local caps", () => {
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
            max_total_tokens: 64000
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
            goal: "Inspect the repo."
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
            "input_rules.max_files is no longer supported. Use input_rules.max_total_tokens for global context budgets and glob.max_files to cap specific globs."
        })
      ])
    );
  });

  it("synthesizes a default repos block when omitted", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "default-repos",
      profiles: {
        default: {
          harness: "cursor-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [{ type: "exec", id: "noop", command: "true" }]
      }
    } as never);

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document?.repos).toEqual({ main: { path: "." } });
  });

  it("defaults workspace_backend to inplace when omitted", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "default-workspace-backend",
      repos: { main: { path: "." } },
      profiles: {
        default: {
          harness: "cursor-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [{ type: "exec", id: "noop", command: "true" }]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document?.defaults?.workspace_backend).toBe("inplace");
  });

  it("defaults launch_profile to default when a default profile exists", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "default-launch-profile",
      repos: { main: { path: "." } },
      profiles: {
        default: {
          harness: "cursor-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [{ type: "exec", id: "noop", command: "true" }]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document?.defaults?.launch_profile).toBe("default");
  });

  it("does not synthesize launch_profile when no default profile exists", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "no-default-profile",
      repos: { main: { path: "." } },
      profiles: {
        review: {
          harness: "cursor-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [{ type: "exec", id: "noop", command: "true" }]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document?.defaults?.launch_profile).toBeUndefined();
  });

  it("derives node and artifact from a dotted ref while accepting bare-node refs", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "ref-derivation",
      repos: { main: { path: "." } },
      profiles: { default: { harness: "cursor-cli" } },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "produce",
            command: "true"
          },
          {
            type: "agent",
            id: "consume",
            goal: "Consume earlier outputs.",
            context: [
              { ref: "produce.stdout" } as never,
              { ref: "produce" } as never
            ]
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual([]);
    const consume = (normalized.document?.graph as { steps: Array<{ context?: unknown }> }).steps[1];
    expect((consume as { context: unknown[] }).context).toEqual([
      expect.objectContaining({
        ref: "produce.stdout",
        node: "produce",
        artifact: "stdout",
        name: "stdout"
      }),
      expect.objectContaining({
        ref: "produce",
        node: "produce",
        artifact: "stdout",
        name: "produce"
      })
    ]);
  });

  it("rejects bare-node context refs that point at a missing node", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "ref-missing-node",
      repos: { main: { path: "." } },
      profiles: { default: { harness: "cursor-cli" } },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "consume",
            goal: "Consume.",
            context: [
              { ref: "ghost" } as never
            ]
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('unknown node "ghost"')
        })
      ])
    );
  });

  it("rejects two context items that resolve to the same default name", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "ref-collision",
      repos: { main: { path: "." } },
      profiles: { default: { harness: "cursor-cli" } },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          { type: "exec", id: "left", command: "true" },
          { type: "exec", id: "right", command: "true" },
          {
            type: "agent",
            id: "merge",
            goal: "Merge both stdouts.",
            context: [
              { ref: "left.stdout" } as never,
              { ref: "right.stdout" } as never
            ]
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/duplicate context item name|collision/i)
        })
      ])
    );
  });

  it("rejects artifact keys that contain a dot", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "dot-in-artifact",
      repos: { main: { path: "." } },
      profiles: { default: { harness: "cursor-cli" } },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "produce",
            goal: "Write artifacts.",
            artifacts: {
              "bad.name": {
                from: "output_dir",
                path: "bad.json",
                description: "An artifact whose key contains a dot."
              }
            }
          }
        ]
      }
    });

    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/dot|reserved|separator/i)
        })
      ])
    );
  });
});
