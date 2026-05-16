import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";
import { validateAuthoredGraphDocument } from "../../src/graph/validate.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";
const execFileAsync = promisify(execFile);
const TEST_INTENT = {
    goal: "Exercise cleanup behavior for supervised graph execution.",
    acceptance_criteria: ["Cleanup steps run deterministically and surface accurate diagnostics."]
};
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
        intent: TEST_INTENT,
        ...document
    }));
    expect(normalized.diagnostics).toEqual([]);
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.compiled_graph).toBeDefined();
    return compilation.compiled_graph!;
}
function buildGraphWithCleanup(cleanupSteps: AuthoredGraphDocument["graph"] extends {
    steps: infer Steps;
} ? Steps : never[]): AuthoredGraphDocument {
    return {
        version: "1",
        graph_id: "cleanup-test",
        intent: TEST_INTENT,
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
            default: {}
        },
        graph: {
            type: "sequence",
            id: "root",
            steps: [
                {
                    type: "exec",
                    id: "main_step",
                    command: "placeholder"
                }
            ],
            cleanup: cleanupSteps
        }
    };
}
describe("sequence cleanup compilation", () => {
    it("marks cleanup steps with is_cleanup and exposes cleanup_entry_node_ids on the sequence scope", () => {
        const graph = compileGraph(buildGraphWithCleanup([
            { type: "exec", id: "teardown_a", command: "placeholder" },
            { type: "exec", id: "teardown_b", command: "placeholder" }
        ] as never));
        const teardownA = graph.nodes.find((node) => node.authored_id === "teardown_a")!;
        const teardownB = graph.nodes.find((node) => node.authored_id === "teardown_b")!;
        const mainStep = graph.nodes.find((node) => node.authored_id === "main_step")!;
        expect(teardownA.is_cleanup).toBe(true);
        expect(teardownA.cleanup_scope_id).toBe("scope__root");
        expect(teardownB.is_cleanup).toBe(true);
        expect(mainStep.is_cleanup).toBeUndefined();
        const rootScope = graph.scopes.find((scope) => scope.scope_id === "scope__root");
        expect(rootScope?.kind).toBe("sequence");
        expect(rootScope?.cleanup_entry_node_ids).toEqual([teardownA.compiled_id]);
        expect(rootScope?.cleanup_compiled_node_ids).toEqual([
            teardownA.compiled_id,
            teardownB.compiled_id
        ]);
        const cleanupEdges = graph.edges.filter((edge) => edge.is_cleanup === true);
        expect(cleanupEdges).toEqual([
            expect.objectContaining({
                from: teardownA.compiled_id,
                to: teardownB.compiled_id,
                cleanup_scope_id: "scope__root"
            })
        ]);
        expect(graph.entry_node_ids).toEqual([mainStep.compiled_id]);
    });
});
describe("sequence cleanup validation", () => {
    it("rejects cleanup nested inside another cleanup chain", async () => {
        const diagnostics = await validateAuthoredGraphDocument(withNodeIntentDefaults({
            version: "1",
            graph_id: "nested-cleanup",
            intent: TEST_INTENT,
            repos: {
                main: { path: "." }
            },
            profiles: {
                default: {}
            },
            defaults: {
                launch_profile: "default"
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    { type: "exec", id: "main_step", command: "placeholder" }
                ],
                cleanup: [
                    {
                        type: "sequence",
                        id: "inner_cleanup",
                        steps: [
                            { type: "exec", id: "inner_step", command: "placeholder" }
                        ],
                        cleanup: [
                            { type: "exec", id: "inner_inner", command: "placeholder" }
                        ]
                    }
                ]
            }
        }));
        expect(diagnostics.some((diag) => /cleanup is not allowed inside another cleanup chain/i.test(diag.message))).toBe(true);
    });
});
describe("runtime engine cleanup", () => {
    it("runs cleanup steps after a passing body and reports them in events", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cleanup-pass-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph(buildGraphWithCleanup([
            { type: "exec", id: "teardown_first", command: "placeholder" },
            { type: "exec", id: "teardown_second", command: "placeholder" }
        ] as never));
        const executionOrder: string[] = [];
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ node }) => {
                    executionOrder.push(node.authored_id);
                    return {
                        status: "passed",
                        outcome: "passed",
                        result: { node: node.authored_id },
                        stdout: "",
                        stderr: ""
                    };
                }
            }
        });
        expect(run.outcome).toBe("passed");
        expect(executionOrder).toEqual(["main_step", "teardown_first", "teardown_second"]);
        const cleanupStarted = run.events.find((event) => event.type === "sequence.cleanup.started");
        const cleanupCompleted = run.events.find((event) => event.type === "sequence.cleanup.completed");
        expect(cleanupStarted?.payload).toEqual(expect.objectContaining({
            sequence_authored_id: "root",
            cleanup_step_count: 2,
            body_outcome: "passed"
        }));
        expect(cleanupCompleted?.payload).toEqual(expect.objectContaining({
            sequence_authored_id: "root",
            steps_attempted: 2,
            steps_passed: 2,
            steps_failed: 0,
            steps_skipped: 0
        }));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("runs cleanup after body failure and preserves the failed run outcome", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cleanup-fail-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph(buildGraphWithCleanup([
            { type: "exec", id: "teardown", command: "placeholder" }
        ] as never));
        const executionOrder: string[] = [];
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ node }) => {
                    executionOrder.push(node.authored_id);
                    if (node.authored_id === "main_step") {
                        return {
                            status: "failed",
                            outcome: "failed",
                            result: { node: node.authored_id, reason: "boom" },
                            stdout: "",
                            stderr: ""
                        };
                    }
                    return {
                        status: "passed",
                        outcome: "passed",
                        result: { node: node.authored_id },
                        stdout: "",
                        stderr: ""
                    };
                }
            }
        });
        expect(run.outcome).toBe("failed");
        expect(executionOrder).toEqual(["main_step", "teardown"]);
        const cleanupStarted = run.events.find((event) => event.type === "sequence.cleanup.started");
        expect(cleanupStarted?.payload).toEqual(expect.objectContaining({
            sequence_authored_id: "root",
            body_outcome: "failed"
        }));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("continues to remaining cleanup steps when an earlier cleanup step fails", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cleanup-step-fail-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph(buildGraphWithCleanup([
            { type: "exec", id: "teardown_first", command: "placeholder" },
            { type: "exec", id: "teardown_second", command: "placeholder" }
        ] as never));
        const executionOrder: string[] = [];
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: {
                main: repoDir
            },
            executors: {
                exec: async ({ node }) => {
                    executionOrder.push(node.authored_id);
                    if (node.authored_id === "teardown_first") {
                        return {
                            status: "failed",
                            outcome: "failed",
                            result: { node: node.authored_id, reason: "cleanup boom" },
                            stdout: "",
                            stderr: ""
                        };
                    }
                    return {
                        status: "passed",
                        outcome: "passed",
                        result: { node: node.authored_id },
                        stdout: "",
                        stderr: ""
                    };
                }
            }
        });
        expect(run.outcome).toBe("passed");
        expect(executionOrder).toEqual(["main_step", "teardown_first", "teardown_second"]);
        const stepFailed = run.events.find((event) => event.type === "sequence.cleanup.step_failed");
        expect(stepFailed).toBeDefined();
        const cleanupCompleted = run.events.find((event) => event.type === "sequence.cleanup.completed");
        expect(cleanupCompleted?.payload).toEqual(expect.objectContaining({
            steps_attempted: 2,
            steps_passed: 1,
            steps_failed: 1,
            steps_skipped: 0
        }));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("runs cleanup steps deepest-first across nested sequences", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cleanup-nested-order-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph({
            version: "1",
            graph_id: "cleanup-nested",
            repos: { main: { path: "." } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: { default: {} },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "sequence",
                        id: "inner",
                        steps: [
                            { type: "exec", id: "inner_step", command: "placeholder" }
                        ],
                        cleanup: [
                            { type: "exec", id: "inner_cleanup", command: "placeholder" }
                        ]
                    }
                ],
                cleanup: [
                    { type: "exec", id: "outer_cleanup", command: "placeholder" }
                ]
            }
        });
        const executionOrder: string[] = [];
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            executors: {
                exec: async ({ node }) => {
                    executionOrder.push(node.authored_id);
                    return {
                        status: "passed",
                        outcome: "passed",
                        result: { node: node.authored_id },
                        stdout: "",
                        stderr: ""
                    };
                }
            }
        });
        expect(run.outcome).toBe("passed");
        expect(executionOrder).toEqual([
            "inner_step",
            "inner_cleanup",
            "outer_cleanup"
        ]);
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("cancels mid-cleanup on operator abort and finalizes the run as canceled", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cleanup-cancel-"));
        const repoDir = join(tempRoot, "repo");
        const runRoot = join(tempRoot, "run");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const graph = compileGraph(buildGraphWithCleanup([
            { type: "exec", id: "long_cleanup", command: "placeholder" },
            { type: "exec", id: "follow_up_cleanup", command: "placeholder" }
        ] as never));
        const executionOrder: string[] = [];
        const controller = new AbortController();
        const run = await runCompiledGraph({
            run_root: runRoot,
            compiled_graph: graph,
            repo_sources: { main: repoDir },
            signal: controller.signal,
            executors: {
                exec: async ({ node, signal }) => {
                    executionOrder.push(node.authored_id);
                    if (node.authored_id === "long_cleanup") {
                        setTimeout(() => controller.abort(), 10);
                        await new Promise<void>((resolveAbort) => {
                            if (signal?.aborted) {
                                resolveAbort();
                                return;
                            }
                            signal?.addEventListener("abort", () => resolveAbort(), { once: true });
                        });
                        return {
                            status: "canceled",
                            result: { node: node.authored_id },
                            stdout: "",
                            stderr: ""
                        };
                    }
                    return {
                        status: "passed",
                        outcome: "passed",
                        result: { node: node.authored_id },
                        stdout: "",
                        stderr: ""
                    };
                }
            }
        });
        expect(run.outcome).toBe("canceled");
        expect(executionOrder).toEqual(["main_step", "long_cleanup"]);
        const cleanupCanceled = run.events.find((event) => event.type === "sequence.cleanup.canceled");
        expect(cleanupCanceled?.payload).toEqual(expect.objectContaining({
            sequence_authored_id: "root"
        }));
        await rm(tempRoot, { recursive: true, force: true });
    });
});
