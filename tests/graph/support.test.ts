import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { loadAuthoredGraphDocument, validateAuthoredGraphDocument } from "../../src/graph/validate.js";
import { renderHarnessPrompt, type AgentInvocation } from "../../src/runtime/harness/types.js";
import { loadResolvedSkillSources, resolveSkillSourcesForGraph } from "../../src/skills/sources.js";
async function writeSkill(root: string, path: string, frontmatter: string): Promise<void> {
    const directory = join(root, path);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `${frontmatter}\n\n# ${path}\n`, "utf8");
}
function graphWithSupport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: "1",
        graph_id: "support-contract",
        intent: {
            goal: "Validate support authoring.",
            acceptance_criteria: ["Only selected support is prompted."]
        },
        repos: {
            main: { path: "." }
        },
        defaults: {
            launch_profile: "review"
        },
        profiles: {
            review: {
                harness: "codex-cli",
                model: "gpt-5.2",
                reasoning_effort: "medium",
                sandbox: "workspace-write"
            },
            supervisor: {
                harness: "codex-cli",
                sandbox: "read-only"
            }
        },
        supervision: {
            profile: "supervisor",
            max_total_interventions: 0
        },
        skill_sources: {
            team: {
                path: "./skills"
            }
        },
        capabilities: {
            pr_review: {
                skills: ["team/pr-review", "team/release-handoff"],
                cli: [
                    {
                        cmd: "sh",
                        description: "Run portable shell checks."
                    }
                ]
            }
        },
        graph: {
            type: "sequence",
            id: "root",
            steps: [
                {
                    type: "agent",
                    id: "watch_pr",
                    runtime: {
                        repo: "main",
                        profile: "review"
                    },
                    intent: {
                        goal: "Produce the ship-readiness handoff.",
                        acceptance_criteria: ["The handoff cites release notes and PR status."],
                        constraints: ["Do not mutate remote services."]
                    },
                    support: {
                        capabilities: [{ ref: "pr_review" }],
                        skills: ["team/issue-triage"],
                        cli: [
                            {
                                cmd: "sh",
                                description: "Run portable shell checks."
                            }
                        ],
                        context: [
                            {
                                name: "release_notes",
                                kind: "workspace_file",
                                path: "README.md",
                                what: "Draft release notes from the repository.",
                                why: "They are required input for the final handoff."
                            }
                        ]
                    },
                    artifacts: {
                        ship_handoff: {
                            from: "output_dir",
                            path: "ship-handoff.md",
                            description: "Final ship-readiness handoff."
                        }
                    }
                }
            ]
        },
        ...overrides
    };
}
function invocationForPrompt(overrides: Partial<AgentInvocation>): AgentInvocation {
    return {
        promptKind: "agent",
        runId: "run-support",
        executionId: "exec-support",
        repoAlias: "main",
        repoPath: "/tmp/workspace",
        sandbox: "workspace-write",
        model: "gpt-5.2",
        reasoningEffort: "medium",
        contextPacketPath: "/tmp/run/runtime/context.json",
        contextManifestPath: "/tmp/run/agent/context.md",
        contextManifest: [
            "# Context Manifest",
            "",
            "## Pointers",
            "",
            "| Name | Kind | Pointer | What | Why |",
            "| --- | --- | --- | --- | --- |",
            "| `release_notes` | `workspace_file` | `/tmp/workspace/README.md` | Draft release notes from the repository. | They are required input for the final handoff. |"
        ].join("\n"),
        outputDir: "/tmp/run/artifacts",
        artifacts: {},
        timeoutSec: 1800,
        signal: undefined,
        ...overrides
    };
}
describe("V1 support authoring", () => {
    it("expands capabilities per node and prompts only selected skills from a larger source", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-support-"));
        try {
            const skillsRoot = join(tempRoot, "skills");
            await writeSkill(skillsRoot, "pr-review", "---\nname: pr-review\ndescription: Review PR evidence.\n---");
            await writeSkill(skillsRoot, "release-handoff", "---\nname: release-handoff\ndescription: Produce release handoffs.\n---");
            await writeSkill(skillsRoot, "issue-triage", "---\nname: issue-triage\ndescription: Triage issue evidence.\n---");
            await writeSkill(skillsRoot, "unused", "---\nname: unused\ndescription: Should not be prompted.\n---");
            await writeFile(join(tempRoot, "README.md"), "# Release notes\n", "utf8");
            const graphPath = join(tempRoot, "graph.json");
            await writeFile(graphPath, `${JSON.stringify(graphWithSupport(), null, 2)}\n`, "utf8");
            const resolution = await resolveSkillSourcesForGraph(tempRoot, graphPath);
            expect(resolution.diagnostics).toEqual([]);
            const parsed = graphWithSupport();
            const normalized = normalizeAuthoredGraphDocument(parsed);
            expect(normalized.diagnostics).toEqual([]);
            expect(normalized.document).toBeDefined();
            const skillDiagnostics: Array<{
                path: string;
                message: string;
            }> = [];
            const resolvedSkills = await loadResolvedSkillSources(graphPath, normalized.document!.skill_sources ?? {}, skillDiagnostics);
            expect(skillDiagnostics).toEqual([]);
            const launch = resolveLaunchConfig(normalized.document!);
            const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes, {
                resolved_skill_sources: resolvedSkills,
                graph_dir: tempRoot
            });
            expect(compilation.diagnostics).toEqual([]);
            const node = compilation.compiled_graph!.nodes.find((item) => item.authored_id === "watch_pr");
            expect(node).toBeDefined();
            expect(node!.skills.map((skill) => skill.ref).sort()).toEqual([
                "team/issue-triage",
                "team/pr-review",
                "team/release-handoff"
            ]);
            expect(node!.skills.some((skill) => skill.ref === "team/unused")).toBe(false);
            expect(node!.cli).toEqual([
                {
                    cmd: "sh",
                    description: "Run portable shell checks."
                }
            ]);
            const prompt = renderHarnessPrompt(invocationForPrompt({
                graphGoal: compilation.compiled_graph!.intent.goal,
                graphAcceptanceCriteria: compilation.compiled_graph!.intent.acceptance_criteria,
                graphConstraints: compilation.compiled_graph!.intent.constraints,
                nodeGoal: node!.intent.goal,
                nodeAcceptanceCriteria: node!.intent.acceptance_criteria,
                nodeConstraints: node!.intent.constraints,
                artifacts: node!.declared_artifacts,
                skills: node!.skills,
                cli: node!.cli
            }));
            expect(prompt).toContain("## Optional Skills");
            expect(prompt).toContain("| Skill | Description | Open |");
            expect(prompt).toContain("| pr-review | Review PR evidence.");
            expect(prompt).toContain("| release-handoff | Produce release handoffs.");
            expect(prompt).toContain("| issue-triage | Triage issue evidence.");
            expect(prompt).not.toContain("team/pr-review");
            expect(prompt).not.toContain("team/unused");
            expect(prompt).not.toContain("Should not be prompted.");
            expect(prompt).toContain("## Ambient CLI Hints");
            expect(prompt).toContain("| `sh` | Run portable shell checks. |");
            expect(prompt).toContain("| `release_notes` | `workspace_file` | `/tmp/workspace/README.md` | Draft release notes from the repository. | They are required input for the final handoff. |");
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("rejects malformed skill frontmatter from resolved skill sources", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-support-bad-frontmatter-"));
        try {
            const skillsRoot = join(tempRoot, "skills");
            await writeSkill(skillsRoot, "bad", "---\nname: bad\n---");
            await writeFile(join(tempRoot, "README.md"), "# Release notes\n", "utf8");
            const graphPath = join(tempRoot, "graph.json");
            await writeFile(graphPath, `${JSON.stringify(graphWithSupport({
                capabilities: {
                    bad_capability: {
                        skills: ["team/bad"]
                    }
                },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "agent",
                            id: "use_bad_skill",
                            runtime: { repo: "main", profile: "review" },
                            intent: {
                                goal: "Use the malformed skill.",
                                acceptance_criteria: ["Validation reports the skill frontmatter problem."]
                            },
                            support: {
                                capabilities: [{ ref: "bad_capability" }]
                            }
                        }
                    ]
                }
            }), null, 2)}\n`, "utf8");
            const resolution = await resolveSkillSourcesForGraph(tempRoot, graphPath);
            expect(resolution.diagnostics).toEqual([]);
            const loaded = await loadAuthoredGraphDocument(tempRoot, graphPath);
            expect(loaded.diagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    path: "$.skill_sources.team",
                    message: "Skill frontmatter requires description."
                }),
                expect.objectContaining({
                    path: "$.capabilities.bad_capability.skills[0]",
                    message: 'Skill "team/bad" is not installed in source "team".'
                })
            ]));
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("rejects prompt-only support on non-prompt executable nodes", async () => {
        const graph = graphWithSupport({
            skill_sources: undefined,
            capabilities: {
                shell_support: {
                    cli: [
                        {
                            cmd: "sh",
                            description: "Run portable shell checks."
                        }
                    ]
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "script_step",
                        command: "node",
                        args: ["--version"],
                        intent: {
                            goal: "Run a deterministic script.",
                            acceptance_criteria: ["The command exits successfully."],
                            constraints: []
                        },
                        support: {
                            capabilities: [{ ref: "shell_support" }]
                        }
                    }
                ]
            }
        });
        const normalized = normalizeAuthoredGraphDocument(graph);
        expect(normalized.diagnostics).toEqual([]);
        await expect(validateAuthoredGraphDocument(normalized.document!)).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.graph.steps[0].support.capabilities[0].ref",
                message: expect.stringContaining("skills and CLI hints can only be attached to prompt-backed agent or AI check nodes")
            })
        ]));
    });
});
