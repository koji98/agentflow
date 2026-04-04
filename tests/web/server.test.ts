import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";
import type { ArtifactRead, NodeDetail, NodeLogPayload, RunEventPage, RunSnapshot, RunSummary } from "../../web-app/shared/contracts/runs";
import type { GraphInspectionPayload } from "../../web-app/shared/contracts/graph";
import { createWebAppServer } from "../../web-app/server/app";
import { createNodeWebServer } from "../../web-app/server/index";

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

async function createFixtureRun() {
  const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-server-"));
  const repoDir = join(tempRoot, "repo");
  const runsRoot = join(tempRoot, ".agentflow", "runs");
  const runRoot = join(runsRoot, "server-fixture");
  const graphPath = join(tempRoot, "agentflow.graph.json");
  await mkdir(repoDir, { recursive: true });
  await initGitRepo(repoDir);

  const document: AuthoredGraphDocument = {
    version: "1",
    graph_id: "server-fixture",
    repos: {
      main: {
        path: "repo"
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
          type: "agent",
          id: "inspect",
          prompt: "Inspect the repository.",
          outputs: [
            {
              name: "notes",
              from: "attempt",
              path: "notes.md",
              required: true
            }
          ]
        },
        {
          type: "repeat",
          id: "repair-loop",
          max_attempts: 2,
          body: {
            type: "sequence",
            id: "repair-body",
            steps: [
              {
                type: "agent",
                id: "apply-fix",
                prompt: "Apply the fix.",
                outputs: [
                  {
                    name: "patch",
                    from: "attempt",
                    path: "patch.md",
                    required: true
                  }
                ]
              },
              {
                type: "check",
                id: "verify-fix",
                check_kind: "deterministic",
                command: "placeholder",
                outputs: [
                  {
                    name: "verification",
                    from: "attempt",
                    path: "result.json",
                    required: true
                  }
                ]
              }
            ]
          },
          until: {
            node: "verify-fix"
          }
        },
        {
          type: "exec",
          id: "finalize",
          command: "placeholder",
          context_from: [
            {
              node: "verify-fix",
              include: "output",
              output: "verification",
              iteration: "latest_passed"
            }
          ]
        }
      ]
    }
  };

  await writeFile(graphPath, `${JSON.stringify(document, null, 2)}\n`);
  const graph = compileGraph(document);
  let repairAttempts = 0;
  const run = await runCompiledGraph({
    run_root: runRoot,
    compiled_graph: graph,
    authored_graph: document,
    repo_sources: {
      main: repoDir
    },
    executors: {
      agent: async ({ node, execution_dir, workspace_path }) => {
        if (node.authored_id === "inspect") {
          await writeFile(join(execution_dir, "notes.md"), "inspection complete\n");
          return {
            status: "passed",
            outcome: "passed",
            result: {
              inspected: true
            },
            stdout: "inspection complete\n",
            stderr: ""
          };
        }

        repairAttempts += 1;
        await writeFile(join(workspace_path, "repair-counter.txt"), `${repairAttempts}\n`);
        await writeFile(join(execution_dir, "patch.md"), `repair attempt ${repairAttempts}\n`);

        return {
          status: "passed",
          outcome: "passed",
          result: {
            repairAttempts
          },
          stdout: `repair attempt ${repairAttempts}\n`,
          stderr: ""
        };
      },
      check: async ({ workspace_path }) => {
        const currentCounter = Number((await readFile(join(workspace_path, "repair-counter.txt"), "utf8")).trim());
        const passed = currentCounter >= 2;

        return {
          status: passed ? "passed" : "failed",
          outcome: passed ? "passed" : "failed",
          result: {
            passed,
            currentCounter
          },
          stdout: JSON.stringify({
            passed,
            currentCounter
          }),
          stderr: "",
          check: {
            check_kind: "deterministic",
            passed,
            summary: passed ? "verification passed" : "retry required"
          }
        };
      },
      exec: async ({ node, context_packet_path }) => {
        if (node.authored_id === "finalize") {
          const packet = JSON.parse(await readFile(context_packet_path, "utf8")) as {
            materials: unknown[];
          };
          expect(packet.materials.length).toBeGreaterThan(0);
        }

        return {
          status: "passed",
          outcome: "passed",
          result: {
            node: node.authored_id
          },
          stdout: `${node.authored_id} ok\n`,
          stderr: ""
        };
      }
    }
  });

  return {
    tempRoot,
    graphPath,
    runsRoot,
    run,
    compiledVerifyId: graph.authored_to_compiled["verify-fix"]![0]
  };
}

async function listen(server: ReturnType<typeof createNodeWebServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address() as AddressInfo | null;

  if (!address) {
    throw new Error("Server did not expose an address.");
  }

  return `http://127.0.0.1:${address.port}`;
}

