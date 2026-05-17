import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    resolveExecutionAgentContextPath,
    resolveExecutionArtifactsDirectory,
    resolveExecutionRuntimeContextPath,
    resolveExecutionRuntimeToolDirectory,
    resolveInterventionDirectory
} from "../../src/artifacts/paths.js";
import type { CompiledAgentNode } from "../../src/graph/compiled.js";
import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import { runRepairArtifactIntervention } from "../../src/supervisor/actions.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { HarnessAdapter } from "../../src/runtime/harness/types.js";
import type { RuntimeSession } from "../../src/runtime/session.js";
describe("supervisor actions", () => {
    it("runs artifact repair in a durable intervention directory", async () => {
        const runRoot = await mkdtemp(join(tmpdir(), "agentflow-supervisor-action-"));
        const executionDir = join(runRoot, "nodes", "001-write", "executions", "001-exec");
        const artifactsRoot = resolveExecutionArtifactsDirectory(executionDir);
        await mkdir(artifactsRoot, { recursive: true });
        const node: CompiledAgentNode = {
            compiled_id: "root__write",
            authored_id: "write",
            kind: "agent",
            repo: "main",
            deps: [],
            scope_stack: ["root"],
            effective_policy: {
                profile_name: "default",
                harness: "codex-cli",
                workspace_backend: "inplace",
                timeout_sec: 60,
                artifact_repair: {
                    max_attempts: 1
                }
            },
            context: [],
            declared_artifacts: {
                handoff: {
                    from: "output_dir",
                    path: "handoff.md",
                    description: "Markdown handoff."
                }
            },
            intent: {
                goal: "Write a handoff.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
            tools: []
        };
        const attempt: RuntimeNodeAttempt = {
            execution_id: "exec-1",
            compiled_id: node.compiled_id,
            authored_id: node.authored_id,
            kind: "agent",
            repo_alias: "main",
            execution_dir: executionDir,
            attempt_index: 1,
            status: "running",
            started_at: "2026-04-24T00:00:00.000Z",
            artifacts: {},
            metadata: {}
        };
        const harness: HarnessAdapter = {
            kind: "codex-cli",
            capabilities: getHarnessCapabilities("codex-cli")!,
            async run(invocation) {
                await writeFile(join(invocation.outputDir, "handoff.md"), "repaired\n", "utf8");
                return {
                    status: "passed",
                    exitCode: 0,
                    stdout: "ok",
                    stderr: "",
                    transcript: {
                        last_message: "repaired"
                    }
                };
            },
            async cancel() {
                return;
            }
        };
        const record = await runRepairArtifactIntervention({
            node,
            attempt,
            missing_artifacts: [{
                    name: "handoff",
                    from: "output_dir",
                    path: "handoff.md",
                    description: "Markdown handoff.",
                    expected_path: join(artifactsRoot, "handoff.md")
                }],
            session: {
                run_id: "run-1",
                run_root: runRoot,
                graph: { graph_id: "graph-1", credential_specs: {} }
            } as RuntimeSession,
            workspace_path: runRoot,
            context_packet_path: resolveExecutionRuntimeContextPath(executionDir),
            context_manifest_path: resolveExecutionAgentContextPath(executionDir),
            harnesses: {
                "codex-cli": harness
            },
            decision_id: "decision-1",
            intervention_id: "intervention-1",
            repair_attempt: 1,
            max_attempts: 1
        });
        expect(record).toEqual(expect.objectContaining({
            intervention_id: "intervention-1",
            decision_id: "decision-1",
            action: "repair_artifact",
            status: "passed",
            target_compiled_id: "root__write",
            target_execution_id: "exec-1"
        }));
        const interventionDir = resolveInterventionDirectory(executionDir, "intervention-1");
        expect(record.artifact_paths.intervention_dir).toBe(interventionDir);
        await expect(readFile(join(interventionDir, "prompt.md"), "utf8"))
            .resolves.toContain("## Repair Task");
        await expect(readFile(join(interventionDir, "result.json"), "utf8"))
            .resolves.toContain('"missing_artifacts_after": []');
        await expect(readFile(join(artifactsRoot, "handoff.md"), "utf8")).resolves.toBe("repaired\n");
        const toolRuntimeDir = resolveExecutionRuntimeToolDirectory(executionDir);
        await expect(readFile(join(toolRuntimeDir, "runtime.json"), "utf8"))
            .resolves.toEqual(expect.stringContaining(`"run_root": "${runRoot}"`));
        const runtimeMetadata = JSON.parse(await readFile(join(toolRuntimeDir, "runtime.json"), "utf8")) as Record<string, unknown>;
        expect(runtimeMetadata).toMatchObject({
            run_id: "run-1",
            graph_id: "graph-1",
            execution_id: "exec-1",
            context_packet_path: resolveExecutionRuntimeContextPath(executionDir),
            context_manifest_path: resolveExecutionAgentContextPath(executionDir),
            sandbox: "workspace-write"
        });
        expect(runtimeMetadata.output_dir).toBe(artifactsRoot);
        expect(runtimeMetadata.runtime_dir).toBe(join(runRoot, "runtime"));
    });
    it("keeps artifact repair writable even when the supervisor profile is read-only", async () => {
        const runRoot = await mkdtemp(join(tmpdir(), "agentflow-supervisor-action-writable-repair-"));
        const executionDir = join(runRoot, "nodes", "001-write", "executions", "001-exec");
        const artifactsRoot = resolveExecutionArtifactsDirectory(executionDir);
        await mkdir(artifactsRoot, { recursive: true });
        const node: CompiledAgentNode = {
            compiled_id: "root__write",
            authored_id: "write",
            kind: "agent",
            repo: "main",
            deps: [],
            scope_stack: ["root"],
            effective_policy: {
                profile_name: "default",
                harness: "codex-cli",
                sandbox: "workspace-write",
                workspace_backend: "inplace",
                timeout_sec: 60,
                artifact_repair: {
                    max_attempts: 1
                }
            },
            context: [],
            declared_artifacts: {
                handoff: {
                    from: "output_dir",
                    path: "handoff.md",
                    description: "Markdown handoff."
                }
            },
            intent: {
                goal: "Write a handoff.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: ["Do not edit workspace files."]
            },
            tools: []
        };
        const attempt: RuntimeNodeAttempt = {
            execution_id: "exec-1",
            compiled_id: node.compiled_id,
            authored_id: node.authored_id,
            kind: "agent",
            repo_alias: "main",
            execution_dir: executionDir,
            attempt_index: 1,
            status: "running",
            started_at: "2026-04-24T00:00:00.000Z",
            artifacts: {},
            metadata: {}
        };
        let observedSandbox: string | undefined;
        const harness: HarnessAdapter = {
            kind: "codex-cli",
            capabilities: getHarnessCapabilities("codex-cli")!,
            async run(invocation) {
                observedSandbox = invocation.sandbox;
                await writeFile(join(invocation.outputDir, "handoff.md"), "repaired\n", "utf8");
                return {
                    status: "passed",
                    exitCode: 0,
                    stdout: "ok",
                    stderr: "",
                    transcript: {
                        last_message: "repaired"
                    }
                };
            },
            async cancel() {
                return;
            }
        };
        try {
            const record = await runRepairArtifactIntervention({
                node,
                attempt,
                missing_artifacts: [{
                        name: "handoff",
                        from: "output_dir",
                        path: "handoff.md",
                        description: "Markdown handoff.",
                        expected_path: join(artifactsRoot, "handoff.md")
                    }],
                session: {
                    run_id: "run-1",
                    run_root: runRoot,
                    graph: { graph_id: "graph-1", credential_specs: {} }
                } as RuntimeSession,
                workspace_path: runRoot,
                context_packet_path: resolveExecutionRuntimeContextPath(executionDir),
                context_manifest_path: resolveExecutionAgentContextPath(executionDir),
                harnesses: {
                    "codex-cli": harness
                },
                supervisor_policy: {
                    harness: "codex-cli",
                    sandbox: "read-only"
                },
                decision_id: "decision-1",
                intervention_id: "intervention-1",
                repair_attempt: 1,
                max_attempts: 1
            });
            expect(record.status).toBe("passed");
            expect(observedSandbox).toBe("workspace-write");
            await expect(readFile(join(resolveInterventionDirectory(executionDir, "intervention-1"), "prompt.md"), "utf8")).resolves.not.toContain("read-only sandbox prevents file writes");
        }
        finally {
            await rm(runRoot, { recursive: true, force: true });
        }
    });
});
