import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { resolveExecutionRuntimeCompletionPacketPath } from "../../src/artifacts/paths.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";
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
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(document));
    expect(normalized.diagnostics).toEqual([]);
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
    expect(compilation.diagnostics).toEqual([]);
    return compilation.compiled_graph!;
}
function harnessOk(invocation: AgentInvocation, lastMessage = "agent done"): Awaited<ReturnType<HarnessAdapter["run"]>> {
    void invocation;
    return {
        status: "passed",
        exitCode: 0,
        transcript: { last_message: lastMessage }
    };
}
function buildHarness(): HarnessAdapter {
    const deliveryHarness = createPassingDeliveryHarness("codex-cli");
    return {
        kind: "codex-cli",
        capabilities: getHarnessCapabilities("codex-cli")!,
        async run(invocation) {
            if (invocation.promptKind === "delivery_curator") {
                return deliveryHarness.run(invocation);
            }

            if (invocation.promptKind === "supervisor_evidence") {
                return harnessOk(invocation, JSON.stringify({
                    claims: ["Managed completion failed because the required criterion still fails."],
                    retry_guidance: ["Change the managed work cycle before retrying the gate."],
                    conflicts: [],
                    confidence: "high"
                }));
            }
            if (invocation.promptKind === "outcome_verification") {
                return harnessOk(invocation, [
                    "```json",
                    JSON.stringify({
                        passed: true,
                        summary: "Private managed helper output is sufficient for the lowered node contract.",
                        findings: []
                    }),
                    "```"
                ].join("\n"));
            }
            if (invocation.nodeGoal.includes("cycle_plan")) {
                await writeFile(join(invocation.outputDir, "cycle-plan.md"), [
                    "Objective",
                    "Plan another managed work cycle.",
                    "",
                    "Relevant evidence",
                    "The required managed criterion still needs execution evidence.",
                    "",
                    "Planned changes",
                    "Keep the next cycle focused on the required criterion.",
                    "",
                    "Validation plan",
                    "Run the managed completion criteria after execution.",
                    "",
                    "Risks or constraints",
                    "Stay inside the authored graph contract."
                ].join("\n"), "utf8");
            }
            if (invocation.nodeGoal.includes("work_notes")) {
                await writeFile(join(invocation.outputDir, "work-notes.md"), "Changed nothing useful.\n", "utf8");
                await writeFile(join(invocation.outputDir, "draft-summary.md"), "Draft summary.\n", "utf8");
                await writeFile(join(invocation.outputDir, "draft-packet.json"), "{\"status\":\"draft\"}\n", "utf8");
            }
            await writeFile(join(invocation.outputDir, "agent-response.md"), "done\n", "utf8");
            const result = harnessOk(invocation);
            await markInvocationRuntimeReady(invocation, result);
            return result;
        },
        async cancel() {
            return;
        }
    };
}
describe("managed supervision monitoring", () => {
    it("escalates repeated no-delta deep-work stalls before exhausting all cycles", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-managed-stall-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "managed-stall",
            intent: {
                goal: "Exercise managed stall detection.",
                acceptance_criteria: ["Repeated no-delta managed failures are supervisor-visible before cycle exhaustion."]
            },
            supervision: {
                profile: "supervisor",
                max_total_interventions: 0
            },
            repos: { main: { path: "." } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: {
                default: { harness: "codex-cli", sandbox: "workspace-write" },
                supervisor: { harness: "codex-cli", sandbox: "read-only" }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "pattern_deep_work",
                        id: "ship_work",
                        intent: {
                            goal: "Do managed work.",
                            acceptance_criteria: ["The required managed criterion passes."],
                            constraints: []
                        },
                        completion: {
                            max_cycles: 3,
                            pass_threshold: 1,
                            criteria: [
                                {
                                    id: "always_fail",
                                    kind: "command",
                                    command: "exit 1",
                                    weight: 1,
                                    required: true
                                }
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
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": buildHarness() }
        });
        expect(run.outcome).toBe("failed");
        const gateAttempts = run.attempts.filter((attempt) => attempt.authored_id.includes("completion_gate"));
        expect(gateAttempts).toHaveLength(2);
        const stalled = run.events.find((event) => event.type === "managed.progress" &&
            typeof event.payload === "object" &&
            event.payload !== null &&
            (event.payload as {
                phase?: string;
            }).phase === "stalled_without_delta");
        expect(stalled?.payload).toEqual(expect.objectContaining({
            status: "stalled_without_delta",
            blocking_criteria: ["always_fail"]
        }));
        expect(run.events.some((event) => event.type === "managed.progress" &&
            typeof event.payload === "object" &&
            event.payload !== null &&
            (event.payload as {
                phase?: string;
            }).phase === "repeat_exhausted")).toBe(false);
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("emits managed completion evidence and invokes supervisor when a deep-work loop exhausts", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-managed-supervision-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "managed-supervision",
            intent: {
                goal: "Exercise managed supervision.",
                acceptance_criteria: ["Managed completion failures are supervisor-visible."]
            },
            supervision: {
                profile: "supervisor",
                max_total_interventions: 1
            },
            repos: { main: { path: "." } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: {
                default: { harness: "codex-cli", sandbox: "workspace-write" },
                supervisor: { harness: "codex-cli", sandbox: "read-only" }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "pattern_deep_work",
                        id: "ship_work",
                        intent: {
                            goal: "Do managed work.",
                            acceptance_criteria: ["The required managed criterion passes."],
                            constraints: []
                        },
                        completion: {
                            max_cycles: 1,
                            pass_threshold: 1,
                            criteria: [
                                {
                                    id: "always_fail",
                                    kind: "command",
                                    command: "exit 1",
                                    weight: 1,
                                    required: true
                                }
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
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            harnesses: { "codex-cli": buildHarness() }
        });
        expect(run.outcome).toBe("failed");
        const exhausted = run.events.find((event) => event.type === "managed.progress" &&
            typeof event.payload === "object" &&
            event.payload !== null &&
            (event.payload as {
                phase?: string;
            }).phase === "repeat_exhausted");
        expect(exhausted?.payload).toEqual(expect.objectContaining({
            completion_status: "incomplete",
            managed_summary: expect.objectContaining({
                managed_kind: "pattern_deep_work",
                failing_required_criteria: ["always_fail"],
                blocking_criteria: ["always_fail"],
                ready_for_publish: false
            })
        }));
        const supervisorDecision = run.events.find((event) => event.type === "supervisor.decision");
        expect(supervisorDecision?.payload).toEqual(expect.objectContaining({
            classification: "completion_contract_failure",
            action: "retry_with_guidance",
            target_compiled_id: expect.stringContaining("generate_validate")
        }));
        const gateAttempt = run.attempts.find((attempt) => attempt.authored_id.includes("completion_gate") &&
            attempt.metadata?.completion &&
            attempt.metadata.completion.completion_status === "incomplete");
        expect(gateAttempt).toBeDefined();
        const packet = JSON.parse(await readFile(resolveExecutionRuntimeCompletionPacketPath(gateAttempt!.execution_dir), "utf8")) as {
            managed: {
                blocking_criteria?: string[];
            };
            blocking_reasons: string[];
        };
        expect(packet.managed.blocking_criteria).toEqual(["always_fail"]);
        expect(packet.blocking_reasons.join("\n")).toContain("Managed completion is not publish-ready");
        await rm(tempRoot, { recursive: true, force: true });
    });
});
