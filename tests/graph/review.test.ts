import { describe, expect, it } from "vitest";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { reviewCompiledGraph } from "../../src/graph/review.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";
function compileReviewGraph(value: unknown) {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(value as never));
    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document).toBeDefined();
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.compiled_graph).toBeDefined();
    return {
        document: normalized.document!,
        graph: compilation.compiled_graph!
    };
}
describe("compiled graph authoring review", () => {
    it("includes graph intent findings in the default full review", () => {
        const { document, graph } = compileReviewGraph({
            version: "1",
            graph_id: "review-default-intent",
            intent: {
                goal: "Ship"
            },
            repos: {
                main: {
                    path: "."
                }
            },
            defaults: {
                launch_profile: "default"
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
                        id: "noop",
                        command: "node",
                        args: ["--version"]
                    }
                ]
            }
        });
        const review = reviewCompiledGraph(document, graph);
        expect(review.status).toBe("serious_findings");
        expect(review.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                category: "intent",
                severity: "serious",
                path: "$.intent.acceptance_criteria"
            }),
            expect.objectContaining({
                category: "intent",
                severity: "warning",
                path: "$.intent.goal"
            }),
            expect.objectContaining({
                category: "intent",
                severity: "warning",
                path: "$.intent.constraints"
            })
        ]));
    });
    it("includes deeper node-purpose guidance in the default review", () => {
        const { document, graph } = compileReviewGraph({
            version: "1",
            graph_id: "review-deep-node-guidance",
            intent: {
                goal: "Publish an implementation package for the requested change.",
                acceptance_criteria: ["The package includes a reviewable summary."],
                constraints: ["Stay within the requested change boundary."]
            },
            repos: {
                main: {
                    path: "."
                }
            },
            defaults: {
                launch_profile: "default"
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
                            goal: "Implement the scoped change.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            change_summary: {
                                from: "output_dir",
                                path: "change-summary.md",
                                description: "Implementation summary."
                            }
                        },
                        support: {
                            context: [
                                {
                                    name: "wide_scan",
                                    kind: "workspace_glob",
                                    path: "src/**/*.ts",
                                    max_files: 101,
                                    what: "Pointer evidence used by the node under test.",
                                    why: "This context is required by the test scenario."
                                }
                            ]
                        }
                    }
                ]
            }
        });
        const review = reviewCompiledGraph(document, graph);
        expect(review.mode).toBe("review");
        expect(review.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                category: "context",
                path: "$.graph.steps[0].context[0].max_files"
            })
        ]));
    });
});
