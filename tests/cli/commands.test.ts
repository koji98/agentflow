import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readRunExecutionAttempts } from "../../src/artifacts/reader.js";
import { executeCli, renderCliStdout } from "../../src/cli/index.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "seed\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
}

async function waitForPath(path: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await access(path, constants.F_OK);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`Timed out waiting for ${path}`);
}

describe("graph CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders graph-native help with the release command surface", async () => {
    const result = await executeCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agentflow CLI");
    expect(result.stdout).toContain("validate");
    expect(result.stdout).toContain("run");
    expect(result.stdout).toContain("runs");
    expect(result.stdout).toContain("inspect");
    expect(result.stdout).toContain("resume");
    expect(result.stdout).toContain("apply");
    expect(result.stdout).toContain("graph-help");
    expect(result.stdout).not.toContain("control");
    expect(result.stdout).toContain("Local workflow:");
    expect(result.stdout).toContain("Path rules:");
    expect(result.stdout).toContain("graph-help: review the authored graph contract");
    expect(result.stdout).toContain("AGENTFLOW_RUNS_ROOT");
  });

  it("emits the compiled graph contract under validate --show-compiled", async () => {
    const graphPath = fileURLToPath(
      new URL("../graph/fixtures/repeat.graph.json", import.meta.url)
    );
    const result = await executeCli(["validate", "--graph", graphPath, "--show-compiled"]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("validate");
    expect(payload.status).toBe("passed");
    expect(payload.path_resolution.graph_path).toBe(graphPath);
    expect(payload.path_resolution.rules.repo_paths).toContain("graph file directory");
    expect(payload.compiled_graph.graph_id).toBe("repeat-graph");
    expect(payload.next_steps.run).toContain("agentflow run --graph");
    expect(payload.compiled_graph.nodes).toHaveLength(7);
    expect(payload.compiled_graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "repeat-back"
        })
      ])
    );
  });

  it("validates through the compiler and returns compiled summary data", async () => {
    const graphPath = fileURLToPath(
      new URL("../graph/fixtures/repeat.graph.json", import.meta.url)
    );
    const result = await executeCli(["validate", "--graph", graphPath]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("validate");
    expect(payload.status).toBe("passed");
    expect(payload.message).toContain('launch profile "default"');
    expect(payload.path_resolution.graph_path).toBe(graphPath);
    expect(payload.path_resolution.rules.graph_path).toContain("launch shell");
    expect(payload.launch.launch_profile).toBe("default");
    expect(payload.compiled_summary.node_count).toBe(7);
    expect(payload.compiled_summary.scope_count).toBeGreaterThan(0);
    expect(payload.authored_validation.status).toBe("passed");
    expect(payload.compiled_validation.status).toBe("passed");
    expect(payload.compiled_validation.compiled_summary.node_count).toBe(7);
    expect(payload.compiled_validation.managed_expansion).toEqual([]);
    expect(payload.readiness_mode).toBe("declared");
    expect(payload.readiness.status).toBe("ready");
    expect(payload.next_steps.run).toContain("agentflow run --graph");
    expect(payload.next_steps.graph_help).toBe("agentflow graph-help");
  });

  it("renders compact interactive validate success output", async () => {
    const graphPath = fileURLToPath(
      new URL("../graph/fixtures/repeat.graph.json", import.meta.url)
    );
    const result = await executeCli(["validate", "--graph", graphPath]);
    const rendered = renderCliStdout(result, { isTty: true });

    expect(result.exitCode).toBe(0);
    expect(rendered).toContain("Graph validated.");
    expect(rendered).toContain("Run-ready checks: not requested");
    expect(rendered).not.toContain("{");
  });

  it("surfaces readiness warnings and blocks from declarative prerequisites during validate", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-validate-prereqs-"));
    const repoDir = join(tempRoot, "repo");
    const warningGraphPath = join(tempRoot, "warning.graph.json");
    const blockedGraphPath = join(tempRoot, "blocked.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const baseGraph = {
      version: "1",
      repos: {
        main: {
          path: "./repo"
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
      },
      profiles: {
        default: {}
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "ok",
            repo: "main",
            command: "sh",
            args: ["-lc", "exit 0"]
          }
        ]
      }
    };

    await writeFile(
      warningGraphPath,
      `${JSON.stringify(
        {
          ...baseGraph,
          graph_id: "cli-validate-prereq-warning",
          prerequisites: {
            checks: [
              {
                kind: "env",
                name: "AGENTFLOW_TEST_MISSING_ENV",
                required: false
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      blockedGraphPath,
      `${JSON.stringify(
        {
          ...baseGraph,
          graph_id: "cli-validate-prereq-blocked",
          prerequisites: {
            checks: [
              {
                kind: "command",
                command: "definitely-missing-command"
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const warningResult = await executeCli(["validate", "--graph", warningGraphPath], tempRoot);
    const blockedResult = await executeCli(["validate", "--graph", blockedGraphPath], tempRoot);
    const warningPayload = JSON.parse(warningResult.stdout);
    const blockedPayload = JSON.parse(blockedResult.stdout);

    expect(warningResult.exitCode).toBe(0);
    expect(warningPayload.status).toBe("passed");
    expect(warningPayload.readiness.status).toBe("warnings");
    expect(warningPayload.readiness.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "env",
          status: "warning",
          message: expect.stringContaining("AGENTFLOW_TEST_MISSING_ENV")
        })
      ])
    );

    expect(blockedResult.exitCode).toBe(1);
    expect(blockedPayload.status).toBe("failed");
    expect(blockedPayload.compiled_validation.status).toBe("passed");
    expect(blockedPayload.readiness.status).toBe("blocked");
    expect(blockedPayload.readiness.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "command",
          status: "blocked",
          message: expect.stringContaining("definitely-missing-command")
        })
      ])
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("checks local runtime dependencies when validate is run-ready", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-ready-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const writeGraph = async (command: string) => {
      await writeFile(
        graphPath,
        `${JSON.stringify(
          {
            version: "1",
            graph_id: "cli-run-ready",
            repos: {
              main: {
                path: "./repo"
              }
            },
            defaults: {
              launch_profile: "default",
              workspace_backend: "worktree"
            },
            profiles: {
              default: {}
            },
            graph: {
              type: "sequence",
              id: "root",
              steps: [
                {
                  type: "exec",
                  id: "verify_tooling",
                  repo: "main",
                  command,
                  args: ["-e", "process.exit(0)"]
                }
              ]
            }
          },
          null,
          2
        )}\n`
      );
    };

    await writeGraph(process.execPath);
    const readyResult = await executeCli(["validate", "--graph", graphPath, "--run-ready"], tempRoot);
    const readyPayload = JSON.parse(readyResult.stdout);

    expect(readyResult.exitCode).toBe(0);
    expect(readyPayload.readiness_mode).toBe("run-ready");
    expect(readyPayload.readiness.status).toBe("ready");
    expect(readyPayload.readiness.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "command",
          target: `verify_tooling: ${process.execPath}`,
          status: "passed"
        }),
        expect.objectContaining({
          kind: "repo",
          target: "main",
          status: "passed"
        })
      ])
    );

    await writeGraph("definitely-missing-node-command");
    const blockedResult = await executeCli(["validate", "--graph", graphPath, "--run-ready"], tempRoot);
    const blockedPayload = JSON.parse(blockedResult.stdout);

    expect(blockedResult.exitCode).toBe(1);
    expect(blockedPayload.readiness_mode).toBe("run-ready");
    expect(blockedPayload.readiness.status).toBe("blocked");
    expect(blockedPayload.readiness.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "command",
          target: "verify_tooling: definitely-missing-node-command",
          status: "blocked",
          message: expect.stringContaining("not available on PATH")
        })
      ])
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("checks required harness binaries only during run-ready validate", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-ready-harness-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    const missingCodex = join(tempRoot, "missing-codex");
    const previousCodex = process.env.AGENTFLOW_CODEX_CLI_BIN;
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-run-ready-harness",
          repos: {
            main: {
              path: "./repo"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "worktree"
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
                id: "implement",
                repo: "main",
                prompt: "Implement the change."
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );
    process.env.AGENTFLOW_CODEX_CLI_BIN = missingCodex;

    try {
      const normalResult = await executeCli(["validate", "--graph", graphPath], tempRoot);
      const normalPayload = JSON.parse(normalResult.stdout);
      const runReadyResult = await executeCli(["validate", "--graph", graphPath, "--run-ready"], tempRoot);
      const runReadyPayload = JSON.parse(runReadyResult.stdout);

      expect(normalResult.exitCode).toBe(0);
      expect(normalPayload.readiness_mode).toBe("declared");
      expect(runReadyResult.exitCode).toBe(1);
      expect(runReadyPayload.readiness.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "harness",
            target: "codex-cli",
            status: "blocked",
            message: expect.stringContaining(missingCodex)
          })
        ])
      );
    } finally {
      if (previousCodex === undefined) {
        delete process.env.AGENTFLOW_CODEX_CLI_BIN;
      } else {
        process.env.AGENTFLOW_CODEX_CLI_BIN = previousCodex;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs a deterministic graph end to end and writes run artifacts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-run-graph",
          repos: {
            main: {
              path: "./repo"
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
                type: "exec",
                id: "write_marker",
                repo: "main",
                command: "node",
                args: [
                  "-e",
                  "require('node:fs').writeFileSync('marker.txt', 'ok\\n')"
                ]
              },
              {
                type: "check",
                id: "verify_marker",
                repo: "main",
                check_kind: "deterministic",
                command: "node",
                args: [
                  "-e",
                  "const fs=require('node:fs'); const passed=fs.existsSync('marker.txt'); process.stdout.write(JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                ],
                pass_if: {
                  json_path: "$.passed",
                  equals: true
                }
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await executeCli(["run", "--graph", graphPath], tempRoot);
    const payload = JSON.parse(result.stdout);
    const state = JSON.parse(await readFile(payload.artifacts.state_file, "utf8")) as {
      status: string;
    };
    const progressOutput = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("run");
    expect(payload.status).toBe("passed");
    expect(payload.message).toContain("durable artifacts are ready");
    expect(payload.path_resolution.graph_path).toBe(graphPath);
    expect(payload.runs_root).toBe(join(tempRoot, ".agentflow", "runs"));
    expect(payload.runs_root_source).toBe("graph-directory-default");
    expect(payload.default_runs_root).toBe(join(tempRoot, ".agentflow", "runs"));
    expect(payload.runs_root_contract).toContain("AGENTFLOW_RUNS_ROOT");
    expect(payload.run_root).toBe(join(payload.runs_root, payload.run_id));
    expect(payload.counts.passed).toBe(2);
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
    expect(payload.cancel_note).toContain("Ctrl-C");
    expect(payload.next_steps.rerun).toContain("agentflow run --graph");
    expect(payload.next_steps.resume).toContain("agentflow resume --run-root");
    expect(state.status).toBe("passed");
    const attempts = await readRunExecutionAttempts(payload.run_root);
    const writeAttempt = attempts.find((attempt) => attempt.authored_id === "write_marker");
    expect(writeAttempt?.execution_dir).toMatch(/\/nodes\/001-write-marker-[0-9a-f]{12}\/executions\/001-exec-[0-9a-f]{16}$/);
    expect(writeAttempt?.context_packet_path).toBe(join(writeAttempt!.execution_dir, "context", "packet.json"));
    expect(writeAttempt?.context_manifest_path).toBe(join(writeAttempt!.execution_dir, "context", "manifest.md"));
    await expect(access(join(writeAttempt!.execution_dir, "logs", "stdout.log"), constants.F_OK)).resolves.toBeUndefined();
    await expect(access(join(writeAttempt!.execution_dir, "logs", "stderr.log"), constants.F_OK)).resolves.toBeUndefined();
    expect(await readFile(join(repoDir, "marker.txt"), "utf8")).toBe("ok\n");
    expect(progressOutput).toContain('agentflow: compiled graph "cli-run-graph" with 2 executable nodes');
    expect(progressOutput).toContain("agentflow: started run · workspace=inplace");
    expect(progressOutput).toContain("[0/2] start exec write_marker · repo=main");
    expect(progressOutput).toContain("[1/2] passed exec write_marker");
    expect(progressOutput).toContain("[1/2] start check verify_marker · repo=main");
    expect(progressOutput).toContain("[2/2] passed check verify_marker");
    expect(progressOutput).toContain("agentflow: run passed · 2/2 terminal nodes");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("captures worktree status, binary diff, and changed files before cleanup", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-worktree-changes-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-worktree-change-capture",
          repos: {
            main: {
              path: "./repo"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "worktree"
          },
          profiles: {
            default: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "mutate_workspace",
                repo: "main",
                command: process.execPath,
                args: [
                  "-e",
                  [
                    "const fs = require('node:fs');",
                    "fs.writeFileSync('README.md', 'changed from worktree\\n');",
                    "fs.writeFileSync('new-file.txt', 'new workspace file\\n');"
                  ].join(" ")
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const result = await executeCli(["run", "--graph", graphPath], tempRoot);
    const payload = JSON.parse(result.stdout);
    const capture = payload.workspace_change_artifacts.main;
    const status = await readFile(capture.status_file, "utf8");
    const diff = await readFile(capture.diff_file, "utf8");
    const changedFiles = JSON.parse(await readFile(capture.changed_files_file, "utf8"));
    const summary = await readFile(payload.artifacts.summary_file, "utf8");

    expect(result.exitCode).toBe(0);
    expect(payload.status).toBe("passed");
    expect(payload.artifacts.workspace_changes_dir).toBe(join(payload.run_root, "workspace-changes"));
    expect(capture.changed_files).toEqual(["README.md", "new-file.txt"]);
    expect(changedFiles).toEqual(["README.md", "new-file.txt"]);
    expect(status).toContain(" M README.md");
    expect(status).toContain("?? new-file.txt");
    expect(diff).toContain("changed from worktree");
    expect(diff).toContain("new workspace file");
    expect(summary).toContain("## Workspace Changes");
    expect(summary).toContain(capture.diff_file);
    await expect(access(payload.repo_workspaces.main.workspace_path)).rejects.toThrow();

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("applies captured worktree changes back to the source repo", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-apply-worktree-changes-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-apply-worktree-change",
          repos: {
            main: {
              path: "./repo"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "worktree"
          },
          profiles: {
            default: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "mutate_workspace",
                repo: "main",
                command: process.execPath,
                args: [
                  "-e",
                  [
                    "const fs = require('node:fs');",
                    "fs.writeFileSync('README.md', 'changed from captured patch\\n');",
                    "fs.writeFileSync('new-file.txt', 'new workspace file\\n');"
                  ].join(" ")
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const runResult = await executeCli(["run", "--graph", graphPath], tempRoot);
    const runPayload = JSON.parse(runResult.stdout);

    expect(runResult.exitCode).toBe(0);
    expect(await readFile(join(repoDir, "README.md"), "utf8")).toBe("seed\n");

    const applyResult = await executeCli(["apply", "--run-root", runPayload.run_root], tempRoot);
    const applyPayload = JSON.parse(applyResult.stdout);

    expect(applyResult.exitCode).toBe(0);
    expect(applyPayload.command).toBe("apply");
    expect(applyPayload.status).toBe("passed");
    expect(applyPayload.repo_alias).toBe("main");
    expect(applyPayload.target_path).toBe(repoDir);
    expect(applyPayload.changed_files).toEqual(["README.md", "new-file.txt"]);
    expect(await readFile(join(repoDir, "README.md"), "utf8")).toBe(
      "changed from captured patch\n"
    );
    expect(await readFile(join(repoDir, "new-file.txt"), "utf8")).toBe("new workspace file\n");
    await expect(
      execFileAsync("git", ["status", "--porcelain=v1"], { cwd: repoDir }).then(
        (result) => result.stdout
      )
    ).resolves.toContain(" M README.md");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("commits captured worktree changes when a commit message is provided", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-apply-commit-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-apply-commit",
          repos: {
            main: {
              path: "./repo"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "worktree"
          },
          profiles: {
            default: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "mutate_workspace",
                repo: "main",
                command: process.execPath,
                args: [
                  "-e",
                  [
                    "const fs = require('node:fs');",
                    "fs.writeFileSync('README.md', 'committed captured patch\\n');"
                  ].join(" ")
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const runResult = await executeCli(["run", "--graph", graphPath], tempRoot);
    const runPayload = JSON.parse(runResult.stdout);
    const applyResult = await executeCli(
      [
        "apply",
        "--run-root",
        runPayload.run_root,
        "--commit-message",
        "Apply captured Agentflow changes"
      ],
      tempRoot
    );
    const applyPayload = JSON.parse(applyResult.stdout);
    const logSubject = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: repoDir });
    const status = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: repoDir });

    expect(applyResult.exitCode).toBe(0);
    expect(applyPayload.status).toBe("passed");
    expect(applyPayload.commit.message).toBe("Apply captured Agentflow changes");
    expect(applyPayload.commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(logSubject.stdout.trim()).toBe("Apply captured Agentflow changes");
    expect(status.stdout).toBe("");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("returns a primary terminal diagnostic for failed runs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-failed-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-run-failed-graph",
          repos: {
            main: {
              path: "./repo"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "inplace"
          },
          profiles: {
            default: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "check",
                id: "verify_missing",
                repo: "main",
                check_kind: "deterministic",
                command: "node",
                args: [
                  "-e",
                  "process.stdout.write(JSON.stringify({passed:false})); process.exit(1);"
                ],
                pass_if: {
                  json_path: "$.passed",
                  equals: true
                }
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const result = await executeCli(["run", "--graph", graphPath], tempRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(payload.command).toBe("run");
    expect(payload.status).toBe("failed");
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
    expect(payload.terminal_error).toContain("Deterministic check failed.");
    expect(payload.terminal_diagnostics).toContainEqual(
      expect.stringContaining("Deterministic check failed.")
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("ignores unused broken repo aliases during run resolution", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-unused-repo-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-unused-repo",
          repos: {
            main: {
              path: "./repo"
            },
            unused: {
              path: "./does-not-exist"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "inplace"
          },
          profiles: {
            default: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "ok",
                repo: "main",
                command: process.execPath,
                args: [
                  "-e",
                  "process.exit(0)"
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const result = await executeCli(["run", "--graph", graphPath], tempRoot);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.status).toBe("passed");
    expect(payload.repo_sources).toEqual({
      main: repoDir
    });

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("does not fail launch just because a blocked checkpoint would require an interactive terminal", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-checkpoint-lazy-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    const originalStdinTty = process.stdin.isTTY;
    const originalStderrTty = process.stderr.isTTY;

    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "checkpoint-cli-preflight",
          repos: {
            main: {
              path: "./repo"
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
                type: "exec",
                id: "fail_first",
                repo: "main",
                command: process.execPath,
                args: ["-e", "process.exit(1)"]
              },
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
                      id: "draft",
                      repo: "main",
                      command: process.execPath,
                      args: ["-e", "process.exit(0)"],
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
                      repo: "main",
                      prompt: "Review the artifact.",
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
        },
        null,
        2
      )}\n`
    );

    try {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true
      });
      Object.defineProperty(process.stderr, "isTTY", {
        value: true,
        configurable: true
      });

      const result = await executeCli(["run", "--graph", graphPath], tempRoot);
      const payload = JSON.parse(result.stdout);

      expect(result.exitCode).toBe(1);
      expect(payload.command).toBe("run");
      expect(payload.status).toBe("failed");
      expect(payload.message).toContain("terminal failure state");
      expect(payload.counts.failed).toBe(1);
      expect(payload.counts.blocked).toBe(2);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalStdinTty,
        configurable: true
      });
      Object.defineProperty(process.stderr, "isTTY", {
        value: originalStderrTty,
        configurable: true
      });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("honors AGENTFLOW_RUNS_ROOT for artifact placement", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-root-"));
    const launchRoot = join(tempRoot, "launch-shell");
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    const runsRoot = join(tempRoot, "shared-runs");
    const previousRunsRoot = process.env.AGENTFLOW_RUNS_ROOT;

    await mkdir(launchRoot, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-run-root-graph",
          repos: {
            main: {
              path: "./repo"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "inplace"
          },
          profiles: {
            default: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "write_marker",
                repo: "main",
                command: "node",
                args: [
                  "-e",
                  "require('node:fs').writeFileSync('marker.txt', 'ok\\n')"
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    try {
      process.env.AGENTFLOW_RUNS_ROOT = runsRoot;

      const result = await executeCli(["run", "--graph", graphPath], launchRoot);
      const payload = JSON.parse(result.stdout);

      expect(result.exitCode).toBe(0);
      expect(payload.runs_root).toBe(runsRoot);
      expect(payload.runs_root_source).toBe("environment");
      expect(payload.runs_root_input).toBe(runsRoot);
      expect(payload.run_root).toBe(join(runsRoot, payload.run_id));
      expect(payload.artifacts.run_file).toBe(join(payload.run_root, "run.json"));
      expect(await readFile(join(repoDir, "marker.txt"), "utf8")).toBe("ok\n");
    } finally {
      if (previousRunsRoot === undefined) {
        delete process.env.AGENTFLOW_RUNS_ROOT;
      } else {
        process.env.AGENTFLOW_RUNS_ROOT = previousRunsRoot;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("resumes a failed run root while preserving passed work", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-resume-graph",
          repos: {
            main: {
              path: "./repo"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "inplace"
          },
          profiles: {
            default: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "write_seed",
                repo: "main",
                command: "node",
                args: [
                  "-e",
                  "require('node:fs').writeFileSync('seed.txt', 'seed\\n')"
                ]
              },
              {
                type: "check",
                id: "gate_resume",
                repo: "main",
                check_kind: "deterministic",
                command: "node",
                args: [
                  "-e",
                  "const fs=require('node:fs'); const passed=fs.existsSync('resume-ok.txt'); process.stdout.write(JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                ],
                pass_if: {
                  json_path: "$.passed",
                  equals: true
                }
              },
              {
                type: "exec",
                id: "after_resume",
                repo: "main",
                command: "node",
                args: [
                  "-e",
                  "const fs=require('node:fs'); if (!fs.existsSync('seed.txt')) process.exit(1); fs.writeFileSync('done.txt', 'done\\n');"
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const firstStderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
    const firstPayload = JSON.parse(firstRun.stdout);
    const firstRunRecord = JSON.parse(
      await readFile(join(firstPayload.run_root, "run.json"), "utf8")
    ) as { graph_path?: string };
    const firstProgress = firstStderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");

    expect(firstRun.exitCode).toBe(1);
    expect(firstPayload.command).toBe("run");
    expect(firstPayload.status).toBe("failed");
    expect(firstRunRecord.graph_path).toBe(graphPath);
    expect(firstProgress).toContain('agentflow: compiled graph "cli-resume-graph" with 3 executable nodes');
    expect(firstProgress).toContain("[0/3] start exec write_seed · repo=main");
    expect(firstProgress).toContain("[1/3] passed exec write_seed");
    expect(firstProgress).toContain("[1/3] start check gate_resume · repo=main");
    expect(firstProgress).toContain("agentflow: check failed gate_resume");
    expect(firstProgress).toContain("[2/3] failed check gate_resume");
    expect(firstProgress).toContain("[3/3] blocked exec after_resume · terminal_failure");
    expect(firstProgress).toContain("agentflow: run failed · 3/3 terminal nodes");

    firstStderrSpy.mockRestore();

    await writeFile(join(repoDir, "resume-ok.txt"), "ok\n");

    const resumedStderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const resumedRun = await executeCli(["resume", "--run-root", firstPayload.run_root], tempRoot);
    const resumedPayload = JSON.parse(resumedRun.stdout);
    const resumedState = JSON.parse(
      await readFile(join(firstPayload.run_root, "state.json"), "utf8")
    ) as { status: string; counts: { passed: number } };
    const resumedEvents = (await readFile(join(firstPayload.run_root, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        type: string;
        payload?: Record<string, unknown>;
      });
    const attempts = await readRunExecutionAttempts(firstPayload.run_root);
    const resumedProgress = resumedStderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");

    expect(resumedRun.exitCode).toBe(0);
    expect(resumedPayload.command).toBe("resume");
    expect(resumedPayload.status).toBe("passed");
    expect(resumedPayload.run_root).toBe(firstPayload.run_root);
    expect(resumedPayload.resumed_from_status).toBe("failed");
    expect(resumedPayload.preserved_node_count).toBe(1);
    expect(resumedPayload.restarted_node_count).toBe(2);
    expect(resumedState.status).toBe("passed");
    expect(resumedState.counts.passed).toBe(3);
    expect(await readFile(join(repoDir, "done.txt"), "utf8")).toBe("done\n");
    expect(
      resumedEvents.filter((event) => event.type === "run.started").at(-1)?.payload
    ).toEqual(
      expect.objectContaining({
        resumed: true,
        previous_status: "failed",
        preserved_node_count: 1,
        restarted_node_count: 2
      })
    );
    expect(attempts.filter((attempt) => attempt.authored_id === "write_seed")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.authored_id === "gate_resume")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.authored_id === "after_resume")).toHaveLength(1);
    expect(resumedProgress).toContain(
      "agentflow: resumed run from failed · preserved=1 restarted=2 · workspace=inplace"
    );
    expect(resumedProgress).toContain("[1/3] start check gate_resume · repo=main");
    expect(resumedProgress).toContain("[2/3] passed check gate_resume");
    expect(resumedProgress).toContain("[2/3] start exec after_resume · repo=main");
    expect(resumedProgress).toContain("[3/3] passed exec after_resume");
    expect(resumedProgress).toContain("agentflow: run passed · 3/3 terminal nodes");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("recompiles the original graph on resume and invalidates changed passed work", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-recompile-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const writeGraph = async (seedValue: string) => {
      await writeFile(
        graphPath,
        `${JSON.stringify(
          {
            version: "1",
            graph_id: "cli-resume-recompile",
            repos: {
              main: {
                path: "./repo"
              }
            },
            defaults: {
              launch_profile: "default",
              workspace_backend: "inplace"
            },
            profiles: {
              default: {}
            },
            graph: {
              type: "sequence",
              id: "root",
              steps: [
                {
                  type: "exec",
                  id: "write_seed",
                  repo: "main",
                  command: "node",
                  args: [
                    "-e",
                    `require('node:fs').writeFileSync('seed.txt', '${seedValue}\\n')`
                  ]
                },
                {
                  type: "check",
                  id: "gate_resume",
                  repo: "main",
                  check_kind: "deterministic",
                  command: "node",
                  args: [
                    "-e",
                    "const fs=require('node:fs'); const passed=fs.existsSync('resume-ok.txt'); process.stdout.write(JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                  ],
                  pass_if: {
                    json_path: "$.passed",
                    equals: true
                  }
                },
                {
                  type: "exec",
                  id: "after_resume",
                  repo: "main",
                  command: "node",
                  args: [
                    "-e",
                    "const fs=require('node:fs'); const seed=fs.readFileSync('seed.txt','utf8'); fs.writeFileSync('done.txt', seed);"
                  ]
                }
              ]
            }
          },
          null,
          2
        )}\n`
      );
    };

    await writeGraph("seed-v1");

    const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
    const firstPayload = JSON.parse(firstRun.stdout);

    expect(firstRun.exitCode).toBe(1);
    expect(await readFile(join(repoDir, "seed.txt"), "utf8")).toBe("seed-v1\n");

    await writeGraph("seed-updated");
    await writeFile(join(repoDir, "resume-ok.txt"), "ok\n");

    const resumedRun = await executeCli(["resume", "--run-root", firstPayload.run_root], tempRoot);
    const resumedPayload = JSON.parse(resumedRun.stdout);
    const attempts = await readRunExecutionAttempts(firstPayload.run_root);

    expect(resumedRun.exitCode).toBe(0);
    expect(resumedPayload.status).toBe("passed");
    expect(resumedPayload.preserved_node_count).toBe(0);
    expect(resumedPayload.restarted_node_count).toBe(3);
    expect(await readFile(join(repoDir, "seed.txt"), "utf8")).toBe("seed-updated\n");
    expect(await readFile(join(repoDir, "done.txt"), "utf8")).toBe("seed-updated\n");
    expect(attempts.filter((attempt) => attempt.authored_id === "write_seed")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.authored_id === "gate_resume")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.authored_id === "after_resume")).toHaveLength(1);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("restarts a passed repeat scope when resume invalidation reaches it from upstream changes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-repeat-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const writeGraph = async (seedValue: string) => {
      await writeFile(
        graphPath,
        `${JSON.stringify(
          {
            version: "1",
            graph_id: "cli-resume-repeat",
            repos: {
              main: {
                path: "./repo"
              }
            },
            defaults: {
              launch_profile: "default",
              workspace_backend: "inplace"
            },
            profiles: {
              default: {}
            },
            graph: {
              type: "sequence",
              id: "root",
              steps: [
                {
                  type: "exec",
                  id: "write_seed",
                  repo: "main",
                  command: "node",
                  args: [
                    "-e",
                    `require('node:fs').writeFileSync('seed.txt', '${seedValue}\\n')`
                  ]
                },
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
                        id: "prepare_loop_output",
                        repo: "main",
                        command: "node",
                        args: [
                          "-e",
                          "const fs=require('node:fs'); fs.writeFileSync('loop.txt', fs.readFileSync('seed.txt', 'utf8'));"
                        ]
                      },
                      {
                        type: "check",
                        id: "verify_loop",
                        repo: "main",
                        check_kind: "deterministic",
                        command: "node",
                        args: [
                          "-e",
                          "const fs=require('node:fs'); const passed=fs.existsSync('loop.txt'); process.stdout.write(JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                        ],
                        pass_if: {
                          json_path: "$.passed",
                          equals: true
                        }
                      }
                    ]
                  },
                  until: {
                    node: "verify_loop"
                  }
                },
                {
                  type: "check",
                  id: "gate_resume",
                  repo: "main",
                  check_kind: "deterministic",
                  command: "node",
                  args: [
                    "-e",
                    "const fs=require('node:fs'); const passed=fs.existsSync('resume-ok.txt'); process.stdout.write(JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                  ],
                  pass_if: {
                    json_path: "$.passed",
                    equals: true
                  }
                },
                {
                  type: "exec",
                  id: "finalize",
                  repo: "main",
                  command: "node",
                  args: [
                    "-e",
                    "const fs=require('node:fs'); fs.writeFileSync('done.txt', fs.readFileSync('loop.txt', 'utf8'));"
                  ]
                }
              ]
            }
          },
          null,
          2
        )}\n`
      );
    };

    await writeGraph("seed-v1");

    const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
    const firstPayload = JSON.parse(firstRun.stdout);

    expect(firstRun.exitCode).toBe(1);
    expect(await readFile(join(repoDir, "seed.txt"), "utf8")).toBe("seed-v1\n");
    expect(await readFile(join(repoDir, "loop.txt"), "utf8")).toBe("seed-v1\n");

    await writeGraph("seed-updated");
    await writeFile(join(repoDir, "resume-ok.txt"), "ok\n");

    const resumedRun = await executeCli(["resume", "--run-root", firstPayload.run_root], tempRoot);
    const resumedPayload = JSON.parse(resumedRun.stdout);
    const resumedState = JSON.parse(
      await readFile(join(firstPayload.run_root, "state.json"), "utf8")
    ) as { status: string; counts: { passed: number }; repeat_scopes: Record<string, { status: string; latest_iteration_index: number }> };
    const attempts = await readRunExecutionAttempts(firstPayload.run_root);

    expect(resumedRun.exitCode).toBe(0);
    expect(resumedPayload.status).toBe("passed");
    expect(resumedPayload.preserved_node_count).toBe(0);
    expect(resumedPayload.restarted_node_count).toBe(5);
    expect(resumedState.status).toBe("passed");
    expect(resumedState.counts.passed).toBe(5);
    expect(resumedState.repeat_scopes.scope__root__retry.status).toBe("passed");
    expect(resumedState.repeat_scopes.scope__root__retry.latest_iteration_index).toBe(1);
    expect(await readFile(join(repoDir, "seed.txt"), "utf8")).toBe("seed-updated\n");
    expect(await readFile(join(repoDir, "loop.txt"), "utf8")).toBe("seed-updated\n");
    expect(await readFile(join(repoDir, "done.txt"), "utf8")).toBe("seed-updated\n");
    expect(attempts.filter((attempt) => attempt.authored_id === "write_seed")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.authored_id === "prepare_loop_output")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.authored_id === "verify_loop")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.authored_id === "gate_resume")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.authored_id === "finalize")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.authored_id === "write_seed").map((attempt) => ({
      attempt_index: attempt.attempt_index,
      execution_dir: attempt.execution_dir
    }))).toEqual([
      {
        attempt_index: 1,
        execution_dir: expect.stringMatching(/\/executions\/001-exec-[0-9a-f]{16}$/)
      },
      {
        attempt_index: 2,
        execution_dir: expect.stringMatching(/\/executions\/002-exec-[0-9a-f]{16}$/)
      }
    ]);
    expect(attempts.filter((attempt) => attempt.authored_id === "prepare_loop_output").map((attempt) => ({
      iteration_index: attempt.iteration_index,
      iteration_attempt_index: attempt.iteration_attempt_index,
      execution_dir: attempt.execution_dir
    }))).toEqual([
      {
        iteration_index: 1,
        iteration_attempt_index: 1,
        execution_dir: expect.stringMatching(/\/executions\/i001-a001-exec-[0-9a-f]{16}$/)
      },
      {
        iteration_index: 1,
        iteration_attempt_index: 2,
        execution_dir: expect.stringMatching(/\/executions\/i001-a002-exec-[0-9a-f]{16}$/)
      }
    ]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("repairs a passed repeat scope whose stored node statuses became inconsistent before resume", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-repeat-repair-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-resume-repeat-repair",
          repos: {
            main: {
              path: "./repo"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "inplace"
          },
          profiles: {
            default: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "write_seed",
                repo: "main",
                command: "node",
                args: [
                  "-e",
                  "require('node:fs').writeFileSync('seed.txt', 'seed-v1\\n')"
                ]
              },
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
                      id: "prepare_loop_output",
                      repo: "main",
                      command: "node",
                      args: [
                        "-e",
                        "const fs=require('node:fs'); fs.writeFileSync('loop.txt', fs.readFileSync('seed.txt', 'utf8'));"
                      ]
                    },
                    {
                      type: "check",
                      id: "verify_loop",
                      repo: "main",
                      check_kind: "deterministic",
                      command: "node",
                      args: [
                        "-e",
                        "const fs=require('node:fs'); const passed=fs.existsSync('loop.txt'); process.stdout.write(JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                      ],
                      pass_if: {
                        json_path: "$.passed",
                        equals: true
                      }
                    }
                  ]
                },
                until: {
                  node: "verify_loop"
                }
              },
              {
                type: "check",
                id: "gate_resume",
                repo: "main",
                check_kind: "deterministic",
                command: "node",
                args: [
                  "-e",
                  "const fs=require('node:fs'); const passed=fs.existsSync('resume-ok.txt'); process.stdout.write(JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                ],
                pass_if: {
                  json_path: "$.passed",
                  equals: true
                }
              },
              {
                type: "exec",
                id: "finalize",
                repo: "main",
                command: "node",
                args: [
                  "-e",
                  "const fs=require('node:fs'); fs.writeFileSync('done.txt', fs.readFileSync('loop.txt', 'utf8'));"
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
    const firstPayload = JSON.parse(firstRun.stdout);
    const statePath = join(firstPayload.run_root, "state.json");
    const mutatedState = JSON.parse(await readFile(statePath, "utf8")) as {
      counts: Record<string, number>;
      node_statuses: Record<string, string>;
      repeat_scopes: Record<string, { status: string }>;
    };

    expect(firstRun.exitCode).toBe(1);
    expect(await readFile(join(repoDir, "loop.txt"), "utf8")).toBe("seed-v1\n");

    for (const compiledId of Object.keys(mutatedState.node_statuses)) {
      if (compiledId.includes("__prepare_loop_output") || compiledId.includes("__verify_loop")) {
        mutatedState.node_statuses[compiledId] = "blocked";
      }
    }

    mutatedState.repeat_scopes.scope__root__retry.status = "passed";
    mutatedState.counts = Object.values(mutatedState.node_statuses).reduce(
      (counts, status) => {
        counts.total += 1;
        counts[status] = (counts[status] ?? 0) + 1;
        return counts;
      },
      {
        total: 0,
        pending: 0,
        ready: 0,
        running: 0,
        passed: 0,
        failed: 0,
        blocked: 0,
        canceled: 0,
        skipped: 0
      } as Record<string, number>
    );

    await writeFile(statePath, `${JSON.stringify(mutatedState, null, 2)}\n`);
    await writeFile(join(repoDir, "seed.txt"), "seed-updated\n");
    await writeFile(join(repoDir, "resume-ok.txt"), "ok\n");

    const resumedRun = await executeCli(["resume", "--run-root", firstPayload.run_root], tempRoot);
    const resumedPayload = JSON.parse(resumedRun.stdout);
    const resumedState = JSON.parse(await readFile(statePath, "utf8")) as {
      status: string;
      repeat_scopes: Record<string, { status: string; latest_iteration_index: number }>;
    };
    const attempts = await readRunExecutionAttempts(firstPayload.run_root);

    expect(resumedRun.exitCode).toBe(0);
    expect(resumedPayload.status).toBe("passed");
    expect(resumedPayload.preserved_node_count).toBe(1);
    expect(resumedPayload.restarted_node_count).toBe(4);
    expect(resumedState.status).toBe("passed");
    expect(resumedState.repeat_scopes.scope__root__retry.status).toBe("passed");
    expect(resumedState.repeat_scopes.scope__root__retry.latest_iteration_index).toBe(1);
    expect(await readFile(join(repoDir, "loop.txt"), "utf8")).toBe("seed-updated\n");
    expect(await readFile(join(repoDir, "done.txt"), "utf8")).toBe("seed-updated\n");
    expect(attempts.filter((attempt) => attempt.authored_id === "write_seed")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.authored_id === "prepare_loop_output")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.authored_id === "verify_loop")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.authored_id === "gate_resume")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.authored_id === "finalize")).toHaveLength(1);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects a relative AGENTFLOW_RUNS_ROOT override before launching a run", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-runs-root-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    const previousRunsRoot = process.env.AGENTFLOW_RUNS_ROOT;
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-run-relative-runs-root",
          repos: {
            main: {
              path: "./repo"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "inplace"
          },
          profiles: {
            default: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "noop",
                repo: "main",
                command: "node",
                args: [
                  "-e",
                  "process.stdout.write('ok\\n')"
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    try {
      process.env.AGENTFLOW_RUNS_ROOT = "relative-runs";

      const result = await executeCli(["run", "--graph", graphPath], tempRoot);
      const payload = JSON.parse(result.stdout);

      expect(result.exitCode).toBe(1);
      expect(payload.command).toBe("run");
      expect(payload.status).toBe("failed");
      expect(payload.message).toContain("AGENTFLOW_RUNS_ROOT must be an absolute path");
      await expect(access(join(tempRoot, ".agentflow", "runs"))).rejects.toThrow();
    } finally {
      if (previousRunsRoot === undefined) {
        delete process.env.AGENTFLOW_RUNS_ROOT;
      } else {
        process.env.AGENTFLOW_RUNS_ROOT = previousRunsRoot;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("cancels an active run through the CLI signal contract and writes canceled artifacts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-cancel-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    const startedPath = join(repoDir, "hang-started.txt");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-cancel-graph",
          repos: {
            main: {
              path: "./repo"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "inplace"
          },
          profiles: {
            default: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "hang",
                repo: "main",
                command: "node",
                args: [
                  "-e",
                  "require('node:fs').writeFileSync('hang-started.txt', 'started\\n'); setInterval(() => {}, 1000);"
                ]
              },
              {
                type: "exec",
                id: "after-cancel",
                repo: "main",
                command: "node",
                args: [
                  "-e",
                  "require('node:fs').writeFileSync('should-not-exist.txt', 'unexpected\\n')"
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const controller = new AbortController();
    const resultPromise = executeCli(["run", "--graph", graphPath], tempRoot, {
      signal: controller.signal
    });
    await waitForPath(startedPath);
    controller.abort();
    const result = await resultPromise;
    const payload = JSON.parse(result.stdout);
    const state = JSON.parse(await readFile(payload.artifacts.state_file, "utf8")) as {
      status: string;
      counts: {
        canceled: number;
        skipped: number;
      };
    };
    const events = (await readFile(payload.artifacts.events_file, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as {
        type: string;
      });
    const runCanceledEvents = events.filter((event) => event.type === "run.canceled");
    const nodeCanceledEvents = events.filter((event) => event.type === "node.canceled");

    expect(result.exitCode).toBe(1);
    expect(payload.command).toBe("run");
    expect(payload.status).toBe("canceled");
    expect(state.status).toBe("canceled");
    expect(state.counts.canceled).toBeGreaterThanOrEqual(1);
    expect(state.counts.skipped).toBeGreaterThanOrEqual(1);
    expect(runCanceledEvents).toHaveLength(1);
    expect(nodeCanceledEvents.length).toBeGreaterThanOrEqual(1);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("fails loudly when a repo path resolves to a file instead of a directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-repo-path-file-"));
    const repoFile = join(tempRoot, "repo.txt");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await writeFile(repoFile, "not a directory\n");
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-repo-path-file",
          repos: {
            main: {
              path: "./repo.txt"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "inplace"
          },
          profiles: {
            default: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "noop",
                repo: "main",
                command: "node",
                args: [
                  "-e",
                  "process.stdout.write('ok\\n')"
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    try {
      const result = await executeCli(["run", "--graph", graphPath], tempRoot);
      const payload = JSON.parse(result.stdout);

      expect(result.exitCode).toBe(1);
      expect(payload.command).toBe("run");
      expect(payload.status).toBe("failed");
      expect(payload.message).toBe("One or more repo sources could not be resolved for runtime execution.");
      expect(payload.path_resolution.graph_path).toBe(graphPath);
      expect(payload.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "$.repos.main.path",
            message: expect.stringContaining("Resolved repo path is not a directory")
          })
        ])
      );
      expect(payload.next_steps.validate).toContain("agentflow validate --graph");
      expect(payload.next_steps).not.toHaveProperty("compile");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("surfaces missing authored launch settings from the graph itself", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-launch-settings-"));
    const graphPath = join(tempRoot, "invalid-launch.graph.json");
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "invalid-launch-settings",
          repos: {
            main: {
              path: "."
            }
          },
          defaults: {
            workspace_backend: "inplace"
          },
          profiles: {
            review: {}
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "noop",
                command: "placeholder"
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const invalidValidate = await executeCli(["validate", "--graph", graphPath], tempRoot);
    const invalidValidatePayload = JSON.parse(invalidValidate.stdout);

    expect(invalidValidate.exitCode).toBe(1);
    expect(invalidValidatePayload.command).toBe("validate");
    expect(invalidValidatePayload.message).toContain("Launch settings could not be resolved from the graph");
    expect(invalidValidatePayload.available_profiles).toContain("review");
    expect(invalidValidatePayload.supported_workspace_backends).toContain("worktree");
    expect(invalidValidatePayload.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("No launch profile could be resolved")
        })
      ])
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("prints graph help with the local-first contract", async () => {
    const graphHelp = await executeCli(["graph-help"]);

    expect(graphHelp.exitCode).toBe(0);
    expect(graphHelp.stdout).toContain("Executable node kinds: agent, exec, check, checkpoint");
    expect(graphHelp.stdout).toContain(
      "Managed pattern scaffolds: pattern_deep_research, pattern_spec_design, pattern_generate_evaluate_fix, pattern_review_change"
    );
    expect(graphHelp.stdout).not.toContain("Legacy thin aliases");
    expect(graphHelp.stdout).toContain(`"version": "1"`);
    expect(graphHelp.stdout).toContain("Recommended local workflow:");
    expect(graphHelp.stdout).toContain("Repo paths in $.repos.*.path resolve relative to the graph file directory.");
  });

  it("rejects the removed control command", async () => {
    const result = await executeCli(["control", "--mission", "mission.json"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Unknown command: control");
  });

  it("renders command help and rejects unexpected positionals or options", async () => {
    const help = await executeCli(["run", "--help"]);
    const positional = await executeCli(["validate", "--graph", "agentflow.graph.json", "extra"]);
    const unexpectedOption = await executeCli(["validate", "--graph", "agentflow.graph.json", "--label", "oops"]);
    const removedLaunchOptions = await executeCli(["run", "--graph", "agentflow.graph.json", "--profile", "default"]);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: agentflow run --graph");
    expect(help.stdout).not.toContain("--workspace-backend <name>");
    expect(help.stdout).not.toContain("--profile <name>");
    expect(help.stdout).toContain("Examples:");
    expect(help.stdout).toContain("Press Ctrl-C");

    expect(positional.exitCode).toBe(2);
    expect(positional.stdout).toContain("Unexpected positional arguments: extra");
    expect(positional.stdout).toContain("Try: agentflow validate --help");
    expect(positional.stdout).toContain("Graph contract: agentflow graph-help");

    expect(unexpectedOption.exitCode).toBe(2);
    expect(unexpectedOption.stdout).toContain("Unexpected option(s): --label");
    expect(unexpectedOption.stdout).toContain("Try: agentflow validate --help");

    expect(removedLaunchOptions.exitCode).toBe(2);
    expect(removedLaunchOptions.stdout).toContain("Unexpected option(s): --profile");
    expect(removedLaunchOptions.stdout).toContain("Try: agentflow run --help");
  });

  it("supports explicit help entrypoints", async () => {
    const mainHelp = await executeCli(["--help"]);
    const validateHelp = await executeCli(["validate", "-h"]);
    const runsHelp = await executeCli(["runs", "--help"]);
    const inspectHelp = await executeCli(["inspect", "--help"]);

    expect(mainHelp.exitCode).toBe(0);
    expect(mainHelp.stdout).toContain("Agentflow CLI");
    expect(mainHelp.stdout).toContain("Runs root contract:");
    expect(mainHelp.stdout).not.toContain("control");

    expect(validateHelp.exitCode).toBe(0);
    expect(validateHelp.stdout).toContain("validate: Validate and compile an authored graph without launching a run.");
    expect(validateHelp.stdout).toContain("--show-compiled");

    expect(runsHelp.exitCode).toBe(0);
    expect(runsHelp.stdout).toContain("runs: Inspect previously recorded run roots");
    expect(runsHelp.stdout).toContain("--graph");

    expect(inspectHelp.exitCode).toBe(0);
    expect(inspectHelp.stdout).toContain("inspect: Inspect a recorded run root");
    expect(inspectHelp.stdout).toContain("Usage: agentflow inspect <run-root>");
  });

  it("lists recorded run summaries for a graph through agentflow runs list", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-runs-list-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-runs-list-graph",
          repos: { main: { path: "./repo" } },
          defaults: { launch_profile: "default", workspace_backend: "inplace" },
          profiles: { default: {} },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "noop",
                repo: "main",
                command: "node",
                args: ["-e", "process.stdout.write('ok\\n');"]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
      const secondRun = await executeCli(["run", "--graph", graphPath], tempRoot);
      expect(firstRun.exitCode).toBe(0);
      expect(secondRun.exitCode).toBe(0);

      const listResult = await executeCli(["runs", "list", "--graph", graphPath], tempRoot);
      const listPayload = JSON.parse(listResult.stdout);

      expect(listResult.exitCode).toBe(0);
      expect(listPayload.command).toBe("runs list");
      expect(listPayload.status).toBe("passed");
      expect(listPayload.runs_root).toBe(join(tempRoot, ".agentflow", "runs"));
      expect(listPayload.runs_root_source).toBe("graph-directory-default");
      expect(listPayload.graph_path).toBe(graphPath);
      expect(listPayload.runs_count).toBe(2);
      expect(listPayload.runs).toHaveLength(2);
      for (const summary of listPayload.runs) {
        expect(summary.graph_id).toBe("cli-runs-list-graph");
        expect(summary.graph_path).toBe(graphPath);
        expect(summary.status).toBe("passed");
        expect(summary.workspace_backend).toBe("inplace");
        expect(summary.launch_profile).toBe("default");
        expect(typeof summary.run_id).toBe("string");
        expect(typeof summary.started_at).toBe("string");
      }

      const firstParsed = JSON.parse(firstRun.stdout);
      const secondParsed = JSON.parse(secondRun.stdout);
      expect(listPayload.runs[0]!.run_id).toBe(secondParsed.run_id);
      expect(listPayload.runs[1]!.run_id).toBe(firstParsed.run_id);

      const explicitRunsRoot = await executeCli(
        ["runs", "list", "--runs-root", join(tempRoot, ".agentflow", "runs")],
        tempRoot
      );
      const explicitPayload = JSON.parse(explicitRunsRoot.stdout);
      expect(explicitRunsRoot.exitCode).toBe(0);
      expect(explicitPayload.runs_count).toBe(2);
      expect(explicitPayload.runs_root_source).toBe("launch-cwd-default");
    } finally {
      stderrSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid runs subcommands and combinations", async () => {
    const missing = await executeCli(["runs"]);
    const conflicting = await executeCli([
      "runs",
      "list",
      "--graph",
      "agentflow.graph.json",
      "--runs-root",
      "/tmp/runs"
    ]);
    const wrongSubcommand = await executeCli(["runs", "show"]);

    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toContain("Missing runs subcommand");

    expect(conflicting.exitCode).toBe(2);
    expect(conflicting.stdout).toContain("Provide either --graph or --runs-root, not both.");

    expect(wrongSubcommand.exitCode).toBe(2);
    expect(wrongSubcommand.stdout).toContain("Unexpected runs subcommand");
  });

  it("inspects a recorded run root and surfaces stderr tails for failures", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-inspect-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-inspect-graph",
          repos: { main: { path: "./repo" } },
          defaults: { launch_profile: "default", workspace_backend: "inplace" },
          profiles: { default: {} },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "boom",
                repo: "main",
                command: "node",
                args: [
                  "-e",
                  "process.stderr.write('failure-marker-12345\\n'); process.exit(1);"
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const runResult = await executeCli(["run", "--graph", graphPath], tempRoot);
      const runPayload = JSON.parse(runResult.stdout);
      expect(runResult.exitCode).toBe(1);
      expect(runPayload.status).toBe("failed");

      const inspectResult = await executeCli(["inspect", runPayload.run_root], tempRoot);
      const inspectPayload = JSON.parse(inspectResult.stdout);

      expect(inspectResult.exitCode).toBe(0);
      expect(inspectPayload.command).toBe("inspect");
      expect(inspectPayload.status).toBe("passed");
      expect(inspectPayload.run_root).toBe(runPayload.run_root);
      expect(inspectPayload.run_id).toBe(runPayload.run_id);
      expect(inspectPayload.graph_id).toBe("cli-inspect-graph");
      expect(inspectPayload.graph_path).toBe(graphPath);
      expect(inspectPayload.run_status).toBe("failed");
      expect(inspectPayload.failed_node_count).toBeGreaterThan(0);
      expect(inspectPayload.failed_node_stderr_tails).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authored_id: "boom",
            status: "failed",
            stderr_tail: expect.stringContaining("failure-marker-12345")
          })
        ])
      );
      expect(inspectPayload.artifacts.run_file).toBe(join(runPayload.run_root, "run.json"));
      expect(inspectPayload.artifacts.state_file).toBe(join(runPayload.run_root, "state.json"));
    } finally {
      stderrSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports missing run roots for inspect and rejects unexpected positionals", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-inspect-missing-"));
    try {
      const missing = await executeCli(["inspect"]);
      expect(missing.exitCode).toBe(2);
      expect(missing.stdout).toContain("Missing required positional argument: <run-root>");

      const extras = await executeCli(["inspect", "a", "b"]);
      expect(extras.exitCode).toBe(2);
      expect(extras.stdout).toContain("Unexpected positional arguments: b");

      const nonexistent = await executeCli(
        ["inspect", join(tempRoot, "missing-run-root")],
        tempRoot
      );
      const nonexistentPayload = JSON.parse(nonexistent.stdout);
      expect(nonexistent.exitCode).toBe(1);
      expect(nonexistentPayload.command).toBe("inspect");
      expect(nonexistentPayload.status).toBe("failed");
      expect(nonexistentPayload.message).toContain("Run root could not be resolved");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("resumes the latest failed run for a graph via resume --graph --latest", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-latest-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-resume-latest-graph",
          repos: { main: { path: "./repo" } },
          defaults: { launch_profile: "default", workspace_backend: "inplace" },
          profiles: { default: {} },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "check",
                id: "gate",
                repo: "main",
                check_kind: "deterministic",
                command: "node",
                args: [
                  "-e",
                  "const fs=require('node:fs'); const passed=fs.existsSync('latest-ok.txt'); process.stdout.write(JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                ],
                pass_if: { json_path: "$.passed", equals: true }
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
      const firstPayload = JSON.parse(firstRun.stdout);
      expect(firstRun.exitCode).toBe(1);
      expect(firstPayload.status).toBe("failed");

      const secondRun = await executeCli(["run", "--graph", graphPath], tempRoot);
      const secondPayload = JSON.parse(secondRun.stdout);
      expect(secondRun.exitCode).toBe(1);
      expect(secondPayload.status).toBe("failed");
      expect(secondPayload.run_id).not.toBe(firstPayload.run_id);

      await writeFile(join(repoDir, "latest-ok.txt"), "ok\n");

      const resumed = await executeCli(
        ["resume", "--graph", graphPath, "--latest"],
        tempRoot
      );
      const resumedPayload = JSON.parse(resumed.stdout);

      expect(resumed.exitCode).toBe(0);
      expect(resumedPayload.command).toBe("resume");
      expect(resumedPayload.status).toBe("passed");
      expect(resumedPayload.run_root).toBe(secondPayload.run_root);
      expect(resumedPayload.run_id).toBe(secondPayload.run_id);
    } finally {
      stderrSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports a friendly message when resume --latest finds no resumable runs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-latest-empty-"));
    const repoDir = join(tempRoot, "repo");
    const graphPath = join(tempRoot, "agentflow.graph.json");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "cli-resume-latest-empty-graph",
          repos: { main: { path: "./repo" } },
          defaults: { launch_profile: "default", workspace_backend: "inplace" },
          profiles: { default: {} },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "noop",
                repo: "main",
                command: "node",
                args: ["-e", "process.exit(0);"]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );

    try {
      const conflicting = await executeCli([
        "resume",
        "--run-root",
        "/tmp/some/run-root",
        "--graph",
        graphPath,
        "--latest"
      ]);
      expect(conflicting.exitCode).toBe(2);
      expect(conflicting.stdout).toContain(
        "Provide either --run-root or --latest with --graph, not both."
      );

      const missingGraph = await executeCli(["resume", "--latest"]);
      expect(missingGraph.exitCode).toBe(2);
      expect(missingGraph.stdout).toContain("--latest requires --graph to locate the runs root.");

      const missingAll = await executeCli(["resume"]);
      expect(missingAll.exitCode).toBe(2);
      expect(missingAll.stdout).toContain(
        "Missing required option: --run-root (or --graph with --latest)"
      );

      const noRunsRoot = await executeCli(
        ["resume", "--graph", graphPath, "--latest"],
        tempRoot
      );
      const noRunsRootPayload = JSON.parse(noRunsRoot.stdout);
      expect(noRunsRoot.exitCode).toBe(1);
      expect(noRunsRootPayload.command).toBe("resume");
      expect(noRunsRootPayload.status).toBe("failed");
      expect(noRunsRootPayload.message).toContain("No runs root found for the supplied graph.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns usage errors for missing required options and unknown commands", async () => {
    const missingGraph = await executeCli(["run"]);
    const unknownCommand = await executeCli(["ui"]);

    expect(missingGraph.exitCode).toBe(2);
    expect(missingGraph.stdout).toContain("Missing required option: --graph");
    expect(missingGraph.stdout).toContain("Try: agentflow run --help");
    expect(missingGraph.stdout).toContain("Graph contract: agentflow graph-help");
    expect(unknownCommand.exitCode).toBe(2);
    expect(unknownCommand.stdout).toContain("Unknown command: ui");
  });
});