describe("web server contracts", () => {
  it("serves graph inspection, run overlays, node attempts, events, logs, artifacts, and event streams", async () => {
    const fixture = await createFixtureRun();

    try {
      const server = createWebAppServer({
        current_working_directory: fixture.tempRoot,
        runs_root: fixture.runsRoot
      });

      expect(server.routes).toContain("/api/graphs/inspect");
      expect(server.routes).toContain("/api/runs/:runId/events/stream");
      expect(await server.getJson("/health")).toEqual({
        status: "ok",
        surface: "graph-native-monitor"
      });

      const graphResponse = await server.request(
        "GET",
        `/api/graphs/inspect?path=${encodeURIComponent(fixture.graphPath)}`
      );
      expect(graphResponse.kind).toBe("json");
      expect(graphResponse.status).toBe(200);
      const graphPayload = graphResponse.kind === "json"
        ? graphResponse.body as GraphInspectionPayload
        : undefined;
      expect(graphPayload?.compile_status).toBe("Pending");
      expect(graphPayload?.modes).toEqual(["Authored"]);
      expect(graphPayload?.compiled_graph).toBeUndefined();

      const compiledGraphResponse = await server.request(
        "GET",
        `/api/graphs/inspect?path=${encodeURIComponent(fixture.graphPath)}&compiled=1`
      );
      expect(compiledGraphResponse.kind).toBe("json");
      expect(compiledGraphResponse.status).toBe(200);
      const compiledGraphPayload = compiledGraphResponse.kind === "json"
        ? compiledGraphResponse.body as GraphInspectionPayload
        : undefined;
      expect(compiledGraphPayload?.compile_status).toBe("Ready");
      expect(compiledGraphPayload?.modes).toEqual(["Authored", "Compiled"]);
      expect(compiledGraphPayload?.compiled_graph?.nodes.length).toBeGreaterThan(0);

      const runsPayload = await server.getJson("/api/runs") as {
        runs: RunSummary[];
      };
      expect(runsPayload.runs).toHaveLength(1);
      expect(runsPayload.runs[0]?.run_id).toBe(fixture.run.run_id);

      const snapshotPayload = await server.getJson(`/api/runs/${fixture.run.run_id}`) as RunSnapshot;
      expect(snapshotPayload.run.status).toBe("Passed");
      expect(snapshotPayload.run_diagnostics).toEqual([]);
      expect(snapshotPayload.overlay_nodes.some((node) => node.compiled_id === fixture.compiledVerifyId)).toBe(true);

      const nodePayload = await server.getJson(
        `/api/runs/${fixture.run.run_id}/nodes/${fixture.compiledVerifyId}`
      ) as NodeDetail;
      expect(nodePayload.executions).toHaveLength(2);
      expect(nodePayload.selected_execution_id).toBeDefined();
      expect(nodePayload.check_evaluations.at(-1)?.passed).toBe(true);

      const eventsPayload = await server.getJson(
        `/api/runs/${fixture.run.run_id}/events?compiled_id=${fixture.compiledVerifyId}`
      ) as RunEventPage;
      expect(eventsPayload.events.some((event) => event.type === "check.evaluated")).toBe(true);

      const logsPayload = await server.getJson(
        `/api/runs/${fixture.run.run_id}/nodes/${fixture.compiledVerifyId}/logs?execution_id=${nodePayload.selected_execution_id}`
      ) as NodeLogPayload;
      expect(logsPayload.stdout?.content).toContain("\"passed\":true");

      const artifactPayload = await server.getJson(
        `/api/runs/${fixture.run.run_id}/nodes/${fixture.compiledVerifyId}/artifact?execution_id=${nodePayload.selected_execution_id}&relative_path=${encodeURIComponent("result.json")}`
      ) as ArtifactRead;
      expect(JSON.parse(artifactPayload.content)).toMatchObject({
        currentCounter: 2,
        passed: true
      });

      const sseResponse = await server.request(
        "GET",
        `/api/runs/${fixture.run.run_id}/events/stream?after_seq=${Math.max(0, fixture.run.state.snapshot_seq - 2)}`
      );
      expect(sseResponse.kind).toBe("sse");

      if (sseResponse.kind === "sse") {
        const streamedEvents: Array<{ event: string; payload: unknown }> = [];
        await sseResponse.stream({
          write(event, payload) {
            streamedEvents.push({
              event,
              payload
            });
          },
          close() {
            // no-op for test collection
          }
        });

        expect(streamedEvents.length).toBeGreaterThan(0);
        expect(streamedEvents.at(-1)?.event).toBe("run.completed");
      }
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("honors inspection overrides, filters event pages, and rejects invalid run ids", async () => {
    const fixture = await createFixtureRun();

    try {
      const server = createWebAppServer({
        current_working_directory: fixture.tempRoot,
        runs_root: fixture.runsRoot
      });

      const graphResponse = await server.request(
        "GET",
        `/api/graphs/inspect?path=${encodeURIComponent(fixture.graphPath)}&workspace_backend=inplace`
      );
      expect(graphResponse.kind).toBe("json");
      expect(graphResponse.status).toBe(200);
      const graphPayload = graphResponse.kind === "json"
        ? graphResponse.body as GraphInspectionPayload
        : undefined;

      expect(graphPayload?.workspace_backend).toBe("inplace");
      expect(graphPayload?.launch_resolution.workspace_backend).toBe("inplace");
      expect(graphPayload?.repos[0]?.workspace_path).toBe(graphPayload?.repos[0]?.source_path);

      const filteredRuns = await server.getJson("/api/runs?graph_id=missing-graph") as {
        runs: RunSummary[];
      };
      expect(filteredRuns.runs).toEqual([]);

      const limitedEvents = await server.getJson(
        `/api/runs/${fixture.run.run_id}/events?after_seq=${Math.max(0, fixture.run.state.snapshot_seq - 5)}&limit=1`
      ) as RunEventPage;
      expect(limitedEvents.events).toHaveLength(1);

      const invalidRunResponse = await server.request("GET", "/api/runs/%2E%2E%2Fescape");
      expect(invalidRunResponse.kind).toBe("json");

      if (invalidRunResponse.kind === "json") {
        expect(invalidRunResponse.status).toBe(400);
        expect(invalidRunResponse.body).toEqual({
          error: "run_id_invalid",
          message: "Invalid run_id."
        });
      }
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("returns inspection payload diagnostics when the graph file is unreadable or malformed", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-server-inspect-failure-"));
    const malformedGraphPath = join(tempRoot, "broken.graph.json");
    await mkdir(tempRoot, { recursive: true });
    await writeFile(malformedGraphPath, "{\n  \"version\": \"1\",\n");

    try {
      const server = createWebAppServer({
        current_working_directory: tempRoot
      });

      const malformedResponse = await server.request(
        "GET",
        `/api/graphs/inspect?path=${encodeURIComponent(malformedGraphPath)}&workspace_backend=remote`
      );
      expect(malformedResponse.kind).toBe("json");
      expect(malformedResponse.status).toBe(200);

      if (malformedResponse.kind === "json") {
        const payload = malformedResponse.body as GraphInspectionPayload;
        expect(payload.compile_status).toBe("Failed");
        expect(payload.launch_resolution.workspace_backend).toBe("worktree");
        expect(payload.launch_resolution.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringContaining('Unsupported workspace backend "remote"')
            })
          ])
        );
        expect(payload.validation_diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: malformedGraphPath,
              message: expect.any(String)
            })
          ])
        );
      }

      const missingResponse = await server.request(
        "GET",
        `/api/graphs/inspect?path=${encodeURIComponent(join(tempRoot, "missing.graph.json"))}`
      );
      expect(missingResponse.kind).toBe("json");
      expect(missingResponse.status).toBe(200);

      if (missingResponse.kind === "json") {
        const payload = missingResponse.body as GraphInspectionPayload;
        expect(payload.compile_status).toBe("Failed");
        expect(payload.validation_diagnostics[0]?.message).toContain("no such file");
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns an empty run list when the resolved runs root does not exist yet", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-web-empty-runs-"));

    try {
      const server = createWebAppServer({
        current_working_directory: tempRoot
      });

      await expect(server.getJson("/api/runs")).resolves.toEqual({
        runs: []
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reads runs from INIT_CWD/.agentflow/runs when AGENTFLOW_RUNS_ROOT is unset", async () => {
    const fixture = await createFixtureRun();
    const previousRunsRoot = process.env.AGENTFLOW_RUNS_ROOT;
    const previousInitCwd = process.env.INIT_CWD;

    delete process.env.AGENTFLOW_RUNS_ROOT;
    process.env.INIT_CWD = fixture.tempRoot;

    const server = createNodeWebServer();

    try {
      const baseUrl = await listen(server);
      const runsResponse = await fetch(`${baseUrl}/api/runs`);

      expect(runsResponse.status).toBe(200);
      await expect(runsResponse.json()).resolves.toEqual({
        runs: [
          expect.objectContaining({
            run_id: fixture.run.run_id
          })
        ]
      });
    } finally {
      server.close();

      if (previousRunsRoot === undefined) {
        delete process.env.AGENTFLOW_RUNS_ROOT;
      } else {
        process.env.AGENTFLOW_RUNS_ROOT = previousRunsRoot;
      }

      if (previousInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previousInitCwd;
      }

      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("reads runs from AGENTFLOW_RUNS_ROOT when the monitor starts from a different working directory", async () => {
    const fixture = await createFixtureRun();
    const monitorLaunchRoot = join(fixture.tempRoot, "monitor-shell");
    const previousRunsRoot = process.env.AGENTFLOW_RUNS_ROOT;
    const previousInitCwd = process.env.INIT_CWD;

    await mkdir(monitorLaunchRoot, { recursive: true });
    process.env.AGENTFLOW_RUNS_ROOT = fixture.runsRoot;
    process.env.INIT_CWD = monitorLaunchRoot;

    const server = createNodeWebServer();

    try {
      const baseUrl = await listen(server);
      const runsResponse = await fetch(`${baseUrl}/api/runs`);

      expect(runsResponse.status).toBe(200);
      await expect(runsResponse.json()).resolves.toEqual({
        runs: [
          expect.objectContaining({
            run_id: fixture.run.run_id
          })
        ]
      });
    } finally {
      server.close();

      if (previousRunsRoot === undefined) {
        delete process.env.AGENTFLOW_RUNS_ROOT;
      } else {
        process.env.AGENTFLOW_RUNS_ROOT = previousRunsRoot;
      }

      if (previousInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previousInitCwd;
      }

      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a relative AGENTFLOW_RUNS_ROOT override when the monitor starts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-web-relative-runs-root-"));
    const previousRunsRoot = process.env.AGENTFLOW_RUNS_ROOT;
    const previousInitCwd = process.env.INIT_CWD;

    try {
      process.env.AGENTFLOW_RUNS_ROOT = "relative-runs";
      process.env.INIT_CWD = tempRoot;

      expect(() => createNodeWebServer()).toThrowError(
        "AGENTFLOW_RUNS_ROOT must be an absolute path when set. Received: relative-runs"
      );
    } finally {
      if (previousRunsRoot === undefined) {
        delete process.env.AGENTFLOW_RUNS_ROOT;
      } else {
        process.env.AGENTFLOW_RUNS_ROOT = previousRunsRoot;
      }

      if (previousInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previousInitCwd;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves the built client shell, deep links, assets, and API routes from the start server", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-web-start-"));
    const distRoot = join(tempRoot, "dist", "client");
    const assetPath = join(distRoot, "assets", "app.js");
    const runsRoot = join(tempRoot, ".agentflow", "runs");
    await mkdir(join(distRoot, "assets"), { recursive: true });
    await mkdir(runsRoot, { recursive: true });
    await writeFile(
      join(distRoot, "index.html"),
      "<!doctype html><html><body><div id=\"app\">graph monitor</div><script type=\"module\" src=\"/assets/app.js\"></script></body></html>\n"
    );
    await writeFile(assetPath, "console.log('graph monitor');\n");

    const server = createNodeWebServer({
      current_working_directory: tempRoot,
      runs_root: runsRoot,
      client_dist_root: distRoot
    });

    try {
      const baseUrl = await listen(server);

      const rootResponse = await fetch(`${baseUrl}/`);
      expect(rootResponse.status).toBe(200);
      expect(rootResponse.headers.get("content-type")).toContain("text/html");
      expect(await rootResponse.text()).toContain("graph monitor");

      const routeResponse = await fetch(`${baseUrl}/runs/demo-run`);
      expect(routeResponse.status).toBe(200);
      expect(routeResponse.headers.get("content-type")).toContain("text/html");
      expect(await routeResponse.text()).toContain("graph monitor");

      const assetResponse = await fetch(`${baseUrl}/assets/app.js`);
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("content-type")).toContain("application/javascript");
      expect(await assetResponse.text()).toContain("graph monitor");

      const healthResponse = await fetch(`${baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({
        status: "ok",
        surface: "graph-native-monitor"
      });
    } finally {
      server.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns an actionable 503 when the built client is missing", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-web-missing-build-"));
    const runsRoot = join(tempRoot, ".agentflow", "runs");
    const missingDistRoot = join(tempRoot, "dist", "client");
    await mkdir(runsRoot, { recursive: true });

    const server = createNodeWebServer({
      current_working_directory: tempRoot,
      runs_root: runsRoot,
      client_dist_root: missingDistRoot
    });

    try {
      const baseUrl = await listen(server);
      const response = await fetch(`${baseUrl}/`);

      expect(response.status).toBe(503);
      expect(await response.text()).toContain("Run npm run build before npm run start --workspace web-app.");
    } finally {
      server.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
