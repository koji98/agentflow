import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
function createHarness(run: HarnessAdapter["run"]): HarnessAdapter {
    return {
        kind: "codex-cli",
        capabilities: getHarnessCapabilities("codex-cli")!,
        run,
        async cancel() {
            return;
        }
    };
}
describe("runtime failure modes", () => {
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
