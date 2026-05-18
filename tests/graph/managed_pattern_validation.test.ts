import { describe, expect, it } from "vitest";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
function buildEnvelope(step) {
    return {
        version: "1",
        graph_id: "managed-pattern-validation",
        intent: {
            goal: "Validate managed pattern contracts.",
            acceptance_criteria: ["Managed pattern diagnostics match the authored contract."]
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
                harness: "codex-cli",
                sandbox: "read-only"
            },
            supervisor: {
                harness: "codex-cli",
                sandbox: "read-only"
            }
        },
        supervision: {
            profile: "supervisor",
            max_total_interventions: 3
        },
        graph: {
            type: "sequence",
            id: "root",
            steps: [step]
        }
    };
}
describe("managed pattern normalization edges", () => {
    it("rejects unsupported managed pattern kinds through strict node-type validation", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_custom_workflow",
            id: "unsupported_pattern",
            goal: "Unsupported pattern should be rejected."
        }));
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].type",
                message: "Node type must be one of: agent, exec, check, checkpoint, sequence, parallel, repeat, pattern_deep_research, pattern_deep_work, pattern_work_list."
            })
        ]));
    });
    it("validates deep research angles as required sentence-style prompts", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_deep_research",
            id: "market_scan",
            intent: {
                goal: "Research a managed pattern change.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
            research: {
                angles: ["architecture"]
            }
        }));
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].research.angles[0]",
                message: "Research angles should be sentence-style prompts, not one-word axes."
            })
        ]));
    });
    it("rejects selected public angle artifacts on deep research managed patterns", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_deep_research",
            id: "market_scan",
            intent: {
                goal: "Research a managed pattern change.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
            research: {
                angles: [
                    {
                        id: "architecture",
                        prompt: "Assess whether the implementation follows the local architecture.",
                        as_artifact: true
                    }
                ]
            }
        }));
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].research.angles[0].as_artifact",
                message: "Unknown field \"as_artifact\" is not part of the graph contract."
            })
        ]));
    });
    it("rejects authored artifacts on deep research managed patterns", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_deep_research",
            id: "market_scan",
            intent: {
                goal: "Research a managed pattern change.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
            research: {
                angles: [
                    {
                        id: "architecture",
                        prompt: "Assess whether the implementation follows the local architecture."
                    }
                ]
            },
            artifacts: {
                custom: {
                    from: "output_dir",
                    path: "custom.md",
                    description: "Custom deep research artifact."
                }
            }
        }));
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].artifacts",
                message: "pattern_deep_research publishes only the summary artifact; raw angle reports are linked from the summary, and synthesis reports remain internal run evidence."
            })
        ]));
    });
    it("validates deep work completion criteria and public artifact references", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_deep_work",
            id: "implement",
            intent: {
                goal: "Implement a change.",
                acceptance_criteria: ["The managed deep work node publishes a valid summary and packet."],
                constraints: []
            },
            completion: {
                pass_threshold: 0.9,
                criteria: [
                    {
                        id: "focused_tests",
                        kind: "command",
                        command: "npm test",
                        weight: 0.7,
                        required: true
                    },
                    {
                        id: "handoff_quality",
                        kind: "rubric",
                        target: "artifact:missing",
                        rubric: "The artifact explains the result.",
                        weight: 0.2
                    }
                ]
            }
        }));
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].completion.criteria[1].target",
                message: 'rubric criterion target references unknown public artifact "missing".'
            }),
            expect.objectContaining({
                path: "$.graph.steps[0].completion.criteria",
                message: "Completion criterion weights must sum to 1. Current total is 0.7."
            })
        ]));
    });
    it("accepts default public artifacts for targeted deep work rubrics", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_deep_work",
            id: "implement",
            intent: {
                goal: "Implement a change.",
                acceptance_criteria: ["The managed deep work node publishes a valid summary and packet."],
                constraints: []
            },
            completion: {
                criteria: [
                    {
                        id: "focused_tests",
                        kind: "command",
                        command: "npm test",
                        weight: 0.5,
                        required: true
                    },
                    {
                        id: "summary_quality",
                        kind: "rubric",
                        target: "artifact:summary",
                        rubric: "The summary explains validation evidence.",
                        weight: 0.5
                    }
                ]
            }
        }));
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.lowered_managed_nodes).toEqual([
            {
                authored_id: "implement",
                managed_kind: "pattern_deep_work",
                lowered_to: "sequence"
            }
        ]);
    });
    it("rejects removed deep work artifact_rubric criteria", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_deep_work",
            id: "implement",
            intent: {
                goal: "Implement a change.",
                acceptance_criteria: ["The managed deep work node publishes a valid summary and packet."],
                constraints: []
            },
            completion: {
                criteria: [
                    {
                        id: "focused_tests",
                        kind: "command",
                        command: "npm test",
                        weight: 0.5,
                        required: true
                    },
                    {
                        id: "summary_quality",
                        kind: "artifact_rubric",
                        artifact: "summary",
                        rubric: "The summary explains validation evidence.",
                        weight: 0.5
                    }
                ]
            }
        }));
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].completion.criteria[1].kind",
                message: "Expected one of: command, rubric."
            })
        ]));
    });
    it("validates work-list required planning and guidance fields", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_work_list",
            id: "deliver",
            intent: {
                goal: "Deliver a bounded work list.",
                acceptance_criteria: ["The managed work-list node publishes a valid summary and packet."],
                constraints: []
            },
            work_list: {
                item_guidance: {
                    what_counts_as_one_item: "One coherent reviewable unit.",
                    done_when: []
                },
                item_worker: {
                    kind: "agent"
                }
            }
        }));
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].work_list.planning_goal",
                message: "Expected a non-empty string."
            }),
            expect.objectContaining({
                path: "$.graph.steps[0].work_list.item_guidance.done_when",
                message: "pattern_work_list.work_list.item_guidance.done_when must include at least one item."
            })
        ]));
    });
    it("rejects unsupported work-list item worker kinds", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_work_list",
            id: "deliver",
            intent: {
                goal: "Deliver a bounded work list.",
                acceptance_criteria: ["The managed work-list node publishes a valid summary and packet."],
                constraints: []
            },
            work_list: {
                planning_goal: "Discover the ordered work items needed for the node.",
                item_guidance: {
                    what_counts_as_one_item: "One coherent reviewable unit.",
                    done_when: ["The item is complete with evidence."]
                },
                item_worker: {
                    kind: "simple"
                }
            }
        }));
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].work_list.item_worker.kind",
                message: "Expected one of: agent, deep_work."
            })
        ]));
    });
    it("requires completion criteria for deep_work item workers", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_work_list",
            id: "deliver",
            intent: {
                goal: "Deliver a bounded work list.",
                acceptance_criteria: ["The managed work-list node publishes a valid summary and packet."],
                constraints: []
            },
            work_list: {
                planning_goal: "Discover the ordered work items needed for the node.",
                item_guidance: {
                    what_counts_as_one_item: "One coherent reviewable unit.",
                    done_when: ["The item is complete with evidence."]
                },
                item_worker: {
                    kind: "deep_work",
                    completion: {
                        criteria: []
                    }
                }
            }
        }));
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].work_list.item_worker.completion.criteria",
                message: "pattern_work_list deep_work item workers require at least one completion criterion."
            })
        ]));
    });
    it("rejects work-list rubric targets outside runtime item evidence", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_work_list",
            id: "deliver",
            intent: {
                goal: "Deliver a bounded work list.",
                acceptance_criteria: ["The managed work-list node publishes a valid summary and packet."],
                constraints: []
            },
            work_list: {
                planning_goal: "Discover the ordered work items needed for the node.",
                item_guidance: {
                    what_counts_as_one_item: "One coherent reviewable unit.",
                    done_when: ["The item is complete with evidence."]
                },
                item_worker: {
                    kind: "deep_work",
                    completion: {
                        criteria: [
                            {
                                id: "summary_quality",
                                kind: "rubric",
                                target: "artifact:summary",
                                rubric: "The final summary is useful.",
                                weight: 1
                            }
                        ]
                    }
                }
            }
        }));
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].work_list.item_worker.completion.criteria[0].target",
                message: 'work-list rubric target must be "workspace", "item_handoff", or "work_list_ledger".'
            })
        ]));
    });
    it("accepts work-list agent item workers and default public artifacts", () => {
        const normalized = normalizeAuthoredGraphDocument(buildEnvelope({
            type: "pattern_work_list",
            id: "deliver",
            intent: {
                goal: "Deliver a bounded work list.",
                acceptance_criteria: ["The managed work-list node publishes a valid summary and packet."],
                constraints: []
            },
            work_list: {
                planning_goal: "Discover the ordered work items needed for the node.",
                item_guidance: {
                    what_counts_as_one_item: "One coherent reviewable unit.",
                    done_when: ["The item is complete with evidence."]
                },
                item_worker: {
                    kind: "agent"
                }
            }
        }));
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.lowered_managed_nodes).toEqual([
            {
                authored_id: "deliver",
                managed_kind: "pattern_work_list",
                lowered_to: "sequence"
            }
        ]);
    });
});
