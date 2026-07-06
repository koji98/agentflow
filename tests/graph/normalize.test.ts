import { describe, expect, it } from "vitest";
import { normalizeAuthoredGraphDocument as normalizeRawAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";
function normalizeAuthoredGraphDocument(value: unknown) {
    if (typeof value !== "object" || value === null || Array.isArray(value) || "intent" in value) {
        return normalizeRawAuthoredGraphDocument(withNodeIntentDefaults(value as never));
    }
    return normalizeRawAuthoredGraphDocument(withNodeIntentDefaults({
        intent: {
            goal: "Test supervised graph contract.",
            acceptance_criteria: ["The graph normalizes under the current contract."]
        },
        ...value
    } as never));
}
describe("graph normalization", () => {
    it("requires an intent block on executable nodes", () => {
        const normalized = normalizeRawAuthoredGraphDocument({
            version: "1",
            graph_id: "missing-node-intent",
            intent: {
                goal: "Validate node intent requirements.",
                acceptance_criteria: ["Missing node intent is rejected."]
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "run",
                        command: "node",
                        args: ["--version"]
                    }
                ]
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            {
                path: "$.graph.steps[0].intent",
                message: "Executable nodes require intent."
            }
        ]));
    });
    it("normalizes supervised v1 intent and required supervisor profile", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "ship-trusted-change",
            intent: {
                goal: "Ship checkout timeout handling.",
                constraints: ["Keep public API names stable inside this repo."],
                acceptance_criteria: ["Targeted checkout tests pass.", "Reviewer guide names risky files."]
            },
            repos: {
                main: {
                    path: "."
                }
            },
            profiles: {
                default: {
                    harness: "codex-cli"
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
                        type: "exec",
                        id: "echo",
                        command: "node",
                        args: ["--version"]
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.document).toEqual(expect.objectContaining({
            intent: {
                goal: "Ship checkout timeout handling.",
                constraints: ["Keep public API names stable inside this repo."],
                acceptance_criteria: ["Targeted checkout tests pass.", "Reviewer guide names risky files."]
            },
            supervision: { profile: "supervisor", max_total_interventions: 3 }
        }));
    });
    it("normalizes profile-level harness config for declared harness capabilities", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "harness-config",
            repos: {
                main: {
                    path: "."
                }
            },
            profiles: {
                default: {
                    harness: "codex-cli",
                    harness_config: {
                        isolation: "isolated",
                        codex: {
                            config: {
                                approval_policy: "never"
                            },
                            mcp_servers: {
                                docs: {
                                    command: "docs-server",
                                    args: ["serve"]
                                }
                            },
                            plugins: {
                                figma: {
                                    enabled: true
                                }
                            },
                            notify: []
                        }
                    }
                },
                supervisor: {
                    harness: "cursor-cli",
                    sandbox: "read-only",
                    harness_config: {
                        cursor: {
                            config: {
                                editor: {
                                    vimMode: true
                                }
                            },
                            permissions: {
                                allow: ["Shell(npm test)"],
                                deny: ["WebFetch(*)"]
                            }
                        }
                    }
                }
            },
            supervision: {
                profile: "supervisor",
                max_total_interventions: 3
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: []
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.document?.profiles?.default?.harness_config).toEqual({
            isolation: "isolated",
            codex: {
                config: {
                    approval_policy: "never"
                },
                mcp_servers: {
                    docs: {
                        command: "docs-server",
                        args: ["serve"]
                    }
                },
                plugins: {
                    figma: {
                        enabled: true
                    }
                },
                notify: []
            }
        });
        expect(normalized.document?.profiles?.supervisor?.harness_config).toEqual({
            cursor: {
                config: {
                    editor: {
                        vimMode: true
                    }
                },
                permissions: {
                    allow: ["Shell(npm test)"],
                    deny: ["WebFetch(*)"]
                }
            }
        });
    });
    it("rejects unknown harness config fields", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "bad-harness-config",
            repos: {
                main: {
                    path: "."
                }
            },
            profiles: {
                default: {
                    harness: "codex-cli",
                    harness_config: {
                        mode: "unsupported",
                        codex: {
                            config: {},
                            mcp: {}
                        },
                        cursor: {
                            config: {},
                            tool_permissions: {},
                            permissions: {
                                allow: [],
                                maybe: []
                            }
                        }
                    }
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: []
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            {
                path: "$.profiles.default.harness_config.mode",
                message: 'Unknown field "mode" is not part of the graph contract.'
            },
            {
                path: "$.profiles.default.harness_config.codex.mcp",
                message: 'Unknown field "mcp" is not part of the graph contract.'
            },
            {
                path: "$.profiles.default.harness_config.cursor.tool_permissions",
                message: 'Unknown field "tool_permissions" is not part of the graph contract.'
            },
            {
                path: "$.profiles.default.harness_config.cursor.permissions.maybe",
                message: 'Unknown field "maybe" is not part of the graph contract.'
            }
        ]));
    });
    it("rejects unknown supervision fields", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "unknown-supervision-fields",
            supervision: {
                actions: {
                    retry_with_guidance: { max_uses: 1 }
                },
                max_total_interventions: 3,
                policy: {
                    pause_on_policy_risk: true
                }
            },
            repos: {
                main: {
                    path: "."
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "echo",
                        command: "node",
                        args: ["--version"]
                    }
                ]
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            {
                path: "$.supervision.actions",
                message: 'Unknown field "actions" is not part of the graph contract.'
            },
            {
                path: "$.supervision.policy",
                message: 'Unknown field "policy" is not part of the graph contract.'
            }
        ]));
    });
    it("requires a supervisor profile", () => {
        const normalized = normalizeRawAuthoredGraphDocument({
            version: "1",
            graph_id: "missing-supervisor-profile",
            intent: {
                goal: "Validate supervisor profile requirements.",
                acceptance_criteria: ["Missing supervisor profile is rejected."]
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
                        id: "echo",
                        intent: {
                            goal: "Print the Node version.",
                            acceptance_criteria: ["The command exits successfully."],
                            constraints: []
                        },
                        command: "node",
                        args: ["--version"]
                    }
                ]
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            {
                path: "$.supervision.profile",
                message: "supervision.profile is required."
            }
        ]));
    });
    it("rejects supervision profiles that do not exist", () => {
        const normalized = normalizeRawAuthoredGraphDocument({
            version: "1",
            graph_id: "unknown-supervisor-profile",
            intent: {
                goal: "Test supervised graph contract.",
                acceptance_criteria: ["The graph normalizes under the current contract."]
            },
            supervision: {
                profile: "supervisor",
                max_total_interventions: 3
            },
            repos: {
                main: {
                    path: "."
                }
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
                        id: "echo",
                        intent: {
                            goal: "Print the Node version.",
                            acceptance_criteria: ["The command exits successfully."],
                            constraints: []
                        },
                        command: "node",
                        args: ["--version"]
                    }
                ]
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            {
                path: "$.supervision.profile",
                message: 'supervision.profile references unknown profile "supervisor".'
            }
        ]));
    });
    it("rejects graphs without supervised intent", () => {
        const normalized = normalizeRawAuthoredGraphDocument({
            version: "1",
            graph_id: "missing-intent",
            repos: {
                main: {
                    path: "."
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: []
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            {
                path: "$.intent.goal",
                message: "Expected a non-empty string."
            }
        ]));
    });
    it("rejects removed prompt and delivery authoring fields", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "removed-fields",
            delivery: {
                required_sections: ["task_brief"]
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "invalid_prompt",
                        prompt: "This field is not part of the node contract."
                    }
                ]
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            {
                path: "$.delivery",
                message: 'Unknown field "delivery" is not part of the graph contract.'
            },
            {
                path: "$.graph.steps[0].prompt",
                message: 'Unknown field "prompt" is not part of the graph contract.'
            }
        ]));
    });
    it("normalizes agent node intent without requiring a prompt", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "node-intent-contract",
            repos: {
                main: {
                    path: "."
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
                            goal: "Implement timeout handling with clear reviewer evidence.",
                            acceptance_criteria: [
                                "Checkout timeout tests pass.",
                                "The handoff explains changed files and residual risks."
                            ],
                            constraints: []
                        },
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Human review handoff."
                            }
                        }
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.document?.graph).toEqual(expect.objectContaining({
            steps: [
                expect.objectContaining({
                    type: "agent",
                    id: "implement",
                    intent: {
                        goal: "Implement timeout handling with clear reviewer evidence.",
                        acceptance_criteria: [
                            "Checkout timeout tests pass.",
                            "The handoff explains changed files and residual risks."
                        ],
                        constraints: []
                    },
                })
            ]
        }));
    });
    it("preserves primitive agent nodes and authored selectors", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "primitive-agents",
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
                        id: "inspect",
                        intent: {
                            goal: "Inspect the repository.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        }
                    },
                    {
                        type: "parallel",
                        id: "fanout",
                        steps: [
                            {
                                type: "agent",
                                id: "fix",
                                intent: {
                                    goal: "Repair the issue.",
                                    acceptance_criteria: ["The node satisfies its acceptance criteria."],
                                    constraints: []
                                }
                            },
                            {
                                type: "agent",
                                id: "handoff",
                                intent: {
                                    goal: "Summarize the work.",
                                    acceptance_criteria: ["The node satisfies its acceptance criteria."],
                                    constraints: []
                                },
                                support: {
                                    context: [
                                        {
                                            kind: "artifact",
                                            ref: "inspect.agent_response",
                                            name: "inspect_response",
                                            iteration: 1,
                                            attempt: "latest_failed",
                                            if_available: true,
                                            what: "Pointer evidence used by the node under test.",
                                            why: "This context is required by the test scenario."
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.lowered_managed_nodes).toEqual([]);
        const graph = normalized.document?.graph;
        expect(graph?.type).toBe("sequence");
        if (!graph || graph.type !== "sequence") {
            throw new Error("Expected normalized graph to be a sequence.");
        }
        const inspect = graph.steps[0];
        const fanout = graph.steps[1];
        expect(inspect).toEqual(expect.objectContaining({
            type: "agent",
            id: "inspect",
            intent: {
                goal: "Inspect the repository.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
        }));
        if (!fanout || fanout.type !== "parallel") {
            throw new Error("Expected second normalized node to be a parallel container.");
        }
        expect(fanout.steps[0]).toEqual(expect.objectContaining({
            type: "agent",
            id: "fix",
            intent: {
                goal: "Repair the issue.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
        }));
        expect(fanout.steps[1]).toEqual(expect.objectContaining({
            type: "agent",
            id: "handoff",
            support: expect.objectContaining({
                context: [
                    {
                        ref: "inspect.agent_response",
                        name: "inspect_response",
                        node: "inspect",
                        artifact: "agent_response",
                        iteration: 1,
                        attempt: "latest_failed",
                        if_available: true,
                        what: "Pointer evidence used by the node under test.",
                        why: "This context is required by the test scenario."
                    }
                ]
            })
        }));
    });
    it("rejects unsupported data-flow fields as unknown graph syntax", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "removed-data-flow",
            repos: {
                main: {
                    path: "."
                }
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
                        id: "bad",
                        intent: {
                            goal: "Legacy fields.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        inputs: [],
                        context_from: [],
                        outputs: []
                    }
                ]
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].inputs",
                message: 'Unknown field "inputs" is not part of the graph contract.'
            }),
            expect.objectContaining({
                path: "$.graph.steps[0].context_from",
                message: 'Unknown field "context_from" is not part of the graph contract.'
            }),
            expect.objectContaining({
                path: "$.graph.steps[0].outputs",
                message: 'Unknown field "outputs" is not part of the graph contract.'
            })
        ]));
    });
    it("rejects unsupported data-flow fields on managed patterns too", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "removed-managed-data-flow",
            repos: {
                main: {
                    path: "."
                }
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
                        type: "pattern_deep_work",
                        id: "implement",
                        intent: {
                            goal: "Implement the requested change.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        completion: {
                            criteria: [
                                {
                                    id: "focused_tests",
                                    kind: "command",
                                    command: "npm test",
                                    weight: 1
                                }
                            ]
                        },
                        inputs: [],
                        context_from: [],
                        outputs: []
                    }
                ]
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].inputs",
                message: 'Unknown field "inputs" is not part of the graph contract.'
            }),
            expect.objectContaining({
                path: "$.graph.steps[0].context_from",
                message: 'Unknown field "context_from" is not part of the graph contract.'
            }),
            expect.objectContaining({
                path: "$.graph.steps[0].outputs",
                message: 'Unknown field "outputs" is not part of the graph contract.'
            })
        ]));
    });
    it("rejects optional on artifact context as unknown graph syntax", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "removed-artifact-context-optional",
            repos: {
                main: {
                    path: "."
                }
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
                        id: "consume",
                        intent: {
                            goal: "Consume a prior response.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        support: {
                            context: [
                                {
                                    kind: "artifact",
                                    ref: "inspect.agent_response",
                                    name: "prior_response",
                                    node: "inspect",
                                    artifact: "agent_response",
                                    // @ts-expect-error optional was removed from the artifact context contract
                                    optional: true,
                                    what: "Pointer evidence used by the node under test.",
                                    why: "This context is required by the test scenario."
                                }
                            ]
                        }
                    }
                ]
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].support.context[0].optional",
                message: 'Unknown field "optional" is not part of the graph contract.'
            })
        ]));
    });
    it("rejects user-declared artifacts that collide with reserved automatic artifacts", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "reserved-artifacts",
            repos: {
                main: {
                    path: "."
                }
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
                        id: "bad",
                        intent: {
                            goal: "Try to redefine automatic artifacts.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            agent_response: {
                                from: "output_dir",
                                path: "agent-response.md"
                            },
                            verification_json: {
                                from: "output_dir",
                                path: "verification.json",
                                description: "Reserved verification payload."
                            }
                        }
                    }
                ]
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].artifacts.agent_response",
                message: 'Artifact name "agent_response" is reserved by Agentflow.'
            }),
            expect.objectContaining({
                path: "$.graph.steps[0].artifacts.verification_json",
                message: 'Artifact name "verification_json" is reserved by Agentflow.'
            })
        ]));
    });
    it("requires artifact descriptions and rejects removed artifact required flags", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "artifact-descriptions",
            repos: {
                main: {
                    path: "."
                }
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
                        id: "bad",
                        intent: {
                            goal: "Write a packet.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            packet: {
                                from: "output_dir",
                                path: "packet.json",
                                required: true
                            }
                        }
                    }
                ]
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].artifacts.packet.required",
                message: 'Unknown field "required" is not part of the graph contract.'
            }),
            expect.objectContaining({
                path: "$.graph.steps[0].artifacts.packet.description",
                message: "Expected a non-empty string."
            })
        ]));
    });
    it("normalizes optional artifact content types", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "typed-artifact",
            repos: {
                main: {
                    path: "."
                }
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
                        id: "capture_visual",
                        intent: {
                            goal: "Capture the rendered UI state.",
                            acceptance_criteria: ["The screenshot artifact is published."],
                            constraints: []
                        },
                        artifacts: {
                            screenshot: {
                                from: "output_dir",
                                path: "screens/settings.png",
                                description: "Rendered settings-page screenshot.",
                                content_type: "image/png"
                            }
                        }
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.document?.graph.steps[0]).toEqual(expect.objectContaining({
            artifacts: {
                screenshot: {
                    from: "output_dir",
                    path: "screens/settings.png",
                    description: "Rendered settings-page screenshot.",
                    content_type: "image/png"
                }
            }
        }));
    });
    it("rejects executable top-level graphs instead of producing a document", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "top-level-exec",
            repos: {
                main: {
                    path: "."
                }
            },
            profiles: {
                default: {
                    harness: "codex-cli"
                }
            },
            graph: {
                type: "exec",
                id: "run_tests",
                command: "npm"
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.lowered_managed_nodes).toEqual([]);
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.type",
                message: "Top-level graph must be a container node."
            })
        ]));
    });
    it("rejects unknown node kinds and non-object graph documents", () => {
        const unknownNode = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "unknown-node",
            repos: {
                main: {
                    path: "."
                }
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
                        type: "mystery_node",
                        id: "bad"
                    }
                ]
            }
        });
        expect(unknownNode.document).toBeUndefined();
        expect(unknownNode.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].type",
                message: "Node type must be one of: agent, exec, check, checkpoint, sequence, parallel, repeat, pattern_deep_research, pattern_deep_work, pattern_work_list, pattern_map_reduce."
            })
        ]));
        const nonObject = normalizeAuthoredGraphDocument(null);
        expect(nonObject.document).toBeUndefined();
        expect(nonObject.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$",
                message: "Graph document must be a JSON object."
            })
        ]));
    });
    it("accepts xhigh as a supported reasoning effort", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "xhigh-reasoning",
            repos: {
                main: {
                    path: "."
                }
            },
            profiles: {
                default: {
                    harness: "codex-cli",
                    reasoning_effort: "xhigh"
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "inspect",
                        intent: {
                            goal: "Inspect the repository.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        reasoning_effort: "xhigh"
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.document?.profiles?.default?.reasoning_effort).toBe("xhigh");
        const graph = normalized.document?.graph;
        if (!graph || graph.type !== "sequence" || graph.steps[0]?.type !== "agent") {
            throw new Error("Expected normalized graph to contain an agent step.");
        }
        expect(graph.steps[0].reasoning_effort).toBe("xhigh");
    });
    it("normalizes artifact repair policy on profiles and agent nodes", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "artifact-repair-policy",
            repos: {
                main: {
                    path: "."
                }
            },
            profiles: {
                default: {
                    harness: "codex-cli",
                    artifact_repair: {
                        max_attempts: 2
                    }
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
                            goal: "Write the handoff.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifact_repair: {
                            max_attempts: 0
                        }
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.document?.profiles?.default.artifact_repair).toEqual({
            max_attempts: 2
        });
        const graph = normalized.document?.graph;
        if (!graph || graph.type !== "sequence" || graph.steps[0]?.type !== "agent") {
            throw new Error("Expected normalized graph to contain an agent step.");
        }
        expect(graph.steps[0].artifact_repair).toEqual({
            max_attempts: 0
        });
    });
    it("rejects invalid artifact repair policy syntax", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "bad-artifact-repair-policy",
            repos: {
                main: {
                    path: "."
                }
            },
            profiles: {
                default: {
                    harness: "codex-cli",
                    artifact_repair: {
                        max_attempts: 4
                    }
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
                            goal: "Write the handoff.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifact_repair: {
                            max_attempts: -1
                        }
                    },
                    {
                        type: "exec",
                        id: "run_tests",
                        command: "npm",
                        artifact_repair: {
                            max_attempts: 1
                        }
                    }
                ]
            }
        });
        expect(normalized.document).toBeUndefined();
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.profiles.default.artifact_repair.max_attempts",
                message: "Expected an integer between 0 and 3."
            }),
            expect.objectContaining({
                path: "$.graph.steps[0].artifact_repair.max_attempts",
                message: "Expected an integer between 0 and 3."
            }),
            expect.objectContaining({
                path: "$.graph.steps[1].artifact_repair",
                message: 'Unknown field "artifact_repair" is not part of the graph contract.'
            })
        ]));
    });
    it("normalizes env_files on profiles and local command nodes", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "env-files",
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
                    env_files: [".env", ".env.development"]
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "run_script",
                        command: "npm",
                        args: ["test"],
                        env_files: [".env.test"]
                    },
                    {
                        type: "check",
                        id: "verify",
                        check_kind: "deterministic",
                        command: "npm",
                        args: ["test"],
                        env_files: []
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.document?.profiles?.default.env_files).toEqual([".env", ".env.development"]);
        const graph = normalized.document?.graph;
        if (!graph || graph.type !== "sequence") {
            throw new Error("Expected normalized graph to be a sequence.");
        }
        expect(graph.steps[0]).toEqual(expect.objectContaining({
            env_files: [".env.test"]
        }));
        expect(graph.steps[1]).toEqual(expect.objectContaining({
            env_files: []
        }));
    });
    it("rejects env_files on AI checks", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "ai-env-files",
            repos: {
                main: {
                    path: "."
                }
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
                            goal: "Judge it.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        env_files: [".env"]
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].env_files",
                message: 'Field "env_files" does not apply to AI checks.'
            })
        ]));
    });
    it("synthesizes a default repos block when omitted", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "default-repos",
            profiles: {
                default: {
                    harness: "cursor-cli"
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [{ type: "exec", id: "noop", command: "true" }]
            }
        } as never);
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.document?.repos).toEqual({ main: { path: "." } });
    });
    it("defaults workspace_backend to inplace when omitted", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "default-workspace-backend",
            repos: { main: { path: "." } },
            profiles: {
                default: {
                    harness: "cursor-cli"
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [{ type: "exec", id: "noop", command: "true" }]
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.document?.defaults?.workspace_backend).toBe("inplace");
    });
    it("does not expose ephemeral as an authored workspace backend", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "no-authored-ephemeral-workspace",
            repos: { main: { path: "." } },
            defaults: {
                workspace_backend: "ephemeral"
            },
            profiles: {
                default: {
                    harness: "cursor-cli"
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [{ type: "exec", id: "noop", command: "true" }]
            }
        } as never);
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.defaults.workspace_backend",
                message: "Expected one of: inplace, worktree."
            })
        ]));
    });
    it("defaults launch_profile to default when a default profile exists", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "default-launch-profile",
            repos: { main: { path: "." } },
            profiles: {
                default: {
                    harness: "cursor-cli"
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [{ type: "exec", id: "noop", command: "true" }]
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.document?.defaults?.launch_profile).toBe("default");
    });
    it("does not synthesize launch_profile when no default profile exists", () => {
        const normalized = normalizeRawAuthoredGraphDocument({
            version: "1",
            graph_id: "no-default-profile",
            intent: {
                goal: "Test launch profile defaults.",
                acceptance_criteria: ["The graph keeps launch profile unset when there is no default profile."]
            },
            repos: { main: { path: "." } },
            profiles: {
                review: {
                    harness: "cursor-cli"
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
                        type: "exec",
                        id: "noop",
                        intent: {
                            goal: "Run a no-op command.",
                            acceptance_criteria: ["The command exits successfully."],
                            constraints: []
                        },
                        command: "true"
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        expect(normalized.document?.defaults?.launch_profile).toBeUndefined();
    });
    it("derives node and artifact from a dotted ref while accepting bare-node refs", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "ref-derivation",
            repos: { main: { path: "." } },
            profiles: { default: { harness: "cursor-cli" } },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "produce",
                        command: "true"
                    },
                    {
                        type: "agent",
                        id: "consume",
                        intent: {
                            goal: "Consume earlier outputs.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        support: {
                            context: [
                                {
                                    kind: "artifact",
                                    ref: "produce.stdout",
                                    what: "Produced stdout.",
                                    why: "The consumer must read the producer output."
                                } as never,
                                {
                                    kind: "artifact",
                                    ref: "produce",
                                    what: "Produced default output.",
                                    why: "The consumer must read the producer output."
                                } as never
                            ]
                        }
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual([]);
        const consume = (normalized.document?.graph as {
            steps: Array<{
                support?: { context?: unknown };
            }>;
        }).steps[1];
        expect((consume as {
            support: { context: unknown[] };
        }).support.context).toEqual([
            expect.objectContaining({
                ref: "produce.stdout",
                node: "produce",
                artifact: "stdout",
                name: "stdout"
            }),
            expect.objectContaining({
                ref: "produce",
                node: "produce",
                artifact: "stdout",
                name: "produce"
            })
        ]);
    });
    it("rejects bare-node context refs that point at a missing node", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "ref-missing-node",
            repos: { main: { path: "." } },
            profiles: { default: { harness: "cursor-cli" } },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "consume",
                        intent: {
                            goal: "Consume.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        support: {
                            context: [
                                {
                                    kind: "artifact",
                                    ref: "ghost",
                                    what: "Missing producer output.",
                                    why: "This validates missing producer diagnostics."
                                } as never
                            ]
                        }
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                message: expect.stringContaining('unknown node "ghost"')
            })
        ]));
    });
    it("rejects two context items that resolve to the same default name", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "ref-collision",
            repos: { main: { path: "." } },
            profiles: { default: { harness: "cursor-cli" } },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    { type: "exec", id: "left", command: "true" },
                    { type: "exec", id: "right", command: "true" },
                    {
                        type: "agent",
                        id: "merge",
                        intent: {
                            goal: "Merge both stdouts.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        support: {
                            context: [
                                {
                                    kind: "artifact",
                                    ref: "left.stdout",
                                    what: "Left output.",
                                    why: "This validates default-name collision diagnostics."
                                } as never,
                                {
                                    kind: "artifact",
                                    ref: "right.stdout",
                                    what: "Right output.",
                                    why: "This validates default-name collision diagnostics."
                                } as never
                            ]
                        }
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                message: expect.stringMatching(/duplicate context item name|collision/i)
            })
        ]));
    });
    it("rejects artifact keys that contain a dot", () => {
        const normalized = normalizeAuthoredGraphDocument({
            version: "1",
            graph_id: "dot-in-artifact",
            repos: { main: { path: "." } },
            profiles: { default: { harness: "cursor-cli" } },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "produce",
                        intent: {
                            goal: "Write artifacts.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        artifacts: {
                            "bad.name": {
                                from: "output_dir",
                                path: "bad.json",
                                description: "An artifact whose key contains a dot."
                            }
                        }
                    }
                ]
            }
        });
        expect(normalized.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                message: expect.stringMatching(/dot|reserved|separator/i)
            })
        ]));
    });
});
