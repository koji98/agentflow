import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const TEST_INTENT = {
  goal: "Exercise workspace preparation and cleanup for supervised execution.",
  acceptance_criteria: ["Workspace backends create and clean up the expected repository state."]
};

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "seed\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
}

function compileGraph(document: AuthoredGraphDocument) {
  const normalized = normalizeAuthoredGraphDocument({
    intent: TEST_INTENT,
    ...document
  });
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

async function listGitWorktrees(repoDir: string): Promise<string[]> {
  const result = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoDir
  });

  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

async function expectWorktreeCleaned(repoDir: string, workspacePath: string): Promise<void> {
  await expect(access(workspacePath)).rejects.toThrow();
  expect(await listGitWorktrees(repoDir)).not.toContain(workspacePath);
}

function createWorkspaceDocument(
  workspaceBackend: "inplace" | "worktree",
  repos: AuthoredGraphDocument["repos"] = {
    main: {
      path: "."
    }
  }
): AuthoredGraphDocument {
  return {
    version: "1",
    graph_id: "workspace-backends",
    intent: TEST_INTENT,
    repos,
    defaults: {
      launch_profile: "default",
      workspace_backend: workspaceBackend
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
          id: "write_marker",
          repo: "main",
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync('marker.txt', 'workspace\\n')"
          ]
        }
      ]
    }
  };
}

