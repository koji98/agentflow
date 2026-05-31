import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { readExecutionManifest } from "../../src/artifacts/reader.js";
import { resumeCompiledGraph, runCompiledGraph } from "../../src/runtime/core/engine.js";
import type { AgentInvocation, HarnessAdapter } from "../../src/runtime/harness/types.js";
import { createResumedRuntimeSession } from "../../src/runtime/resume.js";
import { resumeWorkspaceFromManifest } from "../../src/runtime/workspace/resume.js";
import { markInvocationRuntimeReady } from "../helpers/agentflow-runtime.js";
import { createPassingDeliveryHarness } from "../helpers/delivery-curation.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";
const execFileAsync = promisify(execFile);
async function initGitRepo(repoDir: string): Promise<void> {
    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
    await writeFile(join(repoDir, "README.md"), "seed\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
}
function compileGraph(document: AuthoredGraphDocument) {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults({
        intent: {
            goal: `Resume ${document.graph_id}.`,
            acceptance_criteria: ["Resume preserves only compatible completed work."]
        },
        ...document
    }));
    expect(normalized.diagnostics).toEqual([]);
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.compiled_graph).toBeDefined();
    return compilation.compiled_graph!;
}

function resumeWorkListJson(): string {
    return `${JSON.stringify({
        planning_summary: "One item is enough to test work-list resume compatibility.",
        ordering_rationale: "The single item can execute immediately after freeze.",
        items: [
            {
                id: "w1",
                title: "Complete resume fixture item",
                goal: "Complete the bounded resume fixture item.",
                acceptance_criteria: ["The item handoff is present."],
                constraints: [],
                validation_expectations: ["The item criterion passes."],
                handoff_focus: ["Downstream nodes need the accepted item result."],
                rationale: "This item exercises item phase contract compatibility."
            }
        ]
    }, null, 2)}\n`;
}

function isWorkListItemPlanInvocation(invocation: AgentInvocation): boolean {
    return invocation.nodeGoal?.includes("Plan frozen work-list item") === true;
}

function isWorkListItemExecuteInvocation(invocation: AgentInvocation): boolean {
    return invocation.nodeGoal?.includes("Execute frozen work-list item") === true;
}

function isWorkListItemPublishInvocation(invocation: AgentInvocation): boolean {
    return invocation.nodeGoal?.includes("Publish frozen work-list item") === true;
}

async function writeWorkListItemDrafts(invocation: AgentInvocation): Promise<void> {
    await writeFile(join(invocation.outputDir, "item-work-notes.md"), "# Item Work Notes\n\nExecuted resume fixture item.\n", "utf8");
    await writeFile(join(invocation.outputDir, "draft-item-handoff.md"), "# Draft Item Handoff\n\nFixture item is complete.\n", "utf8");
    await writeFile(join(invocation.outputDir, "draft-item-result.json"), `${JSON.stringify({
        id: "w1",
        status: "completed",
        summary: "Completed the resume fixture item.",
        validation: {
            passed: ["The fixture criterion passed."],
            failed_then_fixed: [],
            unavailable: [],
            blocked: []
        },
        risks: [],
        downstream_implications: ["Downstream nodes can consume the work_items ledger."]
    }, null, 2)}\n`, "utf8");
    await writeFile(join(invocation.outputDir, "draft-item-validation.md"), "Validation: fixture criterion passed.\n", "utf8");
}

async function writeWorkListItemFinals(invocation: AgentInvocation): Promise<void> {
    await writeFile(join(invocation.outputDir, "item-handoff.md"), "# Item Handoff\n\nFixture item is complete.\n", "utf8");
    await writeFile(join(invocation.outputDir, "item-result.json"), `${JSON.stringify({
        id: "w1",
        status: "completed",
        summary: "Completed the resume fixture item.",
        validation: {
            passed: ["The fixture criterion passed."],
            failed_then_fixed: [],
            unavailable: [],
            blocked: []
        },
        risks: [],
        downstream_implications: ["Downstream nodes can consume the work_items ledger."]
    }, null, 2)}\n`, "utf8");
    await writeFile(join(invocation.outputDir, "item-validation.md"), "Validation: fixture criterion passed.\n", "utf8");
}

