import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import {
    resolveExecutionArtifactsDirectory,
    resolveExecutionHumanDebugToolDirectory,
    resolveExecutionRuntimeDirectory,
    resolveInterventionDirectory,
    resolveNodeExecutionDirectory
} from "../../src/artifacts/paths.js";
import { readRunExecutionAttempts, readSupervisorInterventions } from "../../src/artifacts/reader.js";
import { buildExecutionId } from "../../src/runtime/attempts.js";
import { createAuthorityRequest } from "../../src/runtime/authority.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";
import { createCodexCliHarness } from "../../src/runtime/harness/codex_cli.js";
import { renderHarnessPrompt, type HarnessAdapter } from "../../src/runtime/harness/types.js";
import { evaluateGraphReadiness } from "../../src/runtime/readiness.js";
import { markExecutorRuntimeReady, markInvocationRuntimeReady } from "../helpers/agentflow-runtime.js";
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
    const documentWithNodeIntent = withNodeIntentDefaults(document);
    const normalized = normalizeAuthoredGraphDocument({
        intent: {
            goal: `Exercise ${document.graph_id}.`,
            acceptance_criteria: ["The runtime behavior matches the test contract."]
        },
        ...documentWithNodeIntent
    });
    expect(normalized.diagnostics).toEqual([]);
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.compiled_graph).toBeDefined();
    return compilation.compiled_graph!;
}
async function waitFor(predicate: () => Promise<boolean>, options: {
    timeout_ms?: number;
    interval_ms?: number;
} = {}): Promise<void> {
    const timeout_ms = options.timeout_ms ?? 1000;
    const interval_ms = options.interval_ms ?? 20;
    const started_at = Date.now();
    while (Date.now() - started_at < timeout_ms) {
        if (await predicate()) {
            return;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, interval_ms));
    }
    throw new Error(`Condition not met within ${timeout_ms}ms.`);
}
async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
const PASSING_VERIFIER_JSON = [
    "```json",
    JSON.stringify({
        passed: true,
        summary: "Test verifier accepts all agent outputs.",
        findings: [],
        blockers: []
    }, null, 2),
    "```"
].join("\n");
function createHarness(kind: HarnessAdapter["kind"], run: HarnessAdapter["run"], overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
    const wrappedRun: HarnessAdapter["run"] = async (invocation) => {
        if (invocation.promptKind === "outcome_verification") {
            return {
                status: "passed",
                exitCode: 0,
                transcript: { last_message: PASSING_VERIFIER_JSON }
            };
        }
        const result = await run(invocation);
        await markInvocationRuntimeReady(invocation, result);
        return result;
    };
    return {
        kind,
        capabilities: getHarnessCapabilities(kind)!,
        run: wrappedRun,
        async cancel() {
            return;
        },
        ...overrides
    };
}
describe("runtime engine", () => {
    it("publishes selected deep research angle artifacts from the final publisher", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-deep-research-angle-artifact-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(join(repoDir, "operator-note.txt"), "done\n", "utf8");
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-deep-research-angle-artifact",
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
                        type: "pattern_deep_research",
                        id: "market_scan",
                        research: {
                            angles: [
                                {
                                    id: "risk",
                                    prompt: "Identify correctness, maintainability, and rollout risks in the managed pattern design.",
                                    as_artifact: true
                                },
                                "Compare whether the public artifact contract is easy for downstream nodes to consume."
                            ]
                        },
                        runtime: {
                            repo: "main",
                            profile: "default"
                        }
                    }
                ]
            }
        });
        const rawRiskReport = "RAW RISK ANGLE REPORT\nfindings, evidence, sources, conflicts, uncertainty, and confidence for the risk angle.\n";
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                agent: async (context) => {
                    const { node, execution_dir } = context;
                    const outputDir = resolveExecutionArtifactsDirectory(execution_dir);
                    if (node.authored_id.endsWith("__angle_01")) {
                        await writeFile(join(outputDir, "angle-report.md"), rawRiskReport);
                    }
                    else if (node.authored_id.endsWith("__angle_02")) {
                        await writeFile(join(outputDir, "angle-report.md"), "RAW CONTRACT ANGLE REPORT\nangle_02\nfindings, evidence, sources, conflicts, uncertainty, and confidence for the contract angle.\n");
                    }
                    else if (node.authored_id === "market_scan") {
                        await writeFile(join(outputDir, "summary.md"), "Synthesized summary.\n");
                        await mkdir(join(outputDir, "angles"), { recursive: true });
                        await writeFile(join(outputDir, "angles", "risk.md"), "Curated risk report.\n");
                    }
                    const result = {
                        status: "passed",
                        outcome: "passed",
                        result: { node: node.authored_id },
                        stdout: "",
                        stderr: ""
                    };
                    await markExecutorRuntimeReady(context, result);
                    return result;
                }
            }
        });
        const finalAttempt = run.attempts.find((attempt) => attempt.authored_id === "market_scan");
        expect(run.outcome).toBe("passed");
        expect(finalAttempt?.artifacts.risk).toBeDefined();
        await expect(readFile(finalAttempt!.artifacts.risk!, "utf8")).resolves.toBe("Curated risk report.\n");
        const rawAngleAttempt = run.attempts.find((attempt) => attempt.authored_id.endsWith("__angle_01"));
        expect(rawAngleAttempt?.artifacts.angle_report_01).toBeDefined();
        await expect(readFile(rawAngleAttempt!.artifacts.angle_report_01!, "utf8")).resolves.toBe(rawRiskReport);
        const manifest = JSON.parse(await readFile(join(runRoot, "delivery", "manifest.json"), "utf8")) as {
            artifact_taxonomy: {
                declared_artifacts: Array<{
                    label: string;
                    path: string;
                }>;
            };
        };
        expect(manifest.artifact_taxonomy.declared_artifacts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                label: "market_scan.risk",
                path: finalAttempt!.artifacts.risk
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("repairs an upstream worker when a downstream check is the failed symptom", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-causal-supervisor-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-causal-supervisor",
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
                        id: "implement",
                        intent: {
                            goal: "Write the implementation output that validation checks.",
                            acceptance_criteria: ["The workspace file result.txt contains ok."],
                            constraints: ["Only modify result.txt."]
                        },
                        artifacts: {
                            summary: {
                                from: "output_dir",
                                path: "summary.md",
                                description: "Implementation summary."
                            }
                        }
                    },
                    {
                        type: "check",
                        id: "validate",
                        check_kind: "deterministic",
                        intent: {
                            goal: "Validate the implementation output.",
                            acceptance_criteria: ["The validation gate passes only when result.txt contains ok."],
                            constraints: ["Do not edit the workspace."]
                        },
                        command: "placeholder",
                        support: {
                            context: [
                                {
                                    kind: "artifact",
                                    ref: "implement.summary",
                                    name: "implementation summary",
                                    what: "Pointer evidence used by the node under test.",
                                    why: "This context is required by the test scenario."
                                }
                            ]
                        }
                    }
                ]
            }
        });
        let implementAttempts = 0;
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                agent: async (context) => {
                    const { workspace_path, execution_dir, supervisor_recovery_envelope } = context;
                    implementAttempts += 1;
                    await writeFile(join(workspace_path, "result.txt"), supervisor_recovery_envelope ? "ok\n" : "not ok yet\n");
                    await writeFile(join(resolveExecutionArtifactsDirectory(execution_dir), "summary.md"), supervisor_recovery_envelope
                        ? "Recovered implementation with passing result.\n"
                        : "Initial implementation is incomplete.\n");
                    const result = {
                        status: "passed",
                        outcome: "passed",
                        result: { implementAttempts },
                        stdout: "",
                        stderr: ""
                    };
                    await markExecutorRuntimeReady(context, result);
                    return result;
                },
                check: async ({ workspace_path }) => {
                    const value = await readFile(join(workspace_path, "result.txt"), "utf8").catch(() => "");
                    const passed = value.trim() === "ok";
                    return {
                        status: passed ? "passed" : "failed",
                        outcome: passed ? "passed" : "failed",
                        result: { value },
                        stdout: value,
                        stderr: passed ? "" : "result.txt did not contain ok",
                        check: {
                            check_kind: "deterministic",
                            passed,
                            summary: passed ? "result passed" : "result failed"
                        }
                    };
                }
            }
        });
        expect(run.outcome).toBe("passed");
        expect(run.attempts.filter((attempt) => attempt.authored_id === "implement")).toHaveLength(2);
        expect(run.attempts.filter((attempt) => attempt.authored_id === "validate")).toHaveLength(2);
        expect(run.events.map((event) => event.type)).toEqual(expect.arrayContaining([
            "supervisor.intervention.completed",
            "supervisor.retry_scheduled",
            "supervisor.gate_rerun_scheduled"
        ]));
        const interventions = await readSupervisorInterventions(runRoot);
        expect(interventions).toEqual([
            expect.objectContaining({
                target_compiled_id: "root__implement",
                evidence: expect.objectContaining({
                    symptom_compiled_id: "root__validate",
                    recovery_target: expect.objectContaining({
                        operation: "repair_upstream_node"
                    })
                }),
                artifact_paths: expect.objectContaining({
                    causal_case_file_json: expect.stringContaining("causal-case-file.json"),
                    recovery_chain_json: expect.stringContaining("recovery-chain.json")
                })
            })
        ]);
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("executes sequence, parallel, repeat, and context handoff over a compiled graph", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-engine",
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
                        type: "exec",
                        id: "setup",
                        command: "placeholder"
                    },
                    {
                        type: "parallel",
                        id: "fanout",
                        max_concurrency: 2,
                        steps: [
                            {
                                type: "exec",
                                id: "a",
                                command: "placeholder"
                            },
                            {
                                type: "exec",
                                id: "b",
                                command: "placeholder"
                            }
                        ]
                    },
                    {
                        type: "repeat",
                        id: "retry",
                        max_attempts: 3,
                        body: {
                            type: "sequence",
                            id: "body",
                            steps: [
                                {
                                    type: "agent",
                                    id: "implement",
                                    intent: {
                                        goal: "Increment the counter.",
                                        acceptance_criteria: ["The node satisfies its acceptance criteria."],
                                        constraints: []
                                    },
                                    artifacts: {
                                        notes: {
                                            from: "output_dir",
                                            path: "notes.md",
                                            description: "Test artifact produced at notes.md."
                                        }
                                    }
                                },
                                {
                                    type: "check",
                                    id: "verify",
                                    check_kind: "deterministic",
                                    command: "placeholder",
                                    artifacts: {
                                        verification: {
                                            from: "output_dir",
                                            path: "verification.json",
                                            description: "Test artifact produced at verification.json."
                                        }
                                    }
                                }
                            ]
                        },
                        until: {
                            node: "verify"
                        }
                    },
                    {
                        type: "exec",
                        id: "finalize",
                        command: "placeholder",
                        support: {
                            context: [
                                {
                                    name: "operator_note",
                                    kind: "workspace_file",
                                    path: "operator-note.txt",
                                    what: "Pointer evidence used by the node under test.",
                                    why: "This context is required by the test scenario."
                                },
                                {
                                    kind: "artifact",
                                    ref: "verify.verification",
                                    name: "verification",
                                    iteration: "latest_passed",
                                    what: "Pointer evidence used by the node under test.",
                                    why: "This context is required by the test scenario."
                                }
                            ]
                        }
                    }
                ]
            }
        });
        let counter = 0;
        let activeParallel = 0;
        let maxParallel = 0;
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ node, workspace_path, context_packet_path }) => {
                    if (node.authored_id === "setup") {
                        await writeFile(join(workspace_path, "counter.txt"), "0\n");
                    }
                    if (node.authored_id === "a" || node.authored_id === "b") {
                        activeParallel += 1;
                        maxParallel = Math.max(maxParallel, activeParallel);
                        await new Promise((resolveDelay) => setTimeout(resolveDelay, 35));
                        activeParallel -= 1;
                    }
                    if (node.authored_id === "finalize") {
                        const packet = JSON.parse(await readFile(context_packet_path, "utf8")) as {
                            materials: unknown[];
                        };
                        expect(packet.materials).toHaveLength(2);
                    }
                    return {
                        status: "passed",
                        outcome: "passed",
                        result: {
                            node: node.authored_id
                        },
                        stdout: "",
                        stderr: ""
                    };
                },
                agent: async (context) => {
                    const { workspace_path, execution_dir } = context;
                    counter += 1;
                    await writeFile(join(workspace_path, "counter.txt"), `${counter}\n`);
                    await writeFile(join(resolveExecutionArtifactsDirectory(execution_dir), "notes.md"), `iteration ${counter}\n`);
                    const result = {
                        status: "passed",
                        outcome: "passed",
                        result: {
                            counter
                        },
                        stdout: "",
                        stderr: ""
                    };
                    await markExecutorRuntimeReady(context, result);
                    return result;
                },
                check: async ({ workspace_path }) => {
                    const currentCounter = Number((await readFile(join(workspace_path, "counter.txt"), "utf8")).trim());
                    const passed = currentCounter >= 2;
                    return {
                        status: passed ? "passed" : "failed",
                        outcome: passed ? "passed" : "failed",
                        result: {
                            passed,
                            currentCounter
                        },
                        stdout: JSON.stringify({
                            passed,
                            currentCounter
                        }),
                        stderr: "",
                        check: {
                            check_kind: "deterministic",
                            passed,
                            summary: passed ? "verification passed" : "retry required"
                        }
                    };
                }
            }
        });
        expect(run.outcome).toBe("passed");
        expect(run.attempts.filter((attempt) => ["a", "b"].includes(attempt.authored_id)).map((attempt) => attempt.authored_id).sort()).toEqual([
            "a",
            "b"
        ]);
        expect(maxParallel).toBeGreaterThanOrEqual(1);
        expect(maxParallel).toBeLessThanOrEqual(2);
        expect(run.state.status).toBe("passed");
        expect(run.attempts[0]?.execution_dir).toMatch(/\/nodes\/\d{3}-[^/]+-[0-9a-f]{12}\/executions\/001-exec-[0-9a-f]{16}$/);
        expect(run.state.repeat_scopes.scope__root__retry.latest_iteration_index).toBe(2);
        expect(run.state.repeat_scopes.scope__root__retry.status).toBe("passed");
        expect(run.attempts.filter((attempt) => attempt.authored_id === "implement").map((attempt) => ({
            iteration_index: attempt.iteration_index,
            iteration_attempt_index: attempt.iteration_attempt_index,
            execution_dir: attempt.execution_dir
        }))).toEqual([
            {
                iteration_index: 1,
                iteration_attempt_index: 1,
                execution_dir: expect.stringMatching(/\/executions\/i001-a001-exec-[0-9a-f]{16}$/)
            },
            {
                iteration_index: 2,
                iteration_attempt_index: 1,
                execution_dir: expect.stringMatching(/\/executions\/i002-a001-exec-[0-9a-f]{16}$/)
            }
        ]);
        expect(run.attempts.filter((attempt) => attempt.authored_id === "verify").map((attempt) => attempt.outcome)).toEqual(["failed", "passed"]);
        expect(run.events.map((event) => event.type)).toEqual(expect.arrayContaining([
            "run.started",
            "repeat.iteration.started",
            "repeat.iteration.completed",
            "node.completed",
            "run.completed"
        ]));
        expect(await readFile(join(repoDir, "counter.txt"), "utf8")).toContain("2");
        expect(JSON.parse(await readFile(join(runRoot, "run.json"), "utf8"))).toEqual(expect.objectContaining({
            run_id: run.run_id,
            graph_id: "runtime-engine",
            launch_profile: "default",
            workspace_backend: "inplace",
            status: "passed",
            ended_at: expect.any(String)
        }));
        expect(JSON.parse(await readFile(join(runRoot, "execution_manifest.json"), "utf8"))).toEqual(expect.objectContaining({
            run_id: run.run_id,
            repo_workspaces: {
                main: expect.objectContaining({
                    repo_alias: "main",
                    source_path: repoDir,
                    workspace_path: repoDir,
                    backend: "inplace"
                })
            }
        }));
        expect(await pathExists(join(runRoot, "repos"))).toBe(false);
        await Promise.all(run.attempts.map(async (attempt) => {
            expect(await pathExists(resolveExecutionArtifactsDirectory(attempt.execution_dir))).toBe(true);
        }));
        const summary = await readFile(join(runRoot, "summary.md"), "utf8");
        expect(summary).toContain("- Control-flow status: `passed`");
        expect(summary).toContain("- Evidence status: `clean`");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("continues past a soft-failing exec verifier and records evidence warnings", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-soft-exec-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-soft-exec",
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
                        type: "exec",
                        id: "verify",
                        command: "sh",
                        args: ["-lc", "exit 7"],
                        on_failure: "continue"
                    },
                    {
                        type: "exec",
                        id: "after",
                        command: "sh",
                        args: ["-lc", "exit 0"]
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            }
        });
        const verifyAttempt = run.attempts.find((attempt) => attempt.authored_id === "verify");
        expect(run.outcome).toBe("passed");
        expect(run.state.node_statuses.root__verify).toBe("passed");
        expect(run.state.node_statuses.root__after).toBe("passed");
        expect(run.state.evidence_status).toBe("warnings");
        expect(run.state.soft_verification_counts).toEqual({
            passed: 0,
            failed: 1
        });
        expect(run.state.failed_soft_verifications).toEqual(expect.arrayContaining([
            expect.objectContaining({
                authored_id: "verify",
                verifier_kind: "exec",
                passed: false,
                exit_code: 7
            })
        ]));
        expect(JSON.parse(await readFile(verifyAttempt!.result_path!, "utf8"))).toEqual(expect.objectContaining({
            soft_verification: true,
            verifier_kind: "exec",
            passed: false,
            exit_code: 7
        }));
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "verification.recorded",
                compiled_id: "root__verify",
                payload: expect.objectContaining({
                    verifier_kind: "exec",
                    passed: false,
                    exit_code: 7
                })
            })
        ]));
        const summary = await readFile(join(runRoot, "summary.md"), "utf8");
        expect(summary).toContain("- Evidence status: `warnings`");
        expect(summary).toContain("## Failed Soft Verifications");
        expect(summary).toContain("Command exited with code 7.");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("continues past a soft deterministic check failure and keeps check evidence visible", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-soft-check-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-soft-check",
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
                        id: "verify",
                        check_kind: "deterministic",
                        command: "sh",
                        args: ["-lc", "exit 2"],
                        pass_if: {
                            exit_code: 0
                        },
                        on_failure: "continue"
                    },
                    {
                        type: "exec",
                        id: "after",
                        command: "sh",
                        args: ["-lc", "exit 0"]
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            }
        });
        const verifyAttempt = run.attempts.find((attempt) => attempt.authored_id === "verify");
        expect(run.outcome).toBe("passed");
        expect(run.state.node_statuses.root__verify).toBe("passed");
        expect(run.state.evidence_status).toBe("warnings");
        expect(run.state.soft_verification_counts.failed).toBe(1);
        expect(JSON.parse(await readFile(verifyAttempt!.result_path!, "utf8"))).toEqual(expect.objectContaining({
            soft_verification: true,
            verifier_kind: "check",
            check_kind: "deterministic",
            passed: false,
            exit_code: 2,
            summary: "Deterministic check failed: expected exit code 0, received 2."
        }));
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "check.evaluated",
                payload: expect.objectContaining({
                    check_kind: "deterministic",
                    passed: false,
                    summary: "Deterministic check failed: expected exit code 0, received 2."
                })
            }),
            expect.objectContaining({
                type: "verification.recorded",
                payload: expect.objectContaining({
                    verifier_kind: "check",
                    check_kind: "deterministic",
                    passed: false,
                    summary: "Deterministic check failed: expected exit code 0, received 2."
                })
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("keeps operational exec failures hard even when on_failure is continue", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-soft-exec-hard-failure-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-soft-exec-hard-failure",
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
                        type: "exec",
                        id: "verify",
                        command: "definitely-missing-command",
                        on_failure: "continue"
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            }
        });
        const verifyAttempt = run.attempts.find((attempt) => attempt.authored_id === "verify");
        expect(run.outcome).toBe("failed");
        expect(run.state.supervisor.pause).toBeUndefined();
        expect(run.state.node_statuses.root__verify).toBe("failed");
        expect(run.state.evidence_status).toBe("clean");
        expect(run.events.some((event) => event.type === "verification.recorded")).toBe(false);
        expect(JSON.parse(await readFile(verifyAttempt!.result_path!, "utf8"))).toEqual(expect.objectContaining({
            error: expect.stringContaining("definitely-missing-command")
        }));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("creates artifacts only when workspace outputs are materialized", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-workspace-output-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-workspace-output",
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
                        type: "exec",
                        id: "produce-report",
                        command: "placeholder",
                        artifacts: {
                            report: {
                                from: "workspace",
                                path: "reports/report.md",
                                description: "Test artifact produced at reports/report.md."
                            }
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ workspace_path, node }) => {
                    await mkdir(join(workspace_path, "reports"), { recursive: true });
                    await writeFile(join(workspace_path, "reports", "report.md"), `report for ${node.authored_id}\n`);
                    return {
                        status: "passed",
                        outcome: "passed",
                        result: {
                            node: node.authored_id
                        },
                        stdout: "",
                        stderr: ""
                    };
                }
            }
        });
        const attempt = run.attempts[0];
        const copiedArtifactPath = join(attempt!.execution_dir, "artifacts", "reports", "report.md");
        expect(run.outcome).toBe("passed");
        expect(attempt?.artifacts).toEqual(expect.objectContaining({
            report: copiedArtifactPath
        }));
        expect(await pathExists(join(attempt!.execution_dir, "artifacts"))).toBe(true);
        expect(await readFile(copiedArtifactPath, "utf8")).toBe("report for produce-report\n");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("passes authored intent and launch policy into default agent harness invocations", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-intent-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-agent-intent",
            intent: {
                goal: "Ship a controlled refactor.",
                acceptance_criteria: ["The harness receives the run contract."],
                constraints: ["Do not mutate generated files."]
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
                    sandbox: "read-only",
                    model: "gpt-test",
                    reasoning_effort: "high",
                    skip_git_repo_check: true
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
                            goal: "Produce the review handoff.",
                            acceptance_criteria: ["The handoff explains validation."],
                            constraints: []
                        },
                        artifacts: {}
                    }
                ]
            }
        });
        const invocations: Parameters<HarnessAdapter["run"]>[0][] = [];
        const harness = createHarness("codex-cli", async (invocation) => {
            invocations.push(invocation);
            return {
                status: "passed",
                exitCode: 0,
                stdout: "stdout fallback",
                stderr: "",
                transcript: {
                    last_message: "agent final response"
                },
                metadata: {
                    session_id: "agent-1"
                }
            };
        });
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
        const attempt = run.attempts.find((candidate) => candidate.authored_id === "implement");
        expect(run.outcome).toBe("passed");
        expect(invocations[0]).toEqual(expect.objectContaining({
            promptKind: "agent",
            sandbox: "read-only",
            skipGitRepoCheck: true,
            model: "gpt-test",
            reasoningEffort: "high",
            graphGoal: "Ship a controlled refactor.",
            graphAcceptanceCriteria: ["The harness receives the run contract."],
            graphConstraints: ["Do not mutate generated files."],
            nodeGoal: "Produce the review handoff.",
            nodeAcceptanceCriteria: ["The handoff explains validation."]
        }));
        expect(renderHarnessPrompt(invocations[0]!)).not.toContain(invocations[0]?.outputDir);
        expect(attempt?.metadata).toEqual(expect.objectContaining({
            session_id: "agent-1"
        }));
        expect(await readFile(attempt!.artifacts.agent_response!, "utf8")).toBe("agent final response\n");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("lets exec nodes publish declared output_dir artifacts through the runtime environment", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-output-dir-env-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-output-dir-env",
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
                        type: "exec",
                        id: "produce_handoff",
                        command: process.execPath,
                        args: [
                            "-e",
                            [
                                "const fs = require('node:fs');",
                                "const path = require('node:path');",
                                "const payload = {",
                                "  workspace: process.env.AGENTFLOW_WORKSPACE,",
                                "  output_dir: process.env.AGENTFLOW_OUTPUT_DIR,",
                                "  packet_exists: fs.existsSync(process.env.AGENTFLOW_CONTEXT_PACKET),",
                                "  manifest_exists: fs.existsSync(process.env.AGENTFLOW_CONTEXT_MANIFEST)",
                                "};",
                                "fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR, 'handoff.json'), JSON.stringify(payload));"
                            ].join(" ")
                        ],
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.json",
                                description: "Test artifact produced at handoff.json."
                            }
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            }
        });
        const attempt = run.attempts[0]!;
        const handoff = JSON.parse(await readFile(attempt.artifacts.handoff!, "utf8"));
        expect(run.outcome).toBe("passed");
        expect(attempt.artifacts.handoff).toBe(join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "handoff.json"));
        expect(handoff).toEqual({
            workspace: repoDir,
            output_dir: resolveExecutionArtifactsDirectory(attempt.execution_dir),
            packet_exists: true,
            manifest_exists: true
        });
        await expect(access(join(attempt.execution_dir, "handoff.json"))).rejects.toThrow();
        await rm(tempRoot, { recursive: true, force: true });
    }, 120000);
    it("exposes per-context AGENTFLOW_CONTEXT_<UPPER_NAME> env vars to exec nodes", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-context-env-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-context-env",
            repos: { main: { path: "." } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: { default: {} },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "produce_seed",
                        command: process.execPath,
                        args: [
                            "-e",
                            [
                                "const fs = require('node:fs');",
                                "const path = require('node:path');",
                                "fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR, 'seed.txt'), 'hello-context');"
                            ].join(" ")
                        ],
                        artifacts: {
                            seed: {
                                from: "output_dir",
                                path: "seed.txt",
                                description: "Seed payload for the consumer."
                            }
                        }
                    },
                    {
                        type: "exec",
                        id: "consume_seed",
                        command: process.execPath,
                        args: [
                            "-e",
                            [
                                "const fs = require('node:fs');",
                                "const path = require('node:path');",
                                "const seedPath = process.env.AGENTFLOW_CONTEXT_SEED_PAYLOAD;",
                                "const payload = {",
                                "  seed_path: seedPath,",
                                "  seed_text: seedPath ? fs.readFileSync(seedPath, 'utf8') : null",
                                "};",
                                "fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR, 'consume.json'), JSON.stringify(payload));"
                            ].join(" ")
                        ],
                        artifacts: {
                            consume: {
                                from: "output_dir",
                                path: "consume.json",
                                description: "Consumer payload that captures the context pointer path."
                            }
                        },
                        support: {
                            context: [
                                { kind: "artifact", ref: "produce_seed.seed", name: "seed_payload", what: "Pointer evidence used by the node under test.", why: "This context is required by the test scenario." }
                            ]
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir }
        });
        expect(run.outcome).toBe("passed");
        const consumeAttempt = run.attempts.find((attempt) => attempt.authored_id === "consume_seed");
        expect(consumeAttempt).toBeDefined();
        const consume = JSON.parse(await readFile(consumeAttempt!.artifacts.consume!, "utf8"));
        expect(typeof consume.seed_path).toBe("string");
        expect(consume.seed_path.length).toBeGreaterThan(0);
        expect(consume.seed_text).toBe("hello-context");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not accept execution directory files as output_dir artifacts", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-output-dir-root-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-output-dir-root",
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
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "execution_root_writer",
                        command: "placeholder",
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Markdown handoff for downstream nodes."
                            }
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ execution_dir }) => {
                    await writeFile(join(execution_dir, "handoff.md"), "execution root handoff\n");
                    return {
                        status: "passed",
                        outcome: "passed",
                        result: { ok: true },
                        stdout: "",
                        stderr: ""
                    };
                }
            }
        });
        const attempt = run.attempts[0]!;
        expect(run.outcome).toBe("failed");
        expect(await readFile(join(attempt.execution_dir, "handoff.md"), "utf8")).toBe("execution root handoff\n");
        expect(attempt.artifacts.handoff).toBeUndefined();
        expect(attempt.artifacts.result_json).toBeUndefined();
        expect(JSON.parse(await readFile(attempt.result_path!, "utf8"))).toEqual({
            error: 'Required output_dir artifact "handoff" is missing at handoff.md.'
        });
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("passes declared artifact contracts into agent harness invocations", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-artifact-contract-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-agent-artifact-contract",
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
                        id: "package_handoff",
                        intent: {
                            goal: "Write the handoff file.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Test artifact produced at handoff.md."
                            }
                        }
                    }
                ]
            }
        });
        let capturedInvocation: Parameters<HarnessAdapter["run"]>[0] | undefined;
        const harness = createHarness("codex-cli", async (invocation) => {
            capturedInvocation = invocation;
            await writeFile(join(invocation.outputDir, "handoff.md"), "handoff\n");
            return {
                status: "passed",
                exitCode: 0,
                transcript: {
                    last_message: "published handoff"
                }
            };
        });
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
        const attempt = run.attempts[0]!;
        expect(run.outcome).toBe("passed");
        expect(capturedInvocation?.promptKind).toBe("agent");
        expect(capturedInvocation).toEqual(expect.objectContaining({
            repoPath: repoDir,
            outputDir: resolveExecutionArtifactsDirectory(attempt.execution_dir),
            artifacts: {
                handoff: {
                    from: "output_dir",
                    path: "handoff.md",
                    description: "Test artifact produced at handoff.md."
                }
            }
        }));
        expect(await pathExists(capturedInvocation!.outputDir)).toBe(true);
        expect(attempt.artifacts.handoff).toBe(join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "handoff.md"));
        expect(await readFile(attempt.artifacts.handoff!, "utf8")).toBe("handoff\n");
        expect(attempt.artifacts.agent_response).toBe(join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "agent-response.md"));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("substitutes AGENTFLOW_ tokens in agent prompts before invoking the harness", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-prompt-substitution-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-agent-prompt-substitution",
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
                        id: "write_with_paths",
                        intent: {
                            goal: [
                                "Save your draft to ${AGENTFLOW_OUTPUT_DIR}/draft.md.",
                                "The workspace lives at $AGENTFLOW_WORKSPACE.",
                                "The packet path is AGENTFLOW_CONTEXT_PACKET.",
                                "An unrelated identifier $AGENTFLOW_WORKSPACE_OTHER must remain literal.",
                                "Unknown tokens like $AGENTFLOW_DOES_NOT_EXIST must remain literal."
                            ].join("\n"),
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            draft: {
                                from: "output_dir",
                                path: "draft.md",
                                description: "Draft written to the output directory."
                            }
                        }
                    }
                ]
            }
        });
        let capturedInvocation: Parameters<HarnessAdapter["run"]>[0] | undefined;
        const harness = createHarness("codex-cli", async (invocation) => {
            capturedInvocation = invocation;
            await writeFile(join(invocation.outputDir, "draft.md"), "draft\n");
            return {
                status: "passed",
                exitCode: 0,
                transcript: { last_message: "wrote draft" }
            };
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": harness }
        });
        const attempt = run.attempts[0]!;
        const expectedOutputDir = resolveExecutionArtifactsDirectory(attempt.execution_dir);
        expect(run.outcome).toBe("passed");
        expect(capturedInvocation).toBeDefined();
        const renderedPrompt = renderHarnessPrompt(capturedInvocation!);
        expect(renderedPrompt).toContain(`Save your draft to ${expectedOutputDir}/draft.md.`);
        expect(renderedPrompt).toContain(`The workspace lives at ${repoDir}.`);
        expect(renderedPrompt).toMatch(/The packet path is .+\/runtime\/context\.json\./);
        expect(renderedPrompt).toContain("$AGENTFLOW_WORKSPACE_OTHER must remain literal.");
        expect(renderedPrompt).toContain("$AGENTFLOW_DOES_NOT_EXIST must remain literal.");
        expect(renderedPrompt).not.toContain("$AGENTFLOW_OUTPUT_DIR");
        expect(renderedPrompt).not.toContain("${AGENTFLOW_OUTPUT_DIR}");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("repairs missing agent artifacts before finalizing the node", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-artifact-repair-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-agent-artifact-repair",
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
                        id: "write_handoff",
                        intent: {
                            goal: "Write a handoff after inspecting the repo.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifact_repair: {
                            max_attempts: 2
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Markdown handoff for downstream nodes."
                            }
                        }
                    }
                ]
            }
        });
        const invocations: Parameters<HarnessAdapter["run"]>[0][] = [];
        const harness = createHarness("codex-cli", async (invocation) => {
            invocations.push(invocation);
            if (invocation.executionId.endsWith("__repair_artifact_2")) {
                await writeFile(join(invocation.outputDir, "handoff.md"), "repaired handoff\n");
            }
            return {
                status: "passed",
                exitCode: 0,
                stdout: `stdout for ${invocation.executionId}`,
                stderr: "",
                transcript: {
                    last_message: invocation.executionId.includes("__repair_artifact_")
                        ? "repair response"
                        : "initial response"
                }
            };
        });
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
        const attempt = run.attempts[0]!;
        const artifactsRoot = resolveExecutionArtifactsDirectory(attempt.execution_dir);
        expect(run.outcome).toBe("passed");
        expect(invocations).toHaveLength(3);
        expect(invocations.map((invocation) => invocation.executionId)).toEqual([
            attempt.execution_id,
            `${attempt.execution_id}__${attempt.execution_id}__repair_artifact_1`,
            `${attempt.execution_id}__${attempt.execution_id}__repair_artifact_2`
        ]);
        const repairPrompt = renderHarnessPrompt(invocations[1]!);
        expect(invocations[1]?.promptKind).toBe("artifact_repair");
        expect(repairPrompt).toContain("## Repair Task");
        expect(repairPrompt).toContain("## Missing Artifacts");
        expect(repairPrompt).toContain("Write a handoff after inspecting the repo.");
        expect(repairPrompt).not.toContain("expected absolute path");
        expect(attempt.artifacts.handoff).toBe(join(artifactsRoot, "handoff.md"));
        expect(await readFile(attempt.artifacts.handoff!, "utf8")).toBe("repaired handoff\n");
        expect(attempt.metadata.artifact_repair).toEqual({
            status: "passed",
            max_attempts: 2,
            attempt_count: 2,
            missing_artifacts: []
        });
        expect(run.events.filter((event) => event.type === "supervisor.decision")).toHaveLength(2);
        expect(run.events.filter((event) => event.type === "supervisor.intervention.started")).toHaveLength(2);
        expect(run.events.filter((event) => event.type === "supervisor.intervention.failed")).toHaveLength(1);
        expect(run.events.filter((event) => event.type === "supervisor.intervention.completed")).toHaveLength(1);
        expect(await pathExists(join(resolveInterventionDirectory(attempt.execution_dir, `${attempt.execution_id}__repair_artifact_1`), "prompt.md"))).toBe(true);
        expect(await pathExists(join(resolveInterventionDirectory(attempt.execution_dir, `${attempt.execution_id}__repair_artifact_2`), "result.json"))).toBe(true);
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("reports only the artifacts that were missing before a repair attempt", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-artifact-repair-partial-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-agent-artifact-repair-partial",
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
                        id: "write_handoff",
                        intent: {
                            goal: "Write summary and handoff artifacts.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            summary: {
                                from: "output_dir",
                                path: "summary.md",
                                description: "Summary already produced by the initial attempt."
                            },
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Handoff repaired by the supervisor."
                            }
                        }
                    }
                ]
            }
        });
        const harness = createHarness("codex-cli", async (invocation) => {
            if (invocation.executionId.includes("__repair_artifact_")) {
                await writeFile(join(invocation.outputDir, "handoff.md"), "repaired handoff\n");
            }
            else {
                await writeFile(join(invocation.outputDir, "summary.md"), "initial summary\n");
            }
            return {
                status: "passed",
                exitCode: 0,
                stdout: "",
                stderr: "",
                transcript: {
                    last_message: "done"
                }
            };
        });
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
        const attempt = run.attempts[0]!;
        expect(run.outcome).toBe("passed");
        expect(await readFile(attempt.artifacts.summary!, "utf8")).toBe("initial summary\n");
        expect(await readFile(attempt.artifacts.handoff!, "utf8")).toBe("repaired handoff\n");
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "supervisor.intervention.completed",
                compiled_id: "root__write_handoff",
                payload: expect.objectContaining({
                    repaired_artifacts: ["handoff"]
                })
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("accepts a repair attempt when the missing artifact exists after the harness returns failed", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-artifact-repair-failed-status-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-agent-artifact-repair-failed-status",
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
                        id: "write_handoff",
                        intent: {
                            goal: "Write a handoff.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Markdown handoff for downstream nodes."
                            }
                        }
                    }
                ]
            }
        });
        const harness = createHarness("codex-cli", async (invocation) => {
            if (invocation.executionId.includes("__repair_artifact_")) {
                await writeFile(join(invocation.outputDir, "handoff.md"), "handoff from failed repair\n");
                return {
                    status: "failed",
                    exitCode: 1,
                    stdout: "repair wrote the artifact but exited nonzero",
                    stderr: "nonzero",
                    transcript: {
                        last_message: "repair failed after writing"
                    }
                };
            }
            return {
                status: "passed",
                exitCode: 0,
                stdout: "initial",
                stderr: "",
                transcript: {
                    last_message: "initial response"
                }
            };
        });
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
        const attempt = run.attempts[0]!;
        expect(run.outcome).toBe("passed");
        expect(await readFile(attempt.artifacts.handoff!, "utf8")).toBe("handoff from failed repair\n");
        expect(attempt.metadata.artifact_repair).toEqual({
            status: "passed",
            max_attempts: 1,
            attempt_count: 1,
            missing_artifacts: []
        });
        expect(run.events.filter((event) => event.type === "supervisor.intervention.failed")).toHaveLength(0);
        expect(run.events.filter((event) => event.type === "supervisor.intervention.completed")).toHaveLength(1);
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("surfaces previous attempt artifacts to artifact repair prompts", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-artifact-repair-previous-attempt-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-agent-artifact-repair-previous-attempt",
            supervision: { profile: "supervisor", max_total_interventions: 2 },
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
                        id: "write_handoff",
                        intent: {
                            goal: "Write a durable handoff.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Markdown handoff for downstream nodes."
                            }
                        }
                    }
                ]
            }
        });
        const invocations: Parameters<HarnessAdapter["run"]>[0][] = [];
        const harness = createHarness("codex-cli", async (invocation) => {
            invocations.push(invocation);
            if (invocation.executionId.includes("__repair_artifact_")) {
                await writeFile(join(invocation.outputDir, "handoff.md"), "repaired from previous attempt evidence\n");
                return {
                    status: "passed",
                    exitCode: 0,
                    transcript: { last_message: "repair wrote handoff" }
                };
            }
            if (invocations.filter((entry) => entry.promptKind === "agent").length === 1) {
                await writeFile(join(invocation.outputDir, "handoff.md"), "first attempt handoff evidence\n");
                return {
                    status: "failed",
                    exitCode: 1,
                    stderr: "synthetic failure after writing handoff",
                    transcript: { last_message: "wrote handoff but failed validation" }
                };
            }
            return {
                status: "passed",
                exitCode: 0,
                transcript: { last_message: "passed but forgot to write handoff" }
            };
        });
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
        expect(run.outcome).toBe("passed");
        const attempts = run.attempts.filter((attempt) => attempt.authored_id === "write_handoff");
        expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "passed"]);
        const repairInvocation = invocations.find((invocation) => invocation.promptKind === "artifact_repair");
        expect(repairInvocation).toBeDefined();
        const repairPrompt = renderHarnessPrompt(repairInvocation!);
        const firstAttemptHandoffPath = join(resolveExecutionArtifactsDirectory(attempts[0]!.execution_dir), "handoff.md");
        expect(repairPrompt).toContain("Previous attempts for this same node");
        expect(repairPrompt).toContain(firstAttemptHandoffPath);
        expect(attempts[0]!.artifacts.handoff).toBe(firstAttemptHandoffPath);
        expect(await readFile(attempts[0]!.artifacts.handoff!, "utf8")).toBe("first attempt handoff evidence\n");
        expect(await readFile(attempts[1]!.artifacts.handoff!, "utf8")).toBe("repaired from previous attempt evidence\n");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("writes a diagnostic agent response artifact when an agent returns no final text", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-empty-agent-response-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-empty-agent-response",
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
                        id: "silent_agent",
                        intent: {
                            goal: "Return nothing.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                agent: async (context) => {
                    const result = {
                        status: "passed" as const,
                        outcome: "passed" as const,
                        result: { ok: true },
                        stdout: "",
                        stderr: "",
                        agent_response: ""
                    };
                    await markExecutorRuntimeReady(context, result);
                    return result;
                }
            }
        });
        const attempt = run.attempts[0]!;
        expect(run.outcome).toBe("passed");
        expect(attempt.artifacts.agent_response).toBe(join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "agent-response.md"));
        expect(await readFile(attempt.artifacts.agent_response!, "utf8")).toBe("No final response was captured from the agent harness.\n");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not synthesize missing Markdown handoff artifacts from the completed agent response", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-response-artifact-recovery-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-agent-response-artifact-recovery",
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
                        id: "write_handoff",
                        intent: {
                            goal: "Implement the checkout timeout change and produce reviewer evidence.",
                            acceptance_criteria: [
                                "The final handoff explains what changed.",
                                "The final handoff lists validation performed."
                            ],
                            constraints: []
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Human-readable handoff recovered from completed work when safe."
                            }
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                agent: async () => ({
                    status: "passed",
                    outcome: "passed",
                    result: { ok: true },
                    stdout: "stdout fallback",
                    stderr: "",
                    agent_response: [
                        "Outcome: passed",
                        "Work completed: Implemented checkout timeout handling.",
                        "Validation: npm test -- checkout"
                    ].join("\n")
                })
            }
        });
        const attempt = run.attempts[0]!;
        expect(run.outcome).toBe("failed");
        expect(attempt.status).toBe("failed");
        expect(attempt.artifacts.handoff).toBeUndefined();
        expect(attempt.metadata.completion).toEqual(expect.objectContaining({
            completion_status: "incomplete",
            blocking_reasons: expect.arrayContaining([
                expect.stringContaining("Missing expected artifact: handoff")
            ])
        }));
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "supervisor.decision",
                compiled_id: "root__write_handoff",
                payload: expect.objectContaining({
                    classification: "artifact_contract_failure",
                    action: "repair_artifact"
                })
            })
        ]));
        await expect(readFile(join(runRoot, "interventions.jsonl"), "utf8")).resolves.toContain('"action":"repair_artifact"');
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not synthesize the same agent response into multiple missing artifacts", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-response-multi-artifact-recovery-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-agent-response-multi-artifact-recovery",
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
                        id: "write_handoff",
                        intent: {
                            goal: "Produce separate human handoff artifacts.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            change_map: {
                                from: "output_dir",
                                path: "change-map.md",
                                description: "Human-readable change map."
                            },
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Human-readable reviewer handoff."
                            }
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                agent: async () => ({
                    status: "passed",
                    outcome: "passed",
                    result: { ok: true },
                    stdout: "",
                    stderr: "",
                    agent_response: "Implemented the requested change and ran tests."
                })
            }
        });
        const attempt = run.attempts[0]!;
        const artifactDir = resolveExecutionArtifactsDirectory(attempt.execution_dir);
        expect(run.outcome).toBe("failed");
        expect(attempt.metadata.artifact_repair).toEqual({
            status: "failed",
            max_attempts: 1,
            attempt_count: 1,
            missing_artifacts: ["change_map", "handoff"]
        });
        expect(await pathExists(join(artifactDir, "change-map.md"))).toBe(false);
        expect(await pathExists(join(artifactDir, "handoff.md"))).toBe(false);
        await expect(readFile(join(runRoot, "interventions.jsonl"), "utf8")).resolves.not.toContain('"repair_strategy":"synthesize_from_agent_response"');
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("keeps the automatic agent response artifact when declared artifact materialization fails", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-response-materialization-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-agent-response-materialization",
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
                        id: "write_handoff",
                        intent: {
                            goal: "Write a handoff.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.json",
                                description: "Machine-readable handoff that must not be synthesized from prose."
                            }
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                agent: async () => ({
                    status: "passed",
                    outcome: "passed",
                    result: { ok: true },
                    stdout: "stdout fallback",
                    stderr: "",
                    agent_response: "final response"
                })
            }
        });
        const attempt = run.attempts[0];
        expect(run.outcome).toBe("failed");
        expect(attempt?.status).toBe("failed");
        expect(attempt?.artifacts).toEqual(expect.objectContaining({
            agent_response: join(resolveExecutionArtifactsDirectory(attempt!.execution_dir), "agent-response.md")
        }));
        expect(await readFile(attempt!.artifacts.agent_response!, "utf8")).toBe("final response\n");
        expect(JSON.parse(await readFile(attempt!.result_path!, "utf8"))).toEqual({
            error: "Required artifact contract is missing after 1 artifact repair attempt: handoff at handoff.json.",
            failure_code: "artifact_contract_failure"
        });
        expect(attempt?.metadata.artifact_repair).toEqual({
            status: "failed",
            max_attempts: 1,
            attempt_count: 1,
            missing_artifacts: ["handoff"]
        });
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "supervisor.intervention.started",
                compiled_id: "root__write_handoff"
            }),
            expect.objectContaining({
                type: "supervisor.intervention.failed",
                compiled_id: "root__write_handoff",
                payload: expect.objectContaining({
                    summary: "Artifact repair could not run because the resolved harness adapter is unavailable."
                })
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails a node cleanly when required context cannot be resolved at runtime", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-context-failure-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-context-failure",
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
                        type: "exec",
                        id: "source",
                        command: "placeholder"
                    },
                    {
                        type: "exec",
                        id: "consumer",
                        command: "placeholder",
                        support: {
                            context: [
                                {
                                    kind: "artifact",
                                    ref: "source.agent_response",
                                    name: "missing_artifact",
                                    what: "Pointer evidence used by the node under test.",
                                    why: "This context is required by the test scenario."
                                }
                            ]
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ node }) => ({
                    status: "passed",
                    outcome: "passed",
                    result: {
                        node: node.authored_id
                    },
                    stdout: "",
                    stderr: ""
                })
            }
        });
        const consumerAttempt = run.attempts.find((attempt) => attempt.authored_id === "consumer");
        expect(run.outcome).toBe("failed");
        expect(consumerAttempt?.status).toBe("failed");
        expect(consumerAttempt?.result_path).toBeDefined();
        expect(JSON.parse(await readFile(consumerAttempt!.result_path!, "utf8"))).toEqual({
            error: 'Required context artifact is missing for "source".',
            failure_code: "unresolved_context",
            details: {
                node: "source",
                artifact: "agent_response"
            }
        });
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails when a file input escapes the repo root at runtime", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-input-escape-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(join(tempRoot, "secret.txt"), "outside\n");
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-input-escape",
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
                        id: "reader",
                        intent: {
                            goal: "Read the input.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        support: {
                            context: [
                                {
                                    name: "secret",
                                    kind: "workspace_file",
                                    path: "../secret.txt",
                                    what: "Pointer evidence used by the node under test.",
                                    why: "This context is required by the test scenario."
                                }
                            ]
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                agent: async () => ({
                    status: "passed",
                    outcome: "passed",
                    result: {},
                    stdout: "",
                    stderr: ""
                })
            }
        });
        expect(run.outcome).toBe("failed");
        expect(run.attempts).toHaveLength(1);
        expect(run.state.node_statuses.root__reader).toBe("failed");
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "node.completed",
                compiled_id: "root__reader"
            })
        ]));
        expect((run.attempts[0]?.metadata as {
            error?: string;
        } | undefined)?.error).toContain('Context path "../secret.txt" must be a relative path that stays within its repo or workspace root.');
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails when exec cwd escapes the workspace root", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-cwd-escape-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-cwd-escape",
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
                        type: "exec",
                        id: "escape",
                        command: "pwd",
                        cwd: "../outside"
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            }
        });
        expect(run.outcome).toBe("failed");
        expect(run.attempts[0]?.status).toBe("failed");
        expect(run.attempts[0]?.metadata.error).toContain('cwd "../outside" must be a relative path that stays within its repo or workspace root.');
        expect(run.attempts[0]?.metadata.failure_code).toBe("graph_contract_gap");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails when exec env_files use repo-qualified paths at runtime", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-env-files-escape-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-env-files-escape",
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
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "escape",
                        command: "pwd",
                        env_files: ["main:.env"]
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            }
        });
        expect(run.outcome).toBe("failed");
        expect(run.attempts[0]?.status).toBe("failed");
        expect(run.attempts[0]?.metadata.error).toContain('env_files entry "main:.env" must be a relative path that stays within its repo or workspace root.');
        expect(run.attempts[0]?.metadata.failure_code).toBe("graph_contract_gap");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("marks downstream nodes blocked after a terminal failure outside repeat scopes", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-failure-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-terminal-failure",
            supervision: { profile: "supervisor", max_total_interventions: 0 },
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
                        type: "exec",
                        id: "build",
                        command: "placeholder"
                    },
                    {
                        type: "exec",
                        id: "handoff",
                        command: "placeholder"
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ node }) => ({
                    status: node.authored_id === "build" ? "failed" : "passed",
                    outcome: node.authored_id === "build" ? "failed" : "passed",
                    result: {
                        node: node.authored_id
                    },
                    stdout: "",
                    stderr: node.authored_id === "build" ? "build failed" : ""
                })
            }
        });
        expect(run.outcome).toBe("failed");
        expect(run.state.status).toBe("failed");
        expect(run.state.node_statuses.root__build).toBe("failed");
        expect(run.state.node_statuses.root__handoff).toBe("blocked");
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "node.blocked",
                payload: expect.objectContaining({
                    reason: "terminal_failure",
                    upstream_compiled_id: "root__build"
                })
            }),
            expect.objectContaining({
                type: "run.completed",
                payload: expect.objectContaining({
                    outcome: "failed"
                })
            })
        ]));
        expect(run.attempts.map((attempt) => attempt.authored_id)).toEqual(["build"]);
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("cancels sibling executions when a parallel node causes terminal failure", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-terminal-cancel-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-terminal-cancel",
            supervision: { profile: "supervisor", max_total_interventions: 0 },
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
                        type: "parallel",
                        id: "fanout",
                        max_concurrency: 2,
                        steps: [
                            {
                                type: "exec",
                                id: "fail_fast",
                                command: "placeholder"
                            },
                            {
                                type: "exec",
                                id: "long_running",
                                command: "placeholder"
                            }
                        ]
                    },
                    {
                        type: "exec",
                        id: "after_failure",
                        command: "placeholder"
                    }
                ]
            }
        });
        let longRunningCanceled = false;
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ node, signal }) => {
                    if (node.authored_id === "fail_fast") {
                        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
                        return {
                            status: "failed",
                            outcome: "failed",
                            result: {
                                node: node.authored_id
                            },
                            stdout: "",
                            stderr: "boom"
                        };
                    }
                    if (node.authored_id === "long_running") {
                        await new Promise<void>((resolveCancel, rejectCancel) => {
                            const timeout = setTimeout(() => {
                                rejectCancel(new Error("long_running executor was not canceled"));
                            }, 5000);
                            if (signal?.aborted) {
                                longRunningCanceled = true;
                                clearTimeout(timeout);
                                resolveCancel();
                                return;
                            }
                            signal?.addEventListener("abort", () => {
                                longRunningCanceled = true;
                                clearTimeout(timeout);
                                resolveCancel();
                            }, { once: true });
                        });
                        return {
                            status: "canceled",
                            result: {
                                node: node.authored_id
                            },
                            stdout: "",
                            stderr: ""
                        };
                    }
                    return {
                        status: "passed",
                        outcome: "passed",
                        result: {
                            node: node.authored_id
                        },
                        stdout: "",
                        stderr: ""
                    };
                }
            }
        });
        const longRunningAttempt = run.attempts.find((attempt) => attempt.authored_id === "long_running");
        expect(run.outcome).toBe("failed");
        expect(longRunningCanceled).toBe(true);
        expect(run.state.status).toBe("failed");
        expect(run.state.node_statuses.root__fanout__fail_fast).toBe("failed");
        expect(run.state.node_statuses.root__fanout__long_running).toBe("canceled");
        expect(run.state.node_statuses.root__after_failure).toBe("blocked");
        expect(longRunningAttempt?.status).toBe("canceled");
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "node.canceled",
                compiled_id: "root__fanout__long_running",
                payload: expect.objectContaining({
                    reason: "terminal_failure"
                })
            }),
            expect.objectContaining({
                type: "run.completed",
                payload: expect.objectContaining({
                    outcome: "failed"
                })
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("cancels active execution attempts and skips pending nodes when the run signal aborts", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-cancel-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-cancel",
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
                        type: "exec",
                        id: "long_running",
                        command: "placeholder"
                    },
                    {
                        type: "exec",
                        id: "after_cancel",
                        command: "placeholder"
                    }
                ]
            }
        });
        const controller = new AbortController();
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            signal: controller.signal,
            executors: {
                exec: async ({ node, signal }) => {
                    if (node.authored_id === "long_running") {
                        setTimeout(() => controller.abort(), 10);
                        if (!signal?.aborted) {
                            await new Promise<void>((resolveAbort) => {
                                signal?.addEventListener("abort", () => resolveAbort(), { once: true });
                            });
                        }
                        return {
                            status: "canceled",
                            result: {
                                node: node.authored_id
                            },
                            stdout: "",
                            stderr: ""
                        };
                    }
                    return {
                        status: "passed",
                        outcome: "passed",
                        result: {
                            node: node.authored_id
                        },
                        stdout: "",
                        stderr: ""
                    };
                }
            }
        });
        expect(run.outcome).toBe("canceled");
        expect(run.state.status).toBe("canceled");
        expect(run.state.node_statuses.root__long_running).toBe("canceled");
        expect(run.state.node_statuses.root__after_cancel).toBe("skipped");
        expect(run.state.counts.canceled).toBe(1);
        expect(run.state.counts.skipped).toBe(1);
        expect(run.events.map((event) => event.type)).toEqual(expect.arrayContaining([
            "node.canceled",
            "node.skipped",
            "run.canceled"
        ]));
        expect(run.events.some((event) => event.type === "run.completed")).toBe(false);
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails a reachable agent when a required harness binary is unavailable", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-preflight-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-preflight-harness",
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
                        id: "implement",
                        intent: {
                            goal: "Attempt a harness run.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const missingBinary = join(tempRoot, "missing-codex");
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            harnesses: {
                "codex-cli": createCodexCliHarness({
                    binary: missingBinary
                })
            }
        });
        const attempt = run.attempts.find((candidate) => candidate.authored_id === "implement");
        expect(run.outcome).toBe("failed");
        expect(run.attempts).toHaveLength(1);
        expect(run.state.status).toBe("failed");
        expect(run.events).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "run.preflight_failed"
            })
        ]));
        expect(attempt?.metadata).toEqual(expect.objectContaining({
            error: expect.stringContaining(`codex-cli harness binary "${missingBinary}" is unavailable.`),
            context_status: "failed"
        }));
        expect(JSON.parse(await readFile(join(runRoot, "run.json"), "utf8"))).toEqual(expect.objectContaining({
            run_id: run.run_id,
            graph_id: "runtime-preflight-harness",
            launch_profile: "default",
            workspace_backend: "inplace",
            status: "failed",
            ended_at: expect.any(String)
        }));
        const summary = await readFile(join(runRoot, "summary.md"), "utf8");
        expect(summary).toContain(`codex-cli harness binary "${missingBinary}" is unavailable.`);
        expect(summary).not.toContain("No node executions were recorded.");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails a reachable checkpoint when no checkpoint executor is configured", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-checkpoint-preflight-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-preflight-checkpoint",
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
                        type: "repeat",
                        id: "retry",
                        max_attempts: 2,
                        body: {
                            type: "sequence",
                            id: "body",
                            steps: [
                                {
                                    type: "exec",
                                    id: "draft",
                                    command: "placeholder",
                                    artifacts: {
                                        draft_spec: {
                                            from: "output_dir",
                                            path: "draft.md",
                                            description: "Test artifact produced at draft.md."
                                        }
                                    }
                                },
                                {
                                    type: "checkpoint",
                                    id: "review",
                                    intent: {
                                        goal: "Review the draft.",
                                        acceptance_criteria: ["The node satisfies its acceptance criteria."],
                                        constraints: []
                                    },
                                    review_from: {
                                        node: "draft",
                                        artifact: "draft_spec"
                                    }
                                }
                            ]
                        },
                        until: {
                            node: "review"
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ execution_dir }) => {
                    await writeFile(join(resolveExecutionArtifactsDirectory(execution_dir), "draft.md"), "draft\n");
                    return {
                        status: "passed",
                        outcome: "passed",
                        stdout: "",
                        stderr: "",
                        result: { ok: true }
                    };
                }
            }
        });
        const draftAttempt = run.attempts.find((candidate) => candidate.authored_id === "draft");
        const reviewAttempt = run.attempts.find((candidate) => candidate.authored_id === "review");
        expect(run.outcome).toBe("failed");
        expect(draftAttempt?.status).toBe("passed");
        expect(reviewAttempt?.status).toBe("failed");
        expect(reviewAttempt?.metadata).toEqual(expect.objectContaining({
            error: expect.stringContaining("requires a checkpoint executor"),
            context_status: "failed"
        }));
        expect(run.events).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "run.preflight_failed"
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("records AI harness launch errors as failed check evaluations", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-ai-check-failure-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-ai-check-harness-failure",
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
                        id: "judge",
                        check_kind: "ai",
                        intent: {
                            goal: "Evaluate the latest patch.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const failingHarness = createHarness("codex-cli", async () => {
            throw new Error("spawnSync codex ETIMEDOUT");
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            harnesses: {
                "codex-cli": failingHarness
            }
        });
        const judgeAttempt = run.attempts.find((attempt) => attempt.authored_id === "judge");
        expect(run.outcome).toBe("failed");
        expect(run.state.node_statuses.root__judge).toBe("failed");
        expect(judgeAttempt?.status).toBe("failed");
        expect(judgeAttempt?.result_path).toBeDefined();
        expect(JSON.parse(await readFile(judgeAttempt!.result_path!, "utf8"))).toEqual(expect.objectContaining({
            passed: false,
            summary: expect.stringContaining("spawnSync codex ETIMEDOUT")
        }));
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "check.evaluated",
                compiled_id: "root__judge",
                payload: expect.objectContaining({
                    check_kind: "ai",
                    passed: false,
                    summary: expect.stringContaining("spawnSync codex ETIMEDOUT")
                })
            })
        ]));
        expect(await readFile(join(runRoot, "summary.md"), "utf8")).toContain("spawnSync codex ETIMEDOUT");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("uses supervisor classification to retry retryable node failures", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-supervisor-retry-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-supervisor-retry",
            supervision: { profile: "supervisor", max_total_interventions: 1 },
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
                        type: "exec",
                        id: "flaky",
                        command: "placeholder"
                    }
                ]
            }
        });
        let calls = 0;
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async () => {
                    calls += 1;
                    if (calls === 1) {
                        return {
                            status: "failed",
                            outcome: "failed",
                            result: { error: "operation timed out", timed_out: true },
                            stdout: "",
                            stderr: "operation timed out"
                        };
                    }
                    return {
                        status: "passed",
                        outcome: "passed",
                        result: { ok: true },
                        stdout: "retry passed",
                        stderr: ""
                    };
                }
            }
        });
        const attempts = run.attempts.filter((attempt) => attempt.authored_id === "flaky");
        expect(run.outcome).toBe("passed");
        expect(calls).toBe(2);
        expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "passed"]);
        expect(run.state.supervisor.budget_remaining.max_total_interventions).toBe(0);
        expect(run.state.supervisor.intervention_count).toBe(1);
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "supervisor.decision",
                compiled_id: "root__flaky",
                payload: expect.objectContaining({
                    classification: "diagnostic_needed",
                    action: "run_diagnostic",
                    target_execution_id: attempts[0]!.execution_id
                })
            }),
            expect.objectContaining({
                type: "supervisor.intervention.started",
                compiled_id: "root__flaky",
                payload: expect.objectContaining({
                    action: "run_diagnostic",
                    target_compiled_id: "root__flaky"
                })
            }),
            expect.objectContaining({
                type: "supervisor.intervention.completed",
                compiled_id: "root__flaky",
                payload: expect.objectContaining({
                    action: "run_diagnostic",
                    target_compiled_id: "root__flaky"
                })
            })
        ]));
        await expect(readFile(join(runRoot, "interventions.jsonl"), "utf8")).resolves.toContain('"action":"run_diagnostic"');
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("retries failed agent attempts without replacing the harness failure with missing artifacts", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-runtime-artifact-failure-retry-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-artifact-failure-retry",
            supervision: { profile: "supervisor", max_total_interventions: 2 },
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
                        id: "writer",
                        intent: {
                            goal: "Write the handoff artifact.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Required handoff."
                            }
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        });
        const invocations: string[] = [];
        let nodeInvocations = 0;
        const harness = createHarness("codex-cli", async (invocation) => {
            invocations.push(invocation.executionId);
            if (invocation.promptKind === "supervisor_evidence") {
                return {
                    status: "passed",
                    exitCode: 0,
                    outputJson: {
                        claims: ["The failed node can be retried with the unchanged artifact contract."],
                        retry_guidance: ["Write the handoff artifact during the retried node attempt."],
                        conflicts: [],
                        confidence: "high"
                    }
                };
            }
            nodeInvocations += 1;
            if (nodeInvocations === 2) {
                await writeFile(join(invocation.outputDir, "handoff.md"), "handoff after retry\n");
            }
            return {
                status: nodeInvocations === 1 ? "failed" : "passed",
                exitCode: nodeInvocations === 1 ? 1 : 0,
                stdout: "",
                stderr: "",
                transcript: {
                    last_message: nodeInvocations === 1
                        ? "failed before writing handoff"
                        : "wrote handoff"
                }
            };
        });
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
        const attempts = run.attempts.filter((attempt) => attempt.authored_id === "writer");
        expect(run.outcome).toBe("passed");
        expect(nodeInvocations).toBe(2);
        expect(attempts).toHaveLength(2);
        expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "passed"]);
        expect(run.state.supervisor.budget_remaining.max_total_interventions).toBe(1);
        await expect(readFile(attempts[0]!.result_path!, "utf8")).resolves.toContain("exit_code");
        await expect(readFile(attempts[0]!.stderr_log_path!, "utf8")).resolves.toBe("");
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "supervisor.decision",
                compiled_id: "root__writer",
                payload: expect.objectContaining({
                    classification: "completion_contract_failure",
                    action: "retry_with_guidance",
                    target_execution_id: attempts[0]!.execution_id
                })
            })
        ]));
        await expect(readFile(join(runRoot, "interventions.jsonl"), "utf8")).resolves.toContain('"action":"retry_with_guidance"');
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails no-op harness completions with missing declared artifacts without untyped pause", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-runtime-noop-harness-artifact-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-noop-harness-artifact",
            supervision: { profile: "supervisor", max_total_interventions: 3 },
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
                        id: "writer",
                        intent: {
                            goal: "Write the handoff artifact.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Required handoff."
                            }
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        });
        const harness = createHarness("codex-cli", async () => ({
            status: "passed",
            exitCode: 0,
            stdout: "",
            stderr: "",
            transcript: {}
        }));
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
        const attempts = run.attempts.filter((attempt) => attempt.authored_id === "writer");
        expect(run.outcome).toBe("failed");
        expect(run.state.status).toBe("failed");
        expect(run.state.supervisor.pause).toBeUndefined();
        expect(attempts.length).toBeGreaterThanOrEqual(1);
        expect(attempts[0]?.status).toBe("failed");
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "supervisor.decision",
                compiled_id: "root__writer",
                payload: expect.objectContaining({
                    classification: "harness_unavailable",
                    action: "run_diagnostic",
                    target_execution_id: attempts[0]!.execution_id
                })
            })
        ]));
        expect(run.events).toEqual(expect.not.arrayContaining([
            expect.objectContaining({
                type: "supervisor.paused"
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not retry unsupported Cursor sandbox launch configuration", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-runtime-cursor-sandbox-unsupported-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-cursor-sandbox-unsupported",
            supervision: { profile: "supervisor", max_total_interventions: 3 },
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
                    harness: "cursor-cli"
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "writer",
                        intent: {
                            goal: "Write the handoff artifact.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Required handoff."
                            }
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        });
        let launches = 0;
        const harness = createHarness("cursor-cli", async () => {
            launches += 1;
            return {
                status: "failed",
                exitCode: 1,
                stderr: "Sandbox mode is enabled but not available on this system. Run with sandbox disabled.",
                metadata: {
                    error: "Cursor CLI structured output failed: stdout was not a JSON object.\nCursor CLI stderr:\nSandbox mode is enabled but not available on this system. Run with sandbox disabled.",
                    failure_code: "harness_configuration_unsupported"
                }
            };
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            harnesses: {
                "cursor-cli": harness
            }
        });
        const attempts = run.attempts.filter((attempt) => attempt.authored_id === "writer");
        expect(run.outcome).toBe("failed");
        expect(launches).toBe(1);
        expect(attempts).toHaveLength(1);
        expect(run.state.supervisor.pause).toBeUndefined();
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "supervisor.decision",
                compiled_id: "root__writer",
                payload: expect.objectContaining({
                    classification: "harness_unavailable",
                    action: "fail",
                    target_execution_id: attempts[0]!.execution_id
                })
            })
        ]));
        expect(run.events).toEqual(expect.not.arrayContaining([
            expect.objectContaining({
                type: "supervisor.intervention.started"
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails silent failed harness exits with missing declared artifacts without untyped pause", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-runtime-silent-harness-artifact-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-silent-harness-artifact",
            supervision: { profile: "supervisor", max_total_interventions: 3 },
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
                        id: "writer",
                        intent: {
                            goal: "Write the handoff artifact.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Required handoff."
                            }
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        });
        const harness = createHarness("codex-cli", async () => ({
            status: "failed",
            exitCode: 1,
            stdout: "",
            stderr: "",
            transcript: {}
        }));
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
        const attempts = run.attempts.filter((attempt) => attempt.authored_id === "writer");
        expect(run.outcome).toBe("failed");
        expect(run.state.status).toBe("failed");
        expect(run.state.supervisor.pause).toBeUndefined();
        expect(attempts.length).toBeGreaterThanOrEqual(1);
        expect(attempts[0]?.status).toBe("failed");
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "supervisor.decision",
                compiled_id: "root__writer",
                payload: expect.objectContaining({
                    classification: "harness_unavailable",
                    action: "run_diagnostic",
                    target_execution_id: attempts[0]!.execution_id
                })
            })
        ]));
        expect(run.events).toEqual(expect.not.arrayContaining([
            expect.objectContaining({
                type: "supervisor.paused"
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("injects supervisor recovery envelopes into retry context and prompts", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-recovery-envelope-context-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-supervisor-recovery-envelope-context",
            supervision: { profile: "supervisor", max_total_interventions: 2 },
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
                        id: "recover",
                        intent: {
                            goal: "Implement the feature without guessing about ambiguous runtime evidence.",
                            acceptance_criteria: ["The retry must use supervisor evidence before passing."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const invocations: Parameters<HarnessAdapter["run"]>[0][] = [];
        const nodeInvocations: Parameters<HarnessAdapter["run"]>[0][] = [];
        const evidenceInvocations: Parameters<HarnessAdapter["run"]>[0][] = [];
        const harness = createHarness("codex-cli", async (invocation) => {
            invocations.push(invocation);
            if (invocation.promptKind === "supervisor_evidence") {
                evidenceInvocations.push(invocation);
                return {
                    status: "passed",
                    exitCode: 0,
                    outputJson: {
                        claims: ["Recovered evidence for the failed attempt."],
                        retry_guidance: ["Read the supervisor recovery envelope before retrying."],
                        conflicts: [],
                        confidence: "high"
                    }
                };
            }
            nodeInvocations.push(invocation);
            if (nodeInvocations.length <= 2) {
                return {
                    status: "failed",
                    exitCode: 1,
                    stderr: "synthetic transient failure",
                    transcript: { last_message: "failed with synthetic transient failure" }
                };
            }
            return {
                status: "passed",
                exitCode: 0,
                transcript: { last_message: "recovered after reading retry guidance" }
            };
        });
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
        expect(run.outcome).toBe("passed");
        expect(nodeInvocations).toHaveLength(3);
        expect(evidenceInvocations.length).toBeGreaterThan(0);
        const secondPrompt = renderHarnessPrompt(nodeInvocations[1]!);
        expect(secondPrompt).toContain("## Supervisor Recovery Case");
        expect(secondPrompt).toContain("## Success Contract (Original Authored Node Task)");
        expect(secondPrompt.indexOf("## Supervisor Recovery Case")).toBeLessThan(secondPrompt.indexOf("## Graph Context"));
        expect(secondPrompt).toContain("Preserve the original node intent, sandbox, repo authority, and declared artifacts.");
        expect(secondPrompt).toContain("Prior attempt artifacts are evidence only");
        const thirdPrompt = renderHarnessPrompt(nodeInvocations[2]!);
        expect(thirdPrompt).toContain("| Repeated symptom count | `2` |");
        const retryManifest = await readFile(nodeInvocations[1]!.contextManifestPath, "utf8");
        expect(retryManifest).toContain("supervisor_recovery_envelope");
        const retryPacket = JSON.parse(await readFile(nodeInvocations[1]!.contextPacketPath, "utf8")) as {
            materials: Array<{
                key: string;
                source: {
                    from?: string;
                    repeated_fingerprint_count?: number;
                };
            }>;
        };
        const retryEnvelopeMaterial = retryPacket.materials.find((material) => material.key === "supervisor_recovery_envelope");
        expect(retryEnvelopeMaterial?.source).toEqual(expect.objectContaining({
            from: "runtime_supervisor_recovery",
            repeated_fingerprint_count: 1
        }));
        expect(run.state.supervisor.active_recovery_envelopes).toEqual({});
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "supervisor.retry_scheduled",
                payload: expect.objectContaining({
                    repeated_fingerprint_count: 1
                })
            }),
            expect.objectContaining({
                type: "supervisor.retry_scheduled",
                payload: expect.objectContaining({
                    repeated_fingerprint_count: 2
                })
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("resolves large authored context as pointers without repair retries", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-context-repair-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const largeContext = `${Array.from({ length: 120 }, (_, index) => `context-token-${index}`).join(" ")}\n`;
        await writeFile(join(repoDir, "first.md"), largeContext, "utf8");
        await writeFile(join(repoDir, "second.md"), largeContext, "utf8");
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-context-repair",
            supervision: { profile: "supervisor", max_total_interventions: 1 },
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
                        id: "recover_context",
                        intent: {
                            goal: "Use the repaired context package and complete the node.",
                            acceptance_criteria: ["The retry receives a context repair overlay."],
                            constraints: []
                        },
                        support: {
                            context: [{ name: "markdown", kind: "workspace_glob", path: "*.md", what: "Pointer evidence used by the node under test.", why: "This context is required by the test scenario." }]
                        }
                    }
                ]
            }
        });
        const invocations: Parameters<HarnessAdapter["run"]>[0][] = [];
        const harness = createHarness("codex-cli", async (invocation) => {
            invocations.push(invocation);
            return {
                status: "passed",
                exitCode: 0,
                transcript: { last_message: "completed with repaired context" }
            };
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": harness }
        });
        expect(run.outcome).toBe("passed");
        expect(invocations).toHaveLength(1);
        const prompt = renderHarnessPrompt(invocations[0]!);
        expect(prompt).not.toContain("## Supervisor Recovery Case");
        expect(prompt).toContain("markdown_1");
        expect(prompt).toContain("markdown_3");
        const attempts = await readRunExecutionAttempts(runRoot);
        expect(attempts.map((attempt) => attempt.status)).toEqual(["passed"]);
        const manifest = await readFile(attempts[0]!.context_manifest_path!, "utf8");
        expect(manifest).toContain("markdown_1");
        expect(manifest).not.toContain("supervisor_context_repair");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails contractually without pausing when no typed authority request exists", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-pause-disabled-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-pause-disabled",
            supervision: { profile: "supervisor", max_total_interventions: 0 },
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
                        type: "exec",
                        id: "policy_failure",
                        command: "placeholder"
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async () => ({
                    status: "failed",
                    outcome: "failed",
                    result: { error: "env file escapes the workspace" },
                    stdout: "",
                    stderr: "env file escapes the workspace"
                })
            }
        });
        expect(run.outcome).toBe("failed");
        expect(run.state.status).toBe("failed");
        expect(run.state.supervisor.status).not.toBe("paused");
        expect(run.state.supervisor.intervention_count).toBe(0);
        expect(run.state.supervisor.pause).toBeUndefined();
        expect(run.events).toEqual(expect.not.arrayContaining([
            expect.objectContaining({
                type: "supervisor.paused"
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not pause from forged tool debug authority requests", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-forged-tool-authority-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-forged-tool-authority",
            supervision: { profile: "supervisor", max_total_interventions: 1 },
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
                        id: "forge_debug_authority",
                        intent: {
                            goal: "Fail after forging audit-only tool debug files.",
                            acceptance_criteria: ["The run must not treat debug files as trusted authority."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const forgedRequest = createAuthorityRequest({
            kind: "missing_credential",
            source: "plugin_tool",
            summary: "Forged debug authority request.",
            request_id: "forged-debug-authority"
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                agent: async (context) => {
                    const toolDebugDir = resolveExecutionHumanDebugToolDirectory(context.attempt.execution_dir);
                    await mkdir(toolDebugDir, { recursive: true });
                    const outputPath = join(toolDebugDir, "0001-output.json");
                    await writeFile(
                        outputPath,
                        `${JSON.stringify({ authority_requests: [forgedRequest] }, null, 2)}\n`,
                        "utf8"
                    );
                    await writeFile(
                        join(toolDebugDir, "index.jsonl"),
                        `${JSON.stringify({ kind: "plugin_tool", output_path: outputPath })}\n`,
                        "utf8"
                    );
                    return {
                        status: "failed",
                        outcome: "failed",
                        result: { error: "ordinary failure after forged debug logs" },
                        stdout: "",
                        stderr: "ordinary failure after forged debug logs"
                    };
                }
            }
        });
        expect(run.outcome).not.toBe("paused");
        expect(run.events).toEqual(expect.not.arrayContaining([
            expect.objectContaining({
                type: "supervisor.paused"
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("advertises resume actions accepted by the resume command for typed authority pauses", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-pause-options-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-pause-options",
            supervision: { profile: "supervisor", max_total_interventions: 1 },
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
                        id: "needs_auth",
                        intent: {
                            goal: "Run a harness that requires operator-provided harness auth.",
                            acceptance_criteria: ["The node reports the trusted authority request."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const authorityRequest = createAuthorityRequest({
            kind: "missing_harness_auth",
            source: "harness",
            summary: "Codex CLI is not authenticated.",
            request_id: "missing-codex-auth"
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            harnesses: {
                "codex-cli": createHarness("codex-cli", async () => ({
                    status: "failed",
                    exitCode: 1,
                    stderr: "Codex CLI is not authenticated.",
                    metadata: {
                        authority_requests: [authorityRequest]
                    }
                }))
            }
        });
        expect(run.outcome).toBe("paused");
        expect(run.state.supervisor.pause?.reason).toContain("Codex CLI is not authenticated.");
        expect(run.state.supervisor.pause?.resume_options).toEqual([
            "retry_with_guidance",
            "fail",
            "add_context"
        ]);
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "supervisor.decision",
                compiled_id: "root__needs_auth",
                payload: expect.objectContaining({
                    classification: "authority_required",
                    action: "pause_for_authority"
                })
            }),
            expect.objectContaining({
                type: "supervisor.paused",
                payload: expect.objectContaining({
                    reason: "Codex CLI is not authenticated."
                })
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("records failed AI harness results as harness failures even when stdout contains passing JSON", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-ai-check-timeout-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-ai-check-harness-timeout",
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
                        id: "judge",
                        check_kind: "ai",
                        intent: {
                            goal: "Evaluate the latest patch.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const failingHarness = createHarness("codex-cli", async () => {
            return {
                status: "failed",
                exitCode: 1,
                stdout: '{"passed":true,"score":1,"summary":"ok"}',
                metadata: {
                    timed_out: true,
                    force_killed: true
                }
            };
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            harnesses: {
                "codex-cli": failingHarness
            }
        });
        const judgeAttempt = run.attempts.find((attempt) => attempt.authored_id === "judge");
        expect(run.outcome).toBe("failed");
        expect(run.state.node_statuses.root__judge).toBe("failed");
        expect(judgeAttempt?.status).toBe("failed");
        expect(JSON.parse(await readFile(judgeAttempt!.result_path!, "utf8"))).toEqual(expect.objectContaining({
            passed: false,
            summary: "AI check harness timed out and required a force kill."
        }));
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "check.evaluated",
                compiled_id: "root__judge",
                payload: expect.objectContaining({
                    check_kind: "ai",
                    passed: false,
                    summary: "AI check harness timed out and required a force kill."
                })
            })
        ]));
        expect(await readFile(join(runRoot, "summary.md"), "utf8")).toContain("AI check harness timed out and required a force kill.");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("continues past a soft AI check failure and records evaluator evidence", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-soft-ai-check-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-soft-ai-check",
            intent: {
                goal: "Exercise soft AI check behavior.",
                acceptance_criteria: ["The run continues while preserving evaluator evidence."],
                constraints: ["The evaluator must stay read-only."]
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
                    reasoning_effort: "low"
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "check",
                        id: "judge",
                        check_kind: "ai",
                        intent: {
                            goal: "Judge whether reviewer evidence is complete against $AGENTFLOW_OUTPUT_DIR.",
                            acceptance_criteria: ["Incomplete evidence is recorded as a warning."],
                            constraints: []
                        },
                        rubric: "Return JSON with pass/fail and issues.",
                        on_failure: "continue"
                    },
                    {
                        type: "exec",
                        id: "after",
                        intent: {
                            goal: "Continue after a non-blocking AI check warning.",
                            acceptance_criteria: ["The continuation command exits successfully."],
                            constraints: []
                        },
                        command: "sh",
                        args: ["-lc", "exit 0"]
                    }
                ]
            }
        });
        const invocations: Parameters<HarnessAdapter["run"]>[0][] = [];
        const softFailingHarness = createHarness("codex-cli", async (invocation) => {
            invocations.push(invocation);
            return {
                status: "passed",
                exitCode: 0,
                stdout: JSON.stringify({
                    passed: false,
                    score: 0.4,
                    summary: "Missing test evidence.",
                    issues: ["No command output was attached."]
                }),
                metadata: {
                    request_id: "judge-1"
                }
            };
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            harnesses: {
                "codex-cli": softFailingHarness
            }
        });
        const judgeAttempt = run.attempts.find((attempt) => attempt.authored_id === "judge");
        expect(run.outcome).toBe("passed");
        expect(run.state.node_statuses.root__judge).toBe("passed");
        expect(run.state.node_statuses.root__after).toBe("passed");
        expect(run.state.evidence_status).toBe("warnings");
        expect(run.state.soft_verification_counts).toEqual({
            passed: 0,
            failed: 1
        });
        expect(invocations[0]).toEqual(expect.objectContaining({
            promptKind: "ai_check",
            sandbox: "read-only",
            model: "gpt-test",
            reasoningEffort: "low",
            graphGoal: "Exercise soft AI check behavior.",
            graphAcceptanceCriteria: ["The run continues while preserving evaluator evidence."],
            graphConstraints: ["The evaluator must stay read-only."],
            nodeGoal: expect.stringContaining("Judge whether reviewer evidence is complete"),
            nodeAcceptanceCriteria: ["Incomplete evidence is recorded as a warning."]
        }));
        const aiPrompt = renderHarnessPrompt(invocations[0]!);
        expect(aiPrompt).toContain("Rubric:");
        expect(aiPrompt).toContain("Return JSON with pass/fail and issues.");
        expect(JSON.parse(await readFile(judgeAttempt!.result_path!, "utf8"))).toEqual(expect.objectContaining({
            soft_verification: true,
            verifier_kind: "check",
            check_kind: "ai",
            passed: false,
            score: 0.4,
            summary: "Missing test evidence.",
            issues: ["No command output was attached."]
        }));
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "verification.recorded",
                compiled_id: "root__judge",
                payload: expect.objectContaining({
                    verifier_kind: "check",
                    check_kind: "ai",
                    passed: false,
                    summary: "Missing test evidence."
                })
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("records canceled AI checks with fallback verification evidence", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-ai-check-canceled-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-ai-check-canceled",
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
                        id: "judge",
                        check_kind: "ai",
                        intent: {
                            goal: "Evaluate the latest patch.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const cancelingHarness = createHarness("codex-cli", async () => ({
            status: "canceled",
            exitCode: 130,
            stdout: "",
            stderr: "",
            metadata: {
                canceled: true
            }
        }));
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            harnesses: {
                "codex-cli": cancelingHarness
            }
        });
        const judgeAttempt = run.attempts.find((attempt) => attempt.authored_id === "judge");
        expect(run.outcome).toBe("canceled");
        expect(run.state.node_statuses.root__judge).toBe("canceled");
        expect(judgeAttempt?.status).toBe("canceled");
        expect(JSON.parse(await readFile(judgeAttempt!.artifacts.verification_json!, "utf8"))).toEqual(expect.objectContaining({
            exit_code: 130,
            passed: false,
            summary: "Check canceled.",
            metadata: {
                canceled: true
            }
        }));
        expect(run.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "node.canceled",
                compiled_id: "root__judge"
            }),
            expect.objectContaining({
                type: "run.canceled"
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("streams agent stdout into human-debug/harness/stdout.log before the node completes", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-streaming-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-streaming",
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
                        id: "stream_logs",
                        intent: {
                            goal: "Stream a partial response before completion.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const agentNode = graph.nodes.find((node) => node.authored_id === "stream_logs");
        expect(agentNode?.kind).toBe("agent");
        const executionId = buildExecutionId(agentNode!.compiled_id, 1);
        const nodeIndex = graph.nodes.findIndex((node) => node.compiled_id === agentNode!.compiled_id);
        const stdoutLogPath = join(resolveNodeExecutionDirectory(runRoot, agentNode!.compiled_id, executionId, {
            nodeIndex,
            nodeCount: graph.nodes.length,
            label: agentNode!.label ?? agentNode!.authored_id,
            attemptIndex: 1
        }), "human-debug", "harness", "stdout.log");
        const harness = createHarness("codex-cli", async (invocation) => {
            invocation.onStdoutChunk?.("partial output\n");
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
            return {
                status: "passed",
                exitCode: 0,
                stdout: "partial output\nfinal output\n",
                stderr: ""
            };
        });
        try {
            const runPromise = runCompiledGraph({
                run_root: runRoot,
                compiled_graph: graph,
                repo_sources: {
                    main: repoDir
                },
                harnesses: {
                    "codex-cli": harness
                }
            });
            await waitFor(async () => {
                try {
                    return (await readFile(stdoutLogPath, "utf8")).includes("partial output");
                }
                catch {
                    return false;
                }
            });
            const run = await runPromise;
            expect(run.outcome).toBe("passed");
            expect(await readFile(stdoutLogPath, "utf8")).toBe("partial output\nfinal output\n");
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
    it("does not fail when an upstream node deletes a downstream authored input file", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-live-input-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(join(repoDir, "watched.txt"), "before\n");
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-live-input-omission",
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
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "delete_file",
                        command: "placeholder",
                        runtime: {
                            repo: "main"
                        }
                    },
                    {
                        type: "exec",
                        id: "consume",
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
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ node, workspace_path, context_packet_path }) => {
                    if (node.authored_id === "delete_file") {
                        await rm(join(workspace_path, "watched.txt"), { force: true });
                        return {
                            status: "passed",
                            outcome: "passed",
                            stdout: "",
                            stderr: "",
                            result: { deleted: true }
                        };
                    }
                    const packet = JSON.parse(await readFile(context_packet_path, "utf8")) as {
                        materials: unknown[];
                        omitted: Array<{
                            key: string;
                            reason: string;
                            if_available: boolean;
                        }>;
                    };
                    expect(packet.materials).toEqual([]);
                    expect(packet.omitted).toEqual(expect.arrayContaining([
                        expect.objectContaining({
                            key: "watched",
                            reason: 'Requested context workspace file "watched.txt" was not found at execution time.',
                            if_available: false
                        })
                    ]));
                    return {
                        status: "passed",
                        outcome: "passed",
                        stdout: "",
                        stderr: "",
                        result: { consumed: true }
                    };
                }
            }
        });
        expect(run.outcome).toBe("passed");
        expect(run.state.node_statuses.root__consume).toBe("passed");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not preflight-fail a blocked node with a bad authored input path", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-blocked-input-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-blocked-input",
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
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "fail_first",
                        command: "placeholder",
                        runtime: {
                            repo: "main"
                        }
                    },
                    {
                        type: "exec",
                        id: "never_runs",
                        command: "placeholder",
                        support: {
                            context: [
                                {
                                    name: "missing",
                                    kind: "workspace_file",
                                    path: "missing.txt",
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
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ node }) => ({
                    status: node.authored_id === "fail_first" ? "failed" : "passed",
                    outcome: node.authored_id === "fail_first" ? "failed" : "passed",
                    stdout: "",
                    stderr: "",
                    result: { node: node.authored_id }
                })
            }
        });
        expect(run.outcome).toBe("failed");
        expect(run.state.node_statuses.root__fail_first).toBe("failed");
        expect(run.state.node_statuses.root__never_runs).toBe("blocked");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("preflight-fails missing declared CLI hints before execution begins", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-prereq-blocked-"));
        const repoDir = join(tempRoot, "repo");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-prereq-blocked",
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
                        id: "ok",
                        support: {
                            cli: [
                                {
                                    cmd: "definitely-missing-command",
                                    description: "Missing command required by this node."
                                }
                            ]
                        }
                    }
                ]
            }
        });
        const readiness = await evaluateGraphReadiness({
            graph,
            repo_sources: {
                main: repoDir
            },
            machine_checks: true,
            harnesses: {
                "codex-cli": createHarness("codex-cli", async () => ({
                    status: "passed",
                    exitCode: 0,
                    transcript: {}
                }))
            }
        });
        expect(readiness.status).toBe("blocked");
        expect(readiness.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "cli",
                status: "blocked",
                message: expect.stringContaining("definitely-missing-command")
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("continues when declared CLI hints are callable", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-prereq-warning-"));
        const repoDir = join(tempRoot, "repo");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-prereq-warning",
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
                        id: "ok",
                        support: {
                            cli: [
                                {
                                    cmd: "sh",
                                    description: "POSIX shell used by this fixture."
                                }
                            ]
                        }
                    }
                ]
            }
        });
        const readiness = await evaluateGraphReadiness({
            graph,
            repo_sources: {
                main: repoDir
            },
            machine_checks: true,
            harnesses: {
                "codex-cli": createHarness("codex-cli", async () => ({
                    status: "passed",
                    exitCode: 0,
                    transcript: {}
                }))
            }
        });
        expect(readiness.status).toBe("ready");
        expect(readiness.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "cli",
                status: "passed",
                message: expect.stringContaining("sh")
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not fail a blocked agent node just because its harness is unavailable", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-blocked-harness-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-blocked-harness",
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
                        type: "exec",
                        id: "fail_first",
                        command: "placeholder",
                        runtime: {
                            repo: "main"
                        }
                    },
                    {
                        type: "agent",
                        id: "never_runs",
                        intent: {
                            goal: "Should stay blocked.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async () => ({
                    status: "failed",
                    outcome: "failed",
                    stdout: "",
                    stderr: "",
                    result: { ok: false }
                })
            }
        });
        expect(run.outcome).toBe("failed");
        expect(run.state.node_statuses.root__fail_first).toBe("failed");
        expect(run.state.node_statuses.root__never_runs).toBe("blocked");
        expect(run.attempts.find((attempt) => attempt.authored_id === "never_runs")).toBeUndefined();
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails a reachable node lazily when harness readiness fails", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-lazy-readiness-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-lazy-readiness",
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
                        id: "implement",
                        intent: {
                            goal: "Implement the change.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            harnesses: {
                "codex-cli": createHarness("codex-cli", async () => ({
                    status: "passed",
                    exitCode: 0
                }), {
                    checkReadiness() {
                        return ['codex-cli harness binary "missing-codex" is unavailable.'];
                    }
                })
            }
        });
        const attempt = run.attempts.find((candidate) => candidate.authored_id === "implement");
        expect(run.outcome).toBe("failed");
        expect(run.state.node_statuses.root__implement).toBe("failed");
        expect(attempt?.status).toBe("failed");
        expect(attempt?.context_packet_path).toBeUndefined();
        expect(JSON.parse(await readFile(attempt!.result_path!, "utf8"))).toEqual({
            error: 'codex-cli harness binary "missing-codex" is unavailable.',
            failure_code: "harness_unavailable"
        });
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not record nonexistent context artifacts when context resolution fails", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-context-error-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "runtime-context-error",
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
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "consume",
                        command: "placeholder",
                        support: {
                            context: [
                                {
                                    name: "escape",
                                    kind: "workspace_file",
                                    path: "../escape.txt",
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
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            }
        });
        const attempt = run.attempts.find((candidate) => candidate.authored_id === "consume");
        const executionRecord = JSON.parse(await readFile(join(resolveExecutionRuntimeDirectory(attempt!.execution_dir), "execution.json"), "utf8")) as Record<string, unknown>;
        expect(run.outcome).toBe("failed");
        expect(attempt?.context_packet_path).toBeUndefined();
        expect(attempt?.context_manifest_path).toBeUndefined();
        expect(executionRecord.context_packet_path).toBeUndefined();
        expect(executionRecord.context_manifest_path).toBeUndefined();
        expect(attempt?.metadata).toEqual(expect.objectContaining({
            context_status: "failed"
        }));
        await rm(tempRoot, { recursive: true, force: true });
    });
});
