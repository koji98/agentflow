import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveRunArtifactPaths } from "../../src/artifacts/paths.js";
import { buildEvalTracePacket } from "../../src/evals/trace.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("eval trace packets", () => {
  let tempRoot: string;
  let runRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentflow-eval-trace-"));
    runRoot = join(tempRoot, "run");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("projects completion packets and af runtime CLI calls into trajectory events", async () => {
    const paths = resolveRunArtifactPaths(runRoot);
    const executionDir = join(paths.nodes_dir, "node-ship", "executions", "001-ship");
    const completionPacketPath = join(executionDir, "completion-packet.json");

    await writeJson(paths.run_file, {
      run_id: "run-test",
      graph_id: "trace-test",
      launch_profile: "default",
      workspace_backend: "inplace",
      status: "passed",
      started_at: "2026-05-03T12:00:00.000Z"
    });
    await writeJson(paths.compiled_graph_file, {
      graph_id: "trace-test",
      intent: { goal: "Trace runtime CLI.", acceptance_criteria: [], constraints: [] },
      nodes: [{
        compiled_id: "ship",
        authored_id: "ship",
        kind: "agent",
        repo: "main",
        deps: [],
        scope_stack: ["root"],
        declared_artifacts: {},
        effective_policy: {
          profile_name: "default",
          workspace_backend: "inplace",
          sandbox: "workspace-write",
          timeout_sec: 60,
          input_rules: { max_total_tokens: 128000, max_tokens_per_item: 32000 },
          artifact_repair: { max_attempts: 0 }
        },
        intent: { goal: "Ship.", acceptance_criteria: [], constraints: [] },
        context: [],
        tools: []
      }]
    });
    await writeJson(paths.execution_manifest_file, {
      run_id: "run-test",
      graph_id: "trace-test",
      launch_profile: "default",
      workspace_backend: "inplace",
      repo_workspaces: {},
      nodes: []
    });
    await writeJson(paths.state_file, {
      run_id: "run-test",
      graph_id: "trace-test",
      status: "passed",
      counts: { total: 1, passed: 1 }
    });
    await mkdir(dirname(paths.events_file), { recursive: true });
    await writeFile(paths.events_file, "", "utf8");
    await writeFile(paths.interventions_file, "", "utf8");
    await writeJson(join(executionDir, "execution.json"), {
      execution_id: "exec__ship__attempt_1",
      compiled_id: "ship",
      authored_id: "ship",
      kind: "agent",
      repo_alias: "main",
      execution_dir: executionDir,
      attempt_index: 1,
      status: "passed",
      outcome: "passed",
      started_at: "2026-05-03T12:00:01.000Z",
      artifacts: {},
      metadata: {
        completion: {
          completion_status: "ready_for_verification",
          ready_for_verification: true,
          packet_path: completionPacketPath
        }
      }
    });
    await writeJson(completionPacketPath, {
      completion_status: "ready_for_verification",
      ready_for_verification: true,
      blocking_reasons: []
    });
    await writeFile(
      join(executionDir, "tool-invocations.jsonl"),
      `${JSON.stringify({
        kind: "af",
        argv: ["complete", "check"],
        exit_code: 0,
        duration_ms: 12
      })}\n${JSON.stringify({
        kind: "af",
        argv: ["status"],
        exit_code: 0,
        duration_ms: 6
      })}\n`,
      "utf8"
    );

    const packet = await buildEvalTracePacket({ run_root: runRoot });

    expect(packet.trajectory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "completion_packet",
        node_id: "ship",
        completion_status: "ready_for_verification",
        packet_path: completionPacketPath
      }),
      expect.objectContaining({
        kind: "af_tool_call",
        node_id: "ship",
        af_command: "complete check",
        command: "af complete check"
      })
    ]));
    expect(JSON.stringify(packet.trajectory)).toContain("af status");
    await expect(readFile(completionPacketPath, "utf8")).resolves.toContain("ready_for_verification");
  });
});
