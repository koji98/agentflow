import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvalSuite, parseJudgeResult, renderGraphTemplate } from "../../src/evals/suite.js";
async function writeMinimalV1Suite(root: string): Promise<string> {
    const suiteDir = join(root, "suite");
    const scenarioDir = join(suiteDir, "scenarios", "artifact-discipline");
    const variantDir = join(suiteDir, "variants");
    const judgesDir = join(suiteDir, "judges");
    const gradersDir = join(suiteDir, "graders");
    await mkdir(join(scenarioDir, "repo"), { recursive: true });
    await mkdir(variantDir, { recursive: true });
    await mkdir(judgesDir, { recursive: true });
    await mkdir(gradersDir, { recursive: true });
    await writeFile(join(scenarioDir, "repo", "README.md"), "fixture repo\n");
    await writeFile(join(scenarioDir, "docs-response.txt"), "simulated docs\n");
    await writeFile(join(judgesDir, "artifact-quality.md"), "Rate artifact quality from 1 to 5.\n");
    await writeFile(join(gradersDir, "deterministic.mjs"), "console.log(JSON.stringify({ passed: true, score: 1, assertions: [] }));\n");
    await writeFile(join(variantDir, "current.json"), `${JSON.stringify({
        id: "current",
        description: "Current production prompts.",
        env: {
            AGENTFLOW_EVAL_PROMPT_PACK: "current"
        }
    }, null, 2)}\n`);
    await writeFile(join(scenarioDir, "graph.template.json"), `${JSON.stringify({
        version: "1",
        graph_id: "eval-{{scenario.id}}-{{variant.id}}-{{trial.index}}",
        intent: {
            goal: "{{scenario.description}}",
            acceptance_criteria: ["Artifact exists."]
        },
        repos: {
            main: {
                path: "{{environment.repo}}"
            }
        },
        defaults: {
            launch_profile: "default",
            workspace_backend: "inplace"
        },
        profiles: {
            default: {
                harness: "{{workflow.harness}}"
            },
            supervisor: {
                harness: "{{workflow.harness}}",
                sandbox: "read-only"
            }
        },
        supervision: {
            profile: "supervisor",
            max_total_interventions: 0
        },
        graph: {
            type: "sequence",
            id: "root",
            steps: [
                {
                    type: "exec",
                    id: "write_artifact",
                    runtime: { repo: "main" },
                    intent: {
                        goal: "Write the variant marker.",
                        acceptance_criteria: ["Command exits successfully."]
                    },
                    command: "node",
                    args: ["-e", "console.log(process.argv[1])", "{{variant.id}}"]
                }
            ]
        }
    }, null, 2)}\n`);
    await writeFile(join(scenarioDir, "scenario.json"), `${JSON.stringify({
        id: "artifact-discipline",
        bucket: "valid-hard-execution",
        difficulty: "hard",
        description: "Node must publish a real handoff artifact.",
        measurement: {
            claim: "Agentflow should produce a validated handoff artifact without scope drift.",
            scenario_type: "regression",
            metrics: ["outcome", "artifact", "workspace", "trajectory", "delivery"],
            expected_failure_modes: ["missing artifact", "forbidden workspace edit", "missing trajectory event"],
            tweak_signal: "Failure points to artifact guidance, runtime evidence, context packaging, or delivery curation."
        },
        environment: {
            repo: "repo",
            init_git: true,
            simulation: {
                seed: "stable",
                tool_calls: [
                    {
                        id: "docs-503",
                        command: "docs-fetch",
                        match: { argv_contains: ["--url"] },
                        error: { stderr: "maintenance", exit_code: 503 },
                        latency_ms: 1,
                        probability: 1
                    },
                    {
                        id: "docs-ok",
                        command: "docs-ok",
                        match: { argv_exact: ["--url", "local"] },
                        response_file: "docs-response.txt"
                    }
                ]
            },
            scripted_checkpoints: {
                decisions: [
                    { decision: "deny", feedback: "Add evidence." },
                    { decision: "pass" }
                ]
            },
            scripted_resume: {
                human_action: "retry_with_guidance",
                human_note: "Retry with the provided context."
            }
        },
        workflow: {
            graph_template: "graph.template.json",
            harness: "codex-cli",
            workspace_backend: "inplace"
        },
        criteria: {
            outcome: { status: "passed" },
            artifact: { required: [{ name: "handoff", contains: ["validation"] }] },
            workspace: { forbidden_edits: ["forbidden.txt"] },
            supervisor: {},
            trajectory: {
                match: "contains_ordered",
                events: [{ kind: "node_attempt" }, { kind: "artifact_write", artifact: "handoff" }]
            },
            delivery: { required: true },
            deterministic: {},
            "artifact-quality": { dimensions: ["artifact_quality", "graph_contract_adherence"] }
        }
    }, null, 2)}\n`);
    await writeFile(join(suiteDir, "eval.json"), `${JSON.stringify({
        version: "1",
        suite_id: "workflow-quality",
        objective: "Evaluate complete Agentflow workflow behavior.",
        default_trials: 2,
        scenarios: ["scenarios/artifact-discipline/scenario.json"],
        variants: ["variants/current.json"],
        criteria: [
            { id: "outcome", kind: "outcome", required: true },
            { id: "artifact", kind: "artifact", required: true },
            { id: "workspace", kind: "workspace", required: true },
            { id: "supervisor", kind: "supervisor", required: true },
            { id: "trajectory", kind: "trajectory", required: true },
            { id: "delivery", kind: "delivery", required: true },
            { id: "deterministic", kind: "custom_script", command: "node graders/deterministic.mjs" },
            { id: "artifact-quality", kind: "quality", rubric: "judges/artifact-quality.md", required: false }
        ],
        thresholds: {
            pass_rate: 1,
            max_blocker_rate: 0,
            min_average_score: 4
        }
    }, null, 2)}\n`);
    return suiteDir;
}
describe("eval suite v1 loading", () => {
    it("loads the checked-in prompt regression suite as a strict release gate", async () => {
        const loaded = await loadEvalSuite(process.cwd(), "evals/agentflow-prompt-regression");
        expect(loaded.diagnostics).toEqual([]);
        expect(loaded.suite.suite_id).toBe("agentflow-prompt-regression");
        expect(loaded.suite.thresholds).toEqual({
            pass_rate: 1,
            max_blocker_rate: 0,
            min_average_score: 4
        });
        expect(loaded.variants.map((variant) => [variant.id, variant.prompt_pack])).toEqual([
            ["current", "current"],
            ["candidate", "candidate"]
        ]);
        expect(loaded.scenarios).toHaveLength(29);
        expect(loaded.criteria.map((criterion) => [criterion.id, criterion.kind])).toEqual([
            ["outcome", "outcome"],
            ["artifact", "artifact"],
            ["delivery", "delivery"],
            ["prompt-regression", "custom_script"]
        ]);
    });
    it("loads criteria, environment simulation, variant, and renders graph placeholders", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-eval-v1-suite-"));
        const suiteDir = await writeMinimalV1Suite(tempRoot);
        const loaded = await loadEvalSuite(tempRoot, suiteDir);
        const scenario = loaded.scenarios[0]!;
        const variant = loaded.variants[0]!;
        const rendered = await renderGraphTemplate({
            suite_dir: loaded.suite_dir,
            template_path: scenario.graph_template_path,
            scenario,
            variant,
            trial: {
                index: 1,
                id: "trial-001",
                root: "/tmp/trial"
            },
            environment: {
                repo: "/tmp/trial/repo"
            }
        });
        const graph = rendered.graph as {
            graph_id: string;
            intent: {
                goal: string;
            };
            repos: {
                main: {
                    path: string;
                };
            };
            profiles: {
                default: {
                    harness: string;
                };
            };
            graph: {
                steps: Array<{
                    args: string[];
                }>;
            };
        };
        expect(loaded.diagnostics).toEqual([]);
        expect(loaded.suite.version).toBe("1");
        expect(loaded.suite.source_reference).toContain("Demystifying evals for AI agents");
        expect(loaded.suite.source_reference).toContain("ADK");
        expect(loaded.scenarios.map((entry) => entry.id)).toEqual(["artifact-discipline"]);
        expect(scenario.measurement).toEqual(expect.objectContaining({
            claim: expect.stringContaining("validated handoff"),
            scenario_type: "regression",
            metrics: expect.arrayContaining(["outcome", "artifact", "trajectory"]),
            tweak_signal: expect.stringContaining("artifact guidance")
        }));
        expect(loaded.variants.map((entry) => entry.id)).toEqual(["current"]);
        expect(loaded.criteria.map((entry) => [entry.id, entry.kind])).toContainEqual(["artifact-quality", "quality"]);
        expect(scenario.environment.simulation?.tool_calls.map((entry) => entry.id)).toEqual(["docs-503", "docs-ok"]);
        expect(scenario.environment.scripted_checkpoints?.decisions.map((entry) => entry.decision)).toEqual(["deny", "pass"]);
        expect(scenario.environment.scripted_resume?.human_action).toBe("retry_with_guidance");
        expect(rendered.diagnostics).toEqual([]);
        expect(graph.graph_id).toBe("eval-artifact-discipline-current-1");
        expect(graph.intent.goal).toBe("Node must publish a real handoff artifact.");
        expect(graph.repos.main.path).toBe("/tmp/trial/repo");
        expect(graph.profiles.default.harness).toBe("codex-cli");
        expect(graph.graph.steps[0]?.args.at(-1)).toBe("current");
    });
    it("validates rendered graph templates against the current graph contract", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-eval-rendered-graph-"));
        const suiteDir = await writeMinimalV1Suite(tempRoot);
        await writeFile(join(suiteDir, "scenarios", "artifact-discipline", "graph.template.json"), `${JSON.stringify({
            version: "1",
            graph_id: "stale-eval-template",
            intent: {
                goal: "Expose stale graph fields.",
                acceptance_criteria: ["Rendered validation rejects stale graph authoring."]
            },
            repos: {
                main: { path: "{{environment.repo}}" }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {
                    harness: "{{workflow.harness}}",
                    unknown_profile_field: true
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "invalid_exec",
                        command: "node",
                        args: ["-e", "process.exit(0)"],
                        unknown_node_field: ["not allowed"],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const loaded = await loadEvalSuite(tempRoot, suiteDir);
        const messages = loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
        expect(messages).toContain('Unknown field "unknown_profile_field" is not part of the graph contract.');
        expect(messages).toContain('Unknown field "unknown_node_field" is not part of the graph contract.');
        expect(loaded.diagnostics.some((diagnostic) => diagnostic.path.includes(".rendered_graph"))).toBe(true);
    });
    it("rejects unknown eval fields, missing environment paths, duplicate ids, and bad placeholders", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-eval-v1-invalid-"));
        const suiteDir = await writeMinimalV1Suite(tempRoot);
        await writeFile(join(suiteDir, "eval.json"), `${JSON.stringify({
            version: "1",
            suite_id: "bad",
            objective: "bad",
            default_trials: 0,
            scenarios: [
                "scenarios/artifact-discipline/scenario.json",
                "scenarios/artifact-discipline/scenario.json"
            ],
            variants: ["variants/current.json", "variants/current.json"],
            criteria: [
                { id: "outcome", kind: "outcome" },
                { id: "outcome", kind: "outcome" },
                { id: "missing-rubric", kind: "quality", rubric: "judges/missing.md" }
            ],
            unexpected_suite_field: true,
            thresholds: { pass_rate: 2 }
        }, null, 2)}\n`);
        await writeFile(join(suiteDir, "scenarios", "artifact-discipline", "graph.template.json"), `${JSON.stringify({ graph_id: "{{scenario.missing}}" })}\n`);
        await writeFile(join(suiteDir, "scenarios", "artifact-discipline", "scenario.json"), `${JSON.stringify({
            id: "artifact-discipline",
            bucket: "valid-hard-execution",
            difficulty: "hard",
            description: "bad",
            unexpected_scenario_field: true,
            environment: {
                repo: "missing-repo",
                simulation: {
                    tool_calls: [
                        { id: "bad", command: "../bad", response: { stdout: "x" }, probability: 2 }
                    ]
                }
            },
            workflow: { graph_template: "graph.template.json", harness: "codex-cli" },
            criteria: { outcome: {}, unknown: {} }
        }, null, 2)}\n`);
        const loaded = await loadEvalSuite(tempRoot, suiteDir);
        const messages = loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
        expect(messages).toContain("default_trials");
        expect(messages).toContain("pass_rate");
        expect(messages).toContain('Unknown field "unexpected_suite_field" is not part of the eval contract.');
        expect(messages).toContain('Unknown field "unexpected_scenario_field" is not part of the eval contract.');
        expect(messages).toContain("Eval scenario requires measurement object.");
        expect(messages).toContain("Duplicate scenario id");
        expect(messages).toContain("Duplicate variant id");
        expect(messages).toContain("Duplicate criterion id");
        expect(messages).toContain("Environment repo path does not exist");
        expect(messages).toContain("Quality criterion rubric path does not exist");
        expect(messages).toContain("Scenario references unknown criterion");
        expect(messages).toContain("Simulation command must be a command name");
        expect(messages).toContain("Simulation probability must be between 0 and 1");
        expect(messages).toContain("Unknown graph template placeholder");
        await writeFile(join(suiteDir, "eval.json"), `${JSON.stringify({ version: "invalid" })}\n`);
        const unsupported = await loadEvalSuite(tempRoot, suiteDir);
        expect(unsupported.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("Eval suite version must be \"1\"");
    });
    it("validates and preserves real-world scenario metadata", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-eval-realworld-metadata-"));
        const suiteDir = await writeMinimalV1Suite(tempRoot);
        const scenarioPath = join(suiteDir, "scenarios", "artifact-discipline", "scenario.json");
        await writeFile(join(suiteDir, "scenarios", "artifact-discipline", "regression.patch"), "diff --git a/a b/a\n");
        await writeFile(scenarioPath, `${JSON.stringify({
            id: "artifact-discipline",
            bucket: "realworld-regression",
            difficulty: "hard",
            description: "Node must fix a pinned real-world issue.",
            measurement: {
                claim: "Agentflow should solve the pinned issue while preserving scope.",
                scenario_type: "realworld-regression",
                metrics: ["outcome", "workspace", "quality"],
                expected_failure_modes: ["focused test failed", "package manifest changed", "unsupported handoff claim"],
                tweak_signal: "Failure points to prompt/context grounding, validation evidence, or overfit grader assumptions."
            },
            environment: {
                repo: "repo",
                init_git: true
            },
            workflow: {
                graph_template: "graph.template.json",
                harness: "codex-cli",
                workspace_backend: "inplace"
            },
            criteria: {
                outcome: { status: "passed" },
                artifact: { required: [{ name: "handoff", contains: ["validation"] }] },
                workspace: { forbidden_edits: [] },
                supervisor: {},
                trajectory: { match: "contains_any_order", events: [] },
                delivery: { required: true },
                deterministic: {},
                "artifact-quality": { dimensions: ["evidence_use"] }
            },
            metadata: {
                realworld: {
                    source_repo: "owner/project",
                    license: "MIT",
                    base_sha: "0123456789abcdef0123456789abcdef01234567",
                    issue_url: "https://github.com/owner/project/issues/1",
                    pr_url: "https://github.com/owner/project/pull/2",
                    oracle_commit_sha: "abcdef0123456789abcdef0123456789abcdef01",
                    package_manager: "npm",
                    regression_patch: "regression.patch",
                    setup_command: "npm install",
                    focused_test_command: "npm test -- --runInBand",
                    allowed_changed_globs: ["src/**"],
                    forbidden_changed_globs: ["test/**"],
                    hidden_oracle_changed_files: ["src/index.js"]
                }
            }
        }, null, 2)}\n`);
        const loaded = await loadEvalSuite(tempRoot, suiteDir);
        expect(loaded.diagnostics).toEqual([]);
        expect(loaded.scenarios[0]?.metadata.realworld?.source_repo).toBe("owner/project");
        expect(loaded.scenarios[0]?.metadata.realworld?.regression_patch_path).toBe(join(suiteDir, "scenarios", "artifact-discipline", "regression.patch"));
        await writeFile(scenarioPath, `${JSON.stringify({
            id: "artifact-discipline",
            bucket: "realworld-regression",
            difficulty: "hard",
            description: "bad metadata",
            measurement: {
                claim: "Invalid metadata fixture.",
                scenario_type: "realworld-regression",
                metrics: ["metadata"],
                expected_failure_modes: ["metadata invalid"],
                tweak_signal: "Fix scenario metadata."
            },
            environment: { repo: "repo" },
            workflow: { graph_template: "graph.template.json", harness: "codex-cli" },
            criteria: { outcome: {}, deterministic: {} },
            metadata: {
                realworld: {
                    source_repo: "owner/project",
                    license: "Apache-2.0",
                    base_sha: "short",
                    issue_url: "not-a-url",
                    pr_url: "https://example.com/pull/2",
                    oracle_commit_sha: "also-short",
                    package_manager: "npm",
                    regression_patch: "missing.patch",
                    setup_command: "npm install",
                    focused_test_command: "npm test",
                    allowed_changed_globs: []
                }
            }
        }, null, 2)}\n`);
        const invalid = await loadEvalSuite(tempRoot, suiteDir);
        const messages = invalid.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
        expect(messages).toContain('license must be "MIT"');
        expect(messages).toContain("base_sha must be a full 40-character git SHA");
        expect(messages).toContain("issue_url must be a GitHub https URL");
        expect(messages).toContain("pr_url must be a GitHub https URL");
        expect(messages).toContain("oracle_commit_sha must be a full 40-character git SHA");
        expect(messages).toContain("at least one allowed_changed_glob");
        await writeFile(scenarioPath, `${JSON.stringify({
            id: "artifact-discipline",
            bucket: "realworld-regression",
            difficulty: "hard",
            description: "missing patch",
            measurement: {
                claim: "Missing patch fixture.",
                scenario_type: "realworld-regression",
                metrics: ["metadata"],
                expected_failure_modes: ["patch missing"],
                tweak_signal: "Fix scenario metadata."
            },
            environment: { repo: "repo" },
            workflow: { graph_template: "graph.template.json", harness: "codex-cli" },
            criteria: { outcome: {}, deterministic: {} },
            metadata: {
                realworld: {
                    source_repo: "owner/project",
                    license: "MIT",
                    base_sha: "0123456789abcdef0123456789abcdef01234567",
                    issue_url: "https://github.com/owner/project/issues/1",
                    pr_url: "https://github.com/owner/project/pull/2",
                    oracle_commit_sha: "abcdef0123456789abcdef0123456789abcdef01",
                    package_manager: "npm",
                    regression_patch: "missing.patch",
                    setup_command: "npm install",
                    focused_test_command: "npm test",
                    allowed_changed_globs: ["src/**"],
                    forbidden_changed_globs: [],
                    hidden_oracle_changed_files: []
                }
            }
        }, null, 2)}\n`);
        const missingPatch = await loadEvalSuite(tempRoot, suiteDir);
        expect(missingPatch.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("Real-world regression patch does not exist");
    });
    it("requires every checked-in scenario to declare its measurement contract", async () => {
        for (const suitePath of [
            "evals/agentflow-prompt-regression",
            "evals/agentflow-workflow-quality",
            "evals/agentflow-capability-workflows",
            "evals/agentflow-engineering-parity",
            "evals/agentflow-realworld-issues",
            "evals/agentflow-validation"
        ]) {
            const loaded = await loadEvalSuite(process.cwd(), suitePath);
            expect(loaded.diagnostics).toEqual([]);
            for (const scenario of loaded.scenarios) {
                expect(scenario.measurement, `${suitePath}:${scenario.id}`).toEqual(expect.objectContaining({
                    claim: expect.any(String),
                    scenario_type: expect.any(String),
                    metrics: expect.any(Array),
                    expected_failure_modes: expect.any(Array),
                    tweak_signal: expect.any(String)
                }));
                expect(scenario.measurement.metrics.length, `${suitePath}:${scenario.id}`).toBeGreaterThan(0);
                expect(scenario.measurement.expected_failure_modes.length, `${suitePath}:${scenario.id}`).toBeGreaterThan(0);
            }
        }
    });
    it("parses strict judge JSON and rejects malformed judge scores", () => {
        expect(parseJudgeResult(JSON.stringify({
            passed_quality_bar: true,
            score: 4,
            dimension_scores: { artifact_quality: 4 },
            blockers: [],
            rationale: "Good artifact.",
            prompt_feedback: {
                helpful_sections: ["Declared Artifacts"],
                noisy_sections: [],
                missing_guidance: []
            }
        }))).toEqual({
            result: expect.objectContaining({
                passed_quality_bar: true,
                score: 4,
                dimension_scores: { artifact_quality: 4 }
            })
        });
        expect(parseJudgeResult("{bad json").error).toContain("valid JSON");
        expect(parseJudgeResult(JSON.stringify({ passed_quality_bar: true, score: 6 })).error).toContain("score");
        expect(parseJudgeResult(JSON.stringify({ passed_quality_bar: true, score: 3, blockers: "none" })).error).toContain("blockers");
    });
});
