import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeAfCli, runAfCli } from "../../src/af/index.js";
import type { ArtifactDefinition } from "../../src/graph/authored.js";

interface TestRuntimePaths {
  root: string;
  workspace: string;
  output: string;
  metadata: string;
  contextPacket: string;
  contextManifest: string;
  toolInvocations: string;
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
  const toolInvocations = join(root, "executions/main/tool-invocations.jsonl");
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
    tool_invocations_path: toolInvocations,
    credential_specs: {},
    declared_artifacts: artifacts,
    tools: [],
    harness: "codex-cli",
    model: "auto",
    sandbox: "workspace-write",
    timeout_sec: 10
  }, null, 2)}\n`, "utf8");
  return { root, workspace, output, metadata, contextPacket, contextManifest, toolInvocations };
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

  it("renders top-level and subcommand help without runtime metadata", async () => {
    delete process.env.AGENTFLOW_RUNTIME_METADATA;

    const topLevel = await executeAfCli(["--help"]);
    expect(topLevel.exitCode).toBe(0);
    expect(topLevel.stdout).toContain("Usage:");
    expect(topLevel.stdout).toContain("af <command> [subcommand] --help");
    expect(topLevel.stdout).toContain("Exit codes:");

    const artifactWrite = await executeAfCli(["artifact", "write", "--help"]);
    expect(artifactWrite.exitCode).toBe(0);
    expect(artifactWrite.stdout).toContain("af artifact write - publish a declared artifact");
    expect(artifactWrite.stdout).toContain("--file <path>");
    expect(artifactWrite.stdout).toContain("Default:");
    expect(artifactWrite.stdout).toContain("Examples:");

    const contextShow = await executeAfCli(["context", "show", "--help"]);
    expect(contextShow.exitCode).toBe(0);
    expect(contextShow.stdout).toContain("context_packet_path");
    expect(contextShow.stdout).toContain("Read-only inspection");
  });

  it("exposes status, artifact, log, and helper commands through runtime metadata", async () => {
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

    await expect(executeAfCli(["log", "--type", "finding", "--summary", "Observed runtime CLI"]))
      .resolves.toMatchObject({ exitCode: 0 });
    await expect(executeAfCli([
      "log",
      "--type",
      "decision",
      "--decision",
      "Use the generated client path",
      "--rationale",
      "It matches the node contract and existing source layout.",
      "--evidence",
      "repo inspection found src/client.ts",
      "--evidence",
      "context manifest cited the generated client"
    ]))
      .resolves.toMatchObject({ exitCode: 0 });
    const runtimeLog = (await readFile(join(runtime.root, "runtime", "log.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; summary: string; decision?: string; rationale?: string; evidence?: string[] });
    expect(runtimeLog).toEqual([
      expect.objectContaining({ type: "finding", summary: "Observed runtime CLI" }),
      expect.objectContaining({
        type: "decision",
        summary: "Use the generated client path",
        decision: "Use the generated client path",
        rationale: "It matches the node contract and existing source layout.",
        evidence: [
          "repo inspection found src/client.ts",
          "context manifest cited the generated client"
        ]
      })
    ]);

    await expect(executeAfCli([
      "spawn",
      "--brief",
      "Try an ungranted tool.",
      "--tools",
      "not-granted"
    ])).rejects.toThrow("not granted");
  });

  it("records af stdout sidecar logs in the invocation ledger", async () => {
    const runtime = await createRuntime(tempRoot);
    process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(runAfCli(["status"])).resolves.toBe(0);
    } finally {
      stdoutSpy.mockRestore();
    }

    const records = (await readFile(runtime.toolInvocations, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { kind: string; argv: string[]; stdout_path?: string });
    expect(records).toEqual([
      expect.objectContaining({
        kind: "af",
        argv: ["status"],
        stdout_path: expect.stringContaining("tool-invocation-logs")
      })
    ]);
    await expect(readFile(records[0]!.stdout_path!, "utf8")).resolves.toContain('"command": "af status"');
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
  });

  it("reports a missing helper session as a wait failure", async () => {
    const runtime = await createRuntime(tempRoot);
    process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;

    const result = await executeAfCli([
      "wait",
      "--agent",
      "helper_missing",
      "--timeout-sec",
      "0"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toEqual(
      expect.objectContaining({
        command: "af wait",
        status: "failed",
        message: "Timed out waiting for helper_missing."
      })
    );
  });

  it("fails af spawn --wait when the helper exits without its required artifact", async () => {
    const runtime = await createRuntime(tempRoot);
    const codexBin = join(tempRoot, "mock-codex-no-artifact.mjs");
    await writeExecutable(codexBin, [
      "#!/usr/bin/env node",
      "process.stdout.write('helper finished without artifact\\n');",
      ""
    ].join("\n"));
    process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
    process.env.AGENTFLOW_CODEX_CLI_BIN = codexBin;

    const result = await executeAfCli([
      "spawn",
      "--brief",
      "Exit without writing the required helper artifact.",
      "--artifact",
      "helper-report.md",
      "--wait",
      "--timeout-sec",
      "10"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toEqual(
      expect.objectContaining({
        command: "af wait",
        status: "failed",
        agent: expect.objectContaining({
          status: "failed",
          exit_code: 0,
          artifacts: {}
        })
      })
    );
  });
});
