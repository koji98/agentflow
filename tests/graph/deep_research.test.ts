import { describe, expect, it } from "vitest";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";
const TEST_INTENT = {
    goal: "Research an accountable technical recommendation.",
    acceptance_criteria: ["The research package explains findings, uncertainty, and recommended action."]
};
function buildDocument(stepOverrides = {}) {
    return {
        version: "1",
        graph_id: "deep-research-test",
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
            steps: [
                {
                    type: "pattern_deep_research",
                    id: "market_scan",
                    intent: {
                        goal: "Produce a grounded recommendation for Agentflow managed pattern design.",
                        acceptance_criteria: [
                            "The research artifact answers all authored angles.",
                            "The research artifact preserves evidence, uncertainty, confidence, and next actions."
                        ],
                        constraints: ["Do not change the public API contract."]
                    },
                    research: {
                        angles: [
                            "Investigate whether the implementation follows established Agentflow architecture.",
                            "Identify correctness, maintainability, and rollout risks in the managed pattern design.",
                            "Compare whether the public artifact contract is easy for downstream nodes to consume."
                        ]
                    },
                    ...stepOverrides,
                    runtime: {
                        repo: "main",
                        profile: "default"
                    }
                }
            ]
        }
    };
}
describe("deep research managed pattern", () => {
    it("lowers authored angles into a parallel research fanout and public artifact publisher", () => {
        const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument()));
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.lowered_managed_nodes).toEqual([
            {
                authored_id: "market_scan",
                managed_kind: "pattern_deep_research",
                lowered_to: "sequence"
            }
        ]);
        const root = normalized.document?.graph;
        if (!root || root.type !== "sequence") {
            throw new Error("Expected normalized graph root to be a sequence.");
        }
        const workflow = root.steps[0];
        if (!workflow || workflow.type !== "sequence") {
            throw new Error("Expected pattern_deep_research to lower into a sequence workflow.");
        }
        expect(workflow.id).toBe("market_scan__managed__pattern_deep_research__workflow");
        expect(workflow.steps.map((step) => step.id)).toEqual([
            "market_scan__managed__pattern_deep_research__angle_fanout",
            "market_scan"
        ]);
        const fanout = workflow.steps[0];
        const finalNode = workflow.steps[1];
        if (!fanout || fanout.type !== "parallel") {
            throw new Error("Expected research fanout to be parallel.");
        }
        expect(fanout.max_concurrency).toBe(3);
        expect(fanout.steps.map((step) => step.id)).toEqual([
            "market_scan__managed__pattern_deep_research__angle_01",
            "market_scan__managed__pattern_deep_research__angle_02",
            "market_scan__managed__pattern_deep_research__angle_03"
        ]);
        expect(JSON.stringify(fanout.steps[0])).toContain("investigating one assigned research angle");
        if (fanout.steps[0]?.type !== "agent") {
            throw new Error("Expected first angle to be an agent.");
        }
        for (const loweredNode of [...fanout.steps, finalNode]) {
            expect(loweredNode).toEqual(expect.objectContaining({
                managed_runtime: expect.objectContaining({
                    kind: "pattern_deep_research",
                    root_id: "market_scan",
                    config: expect.objectContaining({
                        uses_ephemeral_investigation_workspace: true
                    })
                }),
                runtime: {
                    repo: "main",
                    profile: "default"
                }
            }));
        }
        const anglePrompt = JSON.stringify(fanout.steps[0].managed_prompt);
        expect(fanout.steps[0].intent.goal).toContain("Investigate assigned research angle angle_01");
        expect(fanout.steps[0].intent.goal).not.toContain("This attempt runs in a disposable investigation workspace.");
        expect(anglePrompt).toContain("The assigned angle id is angle_01.");
        expect(anglePrompt).toContain("This attempt runs in a disposable investigation workspace.");
        expect(anglePrompt).toContain("Temporary exploratory edits are allowed only when they materially help the investigation.");
        expect(anglePrompt).toContain("Do not create a report file in the repo workspace");
        expect(anglePrompt).toContain("Cite original source evidence such as repository paths, commands, URLs, documents, or observed outputs");
        expect(anglePrompt).toContain("do not cite internal angle or synthesis report artifacts as the source for a claim");
        expect(anglePrompt).not.toContain("internal research artifact");
        expect(anglePrompt).not.toContain("public artifact");
        expect(anglePrompt).not.toContain("graph contract");
        expect(JSON.stringify(fanout.steps[0])).not.toContain("expert");
        expect(finalNode).toEqual(expect.objectContaining({
            id: "market_scan",
            type: "agent",
            artifacts: expect.objectContaining({
                research: expect.objectContaining({ path: "research.md" })
            })
        }));
        expect(Object.keys(finalNode.artifacts ?? {}).sort()).toEqual(["research"]);
        expect(JSON.stringify(finalNode)).toContain("final research publisher");
        expect(JSON.stringify(finalNode)).not.toContain("internal inputs only");
        expect(JSON.stringify(finalNode)).not.toContain("public artifacts");
        expect(JSON.stringify(finalNode)).not.toContain("graph contract");
        expect(JSON.stringify(finalNode)).not.toContain("expert");
    });
    it("adds balanced synthesis layers when more than three angle reports need synthesis", () => {
        const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument({
            research: {
                angles: [
                    "Investigate the local architecture and extension points for managed patterns.",
                    "Compare managed pattern behavior against the graph authoring contract.",
                    "Identify runtime supervision implications for managed pattern internals.",
                    "Assess how public artifacts should support downstream node consumption.",
                    "Review whether generated context remains compact and useful.",
                    "Evaluate validation strategy for implementation-oriented managed work.",
                    "Identify documentation risks and rollout guidance for workflow authors."
                ]
            }
        })));
        expect(normalized.diagnostics).toEqual([]);
        const root = normalized.document?.graph;
        if (!root || root.type !== "sequence") {
            throw new Error("Expected normalized graph root to be a sequence.");
        }
        const workflow = root.steps[0];
        if (!workflow || workflow.type !== "sequence") {
            throw new Error("Expected pattern_deep_research to lower into a sequence workflow.");
        }
        expect(workflow.steps.map((step) => step.id)).toEqual([
            "market_scan__managed__pattern_deep_research__angle_fanout",
            "market_scan__managed__pattern_deep_research__synthesis_layer_01",
            "market_scan"
        ]);
        const synthesisLayer = workflow.steps[1];
        if (!synthesisLayer || synthesisLayer.type !== "parallel") {
            throw new Error("Expected a parallel synthesis layer.");
        }
        expect(synthesisLayer.steps).toHaveLength(3);
        expect(synthesisLayer.steps.map((step) => step.id)).toEqual([
            "market_scan__managed__pattern_deep_research__synthesis_01_01",
            "market_scan__managed__pattern_deep_research__synthesis_01_02",
            "market_scan__managed__pattern_deep_research__synthesis_01_03"
        ]);
        expect(JSON.stringify(synthesisLayer.steps[0])).toContain("research synthesis worker");
        expect(JSON.stringify(synthesisLayer.steps[0])).toContain("Produce a complete synthesis for the assigned input reports");
        expect(JSON.stringify(synthesisLayer.steps[0])).toContain("preserve original source paths, commands, URLs, documents, or observed outputs instead of citing the input report itself");
        expect(JSON.stringify(synthesisLayer.steps[0])).toContain("Resolve conflicts inside this synthesis when the input evidence is sufficient");
        expect(JSON.stringify(synthesisLayer.steps[0])).toContain("Assigned Input Set");
        expect(JSON.stringify(synthesisLayer.steps[0])).toContain("angle_01: Investigate the local architecture");
        expect(JSON.stringify(synthesisLayer.steps[0])).toContain("angle_02: Compare managed pattern behavior");
        expect(JSON.stringify(synthesisLayer.steps[0])).not.toContain("expert");
        expect(synthesisLayer.steps.map((step) => ("support" in step ? step.support?.context?.length ?? 0 : 0))).toEqual([
            2,
            2,
            3
        ]);
        const finalNode = workflow.steps.at(-1);
        if (!finalNode || finalNode.type !== "agent") {
            throw new Error("Expected final managed node to be an agent.");
        }
        const synthesisContext = finalNode.support?.context?.find((item) => item.name === "synthesis_01_01_report");
        expect(synthesisContext).toEqual(expect.objectContaining({
            what: expect.stringContaining("synthesized")
        }));
        expect(synthesisContext?.what).toContain("angle_01");
        expect(synthesisContext?.what).toContain("Investigate the local architecture");
        expect(synthesisContext?.what).toContain("angle_02");
        expect(synthesisContext?.what).toContain("Compare managed pattern behavior");
    });
    it("keeps deep research graph-addressable output collapsed to one complete research artifact", () => {
        const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument({
            research: {
                angles: [
                    {
                        id: "architecture",
                        prompt: "Investigate whether the implementation follows established Agentflow architecture."
                    },
                    {
                        id: "risk",
                        prompt: "Identify correctness, maintainability, and rollout risks in the managed pattern design."
                    }
                ]
            }
        })));
        expect(normalized.diagnostics).toEqual([]);
        const root = normalized.document?.graph;
        if (!root || root.type !== "sequence") {
            throw new Error("Expected normalized graph root to be a sequence.");
        }
        const workflow = root.steps[0];
        if (!workflow || workflow.type !== "sequence") {
            throw new Error("Expected pattern_deep_research to lower into a sequence workflow.");
        }
        const finalNode = workflow.steps.at(-1);
        expect(finalNode).toEqual(expect.objectContaining({
            id: "market_scan",
            type: "agent",
            artifacts: expect.objectContaining({
                research: expect.objectContaining({ path: "research.md" })
            })
        }));
        if (!finalNode || finalNode.type !== "agent") {
            throw new Error("Expected final managed node to be an agent.");
        }
        expect(Object.keys(finalNode.artifacts ?? {}).sort()).toEqual(["research"]);
        expect(finalNode.managed_artifact_forwards).toBeUndefined();
        expect(finalNode.support?.context?.map((item) => item.name)).toEqual([
            "angle_01_report",
            "angle_02_report"
        ]);
        const finalPrompt = JSON.stringify(finalNode.managed_prompt);
        expect(finalNode.intent.goal).toContain("Publish research.md as the complete source-cited, conflict-resolved research artifact.");
        expect(finalNode.intent.goal).not.toContain("Write `research.md` as the only final file");
        expect(finalPrompt).toContain("Write `research.md` as the only final file");
        expect(finalPrompt).toContain("Include all information needed by downstream planning, implementation, review, or decision nodes inside this one file");
        expect(finalPrompt).toContain("Do not create angle-specific final artifacts, evidence-link tables, packets, or companion files");
        expect(finalPrompt).not.toContain("Evidence Link Ownership");
        expect(finalPrompt).not.toContain("Research Evidence");
        expect(finalPrompt).not.toContain("runtime prepends");
        expect(finalPrompt).not.toContain("Write `summary.md`");
        expect(finalPrompt).not.toContain("Report Pointer Path");
        expect(finalPrompt).not.toContain("`Pointer` value");
        expect(finalPrompt).not.toContain("angle_01_report");
        expect(finalPrompt).toContain("Treat the provided research reports as evidence-gathering scaffolding");
        expect(finalPrompt).toContain("do not cite, link, or mention their artifact names as sources in the final artifact");
        expect(finalPrompt).toContain("Cite original source evidence such as repository paths, commands, URLs, documents, or observed outputs");
        expect(finalPrompt).toContain("carry forward the source-level citation rather than citing the internal report");
        expect(finalPrompt).toContain("Do not include sections named angle reports, synthesis reports, raw reports, or internal reports");
        expect(finalPrompt).not.toContain("managed workflow");
        expect(finalPrompt).not.toContain("public artifact shape");
        expect(finalPrompt).not.toContain("synthesis node");
        const loweredPromptText = JSON.stringify(workflow);
        expect(loweredPromptText).not.toContain("private helper node");
        expect(loweredPromptText).not.toContain("inside a managed workflow");
        expect(loweredPromptText).not.toContain("private synthesis step");
        expect(loweredPromptText).not.toContain("final managed node");
        expect(finalPrompt).toContain("not a high-level abstract");
        expect(finalPrompt).toContain("holistic, sufficiently detailed, conflict-resolved answer");
        expect(finalPrompt).not.toContain("Do not author raw angle links yourself");
        expect(finalPrompt).not.toContain("Selected Public Angle");
        expect(finalPrompt).not.toContain("as_artifact");
        expect(finalPrompt).not.toContain("Context Pointer Name");
        expect(finalPrompt).not.toContain("Synthesis Report |");
        expect(finalPrompt).not.toContain("Runtime-Forwarded Raw Angle Artifacts");
    });
    it("compiles pattern_deep_research so downstream nodes depend on the final public artifacts", () => {
        const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults({
            ...buildDocument(),
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    buildDocument({
                        research: {
                            angles: [
                                "Investigate whether the implementation follows established Agentflow architecture.",
                                {
                                    id: "risk",
                                    prompt: "Identify correctness, maintainability, and rollout risks in the managed pattern design."
                                }
                            ]
                        }
                    }).graph.steps[0],
                    {
                        type: "agent",
                        id: "handoff",
                        intent: {
                            goal: "Summarize the research recommendation.",
                            acceptance_criteria: [
                                "The handoff uses the final managed research artifact.",
                                "The handoff preserves the recommendation and key uncertainty."
                            ],
                            constraints: []
                        },
                        support: {
                            context: [
                                {
                                    kind: "artifact",
                                    ref: "market_scan.agent_response",
                                    name: "research_agent_response",
                                    what: "Pointer evidence used by the node under test.",
                                    why: "This context is required by the test scenario."
                                },
                                {
                                    kind: "artifact",
                                    ref: "market_scan.research",
                                    name: "research_artifact",
                                    what: "Pointer evidence used by the node under test.",
                                    why: "This context is required by the test scenario."
                                }
                            ]
                        }
                    }
                ]
            }
        }));
        const launch = resolveLaunchConfig(normalized.document!);
        const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
        expect(compilation.diagnostics).toEqual([]);
        expect(compilation.compiled_graph).toBeDefined();
        const compiledGraph = compilation.compiled_graph!;
        const finalResearchNode = compiledGraph.nodes.find((node) => node.authored_id === "market_scan");
        const handoffNode = compiledGraph.nodes.find((node) => node.authored_id === "handoff");
        const fanoutScope = compiledGraph.scopes.find((scope) => scope.authored_id === "market_scan__managed__pattern_deep_research__angle_fanout");
        expect(compiledGraph.authored_to_compiled.market_scan).toEqual([
            "root__market_scan__managed__pattern_deep_research__workflow__market_scan"
        ]);
        expect(finalResearchNode).toEqual(expect.objectContaining({
            kind: "agent",
            lowered_from: "pattern_deep_research",
            compiled_id: "root__market_scan__managed__pattern_deep_research__workflow__market_scan"
        }));
        expect(fanoutScope).toEqual(expect.objectContaining({
            kind: "parallel"
        }));
        expect(handoffNode).toEqual(expect.objectContaining({
            deps: ["root__market_scan__managed__pattern_deep_research__workflow__market_scan"]
        }));
    });
});