function createWorkListResumeHarness(): HarnessAdapter {
    const deliveryHarness = createPassingDeliveryHarness("codex-cli");
    return {
        kind: "codex-cli",
        capabilities: getHarnessCapabilities("codex-cli")!,
        async run(invocation) {
            if (invocation.promptKind === "delivery_curator") {
                return deliveryHarness.run(invocation);
            }

            if (invocation.promptKind === "ai_check") {
                return {
                    status: "passed",
                    exitCode: 0,
                    transcript: {
                        last_message: [
                            "```json",
                            JSON.stringify({ passed: true, score: 1, summary: "Fixture criterion passed.", issues: [] }),
                            "```"
                        ].join("\n")
                    }
                };
            }

            if (invocation.promptKind === "outcome_verification") {
                return {
                    status: "passed",
                    exitCode: 0,
                    transcript: {
                        last_message: [
                            "```json",
                            JSON.stringify({ passed: true, summary: "Fixture verifier accepts.", findings: [], blockers: [] }),
                            "```"
                        ].join("\n")
                    }
                };
            }

            if (invocation.nodeGoal?.includes("work_list_json")) {
                await writeFile(join(invocation.outputDir, "work-list.json"), resumeWorkListJson(), "utf8");
            } else if (isWorkListItemPlanInvocation(invocation)) {
                await writeFile(join(invocation.outputDir, "item-cycle-plan.md"), "# Item Cycle Plan\n\nPlan the fixture item.\n", "utf8");
            } else if (isWorkListItemExecuteInvocation(invocation)) {
                await writeWorkListItemDrafts(invocation);
            } else if (isWorkListItemPublishInvocation(invocation)) {
                await writeWorkListItemFinals(invocation);
            } else if (invocation.nodeGoal?.includes("final artifacts")) {
                await writeFile(join(invocation.outputDir, "summary.md"), "Completed the work-list resume fixture.\n", "utf8");
            }

            const result = {
                status: "passed" as const,
                exitCode: 0,
                transcript: {
                    last_message: "done"
                }
            };
            await markInvocationRuntimeReady(invocation, result);
            return result;
        },
        async cancel() {
            return;
        }
    };
}

