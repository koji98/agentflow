import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CompiledGraph } from "../../src/graph/compiled.js";
import { writeDeliveryPackage, type DeliveryPackageManifest } from "../../src/runtime/delivery/package.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { RuntimeEventEnvelope } from "../../src/runtime/events.js";
import type { RuntimeStateSnapshot } from "../../src/runtime/session.js";
import type { SupervisorInterventionRecord } from "../../src/supervisor/types.js";

const basePolicy = {
    profile_name: "default",
    workspace_backend: "inplace",
    harness: "codex-cli",
    sandbox: "workspace-write",
    timeout_sec: 1800,
    artifact_repair: {
        max_attempts: 1
    }
} as const;

const agentNode = {
    compiled_id: "root__implement",
    authored_id: "implement",
    kind: "agent",
    repo: "main",
    deps: [],
    scope_stack: ["root"],
    effective_policy: basePolicy,
    context: [],
    declared_artifacts: {
        handoff: {
            from: "output_dir",
            path: "handoff.md",
            description: "Human reviewer handoff produced by the implement node."
        }
    },
    intent: {
        goal: "Implement checkout timeout handling.",
        acceptance_criteria: ["The node satisfies its acceptance criteria."],
        constraints: []
    },
    tools: [],
    skills: [],
    cli: []
} as const;

const checkNode = {
    compiled_id: "root__handoff_review",
    authored_id: "handoff_review",
    kind: "check",
    repo: "main",
    deps: [],
    scope_stack: ["root"],
    effective_policy: basePolicy,
    context: [],
    declared_artifacts: {},
    intent: {
        goal: "Review the handoff.",
        acceptance_criteria: ["The handoff passes review."],
        constraints: []
    },
    check_kind: "deterministic",
    command: "true",
    args: [],
    on_failure: "fail",
    skills: [],
    cli: []
} as const;

const graph: CompiledGraph = {
    graph_id: "delivery-test",
    intent: {
        goal: "Ship a trustworthy checkout change.",
        constraints: ["Do not change provider credentials."],
        acceptance_criteria: ["Tests pass.", "Review brief names risk."]
    },
    supervision: { profile: "supervisor", max_total_interventions: 2 },
    launch: {
        launch_profile: "default",
        workspace_backend: "inplace"
    },
    entry_node_ids: ["root__implement"],
    nodes: [agentNode],
    edges: [],
    scopes: [],
    authored_to_compiled: {
        implement: ["root__implement"]
    }
};

const checkGraph: CompiledGraph = {
    ...graph,
    entry_node_ids: ["root__handoff_review"],
    nodes: [checkNode],
    authored_to_compiled: {
        handoff_review: ["root__handoff_review"]
    }
};

function baseState(overrides: Partial<RuntimeStateSnapshot> = {}): RuntimeStateSnapshot {
    return {
        run_id: "run-1",
        graph_id: "delivery-test",
        snapshot_seq: 1,
        status: "passed",
        evidence_status: "clean",
        workspace_backend: "inplace",
        repo_workspaces: {},
        workspace_change_artifacts: {},
        counts: {
            total: 1,
            pending: 0,
            ready: 0,
            running: 0,
            passed: 1,
            failed: 0,
            blocked: 0,
            canceled: 0,
            skipped: 0
        },
        soft_verification_counts: {
            passed: 0,
            failed: 0
        },
        failed_soft_verifications: [],
        supervisor: {
            status: "healthy",
            intervention_count: 0,
            budget_remaining: {
                max_total_interventions: 2
            },
            timeline: [],
            escalations: []
        },
        node_statuses: {},
        active_executions: {},
        latest_execution_by_compiled_id: {},
        repeat_scopes: {},
        started_at: "2026-04-24T00:00:00.000Z",
        ended_at: "2026-04-24T00:00:01.000Z",
        ...overrides
    };
}

