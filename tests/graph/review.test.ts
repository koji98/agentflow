import { describe, expect, it } from "vitest";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { reviewCompiledGraph } from "../../src/graph/review.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";
function compileReviewGraph(value: unknown) {
    const authored = withNodeIntentDefaults(value as never);
    const normalized = normalizeAuthoredGraphDocument(authored);
    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document).toBeDefined();
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.compiled_graph).toBeDefined();
    return {
        authored,
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
    it("flags graph-authoring language in managed pattern prompt-facing fields", () => {
        const { authored, document, graph } = compileReviewGraph({
            version: "1",
            graph_id: "review-managed-prompt-surface",
            intent: {
                goal: "Produce a research-backed implementation plan.",
                acceptance_criteria: ["The final handoffs are useful to reviewers."],
                constraints: ["Do not mutate remote services."]
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
                        type: "pattern_deep_research",
                        id: "research_contract",
                        intent: {
                            goal: "Resolve the implementation contract.",
                            acceptance_criteria: ["The research report supports the implementation decision."],
                            constraints: ["Do not edit source files."]
                        },
                        research: {
                            angles: [
                                {
                                    id: "angle_01",
                                    prompt: "Use pattern_deep_research to create a private angle report for the synthesis node."
                                }
                            ]
                        }
                    },
                    {
                        type: "pattern_work_list",
                        id: "work_items",
                        intent: {
                            goal: "Deliver the bounded implementation work.",
                            acceptance_criteria: ["Every item leaves reviewable evidence."],
                            constraints: ["Do not widen scope."]
                        },
                        work_list: {
                            planning_goal: "Use this node to create work items for the managed pattern.",
                            item_guidance: {
                                what_counts_as_one_item: "One downstream node-ready graph slice.",
                                done_when: [
                                    "The graph-addressable artifact is ready for the downstream node."
                                ]
                            },
                            item_worker: {
                                kind: "agent"
                            }
                        }
                    }
                ]
            }
        });

        const review = reviewCompiledGraph(document, graph, { authored_document: authored });
        expect(review.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                category: "prompt_surface",
                severity: "serious",
                path: "$.graph.steps[0].research.angles[0].prompt"
            }),
            expect.objectContaining({
                category: "prompt_surface",
                severity: "serious",
                path: "$.graph.steps[1].work_list.planning_goal"
            }),
            expect.objectContaining({
                category: "prompt_surface",
                severity: "serious",
                path: "$.graph.steps[1].work_list.item_guidance.what_counts_as_one_item"
            }),
            expect.objectContaining({
                category: "prompt_surface",
                severity: "serious",
                path: "$.graph.steps[1].work_list.item_guidance.done_when[0]"
            })
        ]));
    });
    it("flags graph-authoring language in check rubrics, deep-work criteria, context pointers, and artifact descriptions", () => {
        const { authored, document, graph } = compileReviewGraph({
            version: "1",
            graph_id: "review-runtime-prose-fields",
            intent: {
                goal: "Deliver a focused implementation package.",
                acceptance_criteria: ["The package includes validation evidence."],
                constraints: ["Do not mutate remote services."]
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
                        id: "write_handoff",
                        intent: {
                            goal: "Use this node to write the final handoff.",
                            acceptance_criteria: ["The handoff is ready for review."],
                            constraints: ["Do not change source files."]
                        },
                        support: {
                            context: [
                                {
                                    name: "brief",
                                    kind: "workspace_file",
                                    path: "README.md",
                                    what: "Context for the downstream node.",
                                    why: "This graph should make the handoff easier to review."
                                }
                            ]
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Graph-addressable artifact for downstream nodes."
                            }
                        }
                    },
                    {
                        type: "check",
                        id: "semantic_gate",
                        check_kind: "ai",
                        rubric: "Judge whether the compiled prompt makes the downstream node pass.",
                        intent: {
                            goal: "Review the handoff.",
                            acceptance_criteria: ["The verdict is evidence-backed."],
                            constraints: ["Do not edit files."]
                        }
                    },
                    {
                        type: "pattern_deep_work",
                        id: "deep_work",
                        intent: {
                            goal: "Complete the implementation package.",
                            acceptance_criteria: ["The work passes the criteria."],
                            constraints: ["Do not widen scope."]
                        },
                        completion: {
                            max_cycles: 2,
                            pass_threshold: 0.9,
                            criteria: [
                                {
                                    id: "quality",
                                    kind: "rubric",
                                    target: "workspace",
                                    rubric: "The graph topology is implemented as planned.",
                                    weight: 1,
                                    required: true
                                }
                            ]
                        },
                        phases: {
                            plan: {
                                intent: {
                                    goal: "This prompt will plan the managed pattern cycle."
                                }
                            }
                        }
                    }
                ]
            }
        });

        const review = reviewCompiledGraph(document, graph, { authored_document: authored });
        expect(review.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                category: "prompt_surface",
                severity: "serious",
                path: "$.graph.steps[0].intent.goal"
            }),
            expect.objectContaining({
                category: "prompt_surface",
                severity: "warning",
                path: "$.graph.steps[0].support.context[0].what"
            }),
            expect.objectContaining({
                category: "prompt_surface",
                severity: "warning",
                path: "$.graph.steps[0].support.context[0].why"
            }),
            expect.objectContaining({
                category: "prompt_surface",
                severity: "warning",
                path: "$.graph.steps[0].artifacts.handoff.description"
            }),
            expect.objectContaining({
                category: "prompt_surface",
                severity: "serious",
                path: "$.graph.steps[1].rubric"
            }),
            expect.objectContaining({
                category: "prompt_surface",
                severity: "serious",
                path: "$.graph.steps[2].completion.criteria[0].rubric"
            }),
            expect.objectContaining({
                category: "prompt_surface",
                severity: "serious",
                path: "$.graph.steps[2].phases.plan.intent.goal"
            })
        ]));
    });
    it("does not flag Agentflow product language when it is not graph-authoring mechanics", () => {
        const { authored, document, graph } = compileReviewGraph({
            version: "1",
            graph_id: "review-agentflow-product-subject",
            intent: {
                goal: "Improve Agentflow graph authoring guidance for workflow operators.",
                acceptance_criteria: ["The guidance explains user-facing tradeoffs clearly."],
                constraints: ["Do not add compatibility shims."]
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
                        id: "write_guidance",
                        intent: {
                            goal: "Write guidance for Agentflow graph authors choosing between research, work, and review workflows.",
                            acceptance_criteria: ["The handoff explains concrete authoring choices."],
                            constraints: ["Do not describe private runtime internals."]
                        },
                        artifacts: {
                            guidance: {
                                from: "output_dir",
                                path: "guidance.md",
                                description: "Operator guidance for Agentflow graph authors."
                            }
                        }
                    }
                ]
            }
        });

        const review = reviewCompiledGraph(document, graph, { authored_document: authored });
        expect(review.findings.filter((finding) => finding.category === "prompt_surface")).toEqual([]);
    });
});
