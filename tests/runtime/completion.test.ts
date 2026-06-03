import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompiledAgentNode } from "../../src/graph/compiled.js";
import {
    resolveExecutionArtifactsDirectory,
    resolveExecutionHumanDebugToolDirectory
} from "../../src/artifacts/paths.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import { createAuthorityRequest } from "../../src/runtime/authority.js";
import { buildCompletionPacket, buildCompletionProjection, persistCompletionPacket } from "../../src/runtime/completion/index.js";
function makeNode(overrides: Partial<CompiledAgentNode> = {}): CompiledAgentNode {
    return {
        compiled_id: "ship",
        authored_id: "ship",
        kind: "agent",
        intent: {
            goal: "Ship the implementation.",
            acceptance_criteria: ["The implementation satisfies the authored contract."],
            constraints: []
        },
        repo: "main",
        deps: [],
        scope_stack: ["root"],
        effective_policy: {
            profile_name: "default",
            sandbox: "workspace-write",
            timeout_sec: 60,
            artifact_repair: { max_attempts: 0 }
        },
        context: [],
        declared_artifacts: {
            implementation_summary: {
                from: "output_dir",
                path: "implementation-summary.md",
                description: "Summarize implementation, validation, and risks."
            }
        },
        tools: [],
        ...overrides
    };
}
function makeAttempt(executionDir: string, overrides: Partial<RuntimeNodeAttempt> = {}): RuntimeNodeAttempt {
    return {
        execution_id: "exec__ship__attempt_1",
        compiled_id: "ship",
        authored_id: "ship",
        kind: "agent",
        repo_alias: "main",
        execution_dir: executionDir,
        attempt_index: 1,
        status: "running",
        started_at: "2026-05-03T12:00:00.000Z",
        artifacts: {},
        metadata: {},
        ...overrides
    };
}
async function writeOrientInvocation(executionDir: string): Promise<void> {
    const toolDir = resolveExecutionHumanDebugToolDirectory(executionDir);
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(toolDir, "index.jsonl"), `${JSON.stringify({
        ts: "2026-05-03T12:00:10.000Z",
        execution_id: "exec__ship__attempt_1",
        kind: "af",
        tool: "af",
        argv: ["orient"],
        exit_code: 0
    })}\n`, "utf8");
}
async function writeCompletedMilestone(runRoot: string, runtimeDir?: string): Promise<void> {
    const milestoneRoot = join(runtimeDir ?? join(runRoot, "runtime"), "milestones");
    await mkdir(milestoneRoot, { recursive: true });
    await writeFile(join(milestoneRoot, "exec__ship__attempt_1.json"), `${JSON.stringify({
        version: "1",
        execution_id: "exec__ship__attempt_1",
        milestones: [{
            id: "m1",
            execution_id: "exec__ship__attempt_1",
            title: "Complete node work",
            goal: "Satisfy the node contract and publish declared artifacts.",
            status: "completed",
            logs: [],
            completion_evidence: "Node work and artifacts are complete.",
            created_at: "2026-05-03T12:00:20.000Z",
            updated_at: "2026-05-03T12:00:30.000Z",
            completed_at: "2026-05-03T12:00:30.000Z"
        }]
    }, null, 2)}\n`, "utf8");
}
async function writeReadyRuntime(runRoot: string, executionDir: string, runtimeDir?: string): Promise<void> {
    await writeOrientInvocation(executionDir);
    await writeCompletedMilestone(runRoot, runtimeDir);
}
describe("completion packet", () => {
    let tempRoot: string;
    let runRoot: string;
    let workspace: string;
    let executionDir: string;
    beforeEach(async () => {
        tempRoot = await mkdtemp(join(tmpdir(), "agentflow-completion-"));
        runRoot = join(tempRoot, "run");
        workspace = join(tempRoot, "workspace");
        executionDir = join(runRoot, "nodes", "node-ship", "executions", "001-ship");
        await mkdir(resolveExecutionArtifactsDirectory(executionDir), { recursive: true });
        await mkdir(workspace, { recursive: true });
        await writeReadyRuntime(runRoot, executionDir);
    });
    afterEach(async () => {
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("marks a missing declared artifact incomplete and persists the packet", async () => {
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.ready_for_verification).toBe(false);
        expect(packet.missing_artifacts).toEqual(["implementation_summary"]);
        expect(packet.declared_artifacts[0]).toEqual(expect.objectContaining({
            name: "implementation_summary",
            status: "missing",
            current_attempt: false
        }));
        const packetPath = await persistCompletionPacket(packet);
        await expect(readFile(packetPath, "utf8")).resolves.toContain('"completion_status": "incomplete"');
    });
    it("requires af orient before agent completion", async () => {
        await rm(join(resolveExecutionHumanDebugToolDirectory(executionDir), "index.jsonl"), { force: true });
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, "real handoff\n", "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.orientation.orient_called).toBe(false);
        expect(packet.blocking_reasons).toContain("af orient was not run for this agent node.");
    });
    it("requires completed milestones before agent completion", async () => {
        await rm(join(runRoot, "runtime", "milestones", "exec__ship__attempt_1.json"), { force: true });
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, "real handoff\n", "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.milestones.total).toBe(0);
        expect(packet.blocking_reasons).toContain("No milestones were created for this agent node.");
    });
    it("treats active and blocked milestones as completion blockers", async () => {
        const milestonePath = join(runRoot, "runtime", "milestones", "exec__ship__attempt_1.json");
        await writeFile(milestonePath, `${JSON.stringify({
            version: "1",
            execution_id: "exec__ship__attempt_1",
            milestones: [
                {
                    id: "m1",
                    execution_id: "exec__ship__attempt_1",
                    title: "Still working",
                    goal: "Finish the remaining implementation.",
                    status: "active",
                    logs: [],
                    created_at: "2026-05-03T12:00:20.000Z",
                    updated_at: "2026-05-03T12:00:20.000Z"
                },
                {
                    id: "m2",
                    execution_id: "exec__ship__attempt_1",
                    title: "External dependency",
                    goal: "Validate against the external service.",
                    status: "blocked",
                    logs: [],
                    blocked_on: "external service is unavailable",
                    recoverable_by: "operator",
                    blocked_evidence: "service health endpoint timed out",
                    created_at: "2026-05-03T12:00:20.000Z",
                    updated_at: "2026-05-03T12:00:30.000Z",
                    blocked_at: "2026-05-03T12:00:30.000Z"
                }
            ]
        }, null, 2)}\n`, "utf8");
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, "real handoff\n", "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.blocking_reasons).toEqual(expect.arrayContaining([
            "1 milestone(s) are still active.",
            "1 milestone(s) are blocked."
        ]));
    });
    it("blocks read-only nodes with declared write artifacts", async () => {
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                effective_policy: {
                    profile_name: "default",
                    sandbox: "read-only",
                    timeout_sec: 60,
                    artifact_repair: { max_attempts: 0 }
                }
            }),
            attempt: makeAttempt(executionDir),
            workspacePath: workspace,
            sandbox: "read-only"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.blocking_reasons.join("\n")).toContain("read-only sandbox");
    });
    it("uses blocked completion status only for typed authority requests", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, "real handoff\n", "utf8");
        const authorityRequest = createAuthorityRequest({
            kind: "missing_credential",
            source: "credential",
            request_id: "credential-1",
            summary: "GitHub token is required for the approved publish step.",
            created_at: "2026-05-03T12:00:00.000Z"
        });
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write",
            authorityRequests: [authorityRequest]
        });
        expect(packet.completion_status).toBe("blocked");
        expect(packet.authority_requests).toEqual([authorityRequest]);
        expect(packet.blocking_reasons).toContain("Authority required (missing_credential): GitHub token is required for the approved publish step.");
    });
    it("rejects empty and placeholder declared artifacts before semantic verification", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, "TODO: fill this in before shipping.\n", "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.artifact_findings).toEqual([
            expect.objectContaining({
                artifact: "implementation_summary",
                kind: "placeholder"
            })
        ]);
    });
    it("accepts artifact text that states placeholder checks passed", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, [
            "Scenario: completed",
            "Evidence: local checks passed.",
            "Validation: focused validation passed.",
            "Risks: none identified.",
            "Completion: No placeholders or unresolved template values remain in this file."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.artifact_findings).toEqual([]);
        expect(packet.declared_artifacts).toEqual([
            expect.objectContaining({
                name: "implementation_summary",
                status: "present"
            })
        ]);
    });
    it("rejects declared JSON artifacts that do not parse", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "draft-packet.json");
        await writeFile(artifactPath, [
            "{",
            '  "scenario": "managed-cycle-feedback",',
            '  "completion": "Draft generated"',
            '  "notes_artifact": "work-notes.md"',
            "}"
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                declared_artifacts: {
                    draft_packet: {
                        from: "output_dir",
                        path: "draft-packet.json",
                        description: "Draft content packet."
                    }
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { draft_packet: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.artifact_findings).toEqual([
            expect.objectContaining({
                artifact: "draft_packet",
                kind: "invalid_json",
                summary: expect.stringContaining("does not parse")
            })
        ]);
        expect(packet.declared_artifacts[0]).toEqual(expect.objectContaining({
            status: "invalid_json"
        }));
    });
    it("records binary-safe metadata for declared image artifacts", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "screens/settings.png");
        const pngBytes = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x12, 0x16, 0xf1,
            0x4d
        ]);
        await mkdir(join(resolveExecutionArtifactsDirectory(executionDir), "screens"), { recursive: true });
        await writeFile(artifactPath, pngBytes);
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                declared_artifacts: {
                    screenshot: {
                        from: "output_dir",
                        path: "screens/settings.png",
                        description: "Rendered settings screenshot.",
                        content_type: "image/png"
                    }
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { screenshot: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("ready_for_verification");
        expect(packet.artifact_findings).toEqual([]);
        expect(packet.declared_artifacts[0]).toEqual(expect.objectContaining({
            name: "screenshot",
            status: "present",
            content_type: "image/png",
            detected_content_type: "image/png",
            media_kind: "image",
            encoding: "binary",
            size_bytes: pngBytes.byteLength,
            sha256: createHash("sha256").update(pngBytes).digest("hex"),
            preview: expect.objectContaining({
                kind: "image",
                width: 2,
                height: 3
            })
        }));
    });
    it("rejects authored content-type mismatches without decoding binary as text", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "screens/settings.png");
        const pngBytes = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
            0xde
        ]);
        await mkdir(join(resolveExecutionArtifactsDirectory(executionDir), "screens"), { recursive: true });
        await writeFile(artifactPath, pngBytes);
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                declared_artifacts: {
                    screenshot: {
                        from: "output_dir",
                        path: "screens/settings.png",
                        description: "Rendered settings screenshot.",
                        content_type: "application/pdf"
                    }
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { screenshot: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.artifact_findings).toEqual([
            expect.objectContaining({
                artifact: "screenshot",
                kind: "content_type_mismatch",
                summary: expect.stringContaining("application/pdf")
            })
        ]);
        expect(packet.declared_artifacts[0]).toEqual(expect.objectContaining({
            status: "content_type_mismatch",
            detected_content_type: "image/png",
            encoding: "binary"
        }));
    });
    it("rejects declared artifacts that include contract-forbidden exact content", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, [
            "Scenario: customer profile summary.",
            "Evidence: canonical facts only.",
            "Validation: focused validation passed.",
            "Risks: legacy-agentflow-detour was ignored.",
            "Completion: handoff written."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "Write the summary. Do not include `legacy-agentflow-detour`.",
                    acceptance_criteria: ["The handoff omits excluded material."],
                    constraints: []
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.artifact_findings).toEqual([
            expect.objectContaining({
                artifact: "implementation_summary",
                kind: "forbidden_content",
                summary: expect.stringContaining("legacy-agentflow-detour")
            })
        ]);
        expect(packet.declared_artifacts[0]).toEqual(expect.objectContaining({
            status: "forbidden_content"
        }));
    });
    it("rejects declared artifacts missing required exact content", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, [
            "Scenario: verifier guidance.",
            "Evidence: concrete path recorded.",
            "Validation: next validation step recorded.",
            "Risks: none identified.",
            "Completion: handoff written with an actionable retry path."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "Write a handoff that includes `actionable finding`, a concrete evidence path, and a next validation step.",
                    acceptance_criteria: ["The handoff is published."],
                    constraints: []
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.artifact_findings).toEqual([
            expect.objectContaining({
                artifact: "implementation_summary",
                kind: "missing_required_content",
                summary: expect.stringContaining("actionable finding")
            })
        ]);
        expect(packet.declared_artifacts[0]).toEqual(expect.objectContaining({
            status: "missing_required_content"
        }));
    });
    it("does not require implementation validation evidence for managed planning phases", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "work-list.json");
        await writeFile(artifactPath, `${JSON.stringify({
            planning_summary: "Plan the bounded task.",
            ordering_rationale: "One item is enough.",
            items: [{
                id: "w1",
                title: "Implement",
                goal: "Run the implementation item.",
                acceptance_criteria: ["Implementation evidence exists."],
                constraints: ["Stay scoped."],
                validation_expectations: ["Run npm test during item execution."],
                handoff_focus: ["Validation evidence."],
                rationale: "The planner delegates implementation validation."
            }]
        })}\n`, "utf8");
        await writeOrientInvocation(executionDir);
        await rm(join(runRoot, "runtime", "milestones", "exec__ship__attempt_1.json"), { force: true });
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                managed_runtime: {
                    kind: "pattern_work_list",
                    root_id: "work",
                    phase: "plan"
                },
                intent: {
                    goal: "Plan the work list. The downstream implementation must run `npm test`.",
                    acceptance_criteria: ["The planner publishes the machine-readable list."],
                    constraints: []
                },
                declared_artifacts: {
                    work_list_json: {
                        from: "output_dir",
                        path: "work-list.json",
                        description: "Machine-readable planned work-list items."
                    }
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { work_list_json: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("ready_for_verification");
        expect(packet.validation_evidence).toEqual([]);
        expect(packet.milestones.total).toBe(0);
    });
    it("treats active managed contract findings as completion blockers", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "item-result.json");
        await writeFile(artifactPath, "{\"id\":\"w1\",\"status\":\"completed\"}\n", "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                managed_runtime: {
                    kind: "pattern_work_list",
                    root_id: "work",
                    phase: "run_items"
                },
                declared_artifacts: {
                    item_result: {
                        from: "output_dir",
                        path: "item-result.json",
                        description: "Structured work-list item result."
                    }
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { item_result: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write",
            managed: {
                active: true,
                managed_kind: "pattern_work_list",
                ready_for_publish: false,
                contract_findings: [
                    {
                        managed_kind: "pattern_work_list",
                        phase: "item_publish",
                        item_id: "w1",
                        artifact_name: "item_result",
                        artifact_path: artifactPath,
                        failure_kind: "schema_mismatch",
                        message: "item-result.json is missing summary.",
                        expected: "Completed item results include a non-empty summary.",
                        retry_boundary: "current_item",
                        required_next_action: "Repair item-result.json for item w1.",
                        evidence_refs: [artifactPath]
                    }
                ],
                evidence_refs: [artifactPath]
            }
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.managed.contract_findings).toEqual([
            expect.objectContaining({
                phase: "item_publish",
                artifact_name: "item_result",
                failure_kind: "schema_mismatch"
            })
        ]);
        expect(packet.blocking_reasons.join("\n")).toContain("item-result.json is missing summary.");
    });
    it("does not treat runtime command references as required artifact content", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, [
            "Scenario: runtime artifact publishing.",
            "Evidence: the declared artifact was published.",
            "Validation: completion packet was built.",
            "Risks: none identified.",
            "Completion: handoff written."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "Publish the handoff with `af artifact write implementation_summary` and then run `af complete check`.",
                    acceptance_criteria: ["The handoff is published."],
                    constraints: []
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("ready_for_verification");
        expect(packet.artifact_findings).toEqual([]);
    });
    it("requires exact artifact content with punctuation without requiring the artifact path literal", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "handoff.md");
        await writeFile(artifactPath, [
            "Scenario: source edit skipped.",
            "Evidence: No source edit required.",
            "Validation: focused validation passed.",
            "Risks: none identified.",
            "Completion: handoff written."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                declared_artifacts: {
                    handoff: {
                        from: "output_dir",
                        path: "handoff.md",
                        description: "Publish `handoff.md` with `Evidence: no source edit required`."
                    }
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { handoff: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.artifact_findings).toEqual([
            expect.objectContaining({
                artifact: "handoff",
                kind: "missing_required_content",
                summary: expect.stringContaining("Evidence: no source edit required")
            })
        ]);
    });
    it("requires dotted pointer path literals from discovered-risk requirements", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, [
            "Scenario: stale context conflict.",
            "Evidence: context/runtime/stale_agentflow_noise/STALE_AGENTFLOW_SKILL.md is stale.",
            "Validation: focused validation passed.",
            "Risks: stale context was ignored.",
            "Completion: handoff written."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "Record the discovered risk that `docs/STALE_AGENTFLOW_SKILL.md` is stale and publish the handoff.",
                    acceptance_criteria: ["The handoff is published."],
                    constraints: []
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.artifact_findings).toEqual([
            expect.objectContaining({
                artifact: "implementation_summary",
                kind: "missing_required_content",
                summary: expect.stringContaining("docs/STALE_AGENTFLOW_SKILL.md")
            })
        ]);
    });
    it("does not require operational command literals from managed criteria text in artifacts", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "cycle-plan.md");
        await writeFile(artifactPath, [
            "Objective",
            "Plan another cycle.",
            "",
            "Validation plan",
            "Run the managed completion criteria after execution."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: [
                        "Prepare the next managed work cycle.",
                        "Completion Model:",
                        "- always_fail (required, weight 1): command `exit 1`"
                    ].join("\n"),
                    acceptance_criteria: ["The plan addresses failed managed criteria."],
                    constraints: []
                },
                declared_artifacts: {
                    cycle_plan: {
                        from: "output_dir",
                        path: "cycle-plan.md",
                        description: "Focused plan for the next deep work cycle."
                    }
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { cycle_plan: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("ready_for_verification");
        expect(packet.artifact_findings).toEqual([]);
    });
    it("does not require declared artifact filenames to appear in every artifact body", async () => {
        const artifactRoot = resolveExecutionArtifactsDirectory(executionDir);
        const notesPath = join(artifactRoot, "work-notes.md");
        const summaryPath = join(artifactRoot, "draft-summary.md");
        const packetPath = join(artifactRoot, "draft-packet.json");
        await writeFile(notesPath, "Changed nothing useful.\n", "utf8");
        await writeFile(summaryPath, "Draft summary.\n", "utf8");
        await writeFile(packetPath, "{\"status\":\"draft\"}\n", "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "Write `work-notes.md`, `draft-summary.md`, and `draft-packet.json` for this managed cycle.",
                    acceptance_criteria: ["The draft artifacts are published."],
                    constraints: []
                },
                declared_artifacts: {
                    work_notes: {
                        from: "output_dir",
                        path: "work-notes.md",
                        description: "Notes from the current deep work cycle."
                    },
                    draft_summary: {
                        from: "output_dir",
                        path: "draft-summary.md",
                        description: "Draft content for public artifact summary."
                    },
                    draft_packet: {
                        from: "output_dir",
                        path: "draft-packet.json",
                        description: "Draft content for public artifact packet."
                    }
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: {
                    work_notes: notesPath,
                    draft_summary: summaryPath,
                    draft_packet: packetPath
                }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("ready_for_verification");
        expect(packet.artifact_findings).toEqual([]);
    });
    it("does not treat required exact content as forbidden when the same sentence has a separate exclusion", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, [
            "Scenario: current-attempt",
            "Evidence: fresh handoff.",
            "Validation: focused validation passed.",
            "Risks: none identified.",
            "Completion: handoff written."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "The current declared artifact must say `current-attempt` and must not contain `STALE_PRIOR_ARTIFACT`.",
                    acceptance_criteria: ["The handoff satisfies both literal requirements."],
                    constraints: []
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.artifact_findings).toEqual([]);
        expect(packet.declared_artifacts[0]).toEqual(expect.objectContaining({
            status: "present"
        }));
    });
    it("rejects dangling validation commands and prospective completion text", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, [
            "Scenario: malformed handoff",
            "Evidence: context was inspected.",
            "Validation: Run \\ from the repository workspace.",
            "Risks: none recorded.",
            "Completion: ready once validation is recorded."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.artifact_findings).toEqual([
            expect.objectContaining({
                artifact: "implementation_summary",
                kind: "placeholder"
            })
        ]);
    });
    it("requires evidence for exact commands named in the node goal", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, [
            "Scenario: command evidence",
            "Evidence: artifact written.",
            "Validation: not recorded.",
            "Risks: none identified.",
            "Completion: handoff written."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "Run `prompt-validate --case progress` and publish the handoff.",
                    acceptance_criteria: ["The handoff is published."],
                    constraints: []
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.validation_evidence).toEqual([
            expect.objectContaining({
                requirement: "prompt-validate --case progress",
                status: "missing_evidence"
            })
        ]);
    });
    it("recognizes exact command validation evidence logged as structured data", async () => {
        await mkdir(join(runRoot, "runtime"), { recursive: true });
        await writeFile(join(runRoot, "runtime", "log.jsonl"), `${JSON.stringify({
            log_id: "log-command",
            execution_id: "exec__ship__attempt_1",
            type: "progress",
            summary: "Recorded fixture lookup validation.",
            evidence: [{
                    kind: "command_output",
                    summary: "Executed the required fixture lookup.",
                    data: {
                        command: "fixture-lookup --case overlap",
                        output: "selected=lookup-overlap-ok"
                    }
                }],
            created_at: "2026-05-03T12:01:00.000Z"
        })}\n`, "utf8");
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, [
            "Scenario: command evidence",
            "Evidence: fixture lookup succeeded.",
            "Validation: fixture lookup output recorded.",
            "Risks: none identified.",
            "Completion: handoff written."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "Run `fixture-lookup --case overlap` and publish the handoff.",
                    acceptance_criteria: ["The handoff is published."],
                    constraints: []
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("ready_for_verification");
        expect(packet.validation_evidence).toEqual([
            expect.objectContaining({
                requirement: "fixture-lookup --case overlap",
                status: "present",
                source: "runtime_log",
                evidence_ref: "log-command"
            })
        ]);
    });
    it("uses the active runtime dir for completion evidence when it differs from the run root", async () => {
        const runtimeDir = join(workspace, "runtime-overlay", "run-1", "exec-1", "runtime");
        await mkdir(runtimeDir, { recursive: true });
        await writeCompletedMilestone(runRoot, runtimeDir);
        await writeFile(join(runtimeDir, "log.jsonl"), `${JSON.stringify({
            log_id: "log-mirror-command",
            execution_id: "exec__ship__attempt_1",
            type: "progress",
            summary: "npm test passed.",
            evidence: [{
                    kind: "command_output",
                    ref: "npm test",
                    summary: "tests passed",
                    status: "passed"
                }],
            created_at: "2026-05-03T12:01:00.000Z"
        })}\n`, "utf8");
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, [
            "Scenario: mirrored runtime evidence",
            "Evidence: npm test passed.",
            "Validation: npm test passed.",
            "Risks: none identified.",
            "Completion: handoff written."
        ].join("\n"), "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "Publish the handoff.",
                    acceptance_criteria: ["`npm test` passes."],
                    constraints: []
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            runtimeDir,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("ready_for_verification");
        expect(packet.validation_evidence).toEqual([
            expect.objectContaining({
                requirement: "npm test",
                status: "present",
                source: "runtime_log",
                evidence_ref: "log-mirror-command"
            })
        ]);
        expect(packet.runtime_logs.progress).toBe(1);
    });
    it("distinguishes current-attempt artifacts from stale prior-attempt artifacts", async () => {
        const priorArtifactPath = join(tempRoot, "prior", "implementation-summary.md");
        await mkdir(join(tempRoot, "prior"), { recursive: true });
        await writeFile(priorArtifactPath, "prior handoff\n", "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir),
            priorAttempts: [
                makeAttempt(join(tempRoot, "prior-exec"), {
                    execution_id: "exec__ship__attempt_0",
                    attempt_index: 0,
                    status: "passed",
                    outcome: "passed",
                    artifacts: { implementation_summary: priorArtifactPath }
                })
            ],
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.artifact_findings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                artifact: "implementation_summary",
                kind: "stale_prior_attempt",
                summary: expect.stringContaining(join(tempRoot, "prior-exec")),
                evidence_ref: priorArtifactPath
            })
        ]));
        expect(packet.artifact_findings?.map((finding) => finding.summary).join("\n")).not.toContain("exec__ship__attempt_0");
    });
    it("requires validation evidence only for unambiguous literal commands", async () => {
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, "real handoff\n", "utf8");
        const broadPacket = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "Ship the implementation.",
                    acceptance_criteria: ["Tests pass.", "Reviewer guide explains risk."],
                    constraints: []
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(broadPacket.completion_status).toBe("ready_for_verification");
        expect(broadPacket.validation_evidence).toEqual([]);
        const literalPacket = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "Ship the implementation.",
                    acceptance_criteria: ["`npm test` exits successfully."],
                    constraints: []
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(literalPacket.completion_status).toBe("incomplete");
        expect(literalPacket.validation_evidence).toEqual([
            expect.objectContaining({
                requirement: "npm test",
                status: "missing_evidence"
            })
        ]);
        await writeFile(artifactPath, [
            "Scenario: verifier ambiguity.",
            "Evidence: captured node evidence passed.",
            "Validation: no command required.",
            "Risks: none identified.",
            "Completion: non-blocker ambiguity does not contradict the authored contract."
        ].join("\n"), "utf8");
        const phrasePacket = await buildCompletionPacket({
            runRoot,
            node: makeNode({
                intent: {
                    goal: "Write the handoff with `captured node evidence passed` and explain why it does not contradict the authored contract.",
                    acceptance_criteria: ["The handoff is published."],
                    constraints: []
                }
            }),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(phrasePacket.completion_status).toBe("ready_for_verification");
        expect(phrasePacket.validation_evidence).toEqual([]);
    });
    it("treats active blocking findings as blocked completion evidence", async () => {
        await mkdir(join(runRoot, "runtime"), { recursive: true });
        await writeFile(join(runRoot, "runtime", "log.jsonl"), `${JSON.stringify({
            log_id: "log-1",
            execution_id: "exec__ship__attempt_1",
            type: "finding",
            finding_kind: "blocker",
            blocking: true,
            summary: "External worker is unavailable.",
            evidence: [{ kind: "external_state", ref: "worker", summary: "worker offline" }],
            created_at: "2026-05-03T12:01:00.000Z"
        })}\n`, "utf8");
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, "real handoff\n", "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.active_blockers).toHaveLength(1);
        expect(packet.blocking_reasons).toContain("External worker is unavailable.");
    });
    it("does not count non-terminal spawned helpers as completion evidence", async () => {
        await mkdir(join(runRoot, "runtime", "helpers", "helper_pending"), { recursive: true });
        await writeFile(join(runRoot, "runtime", "helpers", "helper_pending", "session.json"), `${JSON.stringify({
            agent_id: "helper_pending",
            parent_agent_id: "exec__ship__attempt_1",
            run_id: "run-test",
            status: "running",
            purpose: "verification",
            brief: "Verify the implementation.",
            output_dir: join(runRoot, "runtime", "helpers", "helper_pending", "artifacts"),
            log_path: join(runRoot, "runtime", "helpers", "helper_pending", "logs", "harness.log"),
            result_path: join(runRoot, "runtime", "helpers", "helper_pending", "result.json"),
            artifacts: {
                "helper-report.md": join(runRoot, "runtime", "helpers", "helper_pending", "artifacts", "helper-report.md")
            },
            created_at: "2026-05-03T12:01:00.000Z"
        }, null, 2)}\n`, "utf8");
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, "real handoff\n", "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.helpers).toEqual(expect.objectContaining({
            active: 1,
            pending: 1,
            completed: 0,
            missing_artifacts: ["helper_pending:helper-report.md"]
        }));
        expect(packet.blocking_reasons).toContain("Helper helper_pending is running and has not produced required evidence.");
    });
    it("folds completed helper artifacts into completion packets", async () => {
        const helperRoot = join(runRoot, "runtime", "helpers", "helper_done");
        const helperArtifact = join(helperRoot, "artifacts", "helper-report.md");
        await mkdir(join(helperRoot, "artifacts"), { recursive: true });
        await writeFile(helperArtifact, "helper verification passed\n", "utf8");
        await writeFile(join(helperRoot, "session.json"), `${JSON.stringify({
            agent_id: "helper_done",
            parent_agent_id: "exec__ship__attempt_1",
            run_id: "run-test",
            status: "completed",
            purpose: "verification",
            brief: "Verify the implementation.",
            output_dir: join(helperRoot, "artifacts"),
            log_path: join(helperRoot, "logs", "harness.log"),
            result_path: join(helperRoot, "result.json"),
            artifacts: {
                "helper-report.md": helperArtifact
            },
            created_at: "2026-05-03T12:01:00.000Z",
            ended_at: "2026-05-03T12:02:00.000Z",
            exit_code: 0
        }, null, 2)}\n`, "utf8");
        const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
        await writeFile(artifactPath, "real handoff\n", "utf8");
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir, {
                artifacts: { implementation_summary: artifactPath }
            }),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        expect(packet.completion_status).toBe("ready_for_verification");
        expect(packet.helpers).toEqual(expect.objectContaining({
            active: 1,
            completed: 1,
            pending: 0,
            failed: 0,
            missing_artifacts: []
        }));
        expect(packet.helpers.latest[0]).toEqual(expect.objectContaining({
            agent_id: "helper_done",
            purpose: "verification",
            status: "completed",
            artifact_refs: [helperArtifact]
        }));
    });
    it("builds compact projections without raw logs or artifact bodies", async () => {
        const packet = await buildCompletionPacket({
            runRoot,
            node: makeNode(),
            attempt: makeAttempt(executionDir),
            workspacePath: workspace,
            sandbox: "workspace-write"
        });
        const projection = buildCompletionProjection(packet, { maxItems: 2 });
        expect(projection).toEqual(expect.objectContaining({
            completion_status: "incomplete",
            blocking_reasons: expect.arrayContaining([
                expect.stringContaining("Missing expected artifact")
            ]),
            packet_path: packet.packet_path
        }));
        expect(JSON.stringify(projection)).not.toContain("TODO");
        expect(JSON.stringify(projection)).not.toContain("runtime_logs_raw");
    });
});
