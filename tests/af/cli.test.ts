import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeAfCli } from "../../src/af/index.js";
import type { ArtifactDefinition } from "../../src/graph/authored.js";

interface TestRuntimePaths {
  root: string;
  workspace: string;
  output: string;
  metadata: string;
  contextPacket: string;
  contextManifest: string;
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
}

function outputOf<T>(result: Awaited<ReturnType<typeof executeAfCli>>): T {
  expect(result.exitCode).toBe(0);
  expect(result.output).toBeDefined();
  return result.output as T;
}

async function createRuntime(tempRoot: string, artifacts: Record<string, ArtifactDefinition> = {
  handoff: {
    from: "output_dir",
    path: "handoff.md",
    description: "Durable handoff."
  }
}): Promise<TestRuntimePaths> {
  const root = join(tempRoot, "run");
  const runtimeDir = join(root, "runtime");
  const workspace = join(tempRoot, "workspace");
  const output = join(root, "executions/main/output");
  const contextPacket = join(root, "executions/main/context.json");
  const contextManifest = join(root, "executions/main/manifest.md");
  const toolsDir = join(root, "executions/main/agentflow-tools");
  const metadata = join(toolsDir, "runtime.json");
  await mkdir(workspace, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(output, { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await writeFile(contextPacket, JSON.stringify({ version: "1", materials: [] }), "utf8");
  await writeFile(contextManifest, "# Context\n\nNo context.\n", "utf8");
  await writeFile(metadata, `${JSON.stringify({
    version: "1",
    run_root: root,
    run_id: "run-test",
    graph_id: "af-cli-test",
    agent_id: "agent-main",
    execution_id: "agent-main",
    node_id: "main",
    compiled_id: "main",
    repo_alias: "main",
    workspace_path: workspace,
    output_dir: output,
    runtime_dir: runtimeDir,
    context_packet_path: contextPacket,
    context_manifest_path: contextManifest,
    tool_state_path: join(toolsDir, "state.json"),
    tool_bin_dir: join(toolsDir, "bin"),
    credential_specs: {},
    declared_artifacts: artifacts,
    tools: [],
    harness: "codex-cli",
    model: "auto",
    sandbox: "workspace-write",
    timeout_sec: 10
  }, null, 2)}\n`, "utf8");
  return { root, workspace, output, metadata, contextPacket, contextManifest };
}

describe("af runtime CLI", () => {
  let tempRoot: string;
  let originalMetadata: string | undefined;
  let originalCodexBin: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentflow-af-cli-"));
    originalMetadata = process.env.AGENTFLOW_RUNTIME_METADATA;
    originalCodexBin = process.env.AGENTFLOW_CODEX_CLI_BIN;
  });

  afterEach(async () => {
    if (originalMetadata === undefined) {
      delete process.env.AGENTFLOW_RUNTIME_METADATA;
    } else {
      process.env.AGENTFLOW_RUNTIME_METADATA = originalMetadata;
    }
    if (originalCodexBin === undefined) {
      delete process.env.AGENTFLOW_CODEX_CLI_BIN;
    } else {
      process.env.AGENTFLOW_CODEX_CLI_BIN = originalCodexBin;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("exposes status, artifact, channel, inbox, and supervisor commands through runtime metadata", async () => {
    const runtime = await createRuntime(tempRoot);
    process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;

    const status = outputOf<{ agent: { agent_id: string }; run: { run_id: string } }>(
      await executeAfCli(["status"])
    );
    expect(status.agent.agent_id).toBe("agent-main");
    expect(status.run.run_id).toBe("run-test");

    await expect(executeAfCli(["artifact", "write", "handoff", "--content", "ready\n"]))
      .resolves.toMatchObject({ exitCode: 0 });
    await expect(readFile(join(runtime.output, "handoff.md"), "utf8")).resolves.toBe("ready\n");

    await expect(executeAfCli(["channel", "post", "--type", "finding", "--summary", "Observed runtime CLI"]))
      .resolves.toMatchObject({ exitCode: 0 });
    const channel = outputOf<{ messages: Array<{ type: string; summary: string }> }>(
      await executeAfCli(["channel", "read", "--latest", "1"])
    );
    expect(channel.messages).toEqual([
      expect.objectContaining({ type: "finding", summary: "Observed runtime CLI" })
    ]);

    const sent = outputOf<{ delivered: boolean; stored: boolean }>(
      await executeAfCli(["send", "--to", "agent-main", "--type", "question", "--summary", "self check"])
    );
    expect(sent).toMatchObject({ delivered: true, stored: true });
    const inbox = outputOf<{ messages: Array<{ summary: string }> }>(
      await executeAfCli(["inbox", "read", "--latest", "1"])
    );
    expect(inbox.messages[0]?.summary).toBe("self check");

    const supervisor = outputOf<{ request: { action: string; reason: string } }>(
      await executeAfCli([
        "supervisor",
        "request",
        "--action",
        "run_diagnostic",
        "--reason",
        "validate af supervisor request persistence"
      ])
    );
    expect(supervisor.request).toMatchObject({
      action: "run_diagnostic",
      reason: "validate af supervisor request persistence"
    });

    await expect(executeAfCli([
      "spawn",
      "--brief",
      "Try an ungranted tool.",
      "--tools",
      "not-granted"
    ])).rejects.toThrow("not granted");
  });

  it("spawns a helper with its own metadata and waits for the helper artifact", async () => {
    const runtime = await createRuntime(tempRoot);
    const codexBin = join(tempRoot, "mock-codex.mjs");
    await writeExecutable(codexBin, [
      "#!/usr/bin/env node",
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      "if (!process.env.AGENTFLOW_RUNTIME_METADATA) process.exit(42);",
      "const artifact = join(process.env.AGENTFLOW_OUTPUT_DIR, 'helper-report.md');",
      "mkdirSync(dirname(artifact), { recursive: true });",
      "writeFileSync(artifact, `helper ok\\nmetadata=${process.env.AGENTFLOW_RUNTIME_METADATA}\\n`);",
      ""
    ].join("\n"));
    process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
    process.env.AGENTFLOW_CODEX_CLI_BIN = codexBin;

    const spawned = outputOf<{ status: string; agent: { status: string }; artifact: string }>(
      await executeAfCli([
        "spawn",
        "--brief",
        "Write the helper validation report.",
        "--artifact",
        "helper-report.md",
        "--wait",
        "--timeout-sec",
        "10"
      ])
    );
    expect(spawned.status).toBe("passed");
    expect(spawned.agent.status).toBe("completed");
    await expect(readFile(spawned.artifact, "utf8")).resolves.toContain("helper ok");

    const agents = outputOf<{ agents: Array<{ parent_agent_id?: string; status: string }> }>(
      await executeAfCli(["agents", "list"])
    );
    expect(agents.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        parent_agent_id: "agent-main",
        status: "completed"
      })
    ]));
  });
});
