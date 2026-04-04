import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readRunExecutionAttempts } from "../../src/artifacts/reader.js";
import { executeCli } from "../../src/cli/index.js";

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
    expect(result.stdout).toContain("compile");
    expect(result.stdout).toContain("run");
    expect(result.stdout).toContain("resume");
    expect(result.stdout).toContain("ui");
    expect(result.stdout).toContain("graph-help");
    expect(result.stdout).toContain("control");
    expect(result.stdout).toContain("Local workflow:");
    expect(result.stdout).toContain("Path rules:");
    expect(result.stdout).toContain("graph-help: review the authored graph contract");
    expect(result.stdout).toContain("AGENTFLOW_RUNS_ROOT");
  });

  it("compiles the repeat graph fixture into the compiled graph contract", async () => {
    const graphPath = fileURLToPath(
      new URL("../graph/fixtures/repeat.graph.json", import.meta.url)
    );
    const result = await executeCli(["compile", "--graph", graphPath]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("compile");
    expect(payload.message).toContain("Compiled graph contract is ready");
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
    const result = await executeCli([
      "validate",
      "--graph",
      graphPath,
      "--profile",
      "default",
      "--workspace-backend",
      "worktree"
    ]);
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
    expect(payload.next_steps.compile).toContain("agentflow compile --graph");
    expect(payload.next_steps.graph_help).toBe("agentflow graph-help");
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
    expect(payload.runs_root_source).toBe("launch-cwd-default");
    expect(payload.default_runs_root).toBe(join(tempRoot, ".agentflow", "runs"));
    expect(payload.runs_root_contract).toContain("AGENTFLOW_RUNS_ROOT");
    expect(payload.run_root).toBe(join(payload.runs_root, payload.run_id));
    expect(payload.counts.passed).toBe(2);
    expect(payload.monitor.runs_root).toBe(payload.runs_root);
    expect(payload.monitor.start_command).toContain("AGENTFLOW_RUNS_ROOT=");
    expect(payload.monitor.start_command).toContain(payload.runs_root);
    expect(payload.monitor.monitor_route).toContain(`/runs/${payload.run_id}`);
    expect(payload.cancel_note).toContain("Ctrl-C");
    expect(payload.next_steps.open_monitor).toBe(payload.monitor.monitor_route);
    expect(payload.next_steps.start_monitor).toBe(payload.monitor.start_command);
    expect(state.status).toBe("passed");
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

  it("honors AGENTFLOW_RUNS_ROOT for artifact placement and monitor handoff", async () => {
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
      expect(payload.monitor.runs_root).toBe(runsRoot);
      expect(payload.monitor.start_command).toContain(runsRoot);
      expect(payload.monitor.dev_command).toContain(runsRoot);
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
    const firstProgress = firstStderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");

    expect(firstRun.exitCode).toBe(1);
    expect(firstPayload.command).toBe("run");
    expect(firstPayload.status).toBe("failed");
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

  it("rejects a relative AGENTFLOW_RUNS_ROOT override before UI handoff", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-ui-runs-root-"));
    const previousRunsRoot = process.env.AGENTFLOW_RUNS_ROOT;

    try {
      process.env.AGENTFLOW_RUNS_ROOT = "relative-runs";

      const result = await executeCli(["ui"], tempRoot);
      const payload = JSON.parse(result.stdout);

      expect(result.exitCode).toBe(1);
      expect(payload.command).toBe("ui");
      expect(payload.status).toBe("failed");
      expect(payload.message).toContain("AGENTFLOW_RUNS_ROOT must be an absolute path");
    } finally {
      if (previousRunsRoot === undefined) {
        delete process.env.AGENTFLOW_RUNS_ROOT;
      } else {
        process.env.AGENTFLOW_RUNS_ROOT = previousRunsRoot;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
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

  it("prepares UI preload metadata for a specific graph", async () => {
    const graphPath = fileURLToPath(
      new URL("../graph/fixtures/repeat.graph.json", import.meta.url)
    );
    const result = await executeCli(["ui", "--graph", graphPath]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("ui");
    expect(payload.status).toBe("ready");
    expect(payload.message).toContain("UI preload is ready");
    expect(payload.path_resolution.graph_path).toBe(graphPath);
    expect(payload.inspect_url).toContain(encodeURIComponent(graphPath));
    expect(payload.inspect_url).toContain("compiled=1");
    expect(payload.runs_root_contract).toContain("AGENTFLOW_RUNS_ROOT");
    expect(payload.dev_note).toContain("proxies /api plus /health");
    expect(payload.preload.compiled_node_count).toBe(7);
    expect(payload.next_steps.open_inspect).toBe(payload.inspect_url);
    expect(payload.next_steps.run).toContain("agentflow run --graph");
  });

  it("returns launchpad metadata when ui is requested without a graph", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-ui-"));

    try {
      const result = await executeCli(["ui"], tempRoot);
      const payload = JSON.parse(result.stdout);

      expect(result.exitCode).toBe(0);
      expect(payload.command).toBe("ui");
      expect(payload.status).toBe("ready");
      expect(payload.message).toContain("UI handoff is ready");
      expect(payload.runs_root).toBe(join(tempRoot, ".agentflow", "runs"));
      expect(payload.runs_root_env).toBe("AGENTFLOW_RUNS_ROOT");
      expect(payload.runs_root_source).toBe("launch-cwd-default");
      expect(payload.runs_root_contract).toContain("AGENTFLOW_RUNS_ROOT");
      expect(payload.launchpad_url).toContain("http://127.0.0.1:4178/");
      expect(payload.inspect_route).toContain("/graphs/inspect");
      expect(payload.inspect_route).toContain("compiled=1");
      expect(payload.dev_note).toContain("http://127.0.0.1:4179");
      expect(payload.runs_root_note).toContain("AGENTFLOW_RUNS_ROOT");
      expect(payload.note).toContain("Pass --graph");
      expect(payload.next_steps.graph_help).toBe("agentflow graph-help");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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
      expect(payload.next_steps.compile).toContain("agentflow compile --graph");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("surfaces launch override diagnostics from CLI arguments", async () => {
    const graphPath = fileURLToPath(
      new URL("../graph/fixtures/repeat.graph.json", import.meta.url)
    );
    const invalidProfile = await executeCli(["compile", "--graph", graphPath, "--profile", "missing"]);
    const invalidBackend = await executeCli(["validate", "--graph", graphPath, "--workspace-backend", "remote"]);
    const invalidProfilePayload = JSON.parse(invalidProfile.stdout);
    const invalidBackendPayload = JSON.parse(invalidBackend.stdout);

    expect(invalidProfile.exitCode).toBe(1);
    expect(invalidProfilePayload.command).toBe("compile");
    expect(invalidProfilePayload.message).toContain("Launch settings could not be resolved");
    expect(invalidProfilePayload.available_profiles).toContain("default");
    expect(invalidProfilePayload.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('Unknown launch profile "missing"')
        })
      ])
    );

    expect(invalidBackend.exitCode).toBe(1);
    expect(invalidBackendPayload.command).toBe("validate");
    expect(invalidBackendPayload.supported_workspace_backends).toContain("worktree");
    expect(invalidBackendPayload.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('Unsupported workspace backend "remote"')
        })
      ])
    );
  });

  it("prints graph help and exposes the deferred control stub", async () => {
    const graphHelp = await executeCli(["graph-help"]);
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-control-"));
    const missionPath = join(tempRoot, "mission.json");
    await writeFile(missionPath, JSON.stringify({ mission: "stub" }, null, 2));
    const control = await executeCli(["control", "--mission", missionPath], tempRoot);
    const controlPayload = JSON.parse(control.stdout);

    expect(graphHelp.exitCode).toBe(0);
    expect(graphHelp.stdout).toContain("Executable node kinds: agent, exec, check");
    expect(graphHelp.stdout).toContain(
      "Managed workflow scaffolds: deep_research, spec_design, execute_spec, review_change"
    );
    expect(graphHelp.stdout).not.toContain("Legacy thin aliases");
    expect(graphHelp.stdout).toContain(`"version": "1"`);
    expect(graphHelp.stdout).toContain("Recommended local workflow:");
    expect(graphHelp.stdout).toContain("Repo paths in $.repos.*.path resolve relative to the graph file directory.");

    expect(control.exitCode).toBe(1);
    expect(controlPayload.command).toBe("control");
    expect(controlPayload.status).toBe("deferred");
    expect(controlPayload.mission_path).toBe(missionPath);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("renders command help and rejects unexpected positionals or options", async () => {
    const help = await executeCli(["run", "--help"]);
    const positional = await executeCli(["validate", "--graph", "agentflow.graph.json", "extra"]);
    const unexpectedOption = await executeCli(["ui", "--label", "oops"]);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: agentflow run --graph");
    expect(help.stdout).toContain("--workspace-backend <name>");
    expect(help.stdout).toContain("Examples:");
    expect(help.stdout).toContain("Press Ctrl-C");

    expect(positional.exitCode).toBe(2);
    expect(positional.stdout).toContain("Unexpected positional arguments: extra");
    expect(positional.stdout).toContain("Try: agentflow validate --help");
    expect(positional.stdout).toContain("Graph contract: agentflow graph-help");

    expect(unexpectedOption.exitCode).toBe(2);
    expect(unexpectedOption.stdout).toContain("Unexpected option(s): --label");
    expect(unexpectedOption.stdout).toContain("Try: agentflow ui --help");
  });

  it("supports explicit help entrypoints and mission-specific control usage errors", async () => {
    const mainHelp = await executeCli(["--help"]);
    const validateHelp = await executeCli(["validate", "-h"]);
    const compileHelp = await executeCli(["compile", "--help"]);
    const uiHelp = await executeCli(["ui", "-h"]);
    const controlHelp = await executeCli(["control", "--help"]);
    const missingMission = await executeCli(["control"]);

    expect(mainHelp.exitCode).toBe(0);
    expect(mainHelp.stdout).toContain("Agentflow CLI");
    expect(mainHelp.stdout).toContain("Runs root contract:");

    expect(validateHelp.exitCode).toBe(0);
    expect(validateHelp.stdout).toContain("validate: Validate and compile an authored graph without launching a run.");
    expect(validateHelp.stdout).toContain("Use compile next");

    expect(compileHelp.exitCode).toBe(0);
    expect(compileHelp.stdout).toContain("compile: Resolve launch settings and emit the compiled graph contract.");
    expect(compileHelp.stdout).toContain("Use ui --graph");

    expect(uiHelp.exitCode).toBe(0);
    expect(uiHelp.stdout).toContain("ui: Prepare the graph-native launchpad or inspect a specific graph for UI preload.");
    expect(uiHelp.stdout).toContain("AGENTFLOW_RUNS_ROOT");
    expect(uiHelp.stdout).toContain("different working directories");

    expect(controlHelp.exitCode).toBe(0);
    expect(controlHelp.stdout).toContain("control: Reserved controller stub");
    expect(controlHelp.stdout).toContain("--mission <path>");
    expect(controlHelp.stdout).not.toContain("--graph <path>");

    expect(missingMission.exitCode).toBe(2);
    expect(missingMission.stdout).toContain("Missing required option: --mission");
    expect(missingMission.stdout).toContain("Try: agentflow control --help");
    expect(missingMission.stdout).not.toContain("Graph contract: agentflow graph-help");
  });

  it("returns usage errors for missing required options and unknown commands", async () => {
    const missingGraph = await executeCli(["run"]);
    const unknownCommand = await executeCli(["plan-help"]);

    expect(missingGraph.exitCode).toBe(2);
    expect(missingGraph.stdout).toContain("Missing required option: --graph");
    expect(missingGraph.stdout).toContain("Try: agentflow run --help");
    expect(missingGraph.stdout).toContain("Graph contract: agentflow graph-help");
    expect(unknownCommand.exitCode).toBe(2);
    expect(unknownCommand.stdout).toContain("Unknown command: plan-help");
  });
});
