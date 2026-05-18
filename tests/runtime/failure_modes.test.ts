import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { readRunExecutionAttempts, readSupervisorInterventions, readSupervisorTimeline } from "../../src/artifacts/reader.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";
import type { HarnessAdapter } from "../../src/runtime/harness/types.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";
function compileGraph(document: AuthoredGraphDocument) {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults({
        intent: {
            goal: `Exercise ${document.graph_id}.`,
            acceptance_criteria: ["Failure-mode behavior matches the runtime contract."]
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
function createHarness(run: HarnessAdapter["run"], overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
    return {
        kind: "codex-cli",
        capabilities: getHarnessCapabilities("codex-cli")!,
        run,
        async cancel() {
            return;
        },
        ...overrides
    };
}
describe("runtime failure modes", () => {
    it("records missing agent harness adapters as structured runtime failures", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-missing-agent-harness-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        const graph = compileGraph({
            version: "1",
            graph_id: "missing-agent-harness",
            repos: {
                main: {
                    path: "."
                }
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
                        id: "needs_harness",
                        intent: {
                            goal: "Run through the default harness.",
                            acceptance_criteria: ["A missing harness is recorded structurally."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        try {
            const run = await runCompiledGraph({
                run_root: runRoot,
                compiled_graph: graph,
                repo_sources: {
                    main: repoDir
                },
                harnesses: {}
            });
            const attempts = await readRunExecutionAttempts(runRoot);
            expect(run.outcome).toBe("failed");
            expect(attempts).toHaveLength(1);
            expect(attempts[0]?.metadata).toEqual(expect.objectContaining({
                failure_code: "harness_unavailable",
                context_status: "failed"
            }));
            expect(String(attempts[0]?.metadata.error)).toContain("Harness adapter");
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("records missing AI-check harness adapters as structured runtime failures", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-missing-ai-check-harness-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        const graph = compileGraph({
            version: "1",
            graph_id: "missing-ai-check-harness",
            repos: {
                main: {
                    path: "."
                }
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
                        type: "check",
                        id: "ai_gate",
                        check_kind: "ai",
                        rubric: "Pass only when the harness is available.",
                        intent: {
                            goal: "Evaluate with an AI check.",
                            acceptance_criteria: ["A missing AI-check harness is recorded structurally."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        try {
            const run = await runCompiledGraph({
                run_root: runRoot,
                compiled_graph: graph,
                repo_sources: {
                    main: repoDir
                },
                harnesses: {}
            });
            const attempts = await readRunExecutionAttempts(runRoot);
            expect(run.outcome).toBe("failed");
            expect(attempts).toHaveLength(1);
            expect(attempts[0]?.metadata).toEqual(expect.objectContaining({
                failure_code: "harness_unavailable",
                context_status: "failed"
            }));
            expect(String(attempts[0]?.metadata.error)).toContain("Harness adapter");
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("runs default AI checks with the authored harness policy and structured evaluation fields", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-ai-check-policy-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        let capturedInvocation: Parameters<HarnessAdapter["run"]>[0] | undefined;
        const graph = compileGraph({
            version: "1",
            graph_id: "ai-check-policy",
            intent: {
                goal: "Validate the runtime sends the authored graph contract.",
                acceptance_criteria: ["The AI check receives graph acceptance criteria."],
                constraints: ["Use read-only evaluation."]
            },
            repos: {
                main: {
                    path: "."
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {
                    harness: "codex-cli",
                    model: "gpt-test",
                    reasoning_effort: "high",
                    skip_git_repo_check: true,
                    harness_config: {
                        isolation: "isolated"
                    }
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "check",
                        id: "ai_gate",
                        check_kind: "ai",
                        rubric: "Return a structured verdict.",
                        intent: {
                            goal: "Evaluate the handoff.",
                            acceptance_criteria: ["The check receives node acceptance criteria."],
                            constraints: ["Do not edit files."]
                        }
                    }
                ]
            }
        });
        const harness = createHarness(async (invocation) => {
            capturedInvocation = invocation;
            return {
                status: "passed",
                exitCode: 0,
                stdout: JSON.stringify({
                    passed: true,
                    score: 0.97,
                    summary: "AI check passed with evidence.",
                    issues: []
                })
            };
        });
        try {
            const run = await runCompiledGraph({
                run_root: runRoot,
                compiled_graph: graph,
                repo_sources: {
                    main: repoDir
                },
                harnesses: {
                    "codex-cli": harness
                }
            });
            const attempts = await readRunExecutionAttempts(runRoot);
            expect(run.outcome).toBe("passed");
            expect(capturedInvocation).toEqual(expect.objectContaining({
                promptKind: "ai_check",
                model: "gpt-test",
                reasoningEffort: "high",
                skipGitRepoCheck: true,
                graphGoal: "Validate the runtime sends the authored graph contract.",
                graphAcceptanceCriteria: ["The AI check receives graph acceptance criteria."],
                graphConstraints: ["Use read-only evaluation."],
                nodeGoal: "Evaluate the handoff.",
                nodeAcceptanceCriteria: ["The check receives node acceptance criteria."],
                nodeConstraints: ["Do not edit files."],
                rubric: "Return a structured verdict.",
                harnessConfig: {
                    isolation: "isolated"
                }
            }));
            expect(attempts[0]?.result_path).toBeDefined();
            const result = JSON.parse(await readFile(attempts[0]!.result_path!, "utf8")) as Record<string, unknown>;
            expect(result).toEqual(expect.objectContaining({
                passed: true,
                score: 0.97,
                summary: "AI check passed with evidence."
            }));
            expect(run.events).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: "check.evaluated",
                    payload: expect.objectContaining({
                        check_kind: "ai",
                        passed: true,
                        score: 0.97,
                        summary: "AI check passed with evidence."
                    })
                })
            ]));
            expect(run.state.node_statuses.root__ai_gate).toBe("passed");
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("records AI-check soft and hard semantic failures without supervisor pauses", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-ai-check-failures-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        let calls = 0;
        const graph = compileGraph({
            version: "1",
            graph_id: "ai-check-failures",
            repos: {
                main: {
                    path: "."
                }
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
                        type: "check",
                        id: "soft_gate",
                        check_kind: "ai",
                        rubric: "Return a failed semantic verdict.",
                        on_failure: "continue",
                        intent: {
                            goal: "Record a soft semantic failure.",
                            acceptance_criteria: ["Soft failures continue."],
                            constraints: []
                        }
                    },
                    {
                        type: "check",
                        id: "hard_gate",
                        check_kind: "ai",
                        rubric: "Return a failed semantic verdict.",
                        intent: {
                            goal: "Record a hard semantic failure.",
                            acceptance_criteria: ["Hard failures fail the graph."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const harness = createHarness(async () => {
            calls += 1;
            return {
                status: "passed",
                exitCode: 0,
                stdout: calls === 1
                    ? JSON.stringify({ passed: false })
                    : JSON.stringify({
                        passed: false,
                        score: 0.12,
                        summary: "Hard semantic failure.",
                        issues: ["criterion missing"]
                    })
            };
        });
        try {
            const run = await runCompiledGraph({
                run_root: runRoot,
                compiled_graph: graph,
                repo_sources: {
                    main: repoDir
                },
                harnesses: {
                    "codex-cli": harness
                }
            });
            const attempts = await readRunExecutionAttempts(runRoot);
            const soft = attempts.find((attempt) => attempt.authored_id === "soft_gate");
            const hard = attempts.find((attempt) => attempt.authored_id === "hard_gate");
            expect(run.outcome).toBe("failed");
            expect(run.state.supervisor.pause).toBeUndefined();
            expect(run.state.node_statuses.root__soft_gate).toBe("passed");
            expect(run.state.node_statuses.root__hard_gate).toBe("failed");
            expect(JSON.parse(await readFile(soft!.result_path!, "utf8"))).toEqual(expect.objectContaining({
                passed: false,
                summary: "AI check failed."
            }));
            expect(JSON.parse(await readFile(hard!.result_path!, "utf8"))).toEqual(expect.objectContaining({
                passed: false,
                score: 0.12,
                summary: "Hard semantic failure.",
                issues: ["criterion missing"]
            }));
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("records default agent harness cancellation without turning it into an artifact failure", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-agent-canceled-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        const graph = compileGraph({
            version: "1",
            graph_id: "agent-canceled",
            repos: {
                main: {
                    path: "."
                }
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
                        id: "worker",
                        intent: {
                            goal: "Start work through the default harness.",
                            acceptance_criteria: ["Cancellation remains canceled."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const harness = createHarness(async (invocation) => {
            invocation.onStdoutChunk?.("");
            invocation.onStderrChunk?.("");
            return {
                status: "canceled",
                exitCode: 130,
                stdout: "partial output",
                stderr: "operator canceled",
                metadata: {
                    canceled: true
                }
            };
        });
        try {
            const run = await runCompiledGraph({
                run_root: runRoot,
                compiled_graph: graph,
                repo_sources: {
                    main: repoDir
                },
                harnesses: {
                    "codex-cli": harness
                }
            });
            const attempts = await readRunExecutionAttempts(runRoot);
            expect(run.outcome).toBe("canceled");
            expect(attempts[0]?.status).toBe("canceled");
            expect(attempts[0]?.outcome).toBeUndefined();
            expect(run.state.supervisor.pause).toBeUndefined();
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("caches harness readiness diagnostics across ready nodes", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-harness-readiness-cache-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        let readinessChecks = 0;
        const graph = compileGraph({
            version: "1",
            graph_id: "harness-readiness-cache",
            repos: {
                main: {
                    path: "."
                }
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
                type: "parallel",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "first",
                        intent: {
                            goal: "Use the unavailable harness.",
                            acceptance_criteria: ["The readiness diagnostic is cached."],
                            constraints: []
                        }
                    },
                    {
                        type: "agent",
                        id: "second",
                        intent: {
                            goal: "Use the unavailable harness.",
                            acceptance_criteria: ["The readiness diagnostic is cached."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const harness = createHarness(async () => {
            throw new Error("readiness failure should prevent invocation");
        }, {
            async checkReadiness() {
                readinessChecks += 1;
                return ["codex-cli test readiness failure"];
            }
        });
        try {
            const run = await runCompiledGraph({
                run_root: runRoot,
                compiled_graph: graph,
                repo_sources: {
                    main: repoDir
                },
                harnesses: {
                    "codex-cli": harness
                }
            });
            const attempts = await readRunExecutionAttempts(runRoot);
            expect(run.outcome).toBe("failed");
            expect(readinessChecks).toBe(1);
            expect(attempts).toHaveLength(2);
            expect(attempts.map((attempt) => attempt.metadata.failure_code)).toEqual([
                "harness_unavailable",
                "harness_unavailable"
            ]);
            expect(attempts.map((attempt) => String(attempt.metadata.error))).toEqual([
                "codex-cli test readiness failure",
                "codex-cli test readiness failure"
            ]);
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("records cancellation when a run is interrupted during supervisor artifact repair", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-interrupted-intervention-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        const graph = compileGraph({
            version: "1",
            graph_id: "interrupted-intervention",
            repos: {
                main: {
                    path: "."
                }
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
            supervision: { profile: "supervisor", max_total_interventions: 1 },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "repairable",
                        intent: {
                            goal: "Finish but omit the declared artifact so repair starts.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifact_repair: {
                            max_attempts: 1
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Required handoff."
                            }
                        }
                    }
                ]
            }
        });
        const controller = new AbortController();
        const harness = createHarness(async (invocation) => {
            if (invocation.promptKind === "artifact_repair") {
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
                return {
                    status: invocation.signal?.aborted ? "canceled" : "failed",
                    exitCode: 1,
                    stdout: "",
                    stderr: invocation.signal?.aborted ? "repair canceled\n" : "repair failed\n",
                    transcript: {
                        last_message: "repair did not publish artifact"
                    }
                };
            }
            return {
                status: "passed",
                exitCode: 0,
                stdout: "initial pass without artifact\n",
                stderr: "",
                transcript: {
                    last_message: "initial response"
                }
            };
        });
        try {
            const run = await runCompiledGraph({
                run_root: runRoot,
                compiled_graph: graph,
                repo_sources: {
                    main: repoDir
                },
                harnesses: {
                    "codex-cli": harness
                },
                signal: controller.signal,
                on_event(event) {
                    if (event.type === "supervisor.intervention.started") {
                        controller.abort();
                    }
                }
            });
            const attempts = await readRunExecutionAttempts(runRoot);
            const interventions = await readSupervisorInterventions(runRoot);
            const timeline = await readSupervisorTimeline(runRoot);
            expect(run.outcome).toBe("canceled");
            expect(run.state.status).toBe("canceled");
            expect(attempts[0]?.status).toBe("canceled");
            expect(attempts[0]?.metadata.artifact_repair).toEqual(expect.objectContaining({
                status: "failed",
                attempt_count: 1
            }));
            expect(interventions).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    action: "repair_artifact",
                    status: "canceled"
                })
            ]));
            expect(timeline.map((decision) => decision.action)).toContain("repair_artifact");
            expect(run.events.map((event) => event.type)).toEqual(expect.arrayContaining([
                "supervisor.intervention.started",
                "supervisor.intervention.failed",
                "run.canceled"
            ]));
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
});
