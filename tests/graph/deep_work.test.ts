import { describe, expect, it } from "vitest";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";
const TEST_INTENT = {
    goal: "Perform accountable implementation work until it is validated.",
    acceptance_criteria: ["The managed pattern loops on completion criteria and publishes public artifacts."]
};
function buildPatternStep(stepOverrides = {}) {
        return {
            type: "pattern_deep_work",
            id: "implement_checkout",
            runtime: {
                repo: "main",
                profile: "default"
            },
        intent: {
            goal: "Implement checkout rounding and publish a clear handoff.",
            acceptance_criteria: [
                "Focused tests pass.",
                "The summary and packet explain validation evidence and risks."
            ],
            constraints: ["Do not edit lockfiles."]
        },
        artifacts: {
            validation_log: {
                from: "output_dir",
                path: "validation-log.md",
                description: "Validation evidence collected during final publication."
            }
        },
        completion: {
            max_cycles: 3,
            pass_threshold: 0.85,
            criteria: [
                {
                    id: "focused_tests",
                    kind: "command",
                    command: "npm test -- tests/checkout",
                    weight: 0.4,
                    required: true
                },
                {
                    id: "acceptance_rubric",
                    kind: "rubric",
                    target: "workspace",
                    rubric: "The workspace satisfies the goal and acceptance criteria without violating constraints.",
                    weight: 0.4
                },
                {
                    id: "handoff_quality",
                    kind: "rubric",
                    target: "artifact:summary",
                    rubric: "The summary clearly describes changes, validation evidence, and residual risks.",
                    weight: 0.2
                }
            ]
        },
        ...stepOverrides
    };
}
function buildDocument(steps) {
    return {
        version: "1",
        graph_id: "pattern-deep-work-test",
        intent: TEST_INTENT,
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
            steps
        }
    };
}
describe("pattern deep work", () => {
    it("lowers completion criteria into a bounded work loop and final public artifact publisher", () => {
        const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([buildPatternStep()])));
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.lowered_managed_nodes).toEqual([
            {
                authored_id: "implement_checkout",
                managed_kind: "pattern_deep_work",
                lowered_to: "sequence"
            }
        ]);
        const root = normalized.document?.graph;
        if (!root || root.type !== "sequence") {
            throw new Error("Expected normalized graph root to be a sequence.");
        }
        const workflow = root.steps[0];
        if (!workflow || workflow.type !== "sequence") {
            throw new Error("Expected pattern_deep_work to lower into a sequence workflow.");
        }
        expect(workflow.steps.map((step) => step.id)).toEqual([
            "implement_checkout__managed__pattern_deep_work__work_loop",
            "implement_checkout"
        ]);
        const loop = workflow.steps[0];
        const finalNode = workflow.steps[1];
        if (!loop || loop.type !== "repeat") {
            throw new Error("Expected deep work to lower into a repeat loop.");
        }
        expect(loop.max_attempts).toBe(3);
        expect(loop.until.node).toBe("implement_checkout__managed__pattern_deep_work__completion_gate");
        if (loop.body.type !== "sequence") {
            throw new Error("Expected work loop body to be a sequence.");
        }
        expect(loop.body.steps.map((step) => step.id)).toEqual([
            "implement_checkout__managed__pattern_deep_work__plan",
            "implement_checkout__managed__pattern_deep_work__generate_validate",
            "implement_checkout__managed__pattern_deep_work__criteria_panel",
            "implement_checkout__managed__pattern_deep_work__completion_gate"
        ]);
        const planNode = loop.body.steps[0];
        const generateValidateNode = loop.body.steps[1];
        const criteriaPanel = loop.body.steps[2];
        const gateNode = loop.body.steps[3];
        const planPrompt = JSON.stringify(planNode);
        const generateValidatePrompt = JSON.stringify(generateValidateNode);
        expect(planNode).toEqual(expect.objectContaining({
            type: "agent",
            id: "implement_checkout__managed__pattern_deep_work__plan",
            managed_runtime: expect.objectContaining({
                kind: "pattern_deep_work",
                root_id: "implement_checkout",
                phase: "plan"
            }),
            artifacts: expect.objectContaining({
                cycle_plan: expect.objectContaining({ path: "cycle-plan.md" })
            })
        }));
        expect(planPrompt).toContain("implementation planner");
        expect(planPrompt).toContain("Do not edit files in this phase.");
        expect(planPrompt).toContain("treat that as expected first-cycle state");
        expect(planPrompt).toContain("Use the provided context pointers for the planning phase.");
        expect(planPrompt).toContain("Preserve exact task-specific names, labels, commands, and required phrases from the task contract in the plan.");
        expect(planPrompt).toContain("The `cycle_plan` artifact is the durable planning record; do not create a milestone solely to restate the plan.");
        expect(planPrompt).not.toContain("managed workflow");
        expect(planPrompt).not.toContain("public artifact");
        expect(planPrompt).not.toContain("private working material");
        expect(planPrompt).not.toContain("This prompt and context pointer packet");
        expect(planPrompt).not.toContain("ambient Codex");
        expect(planPrompt).not.toContain("Agentflow playbooks");
        expect(planPrompt).toContain("Do not wait for, search globally for, or report a blocker solely because first-cycle prior materials are missing.");
        expect(planPrompt).not.toContain("senior");
        expect(generateValidateNode).toEqual(expect.objectContaining({
            type: "agent",
            id: "implement_checkout__managed__pattern_deep_work__generate_validate",
            artifacts: expect.objectContaining({
                work_notes: expect.objectContaining({ path: "work-notes.md" }),
                draft_summary: expect.objectContaining({ path: "draft-summary.md" }),
                draft_packet: expect.objectContaining({ path: "draft-packet.json" })
            })
        }));
        expect(generateValidatePrompt).toContain("implementation agent responsible for completing and validating this work cycle");
        expect(generateValidatePrompt).toContain("Satisfy the task contract, not only the visible tests");
        expect(generateValidatePrompt).toContain("add/edit tests only when the task asks or repo contract expects them");
        expect(generateValidatePrompt).toContain("Preserve API semantics with nullish or explicit checks");
        expect(generateValidatePrompt).toContain("round money with integer cents or Number.EPSILON");
        expect(generateValidatePrompt).toContain("cite concrete evidence names, paths, commands, or packet fields");
        expect(generateValidatePrompt).toContain("Draft handoffs and summaries should include enough evidence citations");
        expect(generateValidatePrompt).not.toContain("managed workflow");
        expect(generateValidatePrompt).not.toContain("public artifact");
        expect(generateValidatePrompt).not.toContain("private working material");
        expect(generateValidatePrompt).not.toContain("meticulous");
        if (!criteriaPanel || criteriaPanel.type !== "parallel") {
            throw new Error("Expected completion criteria to run in parallel.");
        }
        for (const loweredNode of [planNode, generateValidateNode, gateNode, finalNode, ...criteriaPanel.steps]) {
            expect(loweredNode).toEqual(expect.objectContaining({
                runtime: {
                    repo: "main",
                    profile: "default"
                }
            }));
        }
        expect(criteriaPanel.steps).toHaveLength(3);
        expect(criteriaPanel.steps[0]).toEqual(expect.objectContaining({
            type: "check",
            check_kind: "deterministic",
            on_failure: "continue",
            id: "implement_checkout__managed__pattern_deep_work__criterion_01_focused_tests"
        }));
        expect(criteriaPanel.steps[1]).toEqual(expect.objectContaining({
            type: "check",
            check_kind: "ai",
            on_failure: "continue",
            id: "implement_checkout__managed__pattern_deep_work__criterion_02_acceptance_rubric"
        }));
        expect(JSON.stringify(criteriaPanel.steps[1])).toContain("evaluator for completion criterion `acceptance_rubric`");
        expect(JSON.stringify(criteriaPanel.steps[1])).not.toContain("fair");
        expect(criteriaPanel.steps[2]).toEqual(expect.objectContaining({
            type: "check",
            check_kind: "ai",
            on_failure: "continue",
            id: "implement_checkout__managed__pattern_deep_work__criterion_03_handoff_quality",
            support: expect.objectContaining({
                context: [
                    expect.objectContaining({ name: "work_notes" }),
                    expect.objectContaining({ name: "draft_summary" })
                ]
            })
        }));
        expect(gateNode).toEqual(expect.objectContaining({
            type: "check",
            check_kind: "deterministic",
            id: "implement_checkout__managed__pattern_deep_work__completion_gate",
            pass_if: {
                json_path: "$.passed",
                equals: true
            }
        }));
        expect(finalNode).toEqual(expect.objectContaining({
            id: "implement_checkout",
            type: "agent",
            artifacts: expect.objectContaining({
                summary: expect.objectContaining({ path: "summary.md" }),
                packet: expect.objectContaining({ path: "packet.json" }),
                validation_log: expect.objectContaining({ path: "validation-log.md" })
            }),
            intent: expect.objectContaining({
                acceptance_criteria: expect.arrayContaining([
                    "The final artifacts are consistent with the latest passing completion scorecard and do not claim unsupported success."
                ])
            })
        }));
        const finalPrompt = JSON.stringify(finalNode);
        expect(finalPrompt).not.toContain("managed workflow");
        expect(finalPrompt).not.toContain("public artifacts");
        expect(finalPrompt).not.toContain("Downstream work will read only");
        expect(JSON.stringify(finalNode)).toContain("publishing the final artifacts from the latest passing work cycle");
        expect(JSON.stringify(finalNode)).toContain("scorecard evidence or completion scorecard section");
        expect(JSON.stringify(finalNode)).toContain("When a final artifact description names literal labels or fields");
        expect(JSON.stringify(finalNode)).toContain("score, threshold, criterion results, validation command/result, and evidence paths");
    });
    it("compiles pattern_deep_work so downstream nodes depend on the final published artifacts", () => {
        const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
            buildPatternStep(),
            {
                type: "agent",
                id: "handoff",
                intent: {
                    goal: "Summarize the final deep work package.",
                    acceptance_criteria: [
                        "The handoff uses the final managed summary and packet artifacts.",
                        "The handoff is suitable for downstream review."
                    ],
                    constraints: []
                },
                support: {
                    context: [
                        {
                            kind: "artifact",
                            ref: "implement_checkout.agent_response",
                            name: "work_agent_response",
                            what: "Final agent response from the managed deep-work node.",
                            why: "The handoff must summarize the implementation result."
                        },
                        {
                            kind: "artifact",
                            ref: "implement_checkout.summary",
                            name: "work_summary",
                            what: "Final public summary from the managed deep-work node.",
                            why: "The handoff must cite the managed summary."
                        },
                        {
                            kind: "artifact",
                            ref: "implement_checkout.packet",
                            name: "work_packet",
                            what: "Machine-readable packet from the managed deep-work node.",
                            why: "The handoff must use the final managed evidence."
                        }
                    ]
                }
            }
        ])));
        expect(normalized.diagnostics).toEqual([]);
        const launch = resolveLaunchConfig(normalized.document!);
        const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
        expect(compilation.diagnostics).toEqual([]);
        expect(compilation.compiled_graph).toBeDefined();
        const compiledGraph = compilation.compiled_graph!;
        const finalWorkNode = compiledGraph.nodes.find((node) => node.authored_id === "implement_checkout");
        const handoffNode = compiledGraph.nodes.find((node) => node.authored_id === "handoff");
        const loopScope = compiledGraph.scopes.find((scope) => scope.authored_id === "implement_checkout__managed__pattern_deep_work__work_loop");
        expect(loopScope).toEqual(expect.objectContaining({
            kind: "repeat"
        }));
        expect(compiledGraph.authored_to_compiled.implement_checkout).toEqual([
            "root__implement_checkout__managed__pattern_deep_work__workflow__implement_checkout"
        ]);
        expect(finalWorkNode).toEqual(expect.objectContaining({
            kind: "agent",
            lowered_from: "pattern_deep_work",
            compiled_id: "root__implement_checkout__managed__pattern_deep_work__workflow__implement_checkout"
        }));
        expect(handoffNode).toEqual(expect.objectContaining({
            deps: ["root__implement_checkout__managed__pattern_deep_work__workflow__implement_checkout"]
        }));
    });
    it("compiles phase-specific deep-work controls into distinct prompt-backed phases", () => {
        const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
            buildPatternStep({
                phases: {
                    plan: {
                        intent: {
                            goal: "Plan from current scorecard only; do not design unrelated architecture.",
                            acceptance_criteria: ["Name the smallest credible validation command."],
                            constraints: ["Do not prescribe broad rewrites."]
                        },
                        support: {
                            cli: [
                                {
                                    cmd: "npm test -- tests/checkout",
                                    description: "Focused checkout validation command."
                                }
                            ]
                        },
                        runtime: {
                            profile: "supervisor"
                        },
                        model: "gpt-5-planner"
                    },
                    execute: {
                        intent: {
                            goal: "Implement only the selected plan and keep diffs narrow.",
                            acceptance_criteria: ["Record exact command output in work notes."]
                        },
                        sandbox: "workspace-write"
                    },
                    verify: {
                        intent: {
                            goal: "Judge evidence, not intentions.",
                            acceptance_criteria: ["Penalize missing validation evidence."]
                        }
                    },
                    publish: {
                        intent: {
                            goal: "Publish only claims supported by the passing scorecard.",
                            acceptance_criteria: ["Keep downstream handoff bounded to accepted evidence."]
                        }
                    }
                }
            })
        ])));
        expect(normalized.diagnostics).toEqual([]);
        const root = normalized.document?.graph;
        if (!root || root.type !== "sequence") {
            throw new Error("Expected normalized graph root to be a sequence.");
        }
        const workflow = root.steps[0];
        if (!workflow || workflow.type !== "sequence") {
            throw new Error("Expected pattern_deep_work to lower into a workflow sequence.");
        }
        const loop = workflow.steps[0];
        const finalNode = workflow.steps[1];
        if (!loop || loop.type !== "repeat" || loop.body.type !== "sequence") {
            throw new Error("Expected deep-work loop body.");
        }
        const planNode = loop.body.steps[0];
        const generateNode = loop.body.steps[1];
        const criteriaPanel = loop.body.steps[2];
        if (!criteriaPanel || criteriaPanel.type !== "parallel") {
            throw new Error("Expected criteria panel.");
        }
        expect(JSON.stringify(planNode)).toContain("Phase Contract");
        expect(JSON.stringify(planNode)).toContain("Plan from current scorecard only");
        expect(JSON.stringify(planNode)).toContain("Name the smallest credible validation command");
        expect(JSON.stringify(planNode)).toContain("Do not prescribe broad rewrites");
        expect(JSON.stringify(planNode)).toContain("Focused checkout validation command");
        expect(planNode).toEqual(expect.objectContaining({ model: "gpt-5-planner" }));
        expect(planNode).toEqual(expect.objectContaining({
            runtime: {
                repo: "main",
                profile: "supervisor"
            }
        }));
        expect(JSON.stringify(generateNode)).toContain("Implement only the selected plan");
        expect(JSON.stringify(generateNode)).toContain("Record exact command output in work notes");
        expect(generateNode).toEqual(expect.objectContaining({ sandbox: "workspace-write" }));
        expect(JSON.stringify(criteriaPanel.steps[1])).toContain("Judge evidence, not intentions");
        expect(JSON.stringify(criteriaPanel.steps[1])).toContain("Penalize missing validation evidence");
        expect(JSON.stringify(finalNode)).toContain("Publish only claims supported by the passing scorecard");
        expect(JSON.stringify(finalNode)).toContain("Keep downstream handoff bounded to accepted evidence");
        expect(JSON.stringify(finalNode)).toContain("Implement checkout rounding and publish a clear handoff.");
    });
    it("rejects removed deep-work stage fields", () => {
        const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
            buildPatternStep({
                stages: {
                    execute: {
                        directions: ["Implement narrowly."],
                        validation_focus: ["Record validation."]
                    }
                }
            })
        ])));
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].stages",
                message: expect.stringContaining("Unknown field")
            })
        ]));
        expect(normalized.document).toBeUndefined();
    });
    it("rejects removed phase direction and validation-focus fields", () => {
        const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
            buildPatternStep({
                phases: {
                    execute: {
                        directions: ["Implement narrowly."],
                        validation_focus: ["Record validation."]
                    }
                }
            })
        ])));
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].phases.execute.directions",
                message: expect.stringContaining("Unknown field")
            }),
            expect.objectContaining({
                path: "$.graph.steps[0].phases.execute.validation_focus",
                message: expect.stringContaining("Unknown field")
            })
        ]));
        expect(normalized.document).toBeUndefined();
    });
    it("rejects phase-level repo overrides", () => {
        const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
            buildPatternStep({
                phases: {
                    execute: {
                        runtime: {
                            repo: "other",
                            profile: "default"
                        }
                    }
                }
            })
        ])));
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].phases.execute.runtime.repo",
                message: expect.stringContaining("Unknown field")
            })
        ]));
        expect(normalized.document).toBeUndefined();
    });
});
