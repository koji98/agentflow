import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveRunArtifactPaths } from "../../src/artifacts/paths.js";
import { inspectCommand } from "../../src/cli/commands/inspect.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { RuntimeStateSnapshot } from "../../src/runtime/session.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeAttempt(runRoot: string, segment: string, attempt: RuntimeNodeAttempt, stderr = ""): Promise<RuntimeNodeAttempt> {
  const executionDir = join(runRoot, "nodes", segment, "executions", attempt.execution_id);
  const stderrPath = join(executionDir, "human-debug", "harness", "stderr.log");
  const completed = {
    ...attempt,
    execution_dir: executionDir,
    stderr_log_path: stderrPath
  };
  await writeJson(join(executionDir, "runtime", "execution.json"), completed);
  await mkdir(dirname(stderrPath), { recursive: true });
  await writeFile(stderrPath, stderr, "utf8");
  return completed;
}

function baseAttempt(values: {
  compiled_id: string;
  authored_id: string;
  execution_id: string;
  status: RuntimeNodeAttempt["status"];
  outcome?: RuntimeNodeAttempt["outcome"];
  attempt_index?: number;
}): RuntimeNodeAttempt {
  return {
    execution_id: values.execution_id,
    compiled_id: values.compiled_id,
    authored_id: values.authored_id,
    kind: "agent",
    repo_alias: "main",
    execution_dir: "",
    attempt_index: values.attempt_index ?? 1,
    status: values.status,
    ...(values.outcome ? { outcome: values.outcome } : {}),
    started_at: "2026-05-25T10:00:00.000Z",
    ended_at: "2026-05-25T10:01:00.000Z",
    artifacts: {},
    metadata: {}
  };
}

function baseState(overrides: Partial<RuntimeStateSnapshot>): RuntimeStateSnapshot {
  return {
    run_id: "run-1",
    graph_id: "inspect-graph",
    snapshot_seq: 1,
    status: "running",
    graph_status: "running",
    delivery_status: "pending",
    review_ready: false,
    evidence_status: "clean",
    workspace_backend: "inplace",
    repo_workspaces: {},
    workspace_change_artifacts: {},
    counts: {
      total: 3,
      pending: 0,
      ready: 0,
      running: 1,
      passed: 1,
      failed: 1,
      blocked: 0,
      canceled: 0,
      skipped: 0
    },
    soft_verification_counts: { passed: 0, failed: 0 },
    failed_soft_verifications: [],
    supervisor: {
      status: "intervening",
      intervention_count: 1,
      budget_remaining: { max_total_interventions: 2 },
      timeline: [],
      active_recovery_envelopes: {},
      active_recovery_chains: {},
      failure_fingerprints: {},
      escalations: []
    },
    node_statuses: {
      root__recovered: "passed",
      root__broken: "failed",
      root__active: "running"
    },
    active_executions: {
      "exec-active": {
        execution_id: "exec-active",
        compiled_id: "root__active",
        authored_id: "active",
        repo_alias: "main",
        kind: "agent",
        attempt_index: 1,
        started_at: "2026-05-25T10:05:00.000Z"
      }
    },
    latest_execution_by_compiled_id: {
      root__recovered: {
        execution_id: "exec-recovered-pass",
        compiled_id: "root__recovered",
        authored_id: "recovered",
        kind: "agent",
        status: "passed",
        attempt_index: 2,
        started_at: "2026-05-25T10:02:00.000Z"
      },
      root__broken: {
        execution_id: "exec-active-fail",
        compiled_id: "root__broken",
        authored_id: "broken",
        kind: "agent",
        status: "failed",
        attempt_index: 1,
        started_at: "2026-05-25T10:03:00.000Z"
      }
    },
    repeat_scopes: {},
    started_at: "2026-05-25T10:00:00.000Z",
    ...overrides
  };
}

describe("inspect command", () => {
  it("separates active failed nodes from historical failed attempts and derives stale supervisor status", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-inspect-"));
    const runRoot = join(tempRoot, "run");
    const paths = resolveRunArtifactPaths(runRoot);
    await mkdir(runRoot, { recursive: true });
    await writeJson(paths.run_file, {
      run_id: "run-1",
      graph_id: "inspect-graph",
      launch_profile: "default",
      workspace_backend: "inplace",
      status: "running",
      started_at: "2026-05-25T10:00:00.000Z"
    });
    await writeJson(paths.state_file, baseState({}));
    await writeFile(paths.events_file, "", "utf8");

    await writeAttempt(runRoot, "001-recovered", baseAttempt({
      compiled_id: "root__recovered",
      authored_id: "recovered",
      execution_id: "exec-recovered-fail",
      status: "failed",
      outcome: "failed",
      attempt_index: 1
    }), "old recovered failure\n");
    await writeAttempt(runRoot, "001-recovered", baseAttempt({
      compiled_id: "root__recovered",
      authored_id: "recovered",
      execution_id: "exec-recovered-pass",
      status: "passed",
      outcome: "passed",
      attempt_index: 2
    }));
    await writeAttempt(runRoot, "002-broken", baseAttempt({
      compiled_id: "root__broken",
      authored_id: "broken",
      execution_id: "exec-active-fail",
      status: "failed",
      outcome: "failed"
    }), "active failure\n");

    const result = await inspectCommand.run({}, tempRoot, undefined, ["run"]);
    expect(result.exitCode).toBe(0);
    const output = result.output as Record<string, unknown>;
    expect(output.supervisor_status).toBe("healthy");
    expect(output.supervisor_recorded_status).toBe("intervening");
    expect(output.failed_node_count).toBe(1);
    expect(output.active_failed_node_count).toBe(1);
    expect(output.failed_attempt_count).toBe(2);
    expect(output.historical_failed_attempt_count).toBe(1);
    expect(output.failed_node_stderr_tails).toEqual([
      expect.objectContaining({
        execution_dir: join(runRoot, "nodes", "002-broken", "executions", "exec-active-fail"),
        execution_id: "exec-active-fail",
        stderr_tail: "active failure\n"
      })
    ]);
    expect(output.historical_failed_attempt_stderr_tails).toEqual([
      expect.objectContaining({
        execution_dir: join(runRoot, "nodes", "001-recovered", "executions", "exec-recovered-fail"),
        execution_id: "exec-recovered-fail",
        stderr_tail: "old recovered failure\n"
      })
    ]);
    expect(output.delivery_status).toBe("pending");
    expect(output.review_ready).toBe(false);
    expect(output.review_brief).toBeUndefined();
  });
});