describe("workspace backends", () => {
  it("uses inplace workspaces directly and removes worktree registrations after a passed run", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-workspace-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    try {
      const inplaceRun = await runCompiledGraph({
        run_root: join(tempRoot, "run-inplace"),
        compiled_graph: compileGraph(createWorkspaceDocument("inplace")),
        repo_sources: {
          main: repoDir
        }
      });

      expect(inplaceRun.outcome).toBe("passed");
      expect(await readFile(join(repoDir, "marker.txt"), "utf8")).toContain("workspace");

      await execFileAsync("git", ["checkout", "--", "marker.txt"], { cwd: repoDir }).catch(() => undefined);
      await rm(join(repoDir, "marker.txt"), { force: true });

      const worktreeRun = await runCompiledGraph({
        run_root: join(tempRoot, "run-worktree"),
        compiled_graph: compileGraph(createWorkspaceDocument("worktree")),
        repo_sources: {
          main: repoDir
        }
      });

      expect(worktreeRun.outcome).toBe("passed");
      await expect(access(join(repoDir, "marker.txt"))).rejects.toThrow();
      await expectWorktreeCleaned(repoDir, worktreeRun.state.repo_workspaces.main.workspace_path);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("removes worktree registrations after a failed run", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-workspace-failed-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run-failed");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    try {
      const run = await runCompiledGraph({
        run_root: runRoot,
        compiled_graph: compileGraph(createWorkspaceDocument("worktree")),
        repo_sources: {
          main: repoDir
        },
        executors: {
          exec: async () => ({
            status: "failed",
            outcome: "failed",
            result: {
              failed: true
            },
            stdout: "",
            stderr: "boom"
          })
        }
      });

      expect(run.outcome).toBe("failed");
      await expectWorktreeCleaned(repoDir, run.state.repo_workspaces.main.workspace_path);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("removes worktree registrations after a canceled run", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-workspace-canceled-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run-canceled");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    try {
      const controller = new AbortController();
      const run = await runCompiledGraph({
        run_root: runRoot,
        compiled_graph: compileGraph(createWorkspaceDocument("worktree")),
        repo_sources: {
          main: repoDir
        },
        signal: controller.signal,
        executors: {
          exec: async ({ signal }) => {
            setTimeout(() => controller.abort(), 10);

            if (!signal?.aborted) {
              await new Promise<void>((resolveAbort) => {
                signal?.addEventListener("abort", () => resolveAbort(), { once: true });
              });
            }

            return {
              status: "canceled",
              result: {
                canceled: true
              },
              stdout: "",
              stderr: ""
            };
          }
        }
      });

      expect(run.outcome).toBe("canceled");
      await expectWorktreeCleaned(repoDir, run.state.repo_workspaces.main.workspace_path);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("forces a failed terminal outcome when worktree cleanup fails after a passed run", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-workspace-cleanup-failed-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run-cleanup-failed");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    try {
      const run = await runCompiledGraph({
        run_root: runRoot,
        compiled_graph: compileGraph(createWorkspaceDocument("worktree")),
        repo_sources: {
          main: repoDir
        },
        executors: {
          exec: async () => {
            await rm(join(repoDir, ".git"), { recursive: true, force: true });

            return {
              status: "passed",
              outcome: "passed",
              result: {
                sabotaged_cleanup: true
              },
              stdout: "",
              stderr: ""
            };
          }
        }
      });
      const runRecord = JSON.parse(await readFile(join(runRoot, "run.json"), "utf8")) as {
        status: string;
      };
      const summary = await readFile(join(runRoot, "summary.md"), "utf8");

      expect(run.outcome).toBe("failed");
      expect(run.state.status).toBe("failed");
      expect(run.state.node_statuses.root__write_marker).toBe("passed");
      expect(runRecord.status).toBe("failed");
      const completedEvent = run.events.find((event) => event.type === "run.completed");
      expect(completedEvent).toEqual(
        expect.objectContaining({
          type: "run.completed",
          payload: expect.objectContaining({
            outcome: "failed",
            reason: expect.stringContaining("Workspace cleanup failed:")
          })
        })
      );
      expect(run.events.at(-1)?.type).toBe("delivery.package.completed");
      expect(summary).toContain("Workspace cleanup failed:");
      expect(summary).toContain("not a git repository");
      await expect(access(run.state.repo_workspaces.main.workspace_path)).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("forces a failed terminal outcome when canceled worktree cleanup fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-workspace-cancel-cleanup-failed-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run-cancel-cleanup-failed");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const document = createWorkspaceDocument("worktree");
    document.graph.steps.push({
      type: "exec",
      id: "after_cancel",
      repo: "main",
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync('should-not-exist.txt', 'unexpected\\n')"
      ]
    });

    try {
      const controller = new AbortController();
      const run = await runCompiledGraph({
        run_root: runRoot,
        compiled_graph: compileGraph(document),
        repo_sources: {
          main: repoDir
        },
        signal: controller.signal,
        executors: {
          exec: async ({ node, signal }) => {
            if (node.authored_id === "write_marker") {
              await rm(join(repoDir, ".git"), { recursive: true, force: true });
              setTimeout(() => controller.abort(), 10);

              if (!signal?.aborted) {
                await new Promise<void>((resolveAbort) => {
                  signal?.addEventListener("abort", () => resolveAbort(), { once: true });
                });
              }

              return {
                status: "canceled",
                result: {
                  canceled: true
                },
                stdout: "",
                stderr: ""
              };
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
          }
        }
      });
      const runRecord = JSON.parse(await readFile(join(runRoot, "run.json"), "utf8")) as {
        status: string;
      };
      const summary = await readFile(join(runRoot, "summary.md"), "utf8");

      expect(run.outcome).toBe("failed");
      expect(run.state.status).toBe("failed");
      expect(run.state.node_statuses.root__write_marker).toBe("canceled");
      expect(run.state.node_statuses.root__after_cancel).toBe("skipped");
      expect(run.state.counts.canceled).toBe(1);
      expect(run.state.counts.skipped).toBe(1);
      expect(runRecord.status).toBe("failed");
      expect(run.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "node.canceled",
          "node.skipped",
          "run.completed"
        ])
      );
      expect(run.events.some((event) => event.type === "run.canceled")).toBe(false);
      const completedEvent = run.events.find((event) => event.type === "run.completed");
      expect(completedEvent).toEqual(
        expect.objectContaining({
          type: "run.completed",
          payload: expect.objectContaining({
            outcome: "failed",
            reason: expect.stringContaining("operator_cancel | Workspace cleanup failed:")
          })
        })
      );
      expect(run.events.at(-1)?.type).toBe("delivery.package.completed");
      expect(summary).toContain("operator_cancel | Workspace cleanup failed:");
      expect(summary).toContain("not a git repository");
      await expect(access(run.state.repo_workspaces.main.workspace_path)).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("ignores unused broken repo aliases during worktree initialization", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-workspace-rollback-"));
    const repoDir = join(tempRoot, "repo");
    const brokenDir = join(tempRoot, "broken");
    const runRoot = join(tempRoot, "run-rollback");
    await mkdir(repoDir, { recursive: true });
    await mkdir(brokenDir, { recursive: true });
    await initGitRepo(repoDir);

    try {
      const run = await runCompiledGraph({
        run_root: runRoot,
        compiled_graph: compileGraph(
          createWorkspaceDocument("worktree", {
            main: {
              path: "."
            },
            broken: {
              path: "./broken"
            }
          })
        ),
        repo_sources: {
          main: repoDir,
          broken: brokenDir
        }
      });

      expect(run.outcome).toBe("passed");
      await expectWorktreeCleaned(repoDir, join(runRoot, "workspaces", "main"));
      await expect(access(join(runRoot, "workspaces", "broken"))).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
