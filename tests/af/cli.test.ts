import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAfCli, runAfCli } from "../../src/af/index.js";
import type { ArtifactDefinition } from "../../src/graph/authored.js";
import { startSpawnBroker } from "../../src/runtime/harness/spawn_broker.js";
import { writeManagedContractFailurePacket } from "../../src/runtime/managed/contract_failures.js";
import { appendOperatorObservation, createOperatorObservation } from "../../src/runtime/observations/index.js";
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
async function withStdin<T>(content: string, callback: () => Promise<T>): Promise<T> {
    const original = process.stdin;
    Object.defineProperty(process, "stdin", {
        value: Readable.from([content]),
        configurable: true
    });
    try {
        return await callback();
    }
    finally {
        Object.defineProperty(process, "stdin", {
            value: original,
            configurable: true
        });
    }
}
async function withStdinBuffer<T>(content: Buffer, callback: () => Promise<T>): Promise<T> {
    const original = process.stdin;
    Object.defineProperty(process, "stdin", {
        value: Readable.from([content]),
        configurable: true
    });
    try {
        return await callback();
    }
    finally {
        Object.defineProperty(process, "stdin", {
            value: original,
            configurable: true
        });
    }
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
}, metadataOverrides: Record<string, unknown> = {}): Promise<TestRuntimePaths> {
    const root = join(tempRoot, "run");
    const runtimeDir = join(root, "runtime");
    const workspace = join(tempRoot, "workspace");
    const executionDir = join(root, "executions/main");
    const output = join(executionDir, "artifacts");
    const contextPacket = join(executionDir, "runtime/context.json");
    const contextManifest = join(executionDir, "agent/context.md");
    const toolInvocations = join(executionDir, "human-debug/tools/index.jsonl");
    const toolsDir = join(executionDir, "runtime/tools");
    const metadata = join(toolsDir, "runtime.json");
    await mkdir(workspace, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(output, { recursive: true });
    await mkdir(toolsDir, { recursive: true });
    await mkdir(dirname(toolInvocations), { recursive: true });
    await mkdir(dirname(contextPacket), { recursive: true });
    await mkdir(dirname(contextManifest), { recursive: true });
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
        timeout_sec: 10,
        af_command_policy: "worker",
        ...metadataOverrides
    }, null, 2)}\n`, "utf8");
    return { root, workspace, output, metadata, contextPacket, contextManifest, toolInvocations };
}
describe("af runtime CLI", () => {
    let tempRoot: string;
    let originalMetadata: string | undefined;
    let originalCodexBin: string | undefined;
    let originalSpawnMode: string | undefined;
    let originalAfBrokerDir: string | undefined;
    let originalAfBrokerChild: string | undefined;
    let originalAfRunner: string | undefined;
    let originalAfCli: string | undefined;
    let originalInternalHelperRun: string | undefined;
    beforeEach(async () => {
        tempRoot = await mkdtemp(join(tmpdir(), "agentflow-af-cli-"));
        originalMetadata = process.env.AGENTFLOW_RUNTIME_METADATA;
        originalCodexBin = process.env.AGENTFLOW_CODEX_CLI_BIN;
        originalSpawnMode = process.env.AGENTFLOW_SPAWN_MODE;
        originalAfBrokerDir = process.env.AGENTFLOW_AF_BROKER_DIR;
        originalAfBrokerChild = process.env.AGENTFLOW_AF_BROKER_CHILD;
        originalAfRunner = process.env.AGENTFLOW_AF_RUNNER;
        originalAfCli = process.env.AGENTFLOW_AF_CLI;
        originalInternalHelperRun = process.env.AGENTFLOW_INTERNAL_HELPER_RUN;
    });
    afterEach(async () => {
        if (originalMetadata === undefined) {
            delete process.env.AGENTFLOW_RUNTIME_METADATA;
        }
        else {
            process.env.AGENTFLOW_RUNTIME_METADATA = originalMetadata;
        }
        if (originalCodexBin === undefined) {
            delete process.env.AGENTFLOW_CODEX_CLI_BIN;
        }
        else {
            process.env.AGENTFLOW_CODEX_CLI_BIN = originalCodexBin;
        }
        if (originalSpawnMode === undefined) {
            delete process.env.AGENTFLOW_SPAWN_MODE;
        }
        else {
            process.env.AGENTFLOW_SPAWN_MODE = originalSpawnMode;
        }
        if (originalAfBrokerDir === undefined) {
            delete process.env.AGENTFLOW_AF_BROKER_DIR;
        }
        else {
            process.env.AGENTFLOW_AF_BROKER_DIR = originalAfBrokerDir;
        }
        if (originalAfBrokerChild === undefined) {
            delete process.env.AGENTFLOW_AF_BROKER_CHILD;
        }
        else {
            process.env.AGENTFLOW_AF_BROKER_CHILD = originalAfBrokerChild;
        }
        if (originalAfRunner === undefined) {
            delete process.env.AGENTFLOW_AF_RUNNER;
        }
        else {
            process.env.AGENTFLOW_AF_RUNNER = originalAfRunner;
        }
        if (originalAfCli === undefined) {
            delete process.env.AGENTFLOW_AF_CLI;
        }
        else {
            process.env.AGENTFLOW_AF_CLI = originalAfCli;
        }
        if (originalInternalHelperRun === undefined) {
            delete process.env.AGENTFLOW_INTERNAL_HELPER_RUN;
        }
        else {
            process.env.AGENTFLOW_INTERNAL_HELPER_RUN = originalInternalHelperRun;
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
        expect(topLevel.stdout).toContain("af orient");
        expect(topLevel.stdout).toContain("af milestone add");
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
        expect(artifactWrite.stdout).toContain("af artifact write <name>");
        expect(artifactWrite.stdout).toContain("--file <path>");
        expect(artifactWrite.stdout).toContain("Examples:");
        const milestone = await executeAfCli(["milestone", "--help"]);
        expect(milestone.exitCode).toBe(0);
        expect(milestone.stdout).toContain("af milestone add --title");
        expect(milestone.stdout).toContain("chain-of-thought");
        const completeCheck = await executeAfCli(["complete", "check", "--help"]);
        expect(completeCheck.exitCode).toBe(0);
        expect(completeCheck.stdout).toContain("af complete check");
    });
    it("exposes orient, milestone, completion, and stdin artifact commands through runtime metadata", async () => {
        const runtime = await createRuntime(tempRoot);
        process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
        const orient = await executeAfCli(["orient"]);
        expect(orient.exitCode).toBe(0);
        expect(orient.stdout).toContain("# Agentflow Orientation");
        expect(orient.stdout).toContain("## Success Contract");
        expect(orient.stdout).toContain("| `handoff` | `af artifact write handoff` | auto-detect | Durable handoff. |");
        expect(orient.stdout).not.toContain(runtime.output);
        expect(orient.stdout).not.toContain("Destination");
        expect(orient.stdout).toContain("## Milestones");
        const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
            await expect(runAfCli(["orient"])).resolves.toBe(0);
        }
        finally {
            stdoutSpy.mockRestore();
        }
        const incomplete = await executeAfCli(["complete", "check"]);
        expect(incomplete.exitCode).toBe(1);
        expect(incomplete.output).toEqual(expect.objectContaining({
            command: "af complete check",
            completion_status: "incomplete",
            missing_artifacts: ["handoff"]
        }));
        expect(JSON.stringify(incomplete.output)).not.toContain("expected_path");
        expect(JSON.stringify(incomplete.output)).not.toContain("packet_path");
        expect(JSON.stringify(incomplete.output)).not.toContain("size_bytes");
        const added = outputOf<{ milestone: { id: string } }>(await executeAfCli([
            "milestone",
            "add",
            "--title",
            "Prepare handoff",
            "--goal",
            "Publish the declared handoff artifact."
        ]));
        expect(added.milestone.id).toBe("m1");
        await expect(executeAfCli([
            "milestone",
            "log",
            "m1",
            "--kind",
            "validation",
            "--command",
            "npm test",
            "--result",
            "pass",
            "--summary",
            "Validation passed."
        ])).resolves.toMatchObject({ exitCode: 0 });
        await expect(executeAfCli([
            "milestone",
            "complete",
            "m1",
            "--evidence",
            "The handoff content is ready and validation evidence is logged."
        ])).resolves.toMatchObject({ exitCode: 0 });
        await expect(executeAfCli([
            "milestone",
            "log",
            "m1",
            "--kind",
            "validation",
            "--command",
            "fixture-lookup --case overlap",
            "--result",
            "pass",
            "--summary",
            "Late exact command evidence was attached before readiness."
        ])).resolves.toMatchObject({ exitCode: 0 });
        await expect(withStdin("ready\n", () => executeAfCli(["artifact", "write", "handoff"])))
            .resolves.toMatchObject({ exitCode: 0 });
        await expect(readFile(join(runtime.output, "handoff.md"), "utf8")).resolves.toBe("ready\n");
        const complete = await executeAfCli(["complete", "check"]);
        expect(complete.exitCode).toBe(0);
        expect(complete.output).toEqual(expect.objectContaining({
            completion_status: "ready_for_verification",
            ready_for_verification: true
        }));
        await expect(withStdin("late rewrite\n", () => executeAfCli(["artifact", "write", "handoff"])))
            .rejects.toThrow("cannot run after af complete check reported ready_for_verification");
        await expect(executeAfCli([
            "milestone",
            "add",
            "--title",
            "Late milestone",
            "--goal",
            "This should not mutate state after completion is ready."
        ])).rejects.toThrow("cannot run after af complete check reported ready_for_verification");
        await appendOperatorObservation(runtime.root, createOperatorObservation({
            runId: "run-test",
            author: "human",
            kind: "blocker",
            severity: "error",
            message: "Routed export worker is unavailable",
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
        const blockedComplete = await executeAfCli(["complete", "check"]);
        expect(blockedComplete.exitCode).toBe(1);
        expect(blockedComplete.output).toEqual(expect.objectContaining({
            completion_status: "incomplete",
            operator_observations: expect.objectContaining({
                active: 1,
                blocking: 1
            }),
            blocking_reasons: expect.arrayContaining(["Routed export worker is unavailable"])
        }));
        const milestoneState = JSON.parse(await readFile(join(runtime.root, "runtime", "milestones", "agent-main.json"), "utf8")) as {
            milestones: Array<{ id: string; status: string; logs: Array<{ kind: string; command?: string }> }>;
        };
        expect(milestoneState.milestones).toEqual([
            expect.objectContaining({
                id: "m1",
                status: "completed",
                logs: expect.arrayContaining([
                    expect.objectContaining({
                        kind: "validation",
                        command: "npm test"
                    }),
                    expect.objectContaining({
                        kind: "validation",
                        command: "fixture-lookup --case overlap"
                    })
                ])
            })
        ]);
        await expect(executeAfCli([
            "log",
            "--type",
            "blocker",
            "--summary",
            "Old blocker type"
        ])).resolves.toMatchObject({ exitCode: 2 });
        await expect(executeAfCli(["artifact", "write", "handoff", "--content", "old mode"]))
            .rejects.toThrow("reads content from stdin");
        await expect(executeAfCli([
            "spawn",
            "--purpose",
            "repair",
            "--brief",
            "Normal workers cannot spawn helpers."
        ])).resolves.toMatchObject({
            exitCode: 2,
            stdout: expect.stringContaining("not allowed by the worker command policy")
        });
        await expect(executeAfCli(["diagnose", "failure", "--json"]))
            .resolves.toMatchObject({
                exitCode: 2,
                stdout: expect.stringContaining("not allowed by the worker command policy")
            });
        await expect(executeAfCli(["learn", "failed_check"]))
            .resolves.toMatchObject({
                exitCode: 2,
                stdout: expect.stringContaining("not allowed by the worker command policy")
            });
        await expect(executeAfCli([
            "_helper-run",
            "--metadata",
            runtime.metadata,
            "--helper",
            "helper_test"
        ])).resolves.toMatchObject({
            exitCode: 2,
            stdout: expect.stringContaining("_helper-run is internal Agentflow runtime transport")
        });
    });
    it("shows active managed contract failures in orient without raw debug noise", async () => {
        const runtime = await createRuntime(tempRoot);
        const executionDir = dirname(runtime.output);
        await writeManagedContractFailurePacket({
            executionDir,
            findings: {
                managed_kind: "pattern_work_list",
                phase: "item_publish",
                item_id: "w2",
                artifact_name: "item_result",
                artifact_path: join(runtime.output, "item-result.json"),
                failure_kind: "schema_mismatch",
                message: "item-result.json is missing a non-empty summary for item w2.",
                expected: "Completed managed item results include a concrete non-empty summary.",
                retry_boundary: "current_item",
                required_next_action: "Add a concrete summary to item-result.json for item w2.",
                evidence_refs: [join(runtime.output, "item-result.json")]
            }
        });

        process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
        const orient = await executeAfCli(["orient"]);
        expect(orient.exitCode).toBe(0);
        expect(orient.stdout).toContain("## Managed Contract Failure");
        expect(orient.stdout).toContain("item_publish");
        expect(orient.stdout).toContain("item_result");
        expect(orient.stdout).toContain("item-result.json is missing a non-empty summary");
        expect(orient.stdout).toContain("managed-contract-failure.md");
        expect(orient.stdout).not.toContain("human-debug");
    });
    it("publishes declared binary artifacts from stdin and from a file without changing bytes", async () => {
        const pngBytes = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x12, 0x16, 0xf1,
            0x4d
        ]);
        const runtime = await createRuntime(tempRoot, {
            screenshot: {
                from: "output_dir",
                path: "screens/settings.png",
                description: "Rendered settings screenshot.",
                content_type: "image/png"
            },
            pdf: {
                from: "output_dir",
                path: "exports/report.pdf",
                description: "Exported report PDF.",
                content_type: "application/pdf"
            }
        });
        process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;

        await expect(withStdinBuffer(pngBytes, () => executeAfCli(["artifact", "write", "screenshot"])))
            .resolves.toMatchObject({ exitCode: 0 });
        await expect(readFile(join(runtime.output, "screens/settings.png"))).resolves.toEqual(pngBytes);

        const sourcePdf = join(runtime.workspace, "source.pdf");
        const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "binary");
        await writeFile(sourcePdf, pdfBytes);
        await expect(executeAfCli(["artifact", "write", "pdf", "--file", sourcePdf]))
            .resolves.toMatchObject({ exitCode: 0 });
        await expect(readFile(join(runtime.output, "exports/report.pdf"))).resolves.toEqual(pdfBytes);
    });
    it("routes af mutations through the parent broker so sandboxed agents do not write run state directly", async () => {
        const runtime = await createRuntime(tempRoot);
        const brokerDir = await mkdtemp(join(tmpdir(), "agentflow-af-cli-broker-"));
        const afRunner = join(process.cwd(), "node_modules/.bin/tsx");
        const afCli = join(process.cwd(), "src/af/index.ts");
        const toolEnv = {
            AGENTFLOW_RUNTIME_METADATA: runtime.metadata,
            AGENTFLOW_AF_BROKER_DIR: brokerDir,
            AGENTFLOW_AF_RUNNER: afRunner,
            AGENTFLOW_AF_CLI: afCli
        };
        const broker = startSpawnBroker({
            executionId: "agent-main",
            repoPath: runtime.workspace,
            outputDir: runtime.output,
            runtimeDir: join(runtime.root, "runtime"),
            prompt: "test",
            sandbox: "workspace-write",
            timeoutSec: 10,
            toolEnv,
            signal: undefined
        } as any);
        process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
        process.env.AGENTFLOW_AF_BROKER_DIR = brokerDir;
        process.env.AGENTFLOW_AF_RUNNER = afRunner;
        process.env.AGENTFLOW_AF_CLI = afCli;
        const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            await expect(runAfCli([
                "milestone",
                "add",
                "--title",
                "Brokered milestone",
                "--goal",
                "Prove the broker owns run-state writes."
            ])).resolves.toBe(0);
            await expect(withStdin("brokered artifact\n", () => runAfCli(["artifact", "write", "handoff"])))
                .resolves.toBe(0);
        }
        finally {
            stdoutSpy.mockRestore();
            stderrSpy.mockRestore();
            broker.stop();
        }
        await expect(readFile(join(runtime.output, "handoff.md"), "utf8")).resolves.toBe("brokered artifact\n");
        await expect(readFile(join(runtime.root, "runtime", "milestones", "agent-main.json"), "utf8"))
            .resolves.toContain("Brokered milestone");
        await rm(brokerDir, { recursive: true, force: true });
    });
    it("preserves binary artifact bytes through brokered artifact writes", async () => {
        const pngBytes = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x12, 0x16, 0xf1,
            0x4d
        ]);
        const runtime = await createRuntime(tempRoot, {
            screenshot: {
                from: "output_dir",
                path: "screens/settings.png",
                description: "Rendered settings screenshot.",
                content_type: "image/png"
            }
        });
        const brokerDir = await mkdtemp(join(tmpdir(), "agentflow-af-cli-broker-binary-"));
        const afRunner = join(process.cwd(), "node_modules/.bin/tsx");
        const afCli = join(process.cwd(), "src/af/index.ts");
        const toolEnv = {
            AGENTFLOW_RUNTIME_METADATA: runtime.metadata,
            AGENTFLOW_AF_BROKER_DIR: brokerDir,
            AGENTFLOW_AF_RUNNER: afRunner,
            AGENTFLOW_AF_CLI: afCli
        };
        const broker = startSpawnBroker({
            executionId: "agent-main",
            repoPath: runtime.workspace,
            outputDir: runtime.output,
            runtimeDir: join(runtime.root, "runtime"),
            prompt: "test",
            sandbox: "workspace-write",
            timeoutSec: 10,
            toolEnv,
            signal: undefined
        } as any);
        process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
        process.env.AGENTFLOW_AF_BROKER_DIR = brokerDir;
        process.env.AGENTFLOW_AF_RUNNER = afRunner;
        process.env.AGENTFLOW_AF_CLI = afCli;
        const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            await expect(withStdinBuffer(pngBytes, () => runAfCli(["artifact", "write", "screenshot"])))
                .resolves.toBe(0);
        }
        finally {
            stdoutSpy.mockRestore();
            stderrSpy.mockRestore();
            broker.stop();
            await rm(brokerDir, { recursive: true, force: true });
        }
        await expect(readFile(join(runtime.output, "screens/settings.png"))).resolves.toEqual(pngBytes);
    });
    it("rejects forged broker requests that exceed the runtime af command policy", async () => {
        const runtime = await createRuntime(tempRoot);
        const brokerDir = await mkdtemp(join(tmpdir(), "agentflow-af-cli-broker-forged-"));
        const afRunner = join(process.cwd(), "node_modules/.bin/tsx");
        const afCli = join(process.cwd(), "src/af/index.ts");
        const toolEnv = {
            AGENTFLOW_RUNTIME_METADATA: runtime.metadata,
            AGENTFLOW_AF_BROKER_DIR: brokerDir,
            AGENTFLOW_AF_RUNNER: afRunner,
            AGENTFLOW_AF_CLI: afCli
        };
        const broker = startSpawnBroker({
            executionId: "agent-main",
            repoPath: runtime.workspace,
            outputDir: runtime.output,
            runtimeDir: join(runtime.root, "runtime"),
            prompt: "test",
            sandbox: "workspace-write",
            timeoutSec: 10,
            toolEnv,
            signal: undefined
        } as any);
        const requestId = "forged-diagnose";
        await mkdir(join(brokerDir, "requests"), { recursive: true });
        await writeFile(join(brokerDir, "requests", `${requestId}.json`), `${JSON.stringify({
            id: requestId,
            argv: ["diagnose", "failure", "--json"],
            cwd: "/"
        }, null, 2)}\n`, "utf8");
        try {
            const responsePath = join(brokerDir, "responses", `${requestId}.json`);
            let response: { exit_code: number; stdout: string } | undefined;
            for (let index = 0; index < 50; index += 1) {
                response = await readFile(responsePath, "utf8")
                    .then((value) => JSON.parse(value) as { exit_code: number; stdout: string })
                    .catch(() => undefined);
                if (response) {
                    break;
                }
                await new Promise((resolveWait) => setTimeout(resolveWait, 50));
            }
            expect(response).toEqual(expect.objectContaining({ exit_code: 2 }));
            expect(response?.stdout).toContain("not allowed by the worker command policy");
        }
        finally {
            broker.stop();
            await rm(brokerDir, { recursive: true, force: true });
        }
    });
    it("renders retry orientation from structured attempt memory without debug leakage", async () => {
        const executionDir = join(tempRoot, "run", "executions/main");
        const attemptMemoryPath = join(executionDir, "runtime/attempt-memory.json");
        const attemptMemoryMarkdownPath = join(executionDir, "agent/attempt-memory.md");
        const runtime = await createRuntime(tempRoot, undefined, {
            supervisor_recovery_envelope: {
                envelope_id: "recovery-1",
                compiled_id: "main",
                authored_id: "main",
                prior_execution_id: "exec-previous",
                prior_attempt_evidence: {
                    identity: {
                        execution_id: "exec-previous",
                        compiled_id: "main",
                        authored_id: "main"
                    },
                    agent_paths: {
                        attempt_root: join(executionDir, "previous"),
                        response_path: join(executionDir, "previous", "agent", "response.md"),
                        artifacts_dir: join(executionDir, "previous", "artifacts"),
                        artifact_paths: {
                            handoff: join(executionDir, "previous", "artifacts", "handoff.md")
                        },
                        attempt_memory_path: join(executionDir, "previous", "agent", "attempt-memory.md"),
                        supervisor_recovery_path: join(executionDir, "previous", "agent", "supervisor-recovery.md")
                    },
                    audit_paths: {
                        result_path: join(executionDir, "previous", "runtime", "result.json")
                    }
                },
                recovery_plan_path: join(executionDir, "runtime/supervisor/recovery-plan.json"),
                case_file_path: join(executionDir, "runtime/supervisor/case-file.json"),
                action: "retry_node",
                classification: "artifact_contract_failure",
                failure_fingerprint: "fingerprint",
                repeated_fingerprint_count: 1,
                resume_point: "repair_artifacts",
                workspace_decision: "preserve",
                resume_decision: {
                    resume_point: "repair_artifacts",
                    restart_boundary: "artifact_repair",
                    workspace_decision: "preserve",
                    reuse: ["Preserve source edits and validation from the prior attempt."],
                    discard: ["Discard the missing handoff artifact state."],
                    reason_code: "artifact_contract_repair",
                    confidence: "high",
                    evidence: ["The prior implementation passed validation before artifact publication failed."],
                    required_next_action: "Repair the missing handoff artifact, then rerun completion.",
                    validation_gate: ["af complete check must pass."]
                },
                preserve_progress: ["Prior implementation edits are in scope and should be preserved."],
                do_not_redo: ["Do not rerun the entire implementation from scratch."],
                required_next_action: "Repair the missing handoff artifact, then rerun completion.",
                retry_directive: {
                    summary: "The prior attempt completed the implementation but missed the handoff artifact.",
                    must_do: ["Write the missing handoff artifact."],
                    must_not_do: ["Do not rewrite validated source files."],
                    evidence_to_read: ["agent/attempt-memory.md"],
                    validation_focus: ["af complete check must pass."],
                    unchanged_contract: {
                        goal: true,
                        acceptance_criteria: true,
                        constraints: true,
                        repo_authority: true,
                        sandbox: true,
                        declared_artifacts: true
                    }
                },
                created_at: "2026-05-18T00:00:00.000Z"
            },
            attempt_memory_path: attemptMemoryPath,
            attempt_memory_markdown_path: attemptMemoryMarkdownPath
        });
        await writeFile(attemptMemoryPath, `${JSON.stringify({
            version: "1",
            prior_execution_id: "exec-previous",
            prior_attempt_evidence: {
                identity: {
                    execution_id: "exec-previous",
                    compiled_id: "main",
                    authored_id: "main"
                },
                agent_paths: {
                    attempt_root: join(executionDir, "previous"),
                    response_path: join(executionDir, "previous", "agent", "response.md"),
                    artifacts_dir: join(executionDir, "previous", "artifacts"),
                    artifact_paths: {
                        handoff: join(executionDir, "previous", "artifacts", "handoff.md")
                    },
                    attempt_memory_path: join(executionDir, "previous", "agent", "attempt-memory.md"),
                    supervisor_recovery_path: join(executionDir, "previous", "agent", "supervisor-recovery.md")
                },
                audit_paths: {
                    result_path: join(executionDir, "previous", "runtime", "result.json")
                }
            },
            prior_outcome: "failed",
            failure_summary: "Missing declared handoff artifact.",
            resume_point: "repair_artifacts",
            workspace_decision: "preserve",
            resume_decision: {
                resume_point: "repair_artifacts",
                restart_boundary: "artifact_repair",
                workspace_decision: "preserve",
                reuse: ["Preserve source edits and validation from the prior attempt."],
                discard: ["Discard the missing handoff artifact state."],
                reason_code: "artifact_contract_repair",
                confidence: "high",
                evidence: ["The prior implementation passed validation before artifact publication failed."],
                required_next_action: "Repair the missing handoff artifact, then rerun completion.",
                validation_gate: ["af complete check must pass."]
            },
            required_next_action: "Repair the missing handoff artifact, then rerun completion.",
            preserve_progress: ["Prior implementation edits are in scope and should be preserved."],
            do_not_redo: ["Do not rerun the entire implementation from scratch."],
            completed_milestones: ["m1: Implemented feature"],
            unfinished_work: ["Publish handoff artifact"],
            declared_artifact_state: [{
                name: "handoff",
                status: "missing",
                description: "Durable handoff."
            }],
            validation_evidence: [{
                command: "npm test",
                result: "pass",
                summary: "Tests passed before artifact publication failed."
            }],
            workspace_changes: {
                decision: "preserve",
                changed_files: ["src/feature.ts"],
                preserved_files: ["src/feature.ts"],
                reset_files: []
            },
            evidence_to_read: ["agent/attempt-memory.md"]
        }, null, 2)}\n`, "utf8");
        await writeFile(attemptMemoryMarkdownPath, "# Attempt Memory\n\nPrior implementation edits are in scope and should be preserved.\n", "utf8");
        process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
        const orient = await executeAfCli(["orient"]);
        expect(orient.exitCode).toBe(0);
        expect(orient.stdout).toContain("## Retry Orientation");
        expect(orient.stdout).toContain("Missing declared handoff artifact.");
        expect(orient.stdout).toContain("repair_artifacts");
        expect(orient.stdout).toContain("artifact_repair");
        expect(orient.stdout).toContain("artifact_contract_repair");
        expect(orient.stdout).toContain("Preserve source edits and validation from the prior attempt.");
        expect(orient.stdout).toContain("Discard the missing handoff artifact state.");
        expect(orient.stdout).toContain("preserve");
        expect(orient.stdout).toContain("Repair the missing handoff artifact, then rerun completion.");
        expect(orient.stdout).toContain("Do not rerun the entire implementation from scratch.");
        expect(orient.stdout).toContain("## Prior Attempt Memory");
        expect(orient.stdout).toContain("m1: Implemented feature");
        expect(orient.stdout).toContain("npm test");
        expect(orient.stdout).not.toContain("human-debug");
        expect(orient.stdout).not.toContain("provenance");
        expect(orient.stdout).not.toContain("context.json");
        expect(orient.stdout).not.toContain("case-file.json");
        expect(orient.stdout).not.toContain("recovery-plan.json");
        expect(orient.stdout).not.toContain("fingerprint");
    });
    it("rejects broker artifact stdin paths outside the broker request directory", async () => {
        const runtime = await createRuntime(tempRoot);
        const brokerDir = await mkdtemp(join(tmpdir(), "agentflow-af-cli-broker-stdin-"));
        const afRunner = join(process.cwd(), "node_modules/.bin/tsx");
        const afCli = join(process.cwd(), "src/af/index.ts");
        const toolEnv = {
            AGENTFLOW_RUNTIME_METADATA: runtime.metadata,
            AGENTFLOW_AF_BROKER_DIR: brokerDir,
            AGENTFLOW_AF_RUNNER: afRunner,
            AGENTFLOW_AF_CLI: afCli
        };
        const broker = startSpawnBroker({
            executionId: "agent-main",
            repoPath: runtime.workspace,
            outputDir: runtime.output,
            runtimeDir: join(runtime.root, "runtime"),
            prompt: "test",
            sandbox: "workspace-write",
            timeoutSec: 10,
            toolEnv,
            signal: undefined
        } as any);
        const requestId = "forged-stdin";
        await mkdir(join(brokerDir, "requests"), { recursive: true });
        await writeFile(join(brokerDir, "requests", `${requestId}.json`), `${JSON.stringify({
            id: requestId,
            argv: ["artifact", "write", "handoff"],
            stdin_path: join(tempRoot, "outside-stdin.txt")
        }, null, 2)}\n`, "utf8");
        try {
            const responsePath = join(brokerDir, "responses", `${requestId}.json`);
            let response: { exit_code: number; stdout: string } | undefined;
            for (let index = 0; index < 50; index += 1) {
                response = await readFile(responsePath, "utf8")
                    .then((value) => JSON.parse(value) as { exit_code: number; stdout: string })
                    .catch(() => undefined);
                if (response) {
                    break;
                }
                await new Promise((resolveWait) => setTimeout(resolveWait, 50));
            }
            expect(response).toEqual(expect.objectContaining({ exit_code: 2 }));
            expect(response?.stdout).toContain("stdin_path must stay inside");
            await expect(readFile(join(runtime.output, "handoff.md"), "utf8")).rejects.toThrow();
        }
        finally {
            broker.stop();
            await rm(brokerDir, { recursive: true, force: true });
        }
    });
    it("ignores forged broker cwd on allowed worker commands", async () => {
        const runtime = await createRuntime(tempRoot);
        const brokerDir = await mkdtemp(join(tmpdir(), "agentflow-af-cli-broker-cwd-"));
        const afRunner = join(process.cwd(), "node_modules/.bin/tsx");
        const afCli = join(process.cwd(), "src/af/index.ts");
        const toolEnv = {
            AGENTFLOW_RUNTIME_METADATA: runtime.metadata,
            AGENTFLOW_AF_BROKER_DIR: brokerDir,
            AGENTFLOW_AF_RUNNER: afRunner,
            AGENTFLOW_AF_CLI: afCli
        };
        const broker = startSpawnBroker({
            executionId: "agent-main",
            repoPath: runtime.workspace,
            outputDir: runtime.output,
            runtimeDir: join(runtime.root, "runtime"),
            prompt: "test",
            sandbox: "workspace-write",
            timeoutSec: 10,
            toolEnv,
            signal: undefined
        } as any);
        const requestId = "forged-cwd";
        const requestsDir = join(brokerDir, "requests");
        const stdinPath = join(requestsDir, `${requestId}.stdin`);
        await mkdir(requestsDir, { recursive: true });
        await writeFile(stdinPath, "broker cwd constrained\n", "utf8");
        await writeFile(join(requestsDir, `${requestId}.json`), `${JSON.stringify({
            id: requestId,
            argv: ["artifact", "write", "handoff"],
            cwd: "/",
            stdin_path: stdinPath
        }, null, 2)}\n`, "utf8");
        try {
            const responsePath = join(brokerDir, "responses", `${requestId}.json`);
            let response: { exit_code: number; stdout: string } | undefined;
            for (let index = 0; index < 50; index += 1) {
                response = await readFile(responsePath, "utf8")
                    .then((value) => JSON.parse(value) as { exit_code: number; stdout: string })
                    .catch(() => undefined);
                if (response) {
                    break;
                }
                await new Promise((resolveWait) => setTimeout(resolveWait, 50));
            }
            expect(response).toEqual(expect.objectContaining({ exit_code: 0 }));
            await expect(readFile(join(runtime.output, "handoff.md"), "utf8"))
                .resolves.toBe("broker cwd constrained\n");
        }
        finally {
            broker.stop();
            await rm(brokerDir, { recursive: true, force: true });
        }
    });
    it("routes af mutations through the parent broker so sandboxed agents do not write run state directly", async () => {
        const runtime = await createRuntime(tempRoot);
        const brokerDir = await mkdtemp(join(tmpdir(), "agentflow-af-cli-broker-"));
        const afRunner = join(process.cwd(), "node_modules/.bin/tsx");
        const afCli = join(process.cwd(), "src/af/index.ts");
        const toolEnv = {
            AGENTFLOW_RUNTIME_METADATA: runtime.metadata,
            AGENTFLOW_AF_BROKER_DIR: brokerDir,
            AGENTFLOW_AF_RUNNER: afRunner,
            AGENTFLOW_AF_CLI: afCli
        };
        const broker = startSpawnBroker({
            executionId: "agent-main",
            repoPath: runtime.workspace,
            outputDir: runtime.output,
            runtimeDir: join(runtime.root, "runtime"),
            prompt: "test",
            sandbox: "workspace-write",
            timeoutSec: 10,
            toolEnv,
            signal: undefined
        } as any);
        process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
        process.env.AGENTFLOW_AF_BROKER_DIR = brokerDir;
        process.env.AGENTFLOW_AF_RUNNER = afRunner;
        process.env.AGENTFLOW_AF_CLI = afCli;
        const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            await expect(runAfCli([
                "milestone",
                "add",
                "--title",
                "Brokered milestone",
                "--goal",
                "Prove the broker owns run-state writes."
            ])).resolves.toBe(0);
            await expect(withStdin("brokered artifact\n", () => runAfCli(["artifact", "write", "handoff"])))
                .resolves.toBe(0);
        }
        finally {
            stdoutSpy.mockRestore();
            stderrSpy.mockRestore();
            broker.stop();
        }
        await expect(readFile(join(runtime.output, "handoff.md"), "utf8")).resolves.toBe("brokered artifact\n");
        await expect(readFile(join(runtime.root, "runtime", "milestones", "agent-main.json"), "utf8"))
            .resolves.toContain("Brokered milestone");
        await rm(brokerDir, { recursive: true, force: true });
    });
    it("preserves concurrent milestone logs and paired af tool logs", async () => {
        const runtime = await createRuntime(tempRoot);
        process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
        await expect(executeAfCli([
            "milestone",
            "add",
            "--title",
            "Concurrent evidence",
            "--goal",
            "Record adjacent finding and validation evidence without losing either log."
        ])).resolves.toMatchObject({ exitCode: 0 });
        const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
            await Promise.all([
                runAfCli([
                    "milestone",
                    "log",
                    "m1",
                    "--kind",
                    "finding",
                    "--summary",
                    "The stale source is not authoritative."
                ]),
                runAfCli([
                    "milestone",
                    "log",
                    "m1",
                    "--kind",
                    "validation",
                    "--command",
                    "node scripts/check.mjs",
                    "--result",
                    "pass",
                    "--summary",
                    "Validation passed."
                ])
            ]).then((results) => {
                expect(results).toEqual([
                    0,
                    0
                ]);
            });
        }
        finally {
            stdoutSpy.mockRestore();
        }
        const milestoneState = JSON.parse(await readFile(join(runtime.root, "runtime", "milestones", "agent-main.json"), "utf8")) as {
            milestones: Array<{ logs: Array<{ log_id: string; kind: string }> }>;
        };
        expect(milestoneState.milestones[0]?.logs).toEqual([
            expect.objectContaining({ log_id: "m1.l1" }),
            expect.objectContaining({ log_id: "m1.l2" })
        ]);
        expect(milestoneState.milestones[0]?.logs.map((log) => log.kind).sort()).toEqual(["finding", "validation"]);
        const toolIndex = (await readFile(runtime.toolInvocations, "utf8")).trim().split(/\r?\n/u);
        const sidecarPaths = toolIndex.map((line) => JSON.parse(line) as { input_path: string; output_path: string });
        expect(new Set(sidecarPaths.map((entry) => entry.input_path)).size).toBe(sidecarPaths.length);
        expect(new Set(sidecarPaths.map((entry) => entry.output_path)).size).toBe(sidecarPaths.length);
    });
    it("exposes supervisor learn and diagnose helpers", async () => {
        const runtime = await createRuntime(tempRoot, undefined, { af_command_policy: "diagnostic" });
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
            }
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
        const playbook = outputOf<{
            kind: string;
            playbook: {
                safe_repairs: string[];
                contract_boundaries: string[];
            };
        }>(await executeAfCli(["learn", "failed_check"]));
        const removedBoundaryField = ["pause", "boundaries"].join("_");
        expect(playbook.kind).toBe("failed_check");
        expect(playbook.playbook.safe_repairs.join(" ")).toContain("upstream");
        expect(playbook.playbook.contract_boundaries.join(" ")).toContain("trusted typed authority");
        expect(playbook.playbook).not.toHaveProperty(removedBoundaryField);
        expect(JSON.stringify(playbook.playbook)).not.toContain(removedBoundaryField);
        expect(JSON.stringify(playbook.playbook)).not.toMatch(/human pause|free text.*pause|helper.*pause/iu);
        const cone = outputOf<{
            direction: string;
            nodes: Array<{
                compiled_id: string;
            }>;
        }>(await executeAfCli(["diagnose", "graph-cone", "--from", "validate", "--upstream", "--json"]));
        expect(cone.direction).toBe("upstream");
        expect(cone.nodes).toEqual([
            expect.objectContaining({ compiled_id: "implement" })
        ]);
        const validation = outputOf<{
            validation: {
                command: string;
                args: string[];
            };
        }>(await executeAfCli(["diagnose", "validation", "--node", "validate", "--json"]));
        expect(validation.validation.command).toBe("npm");
        expect(validation.validation.args).toEqual(["test"]);
        const evidenceMap = outputOf<{
            command: string;
            requirement_evidence_map: {
                requirements: Array<{
                    requirement: string;
                    status: string;
                }>;
            };
        }>(await executeAfCli(["diagnose", "evidence-map", "--node", "validate", "--json"]));
        expect(evidenceMap.command).toBe("af diagnose evidence-map");
        expect(evidenceMap.requirement_evidence_map.requirements).toEqual(expect.arrayContaining([
            expect.objectContaining({
                requirement: "The focused validation command exits successfully.",
                status: "missing"
            })
        ]));
        const caseFilePath = join(runtime.root, "case-file.json");
        await writeFile(caseFilePath, `${JSON.stringify({
            requirement_evidence_map: evidenceMap.requirement_evidence_map
        }, null, 2)}\n`, "utf8");
        const recoveryDelta = outputOf<{
            command: string;
            retry_allowed: boolean;
            retry_blocked_reason: string;
        }>(await executeAfCli(["diagnose", "recovery-delta", "--case", caseFilePath, "--json"]));
        expect(recoveryDelta.command).toBe("af diagnose recovery-delta");
        expect(recoveryDelta.retry_allowed).toBe(false);
        expect(recoveryDelta.retry_blocked_reason).toContain("No available run evidence");
    });
    it("records af stdout sidecar logs in the invocation ledger", async () => {
        const runtime = await createRuntime(tempRoot);
        process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
        const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
            await expect(runAfCli(["orient"])).resolves.toBe(0);
        }
        finally {
            stdoutSpy.mockRestore();
        }
        const records = (await readFile(runtime.toolInvocations, "utf8"))
            .trim()
            .split(/\r?\n/)
            .map((line) => JSON.parse(line) as {
            kind: string;
            argv: string[];
            output_path?: string;
        });
        expect(records).toEqual([
            expect.objectContaining({
                kind: "af",
                argv: ["orient"],
                output_path: expect.stringContaining("human-debug/tools/0001-output.json")
            })
        ]);
        await expect(readFile(records[0]!.output_path!, "utf8")).resolves.toContain("# Agentflow Orientation");
    });
    it("spawns a helper with its own metadata and waits for the helper artifact", async () => {
        const runtime = await createRuntime(tempRoot, undefined, { af_command_policy: "orchestrator" });
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
        const spawned = outputOf<{
            status: string;
            agent: {
                status: string;
                role?: string;
                sandbox: string;
                input_case_file?: string;
                prompt_path?: string;
            };
            artifact: string;
        }>(await executeAfCli([
            "spawn",
            "--role",
            "evidence_mapper",
            "--brief",
            "Map failed requirements to evidence.",
            "--case",
            join(runtime.root, "case-file.json"),
            "--artifact",
            "helper-report.md",
            "--wait",
            "--timeout-sec",
            "10"
        ]));
        expect(spawned.status).toBe("passed");
        expect(spawned.agent.status).toBe("completed");
        expect(spawned.agent.role).toBe("evidence_mapper");
        expect(spawned.agent.sandbox).toBe("read-only");
        expect(spawned.agent.input_case_file).toBe(join(runtime.root, "case-file.json"));
        await expect(readFile(spawned.artifact, "utf8")).resolves.toContain("helper ok");
        await expect(readFile(spawned.agent.prompt_path!, "utf8")).resolves.toContain("evidence mapper");
        await expect(readFile(spawned.agent.prompt_path!, "utf8")).resolves.toContain("Do not request human pause or approval");
    });
    it.each([
        ["evidence_mapper", "investigation", "evidence mapper"],
        ["causal_investigator", "investigation", "causal investigator"],
        ["verification_auditor", "verification", "verification auditor"],
        ["repair_planner", "repair", "repair planner"]
    ])("records fixed read-only helper role metadata for %s without launching a standing team", async (role, purpose, promptText) => {
        const runtime = await createRuntime(tempRoot, undefined, { af_command_policy: "orchestrator" });
        process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
        process.env.AGENTFLOW_SPAWN_MODE = "broker";
        const spawned = outputOf<{
            role: string;
            agent_id: string;
            output_dir: string;
        }>(await executeAfCli([
            "spawn",
            "--role",
            role,
            "--brief",
            "Inspect the recovery case.",
            "--case",
            join(runtime.root, "case-file.json"),
            "--output-schema",
            `${role}.v1`,
            "--evidence-map",
            join(runtime.root, "evidence-map.json"),
            "--material-delta",
            join(runtime.root, "material-delta.json")
        ]));
        expect(spawned.role).toBe(role);
        const sessionPath = join(runtime.root, "runtime", "helpers", spawned.agent_id, "session.json");
        const session = JSON.parse(await readFile(sessionPath, "utf8")) as {
            status: string;
            purpose: string;
            role: string;
            sandbox: string;
            input_case_file: string;
            output_schema: string;
            evidence_map_path: string;
            material_delta_path: string;
        };
        expect(session).toEqual(expect.objectContaining({
            status: "starting",
            purpose,
            role,
            sandbox: "read-only",
            input_case_file: join(runtime.root, "case-file.json"),
            output_schema: `${role}.v1`,
            evidence_map_path: join(runtime.root, "evidence-map.json"),
            material_delta_path: join(runtime.root, "material-delta.json")
        }));
        const codexBin = join(tempRoot, `mock-codex-${role}.mjs`);
        await writeExecutable(codexBin, [
            "#!/usr/bin/env node",
            "process.stdout.write('helper prompt captured\\n');",
            ""
        ].join("\n"));
        process.env.AGENTFLOW_CODEX_CLI_BIN = codexBin;
        process.env.AGENTFLOW_INTERNAL_HELPER_RUN = "1";
        try {
            const result = await executeAfCli([
                "_helper-run",
                "--metadata",
                runtime.metadata,
                "--helper",
                spawned.agent_id,
                "--artifact",
                "helper-report.md"
            ]);
            expect(result.exitCode).toBe(1);
        }
        finally {
            delete process.env.AGENTFLOW_INTERNAL_HELPER_RUN;
        }
        const promptPath = join(runtime.root, "runtime", "helpers", spawned.agent_id, "prompt.md");
        await expect(readFile(promptPath, "utf8")).resolves.toContain(promptText);
        await expect(readFile(promptPath, "utf8")).resolves.toContain("Do not request human pause or approval");
    });
    it("does not expose a standalone af wait command", async () => {
        const runtime = await createRuntime(tempRoot);
        process.env.AGENTFLOW_RUNTIME_METADATA = runtime.metadata;
        const result = await executeAfCli(["wait", "--agent", "helper_missing"]);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toContain("not allowed by the worker command policy");
        const artifactList = await executeAfCli(["artifact", "list"]);
        expect(artifactList.exitCode).toBe(2);
        expect(artifactList.stdout).toContain("not allowed by the worker command policy");
        const toolsList = await executeAfCli(["tools", "list"]);
        expect(toolsList.exitCode).toBe(2);
        expect(toolsList.stdout).toContain("not allowed by the worker command policy");
        const supervisionShow = await executeAfCli(["supervision", "show"]);
        expect(supervisionShow.exitCode).toBe(2);
        expect(supervisionShow.stdout).toContain("not allowed by the worker command policy");
        const status = await executeAfCli(["status"]);
        expect(status.exitCode).toBe(2);
        expect(status.stdout).toContain("not allowed by the worker command policy");
        const contextShow = await executeAfCli(["context", "show"]);
        expect(contextShow.exitCode).toBe(2);
        expect(contextShow.stdout).toContain("not allowed by the worker command policy");
    });
    it("fails af spawn --wait when the helper exits without its required artifact", async () => {
        const runtime = await createRuntime(tempRoot, undefined, { af_command_policy: "orchestrator" });
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
        expect(result.output).toEqual(expect.objectContaining({
            command: "af spawn",
            status: "failed",
            agent: expect.objectContaining({
                status: "failed",
                exit_code: 0,
                artifacts: {}
            })
        }));
    });
});
