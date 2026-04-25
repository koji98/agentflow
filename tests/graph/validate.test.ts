import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { summarizeAuthoredGraph, validateAuthoredGraphDocument } from "../../src/graph/validate.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/repeat.graph.json", import.meta.url)
);

async function readFixture(): Promise<unknown> {
  const contents = await readFile(fixturePath, "utf8");
  return JSON.parse(contents) as unknown;
}

const TEST_INTENT = {
  goal: "Validate an Agentflow graph contract.",
  acceptance_criteria: ["Graph diagnostics reflect the targeted contract behavior."]
};

describe("graph validation", () => {
  it("normalizes and summarizes the repeat fixture", async () => {
    const normalized = normalizeAuthoredGraphDocument(await readFixture());

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document).toBeDefined();
    expect(normalized.lowered_managed_nodes).toEqual([]);

    const summary = summarizeAuthoredGraph(normalized.document!);

    expect(summary).toEqual({
      graph_id: "repeat-graph",
      node_count: 11,
      executable_node_count: 7,
      container_node_count: 4,
      profile_count: 2,
      repo_count: 1,
      repeat_count: 1,
      node_kind_counts: {
        agent: 4,
        exec: 2,
        check: 1,
        checkpoint: 0,
        sequence: 2,
        parallel: 1,
        repeat: 1
      }
    });
  });

  it("accepts checkpoint nodes inside repeat bodies and as repeat.until targets", async () => {
    const diagnostics = await validateAuthoredGraphDocument({
      version: "1",
      graph_id: "checkpoint-repeat",
      intent: TEST_INTENT,
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

    expect(diagnostics).toEqual([]);
  });

  it("rejects repeat.until references that do not resolve to descendant checks or checkpoints", async () => {
    const diagnostics = await validateAuthoredGraphDocument({
      version: "1",
      graph_id: "invalid-repeat",
      intent: TEST_INTENT,
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
                  type: "exec",
                  id: "lint",
                  command: "npm"
                }
              ]
            },
            until: {
              node: "lint"
            }
          }
        ]
      }
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].until.node",
          message: expect.stringContaining("descendant check or checkpoint node")
        })
      ])
    );
  });

  it("rejects repeat.until checks that use soft failure semantics", async () => {
    const diagnostics = await validateAuthoredGraphDocument({
      version: "1",
      graph_id: "invalid-soft-repeat-until",
      intent: TEST_INTENT,
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
                  type: "agent",
                  id: "fix",
                  prompt: "Apply the fix."
                },
                {
                  type: "check",
                  id: "verify",
                  check_kind: "deterministic",
                  command: "sh",
                  on_failure: "continue"
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

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].until.node",
          message: expect.stringContaining('cannot use on_failure = "continue"')
        })
      ])
    );
  });

  it("rejects checkpoint nodes outside repeat bodies", async () => {
    const diagnostics = await validateAuthoredGraphDocument({
      version: "1",
      graph_id: "invalid-checkpoint-placement",
      intent: TEST_INTENT,
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
      }
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[1]",
          message: expect.stringContaining("only valid inside a repeat body")
        })
      ])
    );
  });

  it("rejects check fields that do not apply to the selected check kind", async () => {
    const diagnostics = await validateAuthoredGraphDocument({
      version: "1",
      graph_id: "invalid-check-fields",
      intent: TEST_INTENT,
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
            type: "check",
            id: "deterministic_gate",
            check_kind: "deterministic",
            command: "npm",
            prompt: "This should not be allowed.",
            model: "gpt-5"
          },
          {
            type: "check",
            id: "ai_gate",
            check_kind: "ai",
            prompt: "Evaluate the change.",
            command: "npm",
            env: {
              SHOULD_NOT_EXIST: "true"
            },
            pass_if: {
              exit_code: 0
            }
          }
        ]
      }
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].prompt",
          message: expect.stringContaining("does not apply to deterministic checks")
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].model",
          message: expect.stringContaining("does not apply to deterministic checks")
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].command",
          message: expect.stringContaining("does not apply to AI checks")
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].env",
          message: expect.stringContaining("does not apply to AI checks")
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].pass_if",
          message: expect.stringContaining("does not apply to AI checks")
        })
      ])
    );
  });

  it("rejects input paths and cwd values that escape the repo or workspace root", async () => {
    const diagnostics = await validateAuthoredGraphDocument({
      version: "1",
      graph_id: "invalid-path-boundaries",
      intent: TEST_INTENT,
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
          env_files: ["../.env"]
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "reader",
            prompt: "Read files.",
            context: [
              {
                name: "secret",
                from: "workspace_file",
                path: "../secret.txt"
              },
              {
                name: "sources",
                from: "workspace_glob",
                path: "main:../../**/*.ts"
              }
            ]
          },
          {
            type: "exec",
            id: "escape_exec",
            command: "pwd",
            cwd: "../outside",
            env_files: ["main:.env"],
            artifacts: {
              absolute_report: {
                from: "workspace",
                path: "/tmp/report.md",
                description: "Invalid absolute workspace artifact path."
              },
              parent_report: {
                from: "output_dir",
                path: "../report.md",
                description: "Invalid parent output artifact path."
              },
              repo_qualified_report: {
                from: "workspace",
                path: "main:reports/report.md",
                description: "Invalid repo-qualified workspace artifact path."
              }
            }
          },
          {
            type: "check",
            id: "escape_check",
            check_kind: "deterministic",
            command: "pwd",
            cwd: "main:../outside",
            env_files: ["/tmp/.env"]
          }
        ]
      }
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].context[0].path",
          message: 'Context path "../secret.txt" must stay within the selected repo root.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].context[1].path",
          message: 'Context path "main:../../**/*.ts" must stay within the selected repo root.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].cwd",
          message: 'cwd "../outside" must stay within the node workspace root.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[2].cwd",
          message: 'cwd "main:../outside" must stay within the node workspace root.'
        }),
        expect.objectContaining({
          path: "$.profiles.default.env_files[0]",
          message: 'env_files entry "../.env" must stay within the node workspace root.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].env_files[0]",
          message: 'env_files entry "main:.env" must stay within the node workspace root.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].artifacts.absolute_report.path",
          message: 'Artifact "absolute_report" path "/tmp/report.md" must stay within its source root.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].artifacts.parent_report.path",
          message: 'Artifact "parent_report" path "../report.md" must stay within its source root.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].artifacts.repo_qualified_report.path",
          message: 'Artifact "repo_qualified_report" path "main:reports/report.md" must stay within its source root.'
        }),
        expect.objectContaining({
          path: "$.graph.steps[2].env_files[0]",
          message: 'env_files entry "/tmp/.env" must stay within the node workspace root.'
        })
      ])
    );
  });

  it("rejects an agent graph that has no profile and therefore no resolvable harness", async () => {
    const diagnostics = await validateAuthoredGraphDocument({
      version: "1",
      graph_id: "missing-harness-agent",
      intent: TEST_INTENT,
      repos: { main: { path: "." } },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "implement",
            prompt: "Implement the requested change."
          }
        ]
      }
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.implement.profile",
          message: expect.stringMatching(/agent.*require.*harness/i)
        })
      ])
    );
  });

  it("rejects an AI check that cannot resolve a harness through the profile chain", async () => {
    const diagnostics = await validateAuthoredGraphDocument({
      version: "1",
      graph_id: "missing-harness-ai-check",
      intent: TEST_INTENT,
      repos: { main: { path: "." } },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "check",
            id: "judge",
            check_kind: "ai",
            prompt: "Judge the current state."
          }
        ]
      }
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.judge.profile",
          message: expect.stringMatching(/check.*require.*harness/i)
        })
      ])
    );
  });

  it("rejects an agent node that combines a read-only sandbox with declared artifacts", async () => {
    const diagnostics = await validateAuthoredGraphDocument({
      version: "1",
      graph_id: "readonly-with-artifacts",
      intent: TEST_INTENT,
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default" },
      profiles: { default: { harness: "cursor-cli", sandbox: "read-only" } },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "summarize",
            prompt: "Summarize the change.",
            artifacts: {
              summary: {
                from: "output_dir",
                path: "summary.md",
                description: "One-paragraph change summary."
              }
            }
          }
        ]
      }
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].artifacts",
          message: expect.stringMatching(/read-only sandbox.*declares artifacts.*"summary"/)
        })
      ])
    );
  });

  it("allows a read-only agent node when it declares no artifacts", async () => {
    const diagnostics = await validateAuthoredGraphDocument({
      version: "1",
      graph_id: "readonly-no-artifacts",
      intent: TEST_INTENT,
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default" },
      profiles: { default: { harness: "cursor-cli", sandbox: "read-only" } },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "inspect",
            prompt: "Read the code and respond with observations only."
          }
        ]
      }
    });

    const sandboxDiagnostics = diagnostics.filter((diagnostic) =>
      /read-only sandbox/i.test(diagnostic.message)
    );
    expect(sandboxDiagnostics).toEqual([]);
  });

  it("does not require a harness for exec-only graphs", async () => {
    const diagnostics = await validateAuthoredGraphDocument({
      version: "1",
      graph_id: "exec-only",
      intent: TEST_INTENT,
      repos: { main: { path: "." } },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "noop",
            command: "true"
          }
        ]
      }
    });

    const harnessDiagnostics = diagnostics.filter((diagnostic) =>
      /require.*harness/i.test(diagnostic.message)
    );
    expect(harnessDiagnostics).toEqual([]);
  });
});
