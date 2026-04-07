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
import type { HarnessAdapter } from "../../src/runtime/harness/types.js";
import {
  listProjectedRuns,
  projectNodeDetail,
  projectNodeLogs,
  projectRunEvents,
  projectRunSnapshot,
  readProjectedArtifact
} from "../../src/artifacts/projection.js";
import { createRunOwnerRecord } from "../../src/artifacts/owner.js";
import {
  readRunExecutionAttempts,
  readRunRecord,
  readRunState
} from "../../src/artifacts/reader.js";
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
  return {
    launch,
    graph: compilation.compiled_graph!
  };
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function countNodeStatuses(nodeStatuses: Record<string, string>) {
  return Object.values(nodeStatuses).reduce(
    (counts, status) => {
      counts.total += 1;
      counts[status as keyof typeof counts] += 1;
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
    }
  );
}

async function createFixtureRun() {
  const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-projection-"));
  const repoDir = join(tempRoot, "repo");
  const runsRoot = join(tempRoot, ".agentflow", "runs");
  const runRoot = join(runsRoot, "projection-fixture");
  const graphPath = join(tempRoot, "agentflow.graph.json");
  await mkdir(repoDir, { recursive: true });
  await initGitRepo(repoDir);

  const document: AuthoredGraphDocument = {
    version: "1",
    graph_id: "projection-fixture",
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
  const { graph } = compileGraph(document);
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
    runRoot,
    runsRoot,
    run,
    compiledVerifyId: graph.authored_to_compiled["verify-fix"]![0]
  };
}

async function createAiTimeoutRun() {
  const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-projection-ai-timeout-"));
  const repoDir = join(tempRoot, "repo");
  const runRoot = join(tempRoot, ".agentflow", "runs", "ai-timeout-fixture");
  await mkdir(repoDir, { recursive: true });
  await initGitRepo(repoDir);

  const document: AuthoredGraphDocument = {
    version: "1",
    graph_id: "ai-timeout-fixture",
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
          type: "check",
          id: "judge-fix",
          repo: "main",
          check_kind: "ai",
          prompt: "Judge the graph output."
        }
      ]
    }
  };

  const { graph } = compileGraph(document);
  const timedOutHarness: HarnessAdapter = {
    kind: "codex-cli",
    preflight() {
      return [];
    },
    async run() {
      return {
        status: "failed",
        exitCode: 1,
        stdout: '{"passed":true,"score":1,"summary":"ok"}',
        metadata: {
          timed_out: true,
          force_killed: true
        }
      };
    },
    async cancel() {
      return;
    }
  };

  const run = await runCompiledGraph({
    run_root: runRoot,
    compiled_graph: graph,
    authored_graph: document,
    repo_sources: {
      main: repoDir
    },
    harnesses: {
      "codex-cli": timedOutHarness
    }
  });

  return {
    tempRoot,
    runRoot,
    run,
    compiledCheckId: graph.authored_to_compiled["judge-fix"]![0]
  };
}

