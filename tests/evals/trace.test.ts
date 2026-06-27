import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    resolveExecutionHumanDebugToolDirectory,
    resolveExecutionRuntimeCompletionPacketPath,
    resolveRunArtifactPaths
} from "../../src/artifacts/paths.js";
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
        const completionPacketPath = resolveExecutionRuntimeCompletionPacketPath(executionDir);
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
        await writeFile(paths.events_file, `${JSON.stringify({
            seq: 1,
            ts: "2026-05-03T12:00:05.000Z",
            run_id: "run-test",
            type: "supervisor.retry_scheduled",
            compiled_id: "ship",
            execution_id: "exec__ship__attempt_1",
            payload: {
                action: "retry_with_guidance",
                target_compiled_id: "ship",
                intervention_decision: {
                    selected_strategy: "rerun_verification",
                    restart_boundary: "verification",
                    workspace_decision: "preserve",
                    material_delta: [
                        { kind: "validation_strategy_changed", summary: "Retry verifier only." }
                    ],
                    fallback_if_repeated: "repair_validation_strategy"
                },
                resume_decision: {
                    resume_point: "rerun_verification",
                    restart_boundary: "verification",
                    workspace_decision: "preserve",
                    reason_code: "verification_substrate_failure"
                }
            }
        })}\n`, "utf8");
        await writeFile(paths.interventions_file, `${JSON.stringify({
            intervention_id: "intervention-1",
            decision_id: "decision-1",
            action: "run_diagnostic",
            status: "passed",
            evidence: {
                failure_fingerprint: "fingerprint-1",
                recovery_plan: { apply_action: "retry_with_evidence" },
                recovery_learning: {
                    diagnosis: "guidance_ignored",
                    followed_required_next_action: "no",
                    followed_validation_gate: "no",
                    material_delta_used: "no",
                    repeated_forbidden_tactic: "yes"
                }
            },
            artifact_paths: {}
        })}\n`, "utf8");
        await writeJson(join(runRoot, "delivery", "manifest.json"), {
            graph_status: "passed",
            delivery_status: "passed",
            review_ready: true
        });
        await writeJson(join(executionDir, "runtime/execution.json"), {
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
        const toolDir = resolveExecutionHumanDebugToolDirectory(executionDir);
        await mkdir(toolDir, { recursive: true });
        await writeJson(join(executionDir, "human-debug", "prompt-diagnostics.json"), {
            version: "1",
            prompt_kind: "agent",
            renderer: "renderHarnessPrompt",
            execution_id: "exec__ship__attempt_1",
            sandbox: "workspace-write",
            total_chars: 1200,
            sections: [{ name: "Context", chars: 400 }],
            context_pointer_count: 3,
            context_pointer_kinds: ["workspace_file", "runtime_supervisor_recovery"],
            context_priority_bucket_counts: {
                read_first: 1,
                current_work: 0,
                task_context: 2,
                progress_state: 0,
                reference_set: 0
            },
            context_read_first_count: 1,
            context_glob_set_count: 0,
            context_glob_match_count: 0,
            context_glob_included_count: 0,
            context_limited_glob_count: 0,
            context_uses_flat_glob_expansion: false,
            tool_count: 0,
            skill_count: 0,
            cli_hint_count: 1,
            declared_artifact_count: 0,
            has_supervisor_recovery: true,
            orient_required_by_prompt: true,
            complete_check_required_by_prompt: true,
            warnings: ["context_many_pointers"]
        });
        await writeFile(join(toolDir, "index.jsonl"), `${JSON.stringify({
            kind: "af",
            argv: ["complete", "check"],
            exit_code: 0,
            duration_ms: 12
        })}\n${JSON.stringify({
            kind: "af",
            argv: ["orient"],
            exit_code: 0,
            duration_ms: 6
        })}\n`, "utf8");
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
        expect(JSON.stringify(packet.trajectory)).toContain("af orient");
        expect(packet.supervisor.resume_decisions).toEqual([
            {
                resume_point: "rerun_verification",
                restart_boundary: "verification",
                workspace_decision: "preserve",
                reason_code: "verification_substrate_failure"
            }
        ]);
        expect(packet.supervisor.intervention_decisions).toEqual([
            expect.objectContaining({
                selected_strategy: "rerun_verification",
                restart_boundary: "verification",
                workspace_decision: "preserve",
                material_delta_count: 1,
                fallback_if_repeated: "repair_validation_strategy"
            })
        ]);
        expect(packet.supervisor.recovery_learning).toEqual([
            expect.objectContaining({
                diagnosis: "guidance_ignored",
                followed_required_next_action: "no",
                repeated_forbidden_tactic: "yes"
            })
        ]);
        expect(packet.prompt_diagnostics).toEqual(expect.objectContaining({
            count: 1,
            total_chars: 1200,
            max_prompt_chars: 1200,
            context_pointer_count: 3,
            context_read_first_count: 1,
            warnings: ["context_many_pointers"],
            warning_counts: { context_many_pointers: 1 }
        }));
        expect(packet.prompt_diagnostics.entries[0]).toEqual(expect.objectContaining({
            path: expect.stringContaining("prompt-diagnostics.json"),
            prompt_kind: "agent",
            has_supervisor_recovery: true
        }));
        expect(packet.metrics.prompt_diagnostics_count).toBe(1);
        expect(packet.delivery).toEqual(expect.objectContaining({
            graph_status: "passed",
            delivery_status: "passed",
            review_ready: true
        }));
        await expect(readFile(completionPacketPath, "utf8")).resolves.toContain("ready_for_verification");
    });
});
