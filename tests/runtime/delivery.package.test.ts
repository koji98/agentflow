import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CompiledGraph } from "../../src/graph/compiled.js";
import { writeDeliveryPackage, type DeliveryPackageManifest } from "../../src/runtime/delivery/package.js";
import type { DeliveryCurator } from "../../src/runtime/delivery/curation.js";
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
        graph_status: "passed",
        delivery_status: "pending",
        review_ready: false,
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

function buildPassingCurator(): DeliveryCurator {
    return {
        async curate(input) {
            const artifact = input.source.final_declared_artifacts[0];
            const validation = input.source.validation.milestone_validation_logs[0];
            const reviewBrief = [
                "# Review Brief",
                "",
                "## Outcome",
                "",
                `Run \`${input.source.run.run_id}\` ended with status \`${input.source.run.status}\`.`,
                "",
                "## Reviewer Decision",
                "",
                "Review the final artifacts and validation evidence before merging.",
                "",
                "## What To Inspect First",
                "",
                "- [Change map](evidence/change-map.json)",
                "- [Validation ledger](evidence/validation-ledger.json)",
                "",
                "## Success Contract",
                "",
                input.source.intent.goal,
                "",
                "## Changed Files",
                "",
                "- [Change map](evidence/change-map.json)",
                "",
                "## Final Declared Artifacts",
                "",
                artifact
                    ? `- \`${artifact.id}\`: [${artifact.declared_path}](${artifact.relative_path})`
                    : "- No final declared artifacts were captured.",
                "",
                "## Validation Evidence",
                "",
                validation
                    ? `- \`${validation.result}\` \`${validation.command}\`: ${validation.summary}`
                    : "- [Validation ledger](evidence/validation-ledger.json)",
                "",
                "## Active Failures And Risks",
                "",
                input.source.failures.active.length > 0
                    ? input.source.failures.active.map((failure) => `- \`${failure.node}\`: ${failure.summary}`).join("\n")
                    : "- No active failures remain.",
                "",
                "## Recovered Issues",
                "",
                input.source.failures.recovered.length > 0
                    ? input.source.failures.recovered.map((failure) => `- \`${failure.node}\`: ${failure.summary}`).join("\n")
                    : "- No recovered issues were recorded.",
                "",
                "## Historical Attempts",
                "",
                input.source.failures.historical.length > 0
                    ? input.source.failures.historical.map((attempt) => `- \`${attempt.node}\`: ${attempt.summary}`).join("\n")
                    : "- No historical attempts require reviewer action.",
                "",
                "## Supervisor And Human Interventions",
                "",
                input.source.interventions.length > 0
                    ? input.source.interventions.map((intervention) => `- \`${intervention.action}\`: ${intervention.reason}`).join("\n")
                    : "- No supervisor or human interventions were recorded.",
                "",
                "## Supporting Evidence",
                "",
                "- [Run learnings](02-run-learnings.md)",
                "- [Audit index](03-audit-index.md)",
                "- [Delivery source](evidence/delivery-source.md)"
            ].join("\n");
            const runLearnings = [
                "# Run Learnings",
                "",
                "## Where Agents Struggled",
                "",
                input.source.failures.recovered.length > 0
                    ? input.source.failures.recovered.map((failure) => `- \`${failure.node}\`: ${failure.summary}`).join("\n")
                    : "- No concrete agent struggle was inferred.",
                "",
                "## Workspace Improvements",
                "",
                "| Area | Recommendation | Evidence | Priority | Confidence | Done When |",
                "| --- | --- | --- | --- | --- | --- |",
                ...input.source.workspace_improvements.map((entry) =>
                    `| ${entry.area} | ${entry.recommendation} | ${entry.evidence} | ${entry.priority} | ${entry.confidence} | ${entry.done_when} |`
                ),
                "",
                "## Graph Prompt And Support Improvements",
                "",
                "- Keep graph context pointer-only and validate delivery with [curation verdict](evidence/curation-verdict.json).",
                "",
                "## Plugin Skill And Eval Opportunities",
                "",
                "- Add evals for any recovered issue that should not repeat.",
                "",
                "## What Worked",
                "",
                "- Deterministic evidence remained available in [audit index](03-audit-index.md).",
                "",
                "## Evidence Links",
                "",
                "- [Validation ledger](evidence/validation-ledger.json)",
                "- [Milestones](evidence/milestones.json)"
            ].join("\n");

            return {
                review_brief_markdown: reviewBrief,
                run_learnings_markdown: runLearnings,
                metadata: { test_curator: true }
            };
        }
    };
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
            interventions,
            curator: buildPassingCurator()
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
            workspace_improvements: join(runRoot, "delivery", "evidence", "workspace-improvements.json"),
            delivery_source: join(runRoot, "delivery", "evidence", "delivery-source.json"),
            curation_verdict: join(runRoot, "delivery", "evidence", "curation-verdict.json")
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
        expect(reviewBrief).not.toContain("human-debug");
        const deliverySourceMarkdown = await readFile(join(runRoot, "delivery", "evidence", "delivery-source.md"), "utf8");
        expect(deliverySourceMarkdown).toContain("# Delivery Source");
        expect(deliverySourceMarkdown).toContain("[attempt](../nodes/001-implement/executions/001-exec)");
        const deliverySource = await readJson<{
            validation: {
                milestone_validation_logs: Array<{ attempt_path?: string; attempt_relative_path?: string }>;
                outcome_verifications: Array<{ attempt_path?: string; attempt_relative_path?: string }>;
            };
        }>(join(runRoot, "delivery", "evidence", "delivery-source.json"));
        expect(deliverySource.validation.milestone_validation_logs[0]).toEqual(expect.objectContaining({
            attempt_path: executionDir,
            attempt_relative_path: "../nodes/001-implement/executions/001-exec"
        }));
        const verdict = await readJson<{ passed: boolean }>(join(runRoot, "delivery", "evidence", "curation-verdict.json"));
        expect(verdict.passed).toBe(true);
        await expect(readFile(join(runRoot, "delivery", "evidence", "artifact-index.json"), "utf8")).resolves.toContain('"final_declared_artifacts"');
        await expect(readFile(join(runRoot, "delivery", "evidence", "validation-ledger.json"), "utf8")).resolves.toContain('"milestone_validation_logs"');
        expect(manifest.artifact_taxonomy.declared_artifacts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                label: "implement.handoff",
                path: handoffPath
            })
        ]));
    });
    it("records binary declared artifact metadata in delivery evidence without reading it as text", async () => {
        const runRoot = await mkdtemp(join(tmpdir(), "agentflow-delivery-binary-"));
        const executionDir = join(runRoot, "nodes", "001-capture", "executions", "001-exec");
        const artifactDir = join(executionDir, "artifacts", "screens");
        await mkdir(artifactDir, { recursive: true });
        await writeRunScaffold(runRoot);

        const screenshotPath = join(artifactDir, "settings.png");
        const pngBytes = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x12, 0x16, 0xf1,
            0x4d
        ]);
        await writeFile(screenshotPath, pngBytes);

        const binaryNode = {
            ...agentNode,
            declared_artifacts: {
                screenshot: {
                    from: "output_dir",
                    path: "screens/settings.png",
                    description: "Rendered settings screenshot.",
                    content_type: "image/png"
                }
            }
        } as const;
        const binaryGraph: CompiledGraph = {
            ...graph,
            nodes: [binaryNode]
        };
        const attempts: RuntimeNodeAttempt[] = [{
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
            artifacts: {
                screenshot: screenshotPath
            },
            metadata: {}
        }];

        await writeDeliveryPackage({
            run_root: runRoot,
            graph: binaryGraph,
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
            events: [],
            interventions: [],
            curator: buildPassingCurator()
        });

        const source = await readJson<{
            final_declared_artifacts: Array<{
                content?: string;
                content_type?: string;
                detected_content_type?: string;
                media_kind?: string;
                encoding?: string;
                sha256?: string;
                preview?: { kind: string; width?: number; height?: number };
            }>;
        }>(join(runRoot, "delivery", "evidence", "delivery-source.json"));
        expect(source.final_declared_artifacts[0]).toEqual(expect.objectContaining({
            content_type: "image/png",
            detected_content_type: "image/png",
            media_kind: "image",
            encoding: "binary",
            sha256: expect.any(String),
            preview: expect.objectContaining({
                kind: "image",
                width: 2,
                height: 3
            })
        }));
        expect(source.final_declared_artifacts[0]?.content).toBeUndefined();
        await expect(readFile(join(runRoot, "delivery", "evidence", "artifact-index.json"), "utf8"))
            .resolves.toContain('"media_kind": "image"');
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
            interventions: [],
            curator: buildPassingCurator()
        });

        expect(manifest.active_failure_count).toBe(0);
        expect(manifest.recovered_issue_count).toBe(1);
        const reviewBrief = await readFile(join(runRoot, "delivery", "01-review-brief.md"), "utf8");
        expect(reviewBrief).toContain("No active failures remain.");
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
            interventions: [],
            curator: buildPassingCurator()
        });

        expect(manifest.active_failure_count).toBe(1);
        expect(manifest.recovered_issue_count).toBe(0);
        const reviewBrief = await readFile(join(runRoot, "delivery", "01-review-brief.md"), "utf8");
        expect(reviewBrief).toContain("Active Failures And Risks");
        expect(reviewBrief).toContain("required evidence is still missing");
        const validationLedger = await readJson<{
            active_failures: unknown[];
            recovered_issues: unknown[];
        }>(join(runRoot, "delivery", "evidence", "validation-ledger.json"));
        expect(validationLedger.active_failures).toHaveLength(1);
        expect(validationLedger.recovered_issues).toEqual([]);
    });

    it("falls back to deterministic delivery when curated review hides an active failure", async () => {
        const runRoot = await mkdtemp(join(tmpdir(), "agentflow-delivery-curation-fail-"));
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
        let calls = 0;
        const curator: DeliveryCurator = {
            async curate(input) {
                calls += 1;
                if (calls === 2) {
                    expect(input.previous_verdict?.passed).toBe(false);
                    expect(input.previous_verdict?.findings).toEqual(expect.arrayContaining([
                        expect.objectContaining({ kind: "missing_active_failure" })
                    ]));
                }
                return {
                    review_brief_markdown: [
                        "# Review Brief",
                        "## Outcome",
                        "Everything passed.",
                        "## Reviewer Decision",
                        "Merge.",
                        "## What To Inspect First",
                        "- [Audit index](03-audit-index.md)",
                        "## Success Contract",
                        "Review the handoff.",
                        "## Changed Files",
                        "- [Change map](evidence/change-map.json)",
                        "## Final Declared Artifacts",
                        "- None.",
                        "## Validation Evidence",
                        "- [Validation ledger](evidence/validation-ledger.json)",
                        "## Active Failures And Risks",
                        "- No active failures remain.",
                        "## Recovered Issues",
                        "- No recovered issues.",
                        "## Historical Attempts",
                        "- None.",
                        "## Supervisor And Human Interventions",
                        "- None.",
                        "## Supporting Evidence",
                        "- [Run learnings](02-run-learnings.md)"
                    ].join("\n"),
                    run_learnings_markdown: [
                        "# Run Learnings",
                        "## Where Agents Struggled",
                        "- None.",
                        "## Workspace Improvements",
                        "| Area | Recommendation | Evidence | Priority | Confidence | Done When |",
                        "| --- | --- | --- | --- | --- | --- |",
                        "| none | No action. | none | low | low | done |",
                        "## Graph Prompt And Support Improvements",
                        "- None.",
                        "## Plugin Skill And Eval Opportunities",
                        "- None.",
                        "## What Worked",
                        "- Everything.",
                        "## Evidence Links",
                        "- [Validation ledger](evidence/validation-ledger.json)"
                    ].join("\n")
                };
            }
        };

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
            interventions: [],
            curator,
            curation_retry_backoff_ms: 0
        });
        expect(calls).toBe(2);
        expect(manifest.curation.status).toBe("passed");
        expect(manifest.curation.fallback_reason).toContain("missing_active_failure");
        const verdict = await readJson<{ passed: boolean; findings: Array<{ kind: string }> }>(
            join(runRoot, "delivery", "evidence", "curation-verdict.json")
        );
        expect(verdict.passed).toBe(true);
        expect(verdict.findings).toEqual([]);
        const writtenManifest = await readJson<{ delivery_status: string; review_ready: boolean }>(
            join(runRoot, "delivery", "manifest.json")
        );
        expect(writtenManifest).toEqual(expect.objectContaining({
            delivery_status: "passed",
            review_ready: true
        }));
        const reviewBrief = await readFile(join(runRoot, "delivery", "01-review-brief.md"), "utf8");
        expect(reviewBrief).toContain("Deterministic delivery fallback was used");
        expect(reviewBrief).toContain("Graph status: `failed`");
        expect(reviewBrief).toContain("required evidence is still missing");
    });

    it("retries curation once with verifier findings before accepting delivery", async () => {
        const runRoot = await mkdtemp(join(tmpdir(), "agentflow-delivery-curation-retry-"));
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
        const passingCurator = buildPassingCurator();
        let calls = 0;
        const curator: DeliveryCurator = {
            async curate(input) {
                calls += 1;
                if (calls === 1) {
                    return {
                        review_brief_markdown: [
                            "# Review Brief",
                            "## Outcome",
                            "Everything passed.",
                            "## Reviewer Decision",
                            "Merge.",
                            "## What To Inspect First",
                            "- [Audit index](03-audit-index.md)",
                            "## Success Contract",
                            "Review the handoff.",
                            "## Changed Files",
                            "- [Change map](evidence/change-map.json)",
                            "## Final Declared Artifacts",
                            "- None.",
                            "## Validation Evidence",
                            "- [Validation ledger](evidence/validation-ledger.json)",
                            "## Active Failures And Risks",
                            "- No active failures remain.",
                            "## Recovered Issues",
                            "- No recovered issues.",
                            "## Historical Attempts",
                            "- None.",
                            "## Supervisor And Human Interventions",
                            "- None.",
                            "## Supporting Evidence",
                            "- [Run learnings](02-run-learnings.md)"
                        ].join("\n"),
                        run_learnings_markdown: [
                            "# Run Learnings",
                            "## Where Agents Struggled",
                            "- None.",
                            "## Workspace Improvements",
                            "| Area | Recommendation | Evidence | Priority | Confidence | Done When |",
                            "| --- | --- | --- | --- | --- | --- |",
                            "| none | No action. | none | low | low | done |",
                            "## Graph Prompt And Support Improvements",
                            "- None.",
                            "## Plugin Skill And Eval Opportunities",
                            "- None.",
                            "## What Worked",
                            "- Everything.",
                            "## Evidence Links",
                            "- [Validation ledger](evidence/validation-ledger.json)"
                        ].join("\n")
                    };
                }
                expect(input.curation_attempt).toBe(2);
                expect(input.previous_verdict?.passed).toBe(false);
                expect(input.previous_verdict?.findings).toEqual(expect.arrayContaining([
                    expect.objectContaining({ kind: "missing_active_failure" })
                ]));
                return passingCurator.curate(input);
            }
        };

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
            interventions: [],
            curator,
            curation_retry_backoff_ms: 0
        });

        expect(calls).toBe(2);
        expect(manifest.curation.status).toBe("passed");
        const verdict = await readJson<{ passed: boolean; findings: unknown[] }>(
            join(runRoot, "delivery", "evidence", "curation-verdict.json")
        );
        expect(verdict.passed).toBe(true);
        expect(verdict.findings).toEqual([]);
    });
});