async function writeRunScaffold(runRoot: string): Promise<void> {
    await writeFile(join(runRoot, "interventions.jsonl"), "", "utf8");
    await mkdir(join(runRoot, "runtime", "milestones"), { recursive: true });
    await writeFile(join(runRoot, "supervisor-timeline.jsonl"), "", "utf8");
    await writeFile(join(runRoot, "runtime", "log.jsonl"), "", "utf8");
    await writeFile(join(runRoot, "compile_diagnostics.json"), "[]\n", "utf8");
}

async function readJson<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("delivery package", () => {
    it("writes the human-first delivery structure without old top-level files", async () => {
        const runRoot = await mkdtemp(join(tmpdir(), "agentflow-delivery-"));
        const executionDir = join(runRoot, "nodes", "001-implement", "executions", "001-exec");
        const artifactDir = join(executionDir, "artifacts");
        const logsDir = join(executionDir, "logs");
        await mkdir(artifactDir, { recursive: true });
        await mkdir(logsDir, { recursive: true });
        await writeRunScaffold(runRoot);

        const responsePath = join(artifactDir, "agent-response.md");
        const handoffPath = join(artifactDir, "handoff.md");
        const stdoutPath = join(logsDir, "stdout.log");
        const stderrPath = join(logsDir, "stderr.log");
        await writeFile(responsePath, "Implemented checkout timeout handling.\n", "utf8");
        await writeFile(handoffPath, "Reviewer handoff with validation evidence.\n", "utf8");
        await writeFile(stdoutPath, "agent stdout\n", "utf8");
        await writeFile(stderrPath, "", "utf8");
        await writeFile(join(runRoot, "runtime", "milestones", "exec-1.json"), `${JSON.stringify({
            version: "1",
            execution_id: "exec-1",
            milestones: [{
                id: "m1",
                execution_id: "exec-1",
                title: "Validate checkout",
                goal: "Prove checkout timeout handling is ready for review.",
                status: "completed",
                logs: [{
                    log_id: "l1",
                    kind: "validation",
                    command: "npm test",
                    result: "pass",
                    summary: "Tests passed.",
                    created_at: "2026-04-24T00:00:00.500Z"
                }],
                completion_evidence: "Validation passed and handoff was written.",
                created_at: "2026-04-24T00:00:00.000Z",
                updated_at: "2026-04-24T00:00:01.000Z",
                completed_at: "2026-04-24T00:00:01.000Z"
            }]
        }, null, 2)}\n`, "utf8");

        const attempts: RuntimeNodeAttempt[] = [
            {
                execution_id: "exec-1",
                compiled_id: "root__implement",
                authored_id: "implement",
                kind: "agent",
                repo_alias: "main",
                execution_dir: executionDir,
                attempt_index: 1,
                status: "passed",
                outcome: "passed",
                started_at: "2026-04-24T00:00:00.000Z",
                ended_at: "2026-04-24T00:00:01.000Z",
                duration_ms: 1000,
                stdout_log_path: stdoutPath,
                stderr_log_path: stderrPath,
                artifacts: {
                    agent_response: responsePath,
                    handoff: handoffPath
                },
                metadata: {}
            }
        ];
        const events: RuntimeEventEnvelope[] = [];
        const interventions: SupervisorInterventionRecord[] = [];
        const manifest = await writeDeliveryPackage({
            run_root: runRoot,
            graph,
            state: baseState({
                node_statuses: { root__implement: "passed" },
                latest_execution_by_compiled_id: {
                    root__implement: {
                        execution_id: "exec-1",
                        compiled_id: "root__implement",
                        authored_id: "implement",
                        kind: "agent",
                        status: "passed",
                        attempt_index: 1,
                        started_at: "2026-04-24T00:00:00.000Z",
                        ended_at: "2026-04-24T00:00:01.000Z"
                    }
                }
            }),
            attempts,
            events,
            interventions
        });

        expect(Object.keys(manifest.sections).sort()).toEqual([
            "artifact_index",
            "audit_index",
            "change_map",
            "decision_log",
            "intervention_trace",
            "milestones",
            "review_brief",
            "run_learnings",
            "validation_ledger",
            "workspace_improvements"
        ]);
        expect(manifest.human_entrypoints).toEqual({
            review_brief: join(runRoot, "delivery", "01-review-brief.md"),
            run_learnings: join(runRoot, "delivery", "02-run-learnings.md"),
            audit_index: join(runRoot, "delivery", "03-audit-index.md")
        });
        expect(manifest.evidence_files).toEqual(expect.objectContaining({
            artifact_index: join(runRoot, "delivery", "evidence", "artifact-index.json"),
            change_map: join(runRoot, "delivery", "evidence", "change-map.json"),
            validation_ledger: join(runRoot, "delivery", "evidence", "validation-ledger.json"),
            decision_log: join(runRoot, "delivery", "evidence", "decision-log.md"),
            intervention_trace: join(runRoot, "delivery", "evidence", "intervention-trace.json"),
            milestones: join(runRoot, "delivery", "evidence", "milestones.json"),
            workspace_improvements: join(runRoot, "delivery", "evidence", "workspace-improvements.json")
        }));
        expect(manifest.artifact_counts.final_declared_artifacts).toBe(1);
        expect(manifest.artifact_counts.superseded_declared_artifacts).toBe(0);
        expect(manifest.active_failure_count).toBe(0);
        expect(manifest.recovered_issue_count).toBe(0);

        const deliveryEntries = (await readdir(join(runRoot, "delivery"))).sort();
        expect(deliveryEntries).toEqual(["01-review-brief.md", "02-run-learnings.md", "03-audit-index.md", "evidence", "manifest.json"]);
        const reviewBrief = await readFile(join(runRoot, "delivery", "01-review-brief.md"), "utf8");
        expect(reviewBrief).toContain("# Review Brief");
        expect(reviewBrief).toContain("Final Declared Artifacts");
        expect(reviewBrief).toContain("npm test");
        expect(reviewBrief).toContain("../nodes/001-implement/executions/001-exec/artifacts/handoff.md");
        expect(reviewBrief).not.toContain(runRoot);
        await expect(readFile(join(runRoot, "delivery", "evidence", "artifact-index.json"), "utf8")).resolves.toContain('"final_declared_artifacts"');
        await expect(readFile(join(runRoot, "delivery", "evidence", "validation-ledger.json"), "utf8")).resolves.toContain('"milestone_validation_logs"');
        expect(manifest.artifact_taxonomy.declared_artifacts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                label: "implement.handoff",
                path: handoffPath
            })
        ]));
    });

    it("treats failed prior attempts as recovered issues when the final attempt passed", async () => {
        const runRoot = await mkdtemp(join(tmpdir(), "agentflow-delivery-recovered-"));
        await writeRunScaffold(runRoot);
        const attempts: RuntimeNodeAttempt[] = [
            {
                execution_id: "exec-check-1",
                compiled_id: "root__handoff_review",
                authored_id: "handoff_review",
                kind: "check",
                repo_alias: "main",
                execution_dir: join(runRoot, "nodes", "001-check", "executions", "001-exec"),
                attempt_index: 1,
                status: "failed",
                outcome: "failed",
                started_at: "2026-04-24T00:00:00.000Z",
                ended_at: "2026-04-24T00:00:01.000Z",
                artifacts: {},
                metadata: {
                    verification: {
                        passed: false,
                        summary: "Check failed because the first handoff missed validation evidence."
                    }
                }
            },
            {
                execution_id: "exec-check-2",
                compiled_id: "root__handoff_review",
                authored_id: "handoff_review",
                kind: "check",
                repo_alias: "main",
                execution_dir: join(runRoot, "nodes", "001-check", "executions", "002-exec"),
                attempt_index: 2,
                status: "passed",
                outcome: "passed",
                started_at: "2026-04-24T00:00:02.000Z",
                ended_at: "2026-04-24T00:00:03.000Z",
                artifacts: {},
                metadata: {}
            }
        ];

        const manifest = await writeDeliveryPackage({
            run_root: runRoot,
            graph: checkGraph,
            state: baseState({
                node_statuses: { root__handoff_review: "passed" },
                latest_execution_by_compiled_id: {
                    root__handoff_review: {
                        execution_id: "exec-check-2",
                        compiled_id: "root__handoff_review",
                        authored_id: "handoff_review",
                        kind: "check",
                        status: "passed",
                        attempt_index: 2,
                        started_at: "2026-04-24T00:00:02.000Z",
                        ended_at: "2026-04-24T00:00:03.000Z"
                    }
                }
            }),
            attempts,
            events: [],
            interventions: []
        });

        expect(manifest.active_failure_count).toBe(0);
        expect(manifest.recovered_issue_count).toBe(1);
        const reviewBrief = await readFile(join(runRoot, "delivery", "01-review-brief.md"), "utf8");
        expect(reviewBrief).toContain("No active failed node attempts remain.");
        expect(reviewBrief).toContain("Recovered Issues");
        expect(reviewBrief).toContain("first handoff missed validation evidence");
        const validationLedger = await readJson<{
            active_failures: unknown[];
            recovered_issues: unknown[];
        }>(join(runRoot, "delivery", "evidence", "validation-ledger.json"));
        expect(validationLedger.active_failures).toEqual([]);
        expect(validationLedger.recovered_issues).toHaveLength(1);
    });

    it("keeps final failed attempts as active risks", async () => {
        const runRoot = await mkdtemp(join(tmpdir(), "agentflow-delivery-active-"));
        await writeRunScaffold(runRoot);
        const attempts: RuntimeNodeAttempt[] = [
            {
                execution_id: "exec-check-1",
                compiled_id: "root__handoff_review",
                authored_id: "handoff_review",
                kind: "check",
                repo_alias: "main",
                execution_dir: join(runRoot, "nodes", "001-check", "executions", "001-exec"),
                attempt_index: 1,
                status: "failed",
                outcome: "failed",
                started_at: "2026-04-24T00:00:00.000Z",
                ended_at: "2026-04-24T00:00:01.000Z",
                artifacts: {},
                metadata: {
                    verification: {
                        passed: false,
                        summary: "Check failed because required evidence is still missing."
                    }
                }
            }
        ];

        const manifest = await writeDeliveryPackage({
            run_root: runRoot,
            graph: checkGraph,
            state: baseState({
                status: "failed",
                evidence_status: "warnings",
                counts: {
                    total: 1,
                    pending: 0,
                    ready: 0,
                    running: 0,
                    passed: 0,
                    failed: 1,
                    blocked: 0,
                    canceled: 0,
                    skipped: 0
                },
                node_statuses: { root__handoff_review: "failed" },
                latest_execution_by_compiled_id: {
                    root__handoff_review: {
                        execution_id: "exec-check-1",
                        compiled_id: "root__handoff_review",
                        authored_id: "handoff_review",
                        kind: "check",
                        status: "failed",
                        attempt_index: 1,
                        started_at: "2026-04-24T00:00:00.000Z",
                        ended_at: "2026-04-24T00:00:01.000Z"
                    }
                }
            }),
            attempts,
            events: [],
            interventions: []
        });

        expect(manifest.active_failure_count).toBe(1);
        expect(manifest.recovered_issue_count).toBe(0);
        const reviewBrief = await readFile(join(runRoot, "delivery", "01-review-brief.md"), "utf8");
        expect(reviewBrief).toContain("Active Risks And Follow-ups");
        expect(reviewBrief).toContain("required evidence is still missing");
        const validationLedger = await readJson<{
            active_failures: unknown[];
            recovered_issues: unknown[];
        }>(join(runRoot, "delivery", "evidence", "validation-ledger.json"));
        expect(validationLedger.active_failures).toHaveLength(1);
        expect(validationLedger.recovered_issues).toEqual([]);
    });
});