describe("artifacts projection", () => {
  it("projects run snapshots, node attempts, events, logs, and artifacts from run artifacts", async () => {
    const fixture = await createFixtureRun();

    try {
      const state = await readRunState(fixture.runRoot);

      expect("artifact_index" in state).toBe(false);
      expect(await pathExists(join(fixture.runRoot, "repos"))).toBe(false);
      await Promise.all(
        fixture.run.attempts.map(async (attempt) => {
          expect(await pathExists(join(attempt.execution_dir, "artifacts"))).toBe(false);
        })
      );

      const runs = await listProjectedRuns(fixture.runsRoot);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("Passed");

      const snapshot = await projectRunSnapshot(fixture.runRoot);
      expect(snapshot.run.run_id).toBe(fixture.run.run_id);
      expect(snapshot.overlay_nodes.some((node) => node.compiled_id === fixture.compiledVerifyId)).toBe(true);
      expect(snapshot.run_diagnostics).toEqual([]);
      expect(snapshot.recent_events.at(-1)?.type).toBe("run.completed");

      const events = await projectRunEvents(fixture.runRoot, {
        compiled_id: fixture.compiledVerifyId
      });
      expect(events.events.some((event) => event.type === "check.evaluated")).toBe(true);

      const nodeDetail = await projectNodeDetail(fixture.runRoot, fixture.compiledVerifyId);
      expect(nodeDetail.executions).toHaveLength(2);
      expect(nodeDetail.check_evaluations.at(-1)?.passed).toBe(true);
      expect(nodeDetail.selected_execution_id).toBeDefined();
      expect(nodeDetail.artifacts.map((artifact) => artifact.relative_path)).toContain("result.json");

      const nodeLogs = await projectNodeLogs(
        fixture.runRoot,
        fixture.compiledVerifyId,
        nodeDetail.selected_execution_id
      );
      expect(nodeLogs.stdout?.content).toContain("\"passed\":true");
      expect(nodeLogs.artifacts.map((artifact) => artifact.relative_path)).toContain("stdout.log");

      const artifact = await readProjectedArtifact(
        fixture.runRoot,
        fixture.compiledVerifyId,
        nodeDetail.selected_execution_id!,
        "result.json"
      );
      expect(JSON.parse(artifact.content)).toMatchObject({
        currentCounter: 2,
        passed: true
      });
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("projects durable run diagnostics for timed-out AI checks", async () => {
    const fixture = await createAiTimeoutRun();

    try {
      const snapshot = await projectRunSnapshot(fixture.runRoot);

      expect(snapshot.run.status).toBe("Failed");
      expect(snapshot.run_diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: "check.evaluated",
            severity: "warning",
            compiled_id: fixture.compiledCheckId,
            summary: "AI check harness timed out and required a force kill."
          }),
          expect.objectContaining({
            event_type: "run.completed",
            severity: "error"
          })
        ])
      );
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("reconciles stale running state from terminal artifacts back to the terminal outcome", async () => {
    const fixture = await createFixtureRun();

    try {
      const runRecordPath = join(fixture.runRoot, "run.json");
      const statePath = join(fixture.runRoot, "state.json");
      const runRecord = await readRunRecord(fixture.runRoot);
      const state = await readRunState(fixture.runRoot);
      const staleState = {
        ...state,
        status: "running",
        snapshot_seq: Math.max(0, state.snapshot_seq - 1)
      };

      delete staleState.ended_at;
      await writeJson(runRecordPath, runRecord);
      await writeJson(statePath, staleState);

      const snapshot = await projectRunSnapshot(fixture.runRoot);
      const repairedState = await readRunState(fixture.runRoot);

      expect(snapshot.run.status).toBe("Passed");
      expect(snapshot.recent_events.at(-1)?.type).toBe("run.completed");
      expect(repairedState.status).toBe("passed");
      expect(repairedState.ended_at).toBeDefined();
      expect(repairedState.snapshot_seq).toBeGreaterThanOrEqual(state.snapshot_seq);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("does not reconcile an in-flight run while the recorded runtime owner fingerprint still matches", async () => {
    const fixture = await createFixtureRun();

    try {
      const runRecordPath = join(fixture.runRoot, "run.json");
      const statePath = join(fixture.runRoot, "state.json");
      const eventsPath = join(fixture.runRoot, "events.jsonl");
      const runRecord = await readRunRecord(fixture.runRoot);
      const state = await readRunState(fixture.runRoot);
      const attempts = await readRunExecutionAttempts(fixture.runRoot);
      const targetAttempt = attempts.at(-1);

      expect(targetAttempt).toBeDefined();

      const activeExecution = {
        execution_id: targetAttempt!.execution_id,
        compiled_id: targetAttempt!.compiled_id,
        authored_id: targetAttempt!.authored_id,
        repo_alias: targetAttempt!.repo_alias,
        kind: targetAttempt!.kind,
        attempt_index: targetAttempt!.attempt_index,
        ...(targetAttempt!.repeat_scope_id ? { repeat_scope_id: targetAttempt!.repeat_scope_id } : {}),
        ...(targetAttempt!.iteration_index !== undefined
          ? { iteration_index: targetAttempt!.iteration_index }
          : {}),
        started_at: targetAttempt!.started_at
      };
      const staleNodeStatuses = {
        ...state.node_statuses,
        [targetAttempt!.compiled_id]: "running"
      };
      const staleLatestExecution = {
        ...state.latest_execution_by_compiled_id,
        [targetAttempt!.compiled_id]: {
          ...state.latest_execution_by_compiled_id[targetAttempt!.compiled_id],
          status: "running",
          ended_at: undefined,
          duration_ms: undefined
        }
      };
      const staleState = {
        ...state,
        status: "running",
        snapshot_seq: Math.max(0, state.snapshot_seq - 1),
        node_statuses: staleNodeStatuses,
        active_executions: {
          [targetAttempt!.execution_id]: activeExecution
        },
        latest_execution_by_compiled_id: staleLatestExecution,
        counts: countNodeStatuses(staleNodeStatuses)
      };
      const staleRunRecord = {
        ...runRecord,
        status: "running",
        ...(await createRunOwnerRecord(process.pid))
      };
      const staleEvents = fixture.run.events.filter((event) => event.type !== "run.completed");
      const staleAttempt = {
        ...targetAttempt!,
        status: "running",
        ended_at: undefined,
        duration_ms: undefined
      };

      delete staleState.ended_at;
      delete staleRunRecord.ended_at;
      await writeJson(runRecordPath, staleRunRecord);
      await writeJson(statePath, staleState);
      await writeFile(
        eventsPath,
        `${staleEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
      );
      await writeJson(join(targetAttempt!.execution_dir, "execution.json"), staleAttempt);

      const snapshot = await projectRunSnapshot(fixture.runRoot);
      const repairedState = await readRunState(fixture.runRoot);
      const repairedRunRecord = await readRunRecord(fixture.runRoot);
      const repairedAttempts = await readRunExecutionAttempts(fixture.runRoot);
      const repairedAttempt = repairedAttempts.find(
        (attempt) => attempt.execution_id === targetAttempt!.execution_id
      );
      const repairedEvents = await projectRunEvents(fixture.runRoot);

      expect(snapshot.run.status).toBe("Running");
      expect(snapshot.run_diagnostics).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({
            event_type: "run.completed"
          })
        ])
      );
      expect(snapshot.recent_events.at(-1)?.type).not.toBe("run.completed");
      expect(repairedState.status).toBe("running");
      expect(repairedRunRecord.status).toBe("running");
      expect(repairedRunRecord.owner_pid).toBe(process.pid);
      expect(repairedRunRecord.owner_hostname).toBeDefined();
      expect(repairedState.active_executions).toEqual({
        [targetAttempt!.execution_id]: activeExecution
      });
      expect(repairedState.node_statuses[targetAttempt!.compiled_id]).toBe("running");
      expect(repairedAttempt?.status).toBe("running");
      expect(repairedEvents.events.some((event) => event.type === "run.completed")).toBe(false);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("reconciles a stale running artifact when the pid is live but the recorded owner fingerprint no longer matches", async () => {
    const fixture = await createFixtureRun();

    try {
      const runRecordPath = join(fixture.runRoot, "run.json");
      const statePath = join(fixture.runRoot, "state.json");
      const eventsPath = join(fixture.runRoot, "events.jsonl");
      const runRecord = await readRunRecord(fixture.runRoot);
      const state = await readRunState(fixture.runRoot);
      const attempts = await readRunExecutionAttempts(fixture.runRoot);
      const targetAttempt = attempts.at(-1);

      expect(targetAttempt).toBeDefined();

      const activeExecution = {
        execution_id: targetAttempt!.execution_id,
        compiled_id: targetAttempt!.compiled_id,
        authored_id: targetAttempt!.authored_id,
        repo_alias: targetAttempt!.repo_alias,
        kind: targetAttempt!.kind,
        attempt_index: targetAttempt!.attempt_index,
        ...(targetAttempt!.repeat_scope_id ? { repeat_scope_id: targetAttempt!.repeat_scope_id } : {}),
        ...(targetAttempt!.iteration_index !== undefined
          ? { iteration_index: targetAttempt!.iteration_index }
          : {}),
        started_at: targetAttempt!.started_at
      };
      const staleNodeStatuses = {
        ...state.node_statuses,
        [targetAttempt!.compiled_id]: "running"
      };
      const staleLatestExecution = {
        ...state.latest_execution_by_compiled_id,
        [targetAttempt!.compiled_id]: {
          ...state.latest_execution_by_compiled_id[targetAttempt!.compiled_id],
          status: "running",
          ended_at: undefined,
          duration_ms: undefined
        }
      };
      const staleState = {
        ...state,
        status: "running",
        snapshot_seq: Math.max(0, state.snapshot_seq - 1),
        node_statuses: staleNodeStatuses,
        active_executions: {
          [targetAttempt!.execution_id]: activeExecution
        },
        latest_execution_by_compiled_id: staleLatestExecution,
        counts: countNodeStatuses(staleNodeStatuses)
      };
      const currentOwner = await createRunOwnerRecord(process.pid);
      const staleRunRecord = {
        ...runRecord,
        status: "running",
        owner_pid: process.pid,
        owner_hostname: currentOwner.owner_hostname,
        owner_started_at: currentOwner.owner_started_at
          ? `${currentOwner.owner_started_at} mismatch`
          : "stale-owner-fingerprint"
      };
      const staleEvents = fixture.run.events.filter((event) => event.type !== "run.completed");
      const staleAttempt = {
        ...targetAttempt!,
        status: "running",
        ended_at: undefined,
        duration_ms: undefined,
        metadata: {}
      };

      delete staleState.ended_at;
      delete staleRunRecord.ended_at;
      await writeJson(runRecordPath, staleRunRecord);
      await writeJson(statePath, staleState);
      await writeFile(
        eventsPath,
        `${staleEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
      );
      await writeJson(join(targetAttempt!.execution_dir, "execution.json"), staleAttempt);

      const snapshot = await projectRunSnapshot(fixture.runRoot);
      const repairedRunRecord = await readRunRecord(fixture.runRoot);
      const repairedEvents = await projectRunEvents(fixture.runRoot);

      expect(snapshot.run.status).toBe("Failed");
      expect(snapshot.run_diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: "run.completed",
            summary: "Run failed: Recorded runtime owner was no longer active before writing a terminal snapshot."
          })
        ])
      );
      expect(repairedRunRecord.status).toBe("failed");
      expect(repairedRunRecord.owner_pid).toBeUndefined();
      expect(repairedRunRecord.owner_started_at).toBeUndefined();
      expect(repairedRunRecord.owner_hostname).toBeUndefined();
      expect(repairedEvents.events.at(-1)?.summary).toBe(
        "Run failed: Recorded runtime owner was no longer active before writing a terminal snapshot."
      );
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("reconciles a stale running artifact when the recorded owner hostname does not match this host", async () => {
    const fixture = await createFixtureRun();

    try {
      const runRecordPath = join(fixture.runRoot, "run.json");
      const statePath = join(fixture.runRoot, "state.json");
      const eventsPath = join(fixture.runRoot, "events.jsonl");
      const runRecord = await readRunRecord(fixture.runRoot);
      const state = await readRunState(fixture.runRoot);
      const attempts = await readRunExecutionAttempts(fixture.runRoot);
      const targetAttempt = attempts.at(-1);

      expect(targetAttempt).toBeDefined();

      const activeExecution = {
        execution_id: targetAttempt!.execution_id,
        compiled_id: targetAttempt!.compiled_id,
        authored_id: targetAttempt!.authored_id,
        repo_alias: targetAttempt!.repo_alias,
        kind: targetAttempt!.kind,
        attempt_index: targetAttempt!.attempt_index,
        ...(targetAttempt!.repeat_scope_id ? { repeat_scope_id: targetAttempt!.repeat_scope_id } : {}),
        ...(targetAttempt!.iteration_index !== undefined
          ? { iteration_index: targetAttempt!.iteration_index }
          : {}),
        started_at: targetAttempt!.started_at
      };
      const staleNodeStatuses = {
        ...state.node_statuses,
        [targetAttempt!.compiled_id]: "running"
      };
      const staleLatestExecution = {
        ...state.latest_execution_by_compiled_id,
        [targetAttempt!.compiled_id]: {
          ...state.latest_execution_by_compiled_id[targetAttempt!.compiled_id],
          status: "running",
          ended_at: undefined,
          duration_ms: undefined
        }
      };
      const staleState = {
        ...state,
        status: "running",
        snapshot_seq: Math.max(0, state.snapshot_seq - 1),
        node_statuses: staleNodeStatuses,
        active_executions: {
          [targetAttempt!.execution_id]: activeExecution
        },
        latest_execution_by_compiled_id: staleLatestExecution,
        counts: countNodeStatuses(staleNodeStatuses)
      };
      const staleRunRecord = {
        ...runRecord,
        status: "running",
        owner_pid: process.pid,
        owner_hostname: "agentflow-foreign-host"
      };
      const staleEvents = fixture.run.events.filter((event) => event.type !== "run.completed");
      const staleAttempt = {
        ...targetAttempt!,
        status: "running",
        ended_at: undefined,
        duration_ms: undefined,
        metadata: {}
      };

      delete staleState.ended_at;
      delete staleRunRecord.ended_at;
      await writeJson(runRecordPath, staleRunRecord);
      await writeJson(statePath, staleState);
      await writeFile(
        eventsPath,
        `${staleEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
      );
      await writeJson(join(targetAttempt!.execution_dir, "execution.json"), staleAttempt);

      const snapshot = await projectRunSnapshot(fixture.runRoot);
      const repairedRunRecord = await readRunRecord(fixture.runRoot);
      const repairedEvents = await projectRunEvents(fixture.runRoot);

      expect(snapshot.run.status).toBe("Failed");
      expect(snapshot.run_diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: "run.completed",
            summary: "Run failed: Recorded runtime owner was no longer active before writing a terminal snapshot."
          })
        ])
      );
      expect(repairedRunRecord.status).toBe("failed");
      expect(repairedRunRecord.owner_pid).toBeUndefined();
      expect(repairedRunRecord.owner_started_at).toBeUndefined();
      expect(repairedRunRecord.owner_hostname).toBeUndefined();
      expect(repairedEvents.events.at(-1)?.summary).toBe(
        "Run failed: Recorded runtime owner was no longer active before writing a terminal snapshot."
      );
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("reconciles stale pending artifacts without attempts to a failed terminal state", async () => {
    const fixture = await createFixtureRun();

    try {
      const runRecordPath = join(fixture.runRoot, "run.json");
      const statePath = join(fixture.runRoot, "state.json");
      const eventsPath = join(fixture.runRoot, "events.jsonl");
      const nodesDir = join(fixture.runRoot, "nodes");
      const runRecord = await readRunRecord(fixture.runRoot);
      const state = await readRunState(fixture.runRoot);
      const runStartedEvent = fixture.run.events.find((event) => event.type === "run.started");

      expect(runStartedEvent).toBeDefined();

      const staleNodeStatuses = Object.fromEntries(
        Object.keys(state.node_statuses).map((compiledId) => [compiledId, "pending"])
      ) as typeof state.node_statuses;
      const staleState = {
        ...state,
        status: "pending",
        snapshot_seq: runStartedEvent!.seq,
        node_statuses: staleNodeStatuses,
        active_executions: {},
        latest_execution_by_compiled_id: {},
        counts: countNodeStatuses(staleNodeStatuses)
      };
      const staleRunRecord = {
        ...runRecord,
        status: "pending",
        owner_pid: 999999
      };

      delete staleState.ended_at;
      delete staleRunRecord.ended_at;
      await rm(nodesDir, { recursive: true, force: true });
      await writeJson(runRecordPath, staleRunRecord);
      await writeJson(statePath, staleState);
      await writeFile(eventsPath, `${JSON.stringify(runStartedEvent)}\n`);

      const runs = await listProjectedRuns(fixture.runsRoot);
      const snapshot = await projectRunSnapshot(fixture.runRoot);
      const repairedState = await readRunState(fixture.runRoot);
      const repairedRunRecord = await readRunRecord(fixture.runRoot);
      const repairedAttempts = await readRunExecutionAttempts(fixture.runRoot);
      const repairedEvents = await projectRunEvents(fixture.runRoot);

      expect(runs).toEqual([
        expect.objectContaining({
          run_id: fixture.run.run_id,
          status: "Failed"
        })
      ]);
      expect(snapshot.run.status).toBe("Failed");
      expect(snapshot.run_diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: "run.completed",
            severity: "error",
            summary: "Run failed: Recorded runtime owner was no longer active before writing a terminal snapshot."
          })
        ])
      );
      expect(repairedState.status).toBe("failed");
      expect(repairedRunRecord.status).toBe("failed");
      expect(repairedRunRecord.owner_pid).toBeUndefined();
      expect(repairedRunRecord.owner_started_at).toBeUndefined();
      expect(repairedRunRecord.owner_hostname).toBeUndefined();
      expect(Object.values(repairedState.node_statuses).every((status) => status === "blocked")).toBe(true);
      expect(repairedState.counts.blocked).toBe(Object.keys(staleNodeStatuses).length);
      expect(repairedAttempts).toEqual([]);
      expect(repairedEvents.events.at(-1)?.type).toBe("run.completed");
      expect(repairedEvents.events.at(-1)?.summary).toBe(
        "Run failed: Recorded runtime owner was no longer active before writing a terminal snapshot."
      );
      expect(await readFile(join(fixture.runRoot, "summary.md"), "utf8")).toContain(
        "No node executions were recorded."
      );
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it("reconciles interrupted running artifacts to a failed terminal state", async () => {
    const fixture = await createFixtureRun();

    try {
      const runRecordPath = join(fixture.runRoot, "run.json");
      const statePath = join(fixture.runRoot, "state.json");
      const eventsPath = join(fixture.runRoot, "events.jsonl");
      const runRecord = await readRunRecord(fixture.runRoot);
      const state = await readRunState(fixture.runRoot);
      const attempts = await readRunExecutionAttempts(fixture.runRoot);
      const targetAttempt = attempts.at(-1);

      expect(targetAttempt).toBeDefined();

      const activeExecution = {
        execution_id: targetAttempt!.execution_id,
        compiled_id: targetAttempt!.compiled_id,
        authored_id: targetAttempt!.authored_id,
        repo_alias: targetAttempt!.repo_alias,
        kind: targetAttempt!.kind,
        attempt_index: targetAttempt!.attempt_index,
        ...(targetAttempt!.repeat_scope_id ? { repeat_scope_id: targetAttempt!.repeat_scope_id } : {}),
        ...(targetAttempt!.iteration_index !== undefined
          ? { iteration_index: targetAttempt!.iteration_index }
          : {}),
        started_at: targetAttempt!.started_at
      };
      const staleNodeStatuses = {
        ...state.node_statuses,
        [targetAttempt!.compiled_id]: "running"
      };
      const staleLatestExecution = {
        ...state.latest_execution_by_compiled_id,
        [targetAttempt!.compiled_id]: {
          ...state.latest_execution_by_compiled_id[targetAttempt!.compiled_id],
          status: "running",
          ended_at: undefined,
          duration_ms: undefined
        }
      };
      const staleState = {
        ...state,
        status: "running",
        snapshot_seq: Math.max(0, state.snapshot_seq - 1),
        node_statuses: staleNodeStatuses,
        active_executions: {
          [targetAttempt!.execution_id]: activeExecution
        },
        latest_execution_by_compiled_id: staleLatestExecution,
        counts: countNodeStatuses(staleNodeStatuses)
      };
      const staleRunRecord = {
        ...runRecord,
        status: "running",
        owner_pid: 999999
      };
      const staleEvents = fixture.run.events.filter((event) => event.type !== "run.completed");
      const staleAttempt = {
        ...targetAttempt!,
        status: "running",
        ended_at: undefined,
        duration_ms: undefined,
        metadata: {}
      };

      delete staleState.ended_at;
      delete staleRunRecord.ended_at;
      await writeJson(runRecordPath, staleRunRecord);
      await writeJson(statePath, staleState);
      await writeFile(
        eventsPath,
        `${staleEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
      );
      await writeJson(join(targetAttempt!.execution_dir, "execution.json"), staleAttempt);

      const snapshot = await projectRunSnapshot(fixture.runRoot);
      const repairedState = await readRunState(fixture.runRoot);
      const repairedRunRecord = await readRunRecord(fixture.runRoot);
      const repairedAttempts = await readRunExecutionAttempts(fixture.runRoot);
      const repairedAttempt = repairedAttempts.find(
        (attempt) => attempt.execution_id === targetAttempt!.execution_id
      );
      const repairedEvents = await projectRunEvents(fixture.runRoot);

      expect(snapshot.run.status).toBe("Failed");
      expect(snapshot.run_diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: "run.completed",
            summary: "Run failed: Recorded runtime owner was no longer active before writing a terminal snapshot."
          })
        ])
      );
      expect(repairedState.status).toBe("failed");
      expect(repairedRunRecord.status).toBe("failed");
      expect(repairedRunRecord.owner_pid).toBeUndefined();
      expect(repairedRunRecord.owner_started_at).toBeUndefined();
      expect(repairedRunRecord.owner_hostname).toBeUndefined();
      expect(repairedState.active_executions).toEqual({});
      expect(repairedState.node_statuses[targetAttempt!.compiled_id]).toBe("canceled");
      expect(repairedAttempt?.status).toBe("canceled");
      expect(repairedAttempt?.metadata).toEqual(
        expect.objectContaining({
          reconciled_reason: "Recorded runtime owner was no longer active before writing a terminal snapshot."
        })
      );
      expect(repairedEvents.events.at(-1)?.type).toBe("run.completed");
      expect(repairedEvents.events.at(-1)?.summary).toBe(
        "Run failed: Recorded runtime owner was no longer active before writing a terminal snapshot."
      );
      expect(await readFile(join(fixture.runRoot, "summary.md"), "utf8")).toContain(
        "Recorded runtime owner was no longer active before writing a terminal snapshot."
      );
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });
});
