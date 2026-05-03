import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeAfCli, runAfCli } from "../../src/af/index.js";
import type { ArtifactDefinition } from "../../src/graph/authored.js";
import {
  appendOperatorObservation,
  createOperatorObservation
} from "../../src/runtime/observations/index.js";

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
    expect(topLevel.stdout).toContain("af complete check");
    expect(topLevel.stdout).not.toContain("af artifact list");
    expect(topLevel.stdout).not.toContain("af tools list");
    expect(topLevel.stdout).not.toContain("af diagnose");
    expect(topLevel.stdout).not.toContain("af learn");
    expect(topLevel.stdout).not.toContain("af spawn");
    expect(topLevel.stdout).not.toContain("af wait");

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

    const completeCheck = await executeAfCli(["complete", "check", "--help"]);
    expect(completeCheck.exitCode).toBe(0);
    expect(completeCheck.stdout).toContain("af complete check");
  });

  it("exposes status, completion, artifact, and structured log commands through runtime metadata", async () => {
    const runtime = await createRuntime(tempRoot);
    process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;

    const status = outputOf<{ agent: { agent_id: string }; run: { run_id: string }; supervisor_recovery: { active: boolean } }>(
      await executeAfCli(["status"])
    );
    expect(status.agent.agent_id).toBe("agent-main");
    expect(status.run.run_id).toBe("run-test");
    expect(status.supervisor_recovery.active).toBe(false);

    const incomplete = await executeAfCli(["complete", "check"]);
    expect(incomplete.exitCode).toBe(1);
    expect(incomplete.output).toEqual(expect.objectContaining({
      command: "af complete check",
      completion_status: "incomplete",
      missing_artifacts: ["handoff"]
    }));

    await expect(executeAfCli(["artifact", "write", "handoff", "--content", "ready\n"]))
      .resolves.toMatchObject({ exitCode: 0 });
    await expect(readFile(join(runtime.output, "handoff.md"), "utf8")).resolves.toBe("ready\n");

    const complete = await executeAfCli(["complete", "check"]);
    expect(complete.exitCode).toBe(0);
    expect(complete.output).toEqual(expect.objectContaining({
      completion_status: "ready_for_verification",
      ready_for_verification: true
    }));

    await appendOperatorObservation(runtime.root, createOperatorObservation({
      runId: "run-test",
      author: "human",
      kind: "blocker",
      severity: "error",
      summary: "Routed export worker is unavailable",
      node: "main",
      blocking: true,
      blockedOn: "operator_managed_backend_worker",
      recoverableBy: "operator",
      evidence: [{
        kind: "external_state",
        summary: "Worker process is stopped.",
        status: "blocked"
      }]
    }));

    const statusWithObservation = outputOf<{
      operator_observations: { active: number; blocking: number };
    }>(await executeAfCli(["status"]));
    expect(statusWithObservation.operator_observations).toEqual(expect.objectContaining({
      active: 1,
      blocking: 1
    }));

    const blockedComplete = await executeAfCli(["complete", "check"]);
    expect(blockedComplete.exitCode).toBe(1);
    expect(blockedComplete.output).toEqual(expect.objectContaining({
      completion_status: "blocked",
      operator_observations: expect.objectContaining({
        active: 1,
        blocking: 1
      }),
      blocking_reasons: expect.arrayContaining(["Routed export worker is unavailable"])
    }));

    await expect(executeAfCli([
      "log",
      "--type",
      "finding",
      "--finding-kind",
      "observation",
      "--summary",
      "Observed runtime CLI",
      "--evidence",
      JSON.stringify({ kind: "runtime_event", summary: "af status completed" })
    ])).resolves.toMatchObject({ exitCode: 0 });
    await expect(executeAfCli([
      "log",
      "--type",
      "decision",
      "--decision",
      "Use the generated client path",
      "--rationale",
      "It matches the node contract and existing source layout.",
      "--evidence",
      JSON.stringify({ kind: "context", ref: "src/client.ts", summary: "repo inspection found src/client.ts" }),
      "--evidence",
      JSON.stringify({ kind: "context", ref: runtime.contextManifest, summary: "context manifest cited the generated client" }),
      "--contract-implication",
      "Artifact handoff can cite the generated client path."
    ]))
      .resolves.toMatchObject({ exitCode: 0 });
    const runtimeLog = (await readFile(join(runtime.root, "runtime", "log.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; summary: string; decision?: string; rationale?: string; evidence?: unknown[]; finding_kind?: string; contract_implication?: string });
    expect(runtimeLog).toEqual([
      expect.objectContaining({ type: "finding", finding_kind: "observation", summary: "Observed runtime CLI" }),
      expect.objectContaining({
        type: "decision",
        summary: "Use the generated client path",
        decision: "Use the generated client path",
        rationale: "It matches the node contract and existing source layout.",
        contract_implication: "Artifact handoff can cite the generated client path.",
        evidence: [
          expect.objectContaining({ kind: "context", summary: "repo inspection found src/client.ts" }),
          expect.objectContaining({ kind: "context", summary: "context manifest cited the generated client" })
        ]
      })
    ]);

    await expect(executeAfCli([
      "log",
      "--type",
      "blocker",
      "--summary",
      "Old blocker type"
    ])).rejects.toThrow("af log --type must be one of: progress, finding, decision");

    await expect(executeAfCli([
      "spawn",
      "--purpose",
      "repair",
      "--brief",
      "Try an ungranted tool.",
      "--tools",
      "not-granted"
    ])).rejects.toThrow("not granted");

    await expect(executeAfCli([
      "spawn",
      "--brief",
      "Missing explicit purpose."
    ])).rejects.toThrow("af spawn requires --purpose.");
  });

  it("exposes supervisor learn and diagnose helpers", async () => {
    const runtime = await createRuntime(tempRoot);
    process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
    await writeFile(join(runtime.root, "compiled_graph.json"), `${JSON.stringify({
      graph_id: "af-cli-test",
      intent: {
        goal: "Test diagnostics.",
        acceptance_criteria: ["Diagnostics expose causal graph evidence."]
      },
      supervision: {
        max_total_interventions: 3
      },
      launch: {
        launch_profile: "default",
        workspace_backend: "inplace"
      },
      entry_node_ids: ["implement"],
      nodes: [
        {
          compiled_id: "implement",
          authored_id: "implement",
          kind: "agent",
          intent: {
            goal: "Implement the change.",
            acceptance_criteria: ["The implementation satisfies downstream validation."],
            constraints: []
          },
          repo: "main",
          deps: [],
          scope_stack: ["root"],
          effective_policy: {
            profile_name: "default",
            sandbox: "workspace-write",
            timeout_sec: 10,
            input_rules: {},
            artifact_repair: { max_attempts: 1 }
          },
          context: [],
          declared_artifacts: {},
          tools: []
        },
        {
          compiled_id: "validate",
          authored_id: "validate",
          kind: "check",
          check_kind: "deterministic",
          intent: {
            goal: "Validate implementation behavior.",
            acceptance_criteria: ["The focused validation command exits successfully."],
            constraints: []
          },
          repo: "main",
          deps: ["implement"],
          scope_stack: ["root"],
          effective_policy: {
            profile_name: "default",
            sandbox: "workspace-write",
            timeout_sec: 10,
            input_rules: {},
            artifact_repair: { max_attempts: 1 }
          },
          context: [],
          declared_artifacts: {},
          on_failure: "fail",
          command: "npm",
          args: ["test"]
        }
      ],
      edges: [{ edge_id: "implement__validate", from: "implement", to: "validate", on: "passed", kind: "flow" }],
      scopes: [],
      authored_to_compiled: {
        implement: ["implement"],
        validate: ["validate"]
      },
      prerequisites: { checks: [] }
    }, null, 2)}\n`, "utf8");
    await writeFile(join(runtime.root, "state.json"), `${JSON.stringify({
      run_id: "run-test",
      graph_id: "af-cli-test",
      status: "running",
      counts: {},
      node_statuses: {
        implement: "passed",
        validate: "failed"
      },
      supervisor: {}
    }, null, 2)}\n`, "utf8");

    const playbook = outputOf<{ kind: string; playbook: { safe_repairs: string[] } }>(
      await executeAfCli(["learn", "failed_check"])
    );
    expect(playbook.kind).toBe("failed_check");
    expect(playbook.playbook.safe_repairs.join(" ")).toContain("upstream");

    const cone = outputOf<{ direction: string; nodes: Array<{ compiled_id: string }> }>(
      await executeAfCli(["diagnose", "graph-cone", "--from", "validate", "--upstream", "--json"])
    );
    expect(cone.direction).toBe("upstream");
    expect(cone.nodes).toEqual([
      expect.objectContaining({ compiled_id: "implement" })
    ]);

    const validation = outputOf<{ validation: { command: string; args: string[] } }>(
      await executeAfCli(["diagnose", "validation", "--node", "validate", "--json"])
    );
    expect(validation.validation.command).toBe("npm");
    expect(validation.validation.args).toEqual(["test"]);
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
        "--purpose",
        "implementation",
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

  it("does not expose a standalone af wait command", async () => {
    const runtime = await createRuntime(tempRoot);
    process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;

    const result = await executeAfCli(["wait", "--agent", "helper_missing"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Unknown af command: wait");

    const artifactList = await executeAfCli(["artifact", "list"]);
    expect(artifactList.exitCode).toBe(2);
    expect(artifactList.stdout).toContain("Unknown af command: artifact list");

    const toolsList = await executeAfCli(["tools", "list"]);
    expect(toolsList.exitCode).toBe(2);
    expect(toolsList.stdout).toContain("Unknown af command: tools list");

    const supervisionShow = await executeAfCli(["supervision", "show"]);
    expect(supervisionShow.exitCode).toBe(2);
    expect(supervisionShow.stdout).toContain("Unknown af command: supervision show");
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
      "--purpose",
      "verification",
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
        command: "af spawn",
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
