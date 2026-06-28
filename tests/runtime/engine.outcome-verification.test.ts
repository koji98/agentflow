import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    resolveExecutionHumanDebugVerifierDirectory,
    resolveExecutionRuntimeCompletionPacketPath,
    resolveExecutionRuntimeSupervisorDirectory,
    resolveExecutionRuntimeVerifierPath
} from "../../src/artifacts/paths.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";
import { createResumedRuntimeSession } from "../../src/runtime/resume.js";
import { readExecutionManifest } from "../../src/artifacts/reader.js";
import type { AgentInvocation, HarnessAdapter } from "../../src/runtime/harness/types.js";
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
    const normalized = normalizeAuthoredGraphDocument({
        intent: {
            goal: `Exercise ${document.graph_id}.`,
            acceptance_criteria: ["The runtime behavior matches the test contract."]
        },
        ...withNodeIntentDefaults(document)
    });
    expect(normalized.diagnostics).toEqual([]);
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
    expect(compilation.diagnostics).toEqual([]);
    return compilation.compiled_graph!;
}
function fencedJson(payload: Record<string, unknown>): string {
    return ["```json", JSON.stringify(payload, null, 2), "```"].join("\n");
}
function passingVerification(summary = "Verifier accepts."): string {
    return fencedJson({
        passed: true,
        summary,
        findings: [],
        blockers: []
    });
}
function failingVerification(category: string, summary: string): string {
    return fencedJson({
        passed: false,
        summary,
        findings: [
            {
                severity: "blocker",
                category,
                evidence: "Captured agent response does not satisfy the acceptance criteria.",
                recommendation: "Address the blocker and re-run the node."
            }
        ]
    });
}
function harnessOk(invocation: AgentInvocation, lastMessage = "agent done"): Awaited<ReturnType<HarnessAdapter["run"]>> {
    void invocation;
    return {
        status: "passed",
        exitCode: 0,
        transcript: { last_message: lastMessage }
    };
}
function makeAgentGraph(graphId: string, agentNodeId = "implement") {
    return compileGraph({
        version: "1",
        graph_id: graphId,
        intent: {
            goal: `Run ${graphId}.`,
            acceptance_criteria: ["Agent ships the change.", "Outcome verifier accepts the change."]
        },
        repos: { main: { path: "." } },
        defaults: { launch_profile: "default", workspace_backend: "inplace" },
        profiles: { default: { harness: "codex-cli" } },
        graph: {
            type: "sequence",
            id: "root",
            steps: [
                {
                    type: "agent",
                    id: agentNodeId,
                    intent: {
                        goal: "Implement the change such that the verifier passes.",
                        acceptance_criteria: ["The implementation actually does the work."],
                        constraints: []
                    }
                }
            ]
        }
    });
}
function buildHarness(handler: (invocation: AgentInvocation) => Promise<Awaited<ReturnType<HarnessAdapter["run"]>>>): HarnessAdapter {
    return {
        kind: "codex-cli",
        capabilities: getHarnessCapabilities("codex-cli")!,
        async run(invocation) {
            if (invocation.promptKind === "delivery_curator") {
                return createPassingDeliveryHarness().run(invocation);
            }
            const result = await handler(invocation);
            await markInvocationRuntimeReady(invocation, result);
            return result;
        },
        async cancel() {
            return;
        }
    };
}
describe("runtime engine outcome verification", () => {
    it("emits outcome.verified passed=true and persists verify-outcome artifacts when the verifier accepts", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-verify-pass-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = makeAgentGraph("verify-pass");
        let agentCalls = 0;
        let verifierCalls = 0;
        const harness = buildHarness(async (invocation) => {
            if (invocation.promptKind === "delivery_curator") {
                return createPassingDeliveryHarness().run(invocation);
            }
            if (invocation.promptKind === "outcome_verification") {
                verifierCalls += 1;
                return harnessOk(invocation, passingVerification("Verifier OK."));
            }
            agentCalls += 1;
            await writeFile(join(invocation.outputDir, "agent-response.md"), "Agent did the work.\n", "utf8");
            return harnessOk(invocation);
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": harness }
        });
        expect(run.outcome).toBe("passed");
        expect(agentCalls).toBe(1);
        expect(verifierCalls).toBe(1);
        const verifiedEvents = run.events.filter((event) => event.type === "outcome.verified");
        expect(verifiedEvents).toHaveLength(1);
        expect(verifiedEvents[0]?.payload).toEqual(expect.objectContaining({
            passed: true,
            findings_count: 0,
            blockers_count: 0,
            verifier_harness: "codex-cli"
        }));
        const attempt = run.attempts[0]!;
        const verifyJsonPath = resolveExecutionRuntimeVerifierPath(attempt.execution_dir);
        const verifyMdPath = join(resolveExecutionHumanDebugVerifierDirectory(attempt.execution_dir), "verdict.md");
        const parsed = JSON.parse(await readFile(verifyJsonPath, "utf8")) as {
            passed: boolean;
            verifier_metadata: {
                parse_status: string;
                harness: string;
            };
        };
        expect(parsed.passed).toBe(true);
        expect(parsed.verifier_metadata.parse_status).toBe("ok");
        expect(parsed.verifier_metadata.harness).toBe("codex-cli");
        expect(await readFile(verifyMdPath, "utf8")).toContain("Verdict: `passed`");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not synthesize missing declared artifacts from the final response", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-no-synth-artifact-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "no-synth-artifact",
            intent: {
                goal: "Run without synthesizing missing artifacts.",
                acceptance_criteria: ["Declared artifacts are real current-attempt outputs."]
            },
            supervision: {
                profile: "supervisor",
                max_total_interventions: 2
            },
            repos: { main: { path: "." } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: {
                default: { harness: "codex-cli" },
                supervisor: { sandbox: "read-only" }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "implement",
                        intent: {
                            goal: "Write a declared handoff artifact.",
                            acceptance_criteria: ["The handoff artifact exists as a current-attempt artifact."],
                            constraints: []
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Current-attempt handoff."
                            }
                        }
                    }
                ]
            }
        });
        const harness = buildHarness(async (invocation) => {
            if (invocation.promptKind === "outcome_verification") {
                throw new Error("Outcome verifier should not run for mechanically incomplete completion.");
            }
            if (invocation.promptKind === "artifact_repair") {
                throw new Error("Artifact repair harness should not be used for final-response synthesis.");
            }
            return harnessOk(invocation, "The handoff content is only in the final response.");
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": harness }
        });
        expect(run.outcome).not.toBe("passed");
        const attempt = run.attempts[0]!;
        const expectedArtifact = join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "handoff.md");
        await expect(readFile(expectedArtifact, "utf8")).rejects.toThrow();
        const packet = JSON.parse(await readFile(resolveExecutionRuntimeCompletionPacketPath(attempt.execution_dir), "utf8")) as {
            completion_status: string;
            missing_artifacts: string[];
        };
        expect(packet.completion_status).toBe("incomplete");
        expect(packet.missing_artifacts).toEqual(["handoff"]);
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("uses the dedicated supervisor profile for outcome verification when configured", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-verify-supervisor-profile-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "verify-supervisor-profile",
            intent: {
                goal: "Run verifier with dedicated supervisor profile.",
                acceptance_criteria: ["The supervisor verifier accepts."]
            },
            supervision: {
                profile: "supervisor",
                max_total_interventions: 3
            },
            repos: { main: { path: "." } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: {
                default: {
                    harness: "codex-cli",
                    model: "worker-model",
                    reasoning_effort: "low"
                },
                supervisor: {
                    model: "supervisor-model",
                    reasoning_effort: "high",
                    sandbox: "read-only"
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
                            goal: "Write evidence for the verifier.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        }
                    }
                ]
            }
        });
        const invocations: AgentInvocation[] = [];
        const harness = buildHarness(async (invocation) => {
            invocations.push(invocation);
            if (invocation.promptKind === "outcome_verification") {
                return harnessOk(invocation, passingVerification("Supervisor verifier OK."));
            }
            await writeFile(join(invocation.outputDir, "agent-response.md"), "Agent did the work.\n", "utf8");
            return harnessOk(invocation);
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": harness }
        });
        expect(run.outcome).toBe("passed");
        expect(invocations.find((invocation) => invocation.promptKind !== "outcome_verification")).toEqual(expect.objectContaining({
            model: "worker-model",
            reasoningEffort: "low"
        }));
        expect(invocations.find((invocation) => invocation.promptKind === "outcome_verification")).toEqual(expect.objectContaining({
            model: "supervisor-model",
            reasoningEffort: "high",
            sandbox: "read-only",
            timeoutSec: 600
        }));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("includes milestone evidence and keeps workspace diff as supporting evidence in outcome verification", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-verify-decision-log-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "verify-decision-log",
            intent: {
                goal: "Publish a reviewable PR-style handoff.",
                acceptance_criteria: ["The handoff explains the branch, base, and evidence."]
            },
            repos: { main: { path: "." } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: { default: { harness: "codex-cli" } },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "publish_pr",
                        intent: {
                            goal: "Publish a PR-style handoff.",
                            acceptance_criteria: ["The milestone evidence records the branch decision."],
                            constraints: []
                        },
                        artifacts: {
                            pr_handoff: {
                                from: "output_dir",
                                path: "pr-handoff.md",
                                description: "PR URL, base, head, head SHA, checks, and risks."
                            }
                        }
                    }
                ]
            }
        });
        let verifierPrompt = "";
        const harness = buildHarness(async (invocation) => {
            if (invocation.promptKind === "outcome_verification") {
                verifierPrompt = invocation.rubric ?? "";
                return harnessOk(invocation, passingVerification("Verifier accepts PR-style evidence."));
            }
            await mkdir(invocation.runtimeDir!, { recursive: true });
            await appendFile(join(invocation.runtimeDir!, "log.jsonl"), `${JSON.stringify({
                log_id: "log_branch_decision",
                run_id: invocation.runId,
                graph_id: "verify-decision-log",
                agent_id: "publish_pr",
                execution_id: invocation.executionId,
                node_id: "publish_pr",
                compiled_id: "root__publish_pr",
                type: "decision",
                summary: "Use agentflow/p1-example as the PR branch",
                decision: "Use agentflow/p1-example as the PR branch",
                rationale: "The branch name matches the node contract and existing PR evidence.",
                contract_implication: "The handoff must cite the branch, base, and checks evidence.",
                evidence: [
                    {
                        kind: "command_output",
                        ref: "gh pr view 123 --json baseRefName,headRefName,headRefOid",
                        summary: "Matched main, agentflow/p1-example, abc123.",
                        status: "passed"
                    },
                    {
                        kind: "tool_output",
                        ref: "babysit-pr",
                        summary: "babysit-pr passed for abc123.",
                        status: "passed"
                    }
                ],
                created_at: "2026-04-28T12:00:00.000Z"
            })}\n`, "utf8");
            await writeFile(join(repoDir, "README.md"), "seed\nmisleading workspace diff body\n", "utf8");
            await writeFile(join(invocation.outputDir, "pr-handoff.md"), "PR: https://example.invalid/pr/123\nBase: main\nHead: agentflow/p1-example\nHead SHA: abc123\nChecks: passed\n", "utf8");
            await writeFile(join(invocation.outputDir, "agent-response.md"), "PR handoff written.\n", "utf8");
            return harnessOk(invocation, "PR handoff written.");
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": harness }
        });
        expect(run.outcome).toBe("passed");
        expect(verifierPrompt).toContain("## Completion Packet");
        expect(verifierPrompt).toContain("- Status: ready_for_verification");
        expect(verifierPrompt).toContain("- Ready for verification: true");
        expect(verifierPrompt).toContain("## Runtime Decision Evidence");
        expect(verifierPrompt).toContain("Use agentflow/p1-example as the PR branch");
        expect(verifierPrompt).toContain("The branch name matches the node contract and existing PR evidence.");
        expect(verifierPrompt).toContain("The handoff must cite the branch, base, and checks evidence.");
        expect(verifierPrompt).toContain("babysit-pr passed for abc123");
        expect(verifierPrompt).toContain("Workspace diffs are audit/provenance evidence.");
        expect(verifierPrompt).toContain("Diff excerpt: (not inlined by default");
        expect(verifierPrompt).not.toContain("misleading workspace diff body");
        expect(verifierPrompt).toContain("Prefer investigative recommendations over restating blockers.");
        expect(verifierPrompt).toContain("ambiguous_configuration_mismatch");
        expect(verifierPrompt).toContain("irreducible_external_blocker");
        const attempt = run.attempts.find((entry) => entry.authored_id === "publish_pr");
        expect(attempt).toBeDefined();
        const payload = JSON.parse(await readFile(resolveExecutionRuntimeVerifierPath(attempt!.execution_dir), "utf8")) as {
            verifier_metadata: {
                decision_log_count?: number;
            };
        };
        expect(payload.verifier_metadata.decision_log_count).toBe(1);
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("retries the agent once when the verifier rejects, then passes after a corrected attempt", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-verify-fail-then-pass-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = makeAgentGraph("verify-fail-then-pass");
        let agentCalls = 0;
        let verifierCalls = 0;
        const harness = buildHarness(async (invocation) => {
            if (invocation.promptKind === "delivery_curator") {
                return createPassingDeliveryHarness().run(invocation);
            }
            if (invocation.promptKind === "outcome_verification") {
                verifierCalls += 1;
                return harnessOk(invocation, verifierCalls === 1
                    ? failingVerification("incorrect_output", "Agent claimed success but the work is wrong.")
                    : passingVerification("Verifier accepts the corrected attempt."));
            }
            if (invocation.promptKind === "supervisor_evidence") {
                return harnessOk(invocation, JSON.stringify({
                    claims: ["Verifier rejection is actionable without changing the graph contract."],
                    retry_guidance: ["Fix the incorrect output before the next handoff."],
                    conflicts: [],
                    confidence: "high"
                }));
            }
            agentCalls += 1;
            await writeFile(join(invocation.outputDir, "agent-response.md"), `Agent attempt ${agentCalls}\n`, "utf8");
            return harnessOk(invocation);
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": harness }
        });
        expect(run.outcome).toBe("passed");
        expect(agentCalls).toBe(2);
        expect(verifierCalls).toBe(2);
        const verifiedEvents = run.events.filter((event) => event.type === "outcome.verified");
        expect(verifiedEvents.map((event) => (event.payload as {
            passed: boolean;
        }).passed)).toEqual([
            false,
            true
        ]);
        expect(run.state.supervisor.intervention_count).toBeGreaterThanOrEqual(1);
        const implementAttempts = run.attempts.filter((attempt) => attempt.authored_id === "implement");
        expect(implementAttempts.map((attempt) => attempt.outcome)).toEqual(["failed", "passed"]);
        const failingAttempt = implementAttempts[0]!;
        const failingPayload = JSON.parse(await readFile(resolveExecutionRuntimeVerifierPath(failingAttempt.execution_dir), "utf8")) as {
            passed: boolean;
        };
        expect(failingPayload.passed).toBe(false);
        const planPath = join(resolveExecutionRuntimeSupervisorDirectory(failingAttempt.execution_dir), `${failingAttempt.execution_id}__semantic_evaluation`, "recovery-plan.json");
        const planText = await readFile(planPath, "utf8").catch(() => undefined);
        if (planText) {
            expect(planText).toContain("Agent claimed success but the work is wrong.");
        }
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails the run when verifier keeps rejecting until retry budget is exhausted", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-verify-exhaust-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = makeAgentGraph("verify-exhaust");
        let verifierCalls = 0;
        const harness = buildHarness(async (invocation) => {
            if (invocation.promptKind === "outcome_verification") {
                verifierCalls += 1;
                return harnessOk(invocation, failingVerification("incorrect_output", "Verifier keeps rejecting the attempt."));
            }
            await writeFile(join(invocation.outputDir, "agent-response.md"), "Attempted work.\n", "utf8");
            return harnessOk(invocation);
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": harness }
        });
        expect(run.outcome).toBe("failed");
        expect(verifierCalls).toBeGreaterThanOrEqual(2);
        const verifiedEvents = run.events.filter((event) => event.type === "outcome.verified");
        expect(verifiedEvents.length).toBeGreaterThanOrEqual(2);
        for (const event of verifiedEvents) {
            expect((event.payload as {
                passed: boolean;
            }).passed).toBe(false);
        }
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails closed and emits a failure outcome.verified event when the verifier returns malformed JSON", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-verify-malformed-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = makeAgentGraph("verify-malformed");
        const harness = buildHarness(async (invocation) => {
            if (invocation.promptKind === "outcome_verification") {
                return harnessOk(invocation, "I refuse to answer in JSON.");
            }
            await writeFile(join(invocation.outputDir, "agent-response.md"), "Agent finished.\n", "utf8");
            return harnessOk(invocation);
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": harness }
        });
        const failedAttempt = run.attempts.find((attempt) => attempt.authored_id === "implement");
        expect(failedAttempt).toBeDefined();
        const payload = JSON.parse(await readFile(resolveExecutionRuntimeVerifierPath(failedAttempt!.execution_dir), "utf8")) as {
            passed: boolean;
            verifier_metadata: {
                parse_status: string;
                attempt_count: number;
                failure_code?: string;
            };
            findings: Array<{ category: string }>;
        };
        expect(payload.passed).toBe(false);
        expect(payload.verifier_metadata.parse_status).toBe("unparseable");
        expect(payload.verifier_metadata.attempt_count).toBeGreaterThanOrEqual(2);
        expect(payload.verifier_metadata.failure_code).toBe("verification_substrate_failure");
        expect(payload.findings).toEqual([
            expect.objectContaining({ category: "verification_substrate_failure" })
        ]);
        expect(failedAttempt!.metadata.failure_code).toBe("verification_substrate_failure");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails closed when the verifier harness throws", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-verify-harness-error-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = makeAgentGraph("verify-harness-error");
        const harness = buildHarness(async (invocation) => {
            if (invocation.promptKind === "outcome_verification") {
                throw new Error("synthetic verifier harness failure");
            }
            await writeFile(join(invocation.outputDir, "agent-response.md"), "Agent finished.\n", "utf8");
            return harnessOk(invocation);
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": harness }
        });
        const failedAttempt = run.attempts.find((attempt) => attempt.authored_id === "implement");
        expect(failedAttempt).toBeDefined();
        const payload = JSON.parse(await readFile(resolveExecutionRuntimeVerifierPath(failedAttempt!.execution_dir), "utf8")) as {
            passed: boolean;
            verifier_metadata: {
                parse_error?: string;
            };
        };
        expect(payload.passed).toBe(false);
        expect(payload.verifier_metadata.parse_error).toContain("synthetic verifier harness failure");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not run outcome verification for exec and check nodes", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-verify-skip-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "verify-skip-non-agent",
            intent: { goal: "Skip verification for non-agent nodes." },
            repos: { main: { path: "." } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: { default: { harness: "codex-cli" } },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    { type: "exec", id: "build", command: "sh", args: ["-lc", "exit 0"] },
                    {
                        type: "check",
                        id: "verify_build",
                        check_kind: "deterministic",
                        command: "sh",
                        args: ["-lc", "exit 0"]
                    }
                ]
            }
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            executors: {
                exec: async () => ({
                    status: "passed",
                    outcome: "passed",
                    result: {},
                    stdout: "",
                    stderr: ""
                }),
                check: async () => ({
                    status: "passed",
                    outcome: "passed",
                    result: {},
                    stdout: "",
                    stderr: "",
                    check: {
                        check_kind: "deterministic",
                        passed: true,
                        summary: "Check passed."
                    }
                })
            }
        });
        expect(run.outcome).toBe("passed");
        const verifiedEvents = run.events.filter((event) => event.type === "outcome.verified");
        expect(verifiedEvents).toEqual([]);
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("preserves a previously verified attempt across a resume so the verifier is not re-run", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-verify-resume-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = makeAgentGraph("verify-resume");
        let verifierCalls = 0;
        const harness = buildHarness(async (invocation) => {
            if (invocation.promptKind === "outcome_verification") {
                verifierCalls += 1;
                return harnessOk(invocation, passingVerification());
            }
            await writeFile(join(invocation.outputDir, "agent-response.md"), "Agent done.\n", "utf8");
            return harnessOk(invocation);
        });
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": harness }
        });
        expect(run.outcome).toBe("passed");
        expect(verifierCalls).toBe(1);
        const manifest = await readExecutionManifest(runRoot);
        const resumed = await createResumedRuntimeSession({
            run_root: runRoot,
            prior_graph: graph,
            graph,
            manifest,
            prior_state: run.state,
            attempts: run.attempts,
            events: run.events
        });
        expect(resumed.preserved_node_count).toBe(1);
        expect(resumed.restarted_node_count).toBe(0);
        expect(verifierCalls).toBe(1);
        await rm(tempRoot, { recursive: true, force: true });
    });
});
void resolveExecutionArtifactsDirectory;
