import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { builtInCodexReasoningEffort, resolveLaunchConfig } from "../../src/graph/profiles.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/repeat.graph.json", import.meta.url)
);

async function readFixture(): Promise<unknown> {
  const contents = await readFile(fixturePath, "utf8");
  return JSON.parse(contents) as unknown;
}

describe("graph compilation", () => {
  it("compiles the repeat fixture into explicit nodes, scopes, and repeat edges", async () => {
    const normalized = normalizeAuthoredGraphDocument(await readFixture());
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(
      normalized.document!,
      launch,
      normalized.lowered_managed_nodes
    );

    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.compiled_graph).toBeDefined();

    const compiledGraph = compilation.compiled_graph!;
    const verifyFixId = "root__repair_loop__repair_body__verify_fix";
    const implementFixId = "root__repair_loop__repair_body__implement_fix";
    const repairNotes = compiledGraph.nodes.find((node) => node.authored_id === "repair_notes");
    const understand = compiledGraph.nodes.find((node) => node.authored_id === "understand");

    expect(compiledGraph.entry_node_ids).toEqual(["root__understand"]);
    expect(compiledGraph.nodes).toHaveLength(7);
    expect(compiledGraph.scopes).toHaveLength(4);
    expect(compiledGraph.authored_to_compiled.verify_fix).toEqual([verifyFixId]);
    expect(compiledGraph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: verifyFixId,
          to: implementFixId,
          on: "failed",
          kind: "repeat-back",
          repeat_scope_id: "scope__root__repair_loop"
        }),
        expect.objectContaining({
          from: verifyFixId,
          to: "root__handoff",
          on: "passed",
          kind: "flow"
        })
      ])
    );

    expect(compiledGraph.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope_id: "scope__root__repair_loop",
          kind: "repeat",
          until_compiled_id: verifyFixId,
          body_entry_node_ids: [implementFixId],
          body_exit_node_ids: [verifyFixId]
        })
      ])
    );
    expect(repairNotes).toEqual(
      expect.objectContaining({
        kind: "agent",
        repeat_scope_id: "scope__root__repair_loop",
        effective_policy: expect.objectContaining({
          profile_name: "review",
          harness: "cursor-cli",
          sandbox: "read-only"
        })
      })
    );
    expect(understand).toEqual(
      expect.objectContaining({
        kind: "agent"
      })
    );
  });

  it("compiles repeat checkpoints into executable nodes with repeat-back edges", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "checkpoint-repeat-compile",
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
            type: "repeat",
            id: "retry",
            max_attempts: 3,
            body: {
              type: "sequence",
              id: "body",
              steps: [
                {
                  type: "agent",
                  id: "draft",
                  prompt: "Draft the artifact.",
                  artifacts: {
                    draft_spec: {
                      from: "output_dir",
                      path: "draft.md",
                      description: "Test artifact produced at draft.md."
                    }
                  }
                },
                {
                  type: "checkpoint",
                  id: "review",
                  prompt: "Review the draft.",
                  review_from: {
                    node: "draft",
                    artifact: "draft_spec"
                  }
                }
              ]
            },
            until: {
              node: "review"
            }
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

    const compiledGraph = compilation.compiled_graph!;
    const reviewId = "root__retry__body__review";

    expect(compiledGraph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          compiled_id: reviewId,
          kind: "checkpoint",
          review_from: expect.objectContaining({
            node: "draft",
            artifact: "draft_spec"
          })
        })
      ])
    );
    expect(compiledGraph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: reviewId,
          to: "root__retry__body__draft",
          on: "failed",
          kind: "repeat-back",
          repeat_scope_id: "scope__root__retry"
        })
      ])
    );
    expect(compiledGraph.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope_id: "scope__root__retry",
          kind: "repeat",
          until_compiled_id: reviewId,
          body_exit_node_ids: [reviewId]
        })
      ])
    );
  });

  it("requires iteration selectors for references that leave a repeat scope", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "ambiguous-repeat-ref",
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
            type: "repeat",
            id: "retry",
            max_attempts: 2,
            body: {
              type: "sequence",
              id: "body",
              steps: [
                {
                  type: "agent",
                  id: "fix",
                  prompt: "Apply the fix."
                },
                {
                  type: "check",
                  id: "verify",
                  check_kind: "deterministic",
                  command: "npm"
                }
              ]
            },
            until: {
              node: "verify"
            }
          },
          {
            type: "agent",
            id: "handoff",
            prompt: "Summarize the run.",
            context: [
              {
                ref: "fix.agent_response",
                name: "fix_response",
                node: "fix",
                artifact: "agent_response"
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

    expect(compilation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("context[0].iteration"),
          message: expect.stringContaining("latest_failed")
        })
      ])
    );
  });

  it("names the actual repeat body exit when repeat.until resolves before the body exit", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "repeat-body-exit-mismatch",
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
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "repeat",
            id: "retry",
            max_attempts: 2,
            body: {
              type: "sequence",
              id: "body",
              steps: [
                {
                  type: "check",
                  id: "verify",
                  check_kind: "deterministic",
                  command: "sh"
                },
                {
                  type: "agent",
                  id: "summarize",
                  prompt: "Summarize the latest attempt."
                }
              ]
            },
            until: {
              node: "verify"
            }
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

    expect(compilation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].until.node",
          message: expect.stringContaining('currently exits through "summarize"')
        })
      ])
    );
  });

  it("rejects parallel sibling context references that are not ordered by the graph", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "parallel-context-gap",
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
            type: "parallel",
            id: "fanout",
            steps: [
              {
                type: "agent",
                id: "inspect",
                prompt: "Inspect the repo."
              },
              {
                type: "agent",
                id: "report",
                prompt: "Write the report.",
                context: [
                  {
                    ref: "inspect.agent_response",
                    name: "inspect_response",
                    node: "inspect",
                    artifact: "agent_response"
                  }
                ]
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

    expect(compilation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("context[0].node"),
          message: expect.stringContaining("not guaranteed to execute before")
        })
      ])
    );
  });

  it("resolves check-specific profile defaults and forces AI checks into read-only mode", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "check-profile-defaults",
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
          model: "gpt-5-codex",
          sandbox: "workspace-write",
          env_files: [".env.defaults"],
          deterministic_check_defaults: {
            pass_if: {
              exit_code: 3
            }
          },
          ai_check_defaults: {
            model: "gpt-5-judge",
            rubric: "Be strict."
          }
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "profile_env_command",
            command: "node"
          },
          {
            type: "check",
            id: "local_gate",
            check_kind: "deterministic",
            command: "npm",
            env_files: [".env.local"],
            env: {
              ACCESS_E2E_ALPHA_ADMIN_USER_ID: "user_123"
            }
          },
          {
            type: "check",
            id: "ai_gate",
            check_kind: "ai",
            prompt: "Evaluate the change."
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

    const compiledGraph = compilation.compiled_graph!;
    const profileEnvCommand = compiledGraph.nodes.find((node) => node.authored_id === "profile_env_command");
    const deterministicCheck = compiledGraph.nodes.find((node) => node.authored_id === "local_gate");
    const aiCheck = compiledGraph.nodes.find((node) => node.authored_id === "ai_gate");

    expect(profileEnvCommand).toEqual(
      expect.objectContaining({
        kind: "exec",
        env_files: [".env.defaults"]
      })
    );
    expect(deterministicCheck).toEqual(
      expect.objectContaining({
        kind: "check",
        check_kind: "deterministic",
        env_files: [".env.local"],
        env: {
          ACCESS_E2E_ALPHA_ADMIN_USER_ID: "user_123"
        },
        pass_if: {
          exit_code: 3
        }
      })
    );
    expect(aiCheck).toEqual(
      expect.objectContaining({
        kind: "check",
        check_kind: "ai",
        rubric: "Be strict.",
        effective_policy: expect.objectContaining({
          harness: "codex-cli",
          model: "gpt-5-judge",
          reasoning_effort: builtInCodexReasoningEffort,
          sandbox: "read-only"
        })
      })
    );
  });

  it("applies launch overrides across the compiled graph while preserving node profile overrides", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "launch-override-graph",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "worktree"
      },
      profiles: {
        default: {
          harness: "codex-cli",
          model: "gpt-5-codex",
          sandbox: "workspace-write",
          timeout_sec: 900,
          input_rules: {
            max_total_tokens: 32000,
            max_tokens_per_item: 8000
          }
        },
        review: {
          harness: "cursor-cli",
          model: "gpt-5-review",
          sandbox: "read-only",
          timeout_sec: 120,
          input_rules: {
            max_total_tokens: 16000,
            max_tokens_per_item: 4000
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
            prompt: "Inspect the codebase."
          },
          {
            type: "exec",
            id: "format",
            profile: "default",
            command: "npm",
            args: ["run", "format"]
          },
          {
            type: "check",
            id: "judge",
            check_kind: "ai",
            prompt: "Judge the change."
          }
        ]
      }
    });

    const launch = resolveLaunchConfig(normalized.document!, {
      launchProfile: "review",
      workspaceBackend: "inplace"
    });
    const compilation = compileAuthoredGraph(
      normalized.document!,
      launch,
      normalized.lowered_managed_nodes
    );

    expect(compilation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.judge.profile",
          message: expect.stringContaining('does not support AI checks')
        })
      ])
    );
    expect(compilation.compiled_graph?.launch).toEqual({
      launch_profile: "review",
      workspace_backend: "inplace"
    });
    expect(compilation.compiled_graph?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authored_id: "inspect",
          effective_policy: expect.objectContaining({
            profile_name: "review",
            workspace_backend: "inplace",
            harness: "cursor-cli",
            model: "gpt-5-review",
            sandbox: "read-only",
            timeout_sec: 120,
            input_rules: {
              max_total_tokens: 16000,
              max_tokens_per_item: 4000
            }
          })
        }),
        expect.objectContaining({
          authored_id: "format",
          effective_policy: expect.objectContaining({
            profile_name: "default",
            workspace_backend: "inplace",
            timeout_sec: 900,
            input_rules: {
              max_total_tokens: 32000,
              max_tokens_per_item: 8000
            }
          })
        }),
        expect.objectContaining({
          authored_id: "judge",
          effective_policy: expect.objectContaining({
            profile_name: "review",
            workspace_backend: "inplace",
            harness: "cursor-cli",
            model: "gpt-5-review",
            sandbox: "read-only"
          })
        })
      ])
    );
  });

  it("does not leak launch-profile models across node profiles that switch harnesses", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "cross-harness-model-boundary",
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
          model: "gpt-5-codex"
        },
        review: {
          harness: "cursor-cli",
          sandbox: "read-only",
          ai_check_defaults: {
            rubric: "Review the change."
          }
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "review_patch",
            profile: "review",
            prompt: "Review the patch."
          },
          {
            type: "check",
            id: "judge_patch",
            profile: "review",
            check_kind: "ai",
            prompt: "Judge the patch."
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

    expect(compilation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.judge_patch.profile",
          message: expect.stringContaining('does not support AI checks')
        })
      ])
    );

    const reviewPatch = compilation.compiled_graph?.nodes.find(
      (node) => node.authored_id === "review_patch"
    );
    const judgePatch = compilation.compiled_graph?.nodes.find(
      (node) => node.authored_id === "judge_patch"
    );

    expect(reviewPatch).toEqual(
      expect.objectContaining({
        effective_policy: expect.objectContaining({
          profile_name: "review",
          harness: "cursor-cli"
        })
      })
    );
    expect(reviewPatch?.effective_policy.model).toBeUndefined();

    expect(judgePatch).toEqual(
      expect.objectContaining({
        effective_policy: expect.objectContaining({
          profile_name: "review",
          harness: "cursor-cli",
          sandbox: "read-only"
        }),
        rubric: "Review the change."
      })
    );
    expect(judgePatch?.effective_policy.model).toBeUndefined();
  });

  it("rejects repeat bodies that compile to multiple entry and exit nodes", () => {
    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "repeat-body-shape",
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
            type: "repeat",
            id: "retry",
            max_attempts: 2,
            body: {
              type: "parallel",
              id: "body",
              steps: [
                {
                  type: "exec",
                  id: "repair",
                  command: "placeholder"
                },
                {
                  type: "check",
                  id: "verify",
                  check_kind: "deterministic",
                  command: "placeholder"
                }
              ]
            },
            until: {
              node: "verify"
            }
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

    expect(compilation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].body",
          message: "repeat.body must compile to a single entry region."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].body",
          message: "repeat.body must compile to a single exit region."
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].until.node",
          message: expect.stringContaining('currently exits through "repair"')
        })
      ])
    );
  });

});
