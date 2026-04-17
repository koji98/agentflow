import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "seed\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
}

function compileGraph(document: AuthoredGraphDocument) {
  const normalized = normalizeAuthoredGraphDocument(document);
  expect(normalized.diagnostics).toEqual([]);
  const launch = resolveLaunchConfig(normalized.document!);
  const compilation = compileAuthoredGraph(
    normalized.document!,
    launch,
    normalized.lowered_managed_nodes
  );

  expect(compilation.diagnostics).toEqual([]);
  expect(compilation.compiled_graph).toBeDefined();
  return compilation.compiled_graph!;
}

describe("runtime repeat", () => {
  it("fails the run when a repeat scope exhausts attempts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-repeat-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "repeat-failure",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
                  id: "implement",
                  prompt: "Attempt a fix."
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
          },
          {
            type: "exec",
            id: "finalize",
            command: "placeholder"
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        agent: async () => ({
          status: "passed",
          outcome: "passed",
          result: {
            attempted: true
          },
          stdout: "",
          stderr: ""
        }),
        check: async () => ({
          status: "failed",
          outcome: "failed",
          result: {
            passed: false
          },
          stdout: "",
          stderr: "",
          check: {
            check_kind: "deterministic",
            passed: false,
            summary: "still failing"
          }
        }),
        exec: async () => ({
          status: "passed",
          outcome: "passed",
          result: {},
          stdout: "",
          stderr: ""
        })
      }
    });

    expect(run.outcome).toBe("failed");
    expect(run.state.status).toBe("failed");
    expect(run.state.repeat_scopes.scope__root__retry.latest_iteration_index).toBe(2);
    expect(run.state.repeat_scopes.scope__root__retry.status).toBe("failed");
    expect(run.state.node_statuses.root__finalize).toBe("blocked");
    expect(run.attempts.filter((attempt) => attempt.authored_id === "verify")).toHaveLength(2);
    expect(run.events.at(-1)?.type).toBe("run.completed");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("reruns a checkpoint-driven repeat loop and resolves latest_failed context from the failed iteration", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-repeat-checkpoint-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "repeat-checkpoint",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
                  id: "revise",
                  prompt: "Revise the spec.",
                  context: [
                    {
                      name: "failed_critique_merged",
                      from: "artifact",
                      node: "merge_feedback",
                      artifact: "critique_merged",
                      iteration: "latest_failed",
                      if_available: true
                    },
                    {
                      name: "failed_quality_review",
                      from: "artifact",
                      node: "quality_review",
                      artifact: "quality_review",
                      iteration: "latest_failed",
                      if_available: true
                    },
                    {
                      name: "failed_operator_feedback",
                      from: "artifact",
                      node: "human_review",
                      artifact: "operator_feedback",
                      iteration: "latest_failed",
                      if_available: true
                    }
                  ],
                  artifacts: {
                    spec_revision: {
                      from: "output_dir",
                      path: "spec-revision.md",
                      description: "Test artifact produced at spec-revision.md."
                    }
                  }
                },
                {
                  type: "agent",
                  id: "merge_feedback",
                  prompt: "Merge feedback.",
                  artifacts: {
                    critique_merged: {
                      from: "output_dir",
                      path: "critique-merged.md",
                      description: "Test artifact produced at critique-merged.md."
                    }
                  }
                },
                {
                  type: "agent",
                  id: "quality_review",
                  prompt: "Evaluate the revision.",
                  artifacts: {
                    quality_review: {
                      from: "output_dir",
                      path: "quality-review.json",
                      description: "Test artifact produced at quality-review.json."
                    }
                  }
                },
                {
                  type: "checkpoint",
                  id: "human_review",
                  prompt: "Review the spec revision.",
                  review_from: {
                    node: "revise",
                    artifact: "spec_revision"
                  },
                  context: [
                    {
                      name: "quality_review",
                      from: "artifact",
                      node: "quality_review",
                      artifact: "quality_review"
                    }
                  ]
                }
              ]
            },
            until: {
              node: "human_review"
            }
          }
        ]
      }
    });

    let sawFailedIterationContext = false;

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        agent: async ({ node, attempt, context_packet_path, execution_dir }) => {
          if (node.authored_id === "revise" && attempt.iteration_index === 2) {
            const packet = JSON.parse(await readFile(context_packet_path, "utf8")) as {
              materials: Array<{ materialized_path: string }>;
            };
            const basenames = packet.materials.map((item) => item.materialized_path.split("/").at(-1));
            sawFailedIterationContext =
              basenames.includes("critique-merged.md") &&
              basenames.includes("quality-review.json") &&
              basenames.includes("operator-feedback.md");
          }

          if (node.authored_id === "revise") {
            await writeFile(
              join(execution_dir, "spec-revision.md"),
              `revision ${attempt.iteration_index ?? 1}\n`
            );
          }

          if (node.authored_id === "merge_feedback") {
            await writeFile(join(execution_dir, "critique-merged.md"), "close the blockers\n");
          }

          if (node.authored_id === "quality_review") {
            await writeFile(
              join(execution_dir, "quality-review.json"),
              JSON.stringify({
                passed: attempt.iteration_index === 2,
                summary: attempt.iteration_index === 2 ? "ready" : "needs revision"
              })
            );
          }

          return {
            status: "passed",
            outcome: "passed",
            result: {
              node: node.authored_id
            },
            stdout: "",
            stderr: ""
          };
        },
        checkpoint: async ({ attempt, execution_dir }) => {
          if (attempt.iteration_index === 1) {
            await writeFile(
              join(execution_dir, "operator-feedback.md"),
              "Add a rollback section and clarify ownership.\n"
            );
            return {
              status: "failed",
              outcome: "failed",
              result: {
                checkpoint_decision: "deny"
              },
              stdout: undefined,
              stderr: undefined,
              metadata: {
                checkpoint_decision: "deny"
              }
            };
          }

          return {
            status: "passed",
            outcome: "passed",
            result: {
              checkpoint_decision: "pass"
            },
            stdout: undefined,
            stderr: undefined,
            metadata: {
              checkpoint_decision: "pass"
            }
          };
        }
      }
    });

    expect(run.outcome).toBe("passed");
    expect(run.state.repeat_scopes.scope__root__retry.latest_iteration_index).toBe(2);
    expect(run.attempts.filter((attempt) => attempt.authored_id === "human_review")).toHaveLength(2);
    expect(sawFailedIterationContext).toBe(true);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("cancels the run when a checkpoint aborts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-repeat-checkpoint-cancel-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "repeat-checkpoint-cancel",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
          },
          {
            type: "exec",
            id: "after",
            command: "placeholder"
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        agent: async ({ execution_dir }) => {
          await writeFile(join(execution_dir, "draft.md"), "draft\n");
          return {
            status: "passed",
            outcome: "passed",
            result: {},
            stdout: "",
            stderr: ""
          };
        },
        checkpoint: async () => ({
          status: "canceled",
          result: {
            checkpoint_decision: "abort"
          },
          stdout: undefined,
          stderr: undefined,
          metadata: {
            checkpoint_decision: "abort"
          }
        }),
        exec: async () => ({
          status: "passed",
          outcome: "passed",
          result: {},
          stdout: "",
          stderr: ""
        })
      }
    });

    expect(run.outcome).toBe("canceled");
    expect(run.state.status).toBe("canceled");
    expect(run.state.node_statuses.root__after).toBe("skipped");
    expect(run.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["node.canceled", "run.canceled"])
    );

    await rm(tempRoot, { recursive: true, force: true });
  });
});
