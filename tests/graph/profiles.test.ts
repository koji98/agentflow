import { describe, expect, it } from "vitest";
import type { AgentNode, AuthoredGraphDocument, CheckNode, ExecNode, GraphDefaults, GraphProfile } from "../../src/graph/authored.js";
import { builtInAgentArtifactRepairPolicy, builtInCodexReasoningEffort, builtInTimeoutSeconds, resolveLaunchConfig, resolveNodePolicy, resolveSupervisorPolicy } from "../../src/graph/profiles.js";
function createDocument(profiles: Record<string, GraphProfile>, defaults?: GraphDefaults): AuthoredGraphDocument {
    return {
        version: "1",
        graph_id: "profile-resolution",
        repos: {
            main: {
                path: "."
            }
        },
        ...(defaults ? { defaults } : {}),
        profiles,
        graph: {
            type: "sequence",
            id: "root",
            steps: []
        }
    };
}
describe("graph profile resolution", () => {
    it("falls back to the default profile and built-in node policy defaults", () => {
        const document = createDocument({
            default: {
                harness: "codex-cli"
            }
        });
        const launch = resolveLaunchConfig(document);
        const resolution = resolveNodePolicy(document, launch, {
            type: "agent",
            id: "implement",
            intent: {
                goal: "Implement the change.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
        } satisfies AgentNode);
        expect(launch).toEqual({
            launch_profile: "default",
            workspace_backend: "inplace",
            profile: document.profiles!.default,
            diagnostics: []
        });
        expect(resolution.diagnostics).toEqual([]);
        expect(resolution.policy).toEqual(expect.objectContaining({
            profile_name: "default",
            workspace_backend: "inplace",
            harness: "codex-cli",
            harness_config: {
                isolation: "inherit_user"
            },
            reasoning_effort: builtInCodexReasoningEffort,
            timeout_sec: builtInTimeoutSeconds,
            artifact_repair: builtInAgentArtifactRepairPolicy,
            sandbox: "workspace-write"
        }));
    });
    it("resolves profile harness config with launch inheritance and node overlay", () => {
        const document = createDocument({
            default: {
                harness: "codex-cli",
                harness_config: {
                    isolation: "isolated",
                    codex: {
                        config: {
                            approval_policy: "never",
                            model_provider: "openai"
                        },
                        mcp_servers: {
                            docs: {
                                command: "docs-server"
                            }
                        },
                        plugins: {
                            figma: {
                                enabled: false
                            }
                        },
                        notify: ["terminal-notifier"]
                    }
                }
            },
            worker: {
                harness: "codex-cli",
                harness_config: {
                    isolation: "inherit_user",
                    codex: {
                        config: {
                            approval_policy: "on-request"
                        },
                        mcp_servers: {
                            repo: {
                                command: "repo-server"
                            }
                        },
                        notify: []
                    }
                }
            },
            cursor_worker: {
                harness: "cursor-cli",
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
        }, {
            launch_profile: "default"
        });
        const launch = resolveLaunchConfig(document);
        const codexResolution = resolveNodePolicy(document, launch, {
            type: "agent",
            id: "implement",
            runtime: { profile: "worker" },
            intent: {
                goal: "Implement the change.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
        } satisfies AgentNode);
        const cursorResolution = resolveNodePolicy(document, launch, {
            type: "agent",
            id: "cursor_implement",
            runtime: { profile: "cursor_worker" },
            intent: {
                goal: "Implement the change.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
        } satisfies AgentNode);
        expect(codexResolution.diagnostics).toEqual([]);
        expect(codexResolution.policy.harness_config).toEqual({
            isolation: "inherit_user",
            codex: {
                config: {
                    approval_policy: "on-request",
                    model_provider: "openai"
                },
                mcp_servers: {
                    docs: {
                        command: "docs-server"
                    },
                    repo: {
                        command: "repo-server"
                    }
                },
                plugins: {
                    figma: {
                        enabled: false
                    }
                },
                notify: []
            }
        });
        expect(cursorResolution.diagnostics).toEqual([]);
        expect(cursorResolution.policy.harness_config).toEqual({
            isolation: "isolated",
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
    it("keeps invalid launch overrides explicit without coercing workspace backend", () => {
        const document = createDocument({
            default: {
                harness: "codex-cli"
            }
        });
        const launch = resolveLaunchConfig(document, {
            launchProfile: "missing",
            workspaceBackend: "remote-devbox"
        });
        expect(launch.launch_profile).toBe("missing");
        expect(launch.workspace_backend).toBe("remote-devbox");
        expect(launch.profile).toBeUndefined();
        expect(launch.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.defaults.launch_profile",
                message: 'Unknown launch profile "missing".'
            }),
            expect.objectContaining({
                path: "$.defaults.workspace_backend",
                message: 'Unsupported workspace backend "remote-devbox".'
            })
        ]));
    });
    it("merges launch and node profiles field-by-field without adding harness-only policy to exec nodes", () => {
        const document = createDocument({
            default: {
                harness: "codex-cli"
            },
            review: {}
        }, {
            launch_profile: "default",
            workspace_backend: "inplace"
        });
        const launch = resolveLaunchConfig(document);
        const resolution = resolveNodePolicy(document, launch, {
            type: "exec",
            id: "format",
            runtime: { profile: "review" },
            command: "npm"
        } satisfies ExecNode);
        expect(resolution.diagnostics).toEqual([]);
        expect(resolution.policy).toEqual({
            profile_name: "review",
            workspace_backend: "inplace",
            timeout_sec: builtInTimeoutSeconds
        });
        expect(resolution.policy.harness).toBeUndefined();
        expect(resolution.policy.model).toBeUndefined();
        expect(resolution.policy.sandbox).toBeUndefined();
        expect(resolution.policy.artifact_repair).toBeUndefined();
    });
    it("resolves artifact repair policy only for agent nodes", () => {
        const document = createDocument({
            default: {
                harness: "codex-cli",
                artifact_repair: {
                    max_attempts: 2
                }
            },
            disabled: {
                harness: "codex-cli",
                artifact_repair: {
                    max_attempts: 0
                }
            }
        }, {
            launch_profile: "default"
        });
        const launch = resolveLaunchConfig(document);
        const inherited = resolveNodePolicy(document, launch, {
            type: "agent",
            id: "inherited",
            intent: {
                goal: "Write artifacts.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
        } satisfies AgentNode);
        const profileOverride = resolveNodePolicy(document, launch, {
            type: "agent",
            id: "profile_override",
            runtime: { profile: "disabled" },
            intent: {
                goal: "Write artifacts.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
        } satisfies AgentNode);
        const nodeOverride = resolveNodePolicy(document, launch, {
            type: "agent",
            id: "node_override",
            intent: {
                goal: "Write artifacts.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
            artifact_repair: {
                max_attempts: 3
            }
        } satisfies AgentNode);
        const exec = resolveNodePolicy(document, launch, {
            type: "exec",
            id: "exec",
            command: "npm"
        } satisfies ExecNode);
        expect(inherited.diagnostics).toEqual([]);
        expect(profileOverride.diagnostics).toEqual([]);
        expect(nodeOverride.diagnostics).toEqual([]);
        expect(exec.diagnostics).toEqual([]);
        expect(inherited.policy.artifact_repair).toEqual({ max_attempts: 2 });
        expect(profileOverride.policy.artifact_repair).toEqual({ max_attempts: 0 });
        expect(nodeOverride.policy.artifact_repair).toEqual({ max_attempts: 3 });
        expect(exec.policy.artifact_repair).toBeUndefined();
    });
    it("inherits launch AI-check models only when the node profile stays on the same harness", () => {
        const document = createDocument({
            default: {
                harness: "codex-cli",
                model: "gpt-5-codex",
                ai_check_defaults: {
                    model: "gpt-5-judge"
                }
            },
            same_harness: {
                harness: "codex-cli"
            },
            different_harness: {
                harness: "cursor-cli",
                ai_check_defaults: {
                    rubric: "Review the patch carefully."
                }
            }
        }, {
            launch_profile: "default"
        });
        const launch = resolveLaunchConfig(document);
        const inherited = resolveNodePolicy(document, launch, {
            type: "check",
            id: "judge_same",
            runtime: { profile: "same_harness" },
            check_kind: "ai",
            intent: {
                goal: "Judge the patch.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
        } satisfies CheckNode);
        const isolated = resolveNodePolicy(document, launch, {
            type: "check",
            id: "judge_cross",
            runtime: { profile: "different_harness" },
            check_kind: "ai",
            intent: {
                goal: "Judge the patch.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
        } satisfies CheckNode);
        expect(inherited.diagnostics).toEqual([]);
        expect(inherited.policy).toEqual(expect.objectContaining({
            profile_name: "same_harness",
            harness: "codex-cli",
            model: "gpt-5-judge",
            reasoning_effort: builtInCodexReasoningEffort,
            sandbox: "read-only"
        }));
        expect(isolated.diagnostics).toEqual([]);
        expect(isolated.policy).toEqual(expect.objectContaining({
            profile_name: "different_harness",
            harness: "cursor-cli",
            sandbox: "read-only"
        }));
        expect(isolated.policy.model).toBeUndefined();
    });
    it("lets codex profiles override the default reasoning effort explicitly, including xhigh", () => {
        const document = createDocument({
            default: {
                harness: "codex-cli",
                reasoning_effort: "low"
            }
        }, {
            launch_profile: "default"
        });
        const launch = resolveLaunchConfig(document);
        const resolution = resolveNodePolicy(document, launch, {
            type: "agent",
            id: "implement",
            intent: {
                goal: "Implement the change.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
            reasoning_effort: "xhigh"
        } satisfies AgentNode);
        expect(resolution.diagnostics).toEqual([]);
        expect(resolution.policy.reasoning_effort).toBe("xhigh");
    });
    it("resolves codex skip_git_repo_check only for codex-backed nodes", () => {
        const document = createDocument({
            default: {
                harness: "codex-cli",
                skip_git_repo_check: true
            },
            cursor: {
                harness: "cursor-cli"
            }
        }, {
            launch_profile: "default"
        });
        const launch = resolveLaunchConfig(document);
        const codexResolution = resolveNodePolicy(document, launch, {
            type: "agent",
            id: "implement",
            intent: {
                goal: "Implement the change.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
        } satisfies AgentNode);
        const cursorResolution = resolveNodePolicy(document, launch, {
            type: "agent",
            id: "cursor_implement",
            runtime: { profile: "cursor" },
            intent: {
                goal: "Implement the change.",
                acceptance_criteria: ["The node satisfies its acceptance criteria."],
                constraints: []
            },
        } satisfies AgentNode);
        expect(codexResolution.diagnostics).toEqual([]);
        expect(codexResolution.policy).toEqual(expect.objectContaining({
            harness: "codex-cli",
            skip_git_repo_check: true
        }));
        expect(cursorResolution.diagnostics).toEqual([]);
        expect(cursorResolution.policy.harness).toBe("cursor-cli");
        expect(cursorResolution.policy.skip_git_repo_check).toBeUndefined();
    });
    it("resolves a dedicated supervisor profile", () => {
        const document = createDocument({
            default: {
                harness: "codex-cli",
                model: "gpt-5-codex",
                sandbox: "workspace-write"
            },
            supervisor: {
                model: "gpt-5.2",
                reasoning_effort: "high",
                sandbox: "read-only",
                skip_git_repo_check: true
            }
        }, {
            launch_profile: "default",
            workspace_backend: "worktree"
        });
        document.supervision = {
            profile: "supervisor",
            max_total_interventions: 3
        };
        const launch = resolveLaunchConfig(document);
        const resolution = resolveSupervisorPolicy(document, launch);
        expect(resolution.diagnostics).toEqual([]);
        expect(resolution.policy).toEqual({
            profile_name: "supervisor",
            harness: "codex-cli",
            harness_config: {
                isolation: "isolated"
            },
            model: "gpt-5.2",
            reasoning_effort: "high",
            sandbox: "read-only",
            timeout_sec: builtInTimeoutSeconds,
            skip_git_repo_check: true
        });
    });
});