async function createResumeFixture(options: {
    document: AuthoredGraphDocument;
    setupRepo?: (repoDir: string) => Promise<void>;
}): Promise<{
    tempRoot: string;
    repoDir: string;
    runRoot: string;
    graph: ReturnType<typeof compileGraph>;
    result: Awaited<ReturnType<typeof runCompiledGraph>>;
    manifest: Awaited<ReturnType<typeof readExecutionManifest>>;
}> {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-runtime-resume-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await options.setupRepo?.(repoDir);
    const graph = compileGraph(options.document);
    const deliveryHarness = createPassingDeliveryHarness("codex-cli");
    const result = await runCompiledGraph({
        run_root: runRoot,
        compiled_graph: graph,
        repo_sources: {
            main: repoDir
        },
        executors: {
            exec: async () => ({
                status: "passed",
                outcome: "passed",
                stdout: "",
                stderr: "",
                result: { ok: true }
            })
        },
        harnesses: {
            "codex-cli": {
                kind: "codex-cli",
                capabilities: getHarnessCapabilities("codex-cli")!,
                async run(invocation) {
                    if (invocation.promptKind === "delivery_curator") {
                        return deliveryHarness.run(invocation);
                    }

                    if (invocation.promptKind === "outcome_verification") {
                        return {
                            status: "passed",
                            exitCode: 0,
                            transcript: {
                                last_message: [
                                    "```json",
                                    JSON.stringify({
                                        passed: true,
                                        summary: "Resume fixture verifier accepts.",
                                        findings: [],
                                        blockers: []
                                    }, null, 2),
                                    "```"
                                ].join("\n")
                            }
                        };
                    }
                    const result = {
                        status: "passed",
                        exitCode: 0,
                        stdout: "",
                        stderr: "",
                        transcript: {
                            last_message: "done"
                        },
                        outputJson: {
                            ok: true
                        }
                    };
                    for (const [name, artifact] of Object.entries(invocation.artifacts)) {
                        if (artifact.from !== "output_dir") {
                            continue;
                        }
                        const artifactPath = join(invocation.outputDir, artifact.path);
                        await mkdir(dirname(artifactPath), { recursive: true });
                        const content = artifact.path.endsWith(".json")
                            ? `${JSON.stringify({
                                name,
                                ok: true,
                                completion_score: 1,
                                criteria: [],
                                "Completion Scorecard": "Completion score 1 met threshold 1.",
                                "Scorecard Evidence": "Fixture scorecard evidence is present."
                              }, null, 2)}\n`
                            : [
                                `# ${name}`,
                                "",
                                "## Objective",
                                "Satisfy the fixture contract.",
                                "",
                                "## Relevant evidence",
                                "The test harness supplies passing runtime evidence.",
                                "",
                                "## Planned material delta",
                                "No source change is required for this fixture.",
                                "",
                                "## Criterion evidence map",
                                "The fixture command passes.",
                                "",
                                "## Validation plan",
                                "Use the fixture command result.",
                                "",
                                "## Risks or constraints",
                                "No fixture constraints are at risk.",
                                "",
                                "## What changed",
                                "The fixture completed.",
                                "",
                                "## Validation attempted",
                                "Fixture validation passed.",
                                "",
                                "## Remaining risks",
                                "No fixture risks.",
                                "",
                                "## Scorecard Evidence",
                                "Completion score 1 met threshold 1.",
                                "",
                                "## Completion Scorecard",
                                "Completion score 1 met threshold 1."
                              ].join("\n") + "\n";
                        await writeFile(artifactPath, content, "utf8");
                    }
                    await markInvocationRuntimeReady(invocation, result);
                    return result;
                },
                async cancel() {
                    return;
                }
            } satisfies HarnessAdapter
        }
    });
    expect(result.outcome).toBe("passed");
    const manifest = await readExecutionManifest(runRoot);
    return {
        tempRoot,
        repoDir,
        runRoot,
        graph,
        result,
        manifest
    };
}
async function buildResumedSession(fixture: Awaited<ReturnType<typeof createResumeFixture>>, graph = fixture.graph, attempts = fixture.result.attempts, resetSupervisorBudget = false) {
    return createResumedRuntimeSession({
        run_root: fixture.runRoot,
        prior_graph: fixture.graph,
        graph,
        manifest: fixture.manifest,
        prior_state: fixture.result.state,
        attempts,
        events: fixture.result.events,
        reset_supervisor_budget: resetSupervisorBudget
    });
}
describe("runtime resume", () => {
    it("preserves a passed node when explicit file inputs change after the prior run", async () => {
        const fixture = await createResumeFixture({
            document: {
                version: "1",
                graph_id: "resume-explicit-input",
                repos: {
                    main: { path: "." }
                },
                defaults: {
                    launch_profile: "default",
                    workspace_backend: "inplace"
                },
                profiles: {
                    default: {}
                },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "exec",
                            id: "consumer",
                            command: "placeholder",
                            support: {
                                context: [
                                    {
                                        name: "watched",
                                        kind: "workspace_file",
                                        path: "watched.txt",
                                        what: "Pointer evidence used by the node under test.",
                                        why: "This context is required by the test scenario."
                                    }
                                ]
                            },
                            runtime: {
                                repo: "main"
                            }
                        }
                    ]
                }
            },
            async setupRepo(repoDir) {
                await writeFile(join(repoDir, "watched.txt"), "v1\n");
            }
        });
        await writeFile(join(fixture.repoDir, "watched.txt"), "updated\n");
        const resumed = await buildResumedSession(fixture);
        expect(resumed.preserved_node_count).toBe(1);
        expect(resumed.restarted_node_count).toBe(0);
        await rm(fixture.tempRoot, { recursive: true, force: true });
    });
    it("blocks resume before restarting work when required static context is missing", async () => {
        const fixture = await createResumeFixture({
            document: {
                version: "1",
                graph_id: "resume-missing-static-context",
                repos: {
                    main: { path: "." }
                },
                defaults: {
                    launch_profile: "default",
                    workspace_backend: "inplace"
                },
                profiles: {
                    default: {}
                },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "exec",
                            id: "consumer",
                            command: "placeholder",
                            support: {
                                context: [
                                    {
                                        name: "watched",
                                        kind: "workspace_file",
                                        path: "watched.txt",
                                        what: "Required static context.",
                                        why: "Resume should preflight this file before restarting work."
                                    }
                                ]
                            },
                            runtime: {
                                repo: "main"
                            }
                        }
                    ]
                }
            },
            async setupRepo(repoDir) {
                await writeFile(join(repoDir, "watched.txt"), "stable\n");
            }
        });
        await unlink(join(fixture.repoDir, "watched.txt"));
        const resumed = await buildResumedSession(fixture);
        const workspace = await resumeWorkspaceFromManifest(fixture.manifest);
        const result = await resumeCompiledGraph({
            run_root: fixture.runRoot,
            compiled_graph: fixture.graph,
            repo_sources: {
                main: fixture.repoDir
            },
            resumed_session: resumed.session,
            prior_events: fixture.result.events,
            workspace,
            previous_status: "failed",
            preserved_node_count: resumed.preserved_node_count,
            restarted_node_count: resumed.restarted_node_count,
            executors: {
                exec: async () => {
                    throw new Error("executor should not run when resume static context preflight fails");
                }
            }
        });
        expect(result.outcome).toBe("failed");
        expect(result.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "run.preflight_failed",
                payload: expect.objectContaining({
                    reason: "readiness_blocked",
                    message: expect.stringContaining("workspace_file")
                })
            })
        ]));
        await workspace.cleanup();
        await rm(fixture.tempRoot, { recursive: true, force: true });
    });
    it("preserves a passed node when glob contents or matches change after the prior run", async () => {
        const fixture = await createResumeFixture({
            document: {
                version: "1",
                graph_id: "resume-glob-change",
                repos: {
                    main: { path: "." }
                },
                defaults: {
                    launch_profile: "default",
                    workspace_backend: "inplace"
                },
                profiles: {
                    default: {}
                },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "exec",
                            id: "consumer",
                            command: "placeholder",
                            support: {
                                context: [
                                    {
                                        name: "docs",
                                        kind: "workspace_glob",
                                        path: "docs/*.md",
                                        what: "Pointer evidence used by the node under test.",
                                        why: "This context is required by the test scenario."
                                    }
                                ]
                            },
                            runtime: {
                                repo: "main"
                            }
                        }
                    ]
                }
            },
            async setupRepo(repoDir) {
                await mkdir(join(repoDir, "docs"), { recursive: true });
                await writeFile(join(repoDir, "docs", "a.md"), "alpha\n");
            }
        });
        await writeFile(join(fixture.repoDir, "docs", "a.md"), "alpha-updated\n");
        await writeFile(join(fixture.repoDir, "docs", "b.md"), "beta\n");
        const resumed = await buildResumedSession(fixture);
        expect(resumed.preserved_node_count).toBe(1);
        expect(resumed.restarted_node_count).toBe(0);
        await rm(fixture.tempRoot, { recursive: true, force: true });
    });
    it("preserves a passed harnessed node when repo instruction files change", async () => {
        const fixture = await createResumeFixture({
            document: {
                version: "1",
                graph_id: "resume-instruction-change",
                repos: {
                    main: { path: "." }
                },
                defaults: {
                    launch_profile: "default",
                    workspace_backend: "inplace"
                },
                profiles: {
                    default: {
                        harness: "codex-cli"
                    }
                },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "agent",
                            id: "implement",
                            intent: {
                                goal: "Write nothing.",
                                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                                constraints: []
                            },
                            runtime: {
                                repo: "main"
                            }
                        }
                    ]
                }
            },
            async setupRepo(repoDir) {
                await mkdir(join(repoDir, ".cursor", "rules"), { recursive: true });
                await writeFile(join(repoDir, "AGENTS.md"), "v1\n");
                await writeFile(join(repoDir, ".cursor", "rules", "review.mdc"), "v1\n");
            }
        });
        await writeFile(join(fixture.repoDir, "AGENTS.md"), "updated\n");
        await writeFile(join(fixture.repoDir, ".cursor", "rules", "review.mdc"), "updated\n");
        const resumed = await buildResumedSession(fixture);
        expect(resumed.preserved_node_count).toBe(1);
        expect(resumed.restarted_node_count).toBe(0);
        await rm(fixture.tempRoot, { recursive: true, force: true });
    });
    it("preserves passed nodes even when prior attempts are missing context provenance artifacts", async () => {
        const fixture = await createResumeFixture({
            document: {
                version: "1",
                graph_id: "resume-missing-provenance",
                repos: {
                    main: { path: "." }
                },
                defaults: {
                    launch_profile: "default",
                    workspace_backend: "inplace"
                },
                profiles: {
                    default: {}
                },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "exec",
                            id: "consumer",
                            command: "placeholder",
                            support: {
                                context: [
                                    {
                                        name: "watched",
                                        kind: "workspace_file",
                                        path: "watched.txt",
                                        what: "Pointer evidence used by the node under test.",
                                        why: "This context is required by the test scenario."
                                    }
                                ]
                            },
                            runtime: {
                                repo: "main"
                            }
                        }
                    ]
                }
            },
            async setupRepo(repoDir) {
                await writeFile(join(repoDir, "watched.txt"), "stable\n");
            }
        });
        const attemptsWithoutProvenance = fixture.result.attempts.map((attempt) => ({
            ...attempt,
            context_provenance_path: undefined
        }));
        const resumed = await buildResumedSession(fixture, fixture.graph, attemptsWithoutProvenance);
        expect(resumed.preserved_node_count).toBe(1);
        expect(resumed.restarted_node_count).toBe(0);
        await rm(fixture.tempRoot, { recursive: true, force: true });
    });
    it("can reset supervisor budget while preserving compatible passed work", async () => {
        const fixture = await createResumeFixture({
            document: {
                version: "1",
                graph_id: "resume-reset-supervisor-budget",
                repos: {
                    main: { path: "." }
                },
                defaults: {
                    launch_profile: "default",
                    workspace_backend: "inplace"
                },
                profiles: {
                    default: {}
                },
                supervision: { profile: "supervisor", max_total_interventions: 5 },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "exec",
                            id: "done",
                            command: "placeholder",
                            runtime: {
                                repo: "main"
                            }
                        }
                    ]
                }
            }
        });
        fixture.result.state.supervisor.status = "exhausted";
        fixture.result.state.supervisor.budget_remaining = {
            max_total_interventions: 0
        };
        const resumed = await buildResumedSession(fixture, fixture.graph, fixture.result.attempts, true);
        expect(resumed.preserved_node_count).toBe(1);
        expect(resumed.restarted_node_count).toBe(0);
        expect(resumed.session.supervisor.status).toBe("healthy");
        expect(resumed.session.supervisor.budget_remaining.max_total_interventions).toBe(5);
        await rm(fixture.tempRoot, { recursive: true, force: true });
    });
    it("restarts passed nodes when the compiled node contract changes", async () => {
        const fixture = await createResumeFixture({
            document: {
                version: "1",
                graph_id: "resume-compiled-change",
                repos: {
                    main: { path: "." }
                },
                defaults: {
                    launch_profile: "default",
                    workspace_backend: "inplace"
                },
                profiles: {
                    default: {}
                },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "exec",
                            id: "consumer",
                            command: "placeholder",
                            runtime: {
                                repo: "main"
                            }
                        }
                    ]
                }
            }
        });
        const changedGraph = compileGraph({
            version: "1",
            graph_id: "resume-compiled-change",
            repos: {
                main: { path: "." }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "consumer",
                        command: "placeholder",
                        args: ["--changed"],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        });
        const resumed = await buildResumedSession(fixture, changedGraph);
        expect(resumed.preserved_node_count).toBe(0);
        expect(resumed.restarted_node_count).toBe(1);
        await rm(fixture.tempRoot, { recursive: true, force: true });
    });
    it("restarts passed nodes when the graph intent contract changes", async () => {
        const baseDocument: AuthoredGraphDocument = {
            version: "1",
            graph_id: "resume-intent-change",
            intent: {
                goal: "Ship the original goal.",
                acceptance_criteria: ["Original acceptance criteria."]
            },
            repos: {
                main: { path: "." }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "consumer",
                        command: "placeholder",
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        };
        const fixture = await createResumeFixture({ document: baseDocument });
        const changedGraph = compileGraph({
            ...baseDocument,
            intent: {
                goal: "Ship the changed goal.",
                acceptance_criteria: ["Changed acceptance criteria."]
            }
        });
        const resumed = await buildResumedSession(fixture, changedGraph);
        expect(resumed.preserved_node_count).toBe(0);
        expect(resumed.restarted_node_count).toBe(1);
        await rm(fixture.tempRoot, { recursive: true, force: true });
    });
    it("restarts passed agent nodes and downstream dependents when prompt support changes", async () => {
        const fixture = await createResumeFixture({
            document: {
                version: "1",
                graph_id: "resume-agent-support-change",
                repos: {
                    main: { path: "." }
                },
                defaults: {
                    launch_profile: "default",
                    workspace_backend: "inplace"
                },
                profiles: {
                    default: {
                        harness: "codex-cli"
                    }
                },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "agent",
                            id: "producer",
                            intent: {
                                goal: "Produce the upstream result.",
                                acceptance_criteria: ["The producer passes."],
                                constraints: []
                            },
                            runtime: {
                                repo: "main"
                            }
                        },
                        {
                            type: "agent",
                            id: "consumer",
                            intent: {
                                goal: "Consume the upstream result.",
                                acceptance_criteria: ["The consumer passes."],
                                constraints: []
                            },
                            runtime: {
                                repo: "main"
                            }
                        }
                    ]
                }
            }
        });
        const changedGraph = structuredClone(fixture.graph);
        const producer = changedGraph.nodes.find((node) => node.authored_id === "producer");
        expect(producer?.kind).toBe("agent");
        if (producer?.kind === "agent") {
            producer.tools = [
                {
                    callable_name: "fixture-tool",
                    description: "Prompt-visible managed tool.",
                    executable_path: "/tmp/fixture-tool",
                    config: { mode: "changed" },
                    credentials: [],
                    source: {
                        kind: "plugin",
                        alias: "fixture",
                        tool: "inspect",
                        plugin_root: "/tmp/fixture-plugin",
                        declared_at: "registry",
                        declaration_path: "tools.fixture_tool"
                    }
                }
            ];
            producer.skills = [
                {
                    ref: "team/review",
                    source_alias: "team",
                    name: "review",
                    description: "Prompt-visible skill.",
                    path: "/tmp/skills/team/review/SKILL.md"
                }
            ];
            producer.cli = [
                {
                    cmd: "jq",
                    description: "Prompt-visible CLI hint."
                }
            ];
        }
        const resumed = await buildResumedSession(fixture, changedGraph);
        expect(resumed.preserved_node_count).toBe(0);
        expect(resumed.restarted_node_count).toBe(2);
        await rm(fixture.tempRoot, { recursive: true, force: true });
    });
    it("restarts completed deep-work internals when phase prompt inputs change", async () => {
        const baseDocument: AuthoredGraphDocument = {
            version: "1",
            graph_id: "resume-deep-work-phase-change",
            repos: {
                main: { path: "." }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {
                    harness: "codex-cli"
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "pattern_deep_work",
                        id: "deep_work",
                        intent: {
                            goal: "Complete the deep work fixture.",
                            acceptance_criteria: ["The fixture passes."],
                            constraints: []
                        },
                        runtime: {
                            repo: "main"
                        },
                        completion: {
                            max_cycles: 1,
                            pass_threshold: 1,
                            criteria: [
                                {
                                    id: "fixture_command",
                                    kind: "command",
                                    command: "true",
                                    weight: 1,
                                    required: true
                                }
                            ]
                        }
                    }
                ]
            }
        };
        const fixture = await createResumeFixture({ document: baseDocument });
        const changedGraph = compileGraph({
            ...baseDocument,
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        ...baseDocument.graph.steps[0],
                        phases: {
                            execute: {
                                intent: {
                                    goal: "Record the exact evidence map in work notes."
                                }
                            }
                        }
                    }
                ]
            }
        });
        const resumed = await buildResumedSession(fixture, changedGraph);
        expect(resumed.restarted_node_count).toBeGreaterThan(0);
        expect(resumed.preserved_node_count).toBeLessThan(fixture.graph.nodes.length);
        await rm(fixture.tempRoot, { recursive: true, force: true });
    });

    it("restarts completed work-list deep-work items when item phase prompt inputs change", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-runtime-work-list-phase-resume-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);

        const baseDocument: AuthoredGraphDocument = {
            version: "1",
            graph_id: "resume-work-list-item-phase-change",
            repos: {
                main: { path: "." }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {
                    harness: "codex-cli"
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "pattern_work_list",
                        id: "deliver",
                        intent: {
                            goal: "Complete the work-list phase resume fixture.",
                            acceptance_criteria: ["The fixture item is completed."],
                            constraints: []
                        },
                        runtime: {
                            repo: "main"
                        },
                        work_list: {
                            planning_goal: "Plan the single fixture item.",
                            item_guidance: {
                                what_counts_as_one_item: "One bounded fixture item.",
                                done_when: ["The item handoff and validation evidence are present."]
                            },
                            item_worker: {
                                kind: "deep_work",
                                phases: {
                                    execute: {
                                        intent: {
                                            goal: "Record the baseline execute-phase evidence."
                                        }
                                    }
                                },
                                completion: {
                                    max_cycles: 1,
                                    pass_threshold: 1,
                                    criteria: [
                                        {
                                            id: "fixture_rubric",
                                            kind: "rubric",
                                            target: "item_handoff",
                                            rubric: "The item handoff proves the fixture item is complete.",
                                            weight: 1,
                                            required: true
                                        }
                                    ]
                                }
                            }
                        }
                    }
                ]
            }
        };
        const graph = compileGraph(baseDocument);
        const result = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            harnesses: {
                "codex-cli": createWorkListResumeHarness()
            }
        });
        expect(result.outcome).toBe("passed");
        const manifest = await readExecutionManifest(runRoot);
        const changedGraph = compileGraph({
            ...baseDocument,
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        ...baseDocument.graph.steps[0],
                        work_list: {
                            ...baseDocument.graph.steps[0].work_list,
                            item_worker: {
                                ...baseDocument.graph.steps[0].work_list.item_worker,
                                phases: {
                                    execute: {
                                        intent: {
                                            goal: "Record the changed execute-phase evidence."
                                        }
                                    }
                                }
                            }
                        }
                    }
                ]
            }
        });
        const resumed = await createResumedRuntimeSession({
            run_root: runRoot,
            prior_graph: graph,
            graph: changedGraph,
            manifest,
            prior_state: result.state,
            attempts: result.attempts,
            events: result.events
        });
        const runItemsNode = changedGraph.nodes.find((node) =>
            node.authored_id.endsWith("__managed__pattern_work_list__run_items")
        );
        expect(runItemsNode).toBeDefined();
        expect(resumed.session.node_statuses.get(runItemsNode!.compiled_id)).toBe("pending");
        expect(resumed.restarted_node_count).toBeGreaterThan(0);
        expect(resumed.preserved_node_count).toBeLessThan(graph.nodes.length);

        await rm(tempRoot, { recursive: true, force: true });
    });
});
