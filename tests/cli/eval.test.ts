import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { executeCli } from "../../src/cli/index.js";
const execFileAsync = promisify(execFile);
async function initGitRepo(repoDir: string): Promise<void> {
    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
    await writeFile(join(repoDir, "README.md"), "seed\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
}
async function writeWorkflowEvalFixture(tempRoot: string): Promise<{
    suiteDir: string;
    evalRoot: string;
}> {
    const suiteDir = join(tempRoot, "suite");
    const scenarioDir = join(suiteDir, "scenarios", "exec-artifact");
    const repoDir = join(scenarioDir, "repo");
    const variantDir = join(suiteDir, "variants");
    const gradersDir = join(suiteDir, "graders");
    const evalRoot = join(tempRoot, "eval-output");
    await mkdir(repoDir, { recursive: true });
    await mkdir(variantDir, { recursive: true });
    await mkdir(gradersDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(join(repoDir, "package.json"), "{\"scripts\":{\"test\":\"node check.js\"}}\n");
    await writeFile(join(repoDir, "check.js"), "process.exit(0);\n");
    await writeFile(join(repoDir, "forbidden.txt"), "this committed fixture file must remain unchanged\n");
    await execFileAsync("git", ["add", "package.json", "check.js", "forbidden.txt"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "fixture files"], { cwd: repoDir });
    await writeFile(join(variantDir, "current.json"), `${JSON.stringify({
        id: "current",
        description: "Current prompts.",
        env: {
            AGENTFLOW_EVAL_PROMPT_PACK: "current"
        }
    }, null, 2)}\n`);
    await writeFile(join(variantDir, "terse.json"), `${JSON.stringify({
        id: "terse",
        description: "Terse prompt pack.",
        env: {
            AGENTFLOW_EVAL_PROMPT_PACK: "terse"
        }
    }, null, 2)}\n`);
    await writeFile(join(gradersDir, "packet.mjs"), [
        "import { readFileSync } from 'node:fs';",
        "const packet = JSON.parse(readFileSync(process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE, 'utf8'));",
        "const passed = packet.outcome.status === 'passed' && packet.artifacts.some((artifact) => artifact.name === 'handoff') && packet.simulation_events.some((event) => event.rule_id === 'remote-ok');",
        "console.log(JSON.stringify({",
        "  passed,",
        "  score: passed ? 5 : 1,",
        "  summary: passed ? 'packet ok' : 'packet missing expected outcome, artifact, or simulation event',",
        "  assertions: [{ id: 'packet', passed, evidence: process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE }],",
        "  metrics: { attempts: packet.metrics.attempts, simulation_events: packet.metrics.simulation_events }",
        "}));"
    ].join("\n"));
    await writeFile(join(gradersDir, "optional-signal.mjs"), [
        "console.log(JSON.stringify({",
        "  passed: false,",
        "  score: 1,",
        "  summary: 'optional signal found a non-gating concern',",
        "  blockers: ['optional concern'],",
        "  assertions: [{ id: 'optional_signal', passed: false, evidence: 'secondary signal only' }]",
        "}));"
    ].join("\n"));
    await writeFile(join(scenarioDir, "graph.template.json"), `${JSON.stringify({
        version: "1",
        graph_id: "eval-cli-v1-{{scenario.id}}-{{variant.id}}-{{trial.index}}",
        intent: {
            goal: "Run the workflow eval case.",
            acceptance_criteria: ["The declared handoff artifact exists."]
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
            max_total_interventions: 3
        },
        graph: {
            type: "sequence",
            id: "root",
            steps: [
                {
                    type: "exec",
                    id: "simulated_remote",
                    runtime: { repo: "main" },
                    intent: {
                        goal: "Call the simulated remote tool so the eval trace records a deterministic tool event.",
                        acceptance_criteria: [
                            "The fixture-remote simulation rule matches.",
                            "The command exits successfully before the handoff writer runs."
                        ],
                        constraints: []
                    },
                    command: "fixture-remote",
                    args: ["--url", "local"]
                },
                {
                    type: "exec",
                    id: "write_handoff",
                    runtime: { repo: "main" },
                    intent: {
                        goal: "Write the declared handoff artifact for eval grading.",
                        acceptance_criteria: [
                            "The handoff artifact exists in the output directory.",
                            "The handoff includes validation evidence text."
                        ],
                        constraints: []
                    },
                    command: "node",
                    args: [
                        "-e",
                        "const fs=require('node:fs'); const path=require('node:path'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'handoff.md'), 'validation evidence for '+process.env.AGENTFLOW_EVAL_PROMPT_PACK+'\\n');"
                    ],
                    artifacts: {
                        handoff: {
                            from: "output_dir",
                            path: "handoff.md",
                            description: "Workflow handoff."
                        }
                    }
                }
            ]
        }
    }, null, 2)}\n`);
    await writeFile(join(scenarioDir, "scenario.json"), `${JSON.stringify({
        id: "exec-artifact",
        bucket: "valid-hard-execution",
        difficulty: "medium",
        description: "A deterministic workflow must write a declared handoff artifact.",
        environment: {
            repo: "repo",
            init_git: true,
            simulation: {
                seed: "eval-cli",
                tool_calls: [
                    {
                        id: "remote-ok",
                        command: "fixture-remote",
                        match: { argv_exact: ["--url", "local"] },
                        response: { stdout: "remote ok\\n" }
                    }
                ]
            }
        },
        workflow: {
            graph_template: "graph.template.json",
            harness: "codex-cli",
            workspace_backend: "inplace"
        },
        criteria: {
            outcome: { status: "passed" },
            artifact: { required: [{ name: "handoff", contains: ["validation evidence"] }] },
            workspace: { forbidden_edits: ["forbidden.txt"] },
            trajectory: {
                match: "contains_ordered",
                events: [
                    { kind: "simulation_tool_call", rule_id: "remote-ok", matched: true },
                    { kind: "artifact_write", artifact: "handoff" }
                ]
            },
            delivery: { required: true },
            packet: {},
            optional_signal: {}
        }
    }, null, 2)}\n`);
    await writeFile(join(suiteDir, "eval.json"), `${JSON.stringify({
        version: "1",
        suite_id: "workflow-eval-cli",
        objective: "Exercise the v1 workflow eval CLI.",
        default_trials: 2,
        scenarios: ["scenarios/exec-artifact/scenario.json"],
        variants: ["variants/current.json", "variants/terse.json"],
        criteria: [
            { id: "outcome", kind: "outcome", required: true },
            { id: "artifact", kind: "artifact", required: true },
            { id: "workspace", kind: "workspace", required: true },
            { id: "trajectory", kind: "trajectory", required: true },
            { id: "delivery", kind: "delivery", required: true },
            { id: "packet", kind: "custom_script", command: "node graders/packet.mjs" },
            { id: "optional_signal", kind: "custom_script", command: "node graders/optional-signal.mjs", required: false }
        ],
        thresholds: {
            pass_rate: 1,
            max_blocker_rate: 0,
            min_average_score: 4
        }
    }, null, 2)}\n`);
    return { suiteDir, evalRoot };
}
describe("eval CLI v1", () => {
    it("validates, runs trials, reports, inspects, and compares workflow evals", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-eval-v1-"));
        const { suiteDir, evalRoot } = await writeWorkflowEvalFixture(tempRoot);
        const validateResult = await executeCli(["eval", "validate", suiteDir], tempRoot);
        const validatePayload = JSON.parse(validateResult.stdout);
        expect(validateResult.exitCode).toBe(0);
        expect(validatePayload.command).toBe("eval validate");
        expect(validatePayload.status).toBe("passed");
        expect(validatePayload.scenario_count).toBe(1);
        expect(validatePayload.variants).toEqual(["current", "terse"]);
        expect(validatePayload.criterion_count).toBe(7);
        const runResult = await executeCli(["eval", "run", suiteDir, "--eval-root", evalRoot, "--variant", "all", "--trials", "2", "--concurrency", "2"], tempRoot);
        const runPayload = JSON.parse(runResult.stdout);
        const benchmark = JSON.parse(await readFile(join(evalRoot, "benchmark.json"), "utf8"));
        const scorecard = JSON.parse(await readFile(join(evalRoot, "scenarios", "exec-artifact", "current", "trial-001", "scorecard.json"), "utf8"));
        const currentTrialOneRoot = (await readFile(join(evalRoot, "scenarios", "exec-artifact", "current", "trial-001", "run-root.txt"), "utf8")).trim();
        const currentTrialTwoRoot = (await readFile(join(evalRoot, "scenarios", "exec-artifact", "current", "trial-002", "run-root.txt"), "utf8")).trim();
        const terseTrialOneRoot = (await readFile(join(evalRoot, "scenarios", "exec-artifact", "terse", "trial-001", "run-root.txt"), "utf8")).trim();
        const terseTrialTwoRoot = (await readFile(join(evalRoot, "scenarios", "exec-artifact", "terse", "trial-002", "run-root.txt"), "utf8")).trim();
        const currentTrace = JSON.parse(await readFile(join(evalRoot, "scenarios", "exec-artifact", "current", "trial-001", "trace-packet.json"), "utf8")) as {
            artifacts: Array<{
                name: string;
                content?: string;
            }>;
            trajectory: Array<{
                kind: string;
                rule_id?: string;
            }>;
        };
        const terseTrace = JSON.parse(await readFile(join(evalRoot, "scenarios", "exec-artifact", "terse", "trial-001", "trace-packet.json"), "utf8")) as {
            artifacts: Array<{
                name: string;
                content?: string;
            }>;
        };
        expect(runResult.exitCode).toBe(0);
        expect(runPayload.command).toBe("eval run");
        expect(runPayload.status).toBe("passed");
        expect(benchmark.total_trials).toBe(4);
        expect(benchmark.pass_rate).toBe(1);
        expect(benchmark.blocker_rate).toBe(0);
        expect(benchmark.threshold_passed).toBe(true);
        expect(benchmark.criteria.some((criterion: {
            criterion_id: string;
        }) => criterion.criterion_id === "trajectory")).toBe(true);
        expect(benchmark.criteria.find((criterion: {
            criterion_id: string;
            blocker_count: number;
        }) => criterion.criterion_id === "optional_signal")?.blocker_count).toBeGreaterThan(0);
        expect(benchmark.average_score).toBeGreaterThanOrEqual(4);
        expect(await readFile(join(evalRoot, "prompt-pack-diff.md"), "utf8")).toContain("# Prompt Pack Diff");
        expect(JSON.parse(await readFile(join(evalRoot, "prompt-pack-diff.json"), "utf8")).variants).toHaveLength(2);
        expect(scorecard.criteria_results.filter((result: {
            required: boolean;
        }) => result.required).every((result: {
            status: string;
        }) => result.status === "passed")).toBe(true);
        expect(scorecard.metrics.blockers).toBe(0);
        expect(scorecard.criteria_results.find((result: {
            id: string;
            status: string;
            required: boolean;
        }) => result.id === "optional_signal")).toEqual(expect.objectContaining({
            required: false,
            status: "failed"
        }));
        expect(scorecard.criteria_results
            .find((result: {
            id: string;
        }) => result.id === "workspace")
            ?.assertions.find((assertion: {
            id: string;
        }) => assertion.id === "forbidden_edit:forbidden.txt")).toEqual(expect.objectContaining({
            passed: true,
            evidence: expect.stringContaining("forbidden.txt unchanged")
        }));
        expect(scorecard.metrics.attempts).toBeGreaterThanOrEqual(1);
        expect(currentTrialOneRoot).toContain(join(evalRoot, "scenarios", "exec-artifact", "current", "trial-001", "runs"));
        expect(currentTrialTwoRoot).toContain(join(evalRoot, "scenarios", "exec-artifact", "current", "trial-002", "runs"));
        expect(terseTrialOneRoot).toContain(join(evalRoot, "scenarios", "exec-artifact", "terse", "trial-001", "runs"));
        expect(terseTrialTwoRoot).toContain(join(evalRoot, "scenarios", "exec-artifact", "terse", "trial-002", "runs"));
        expect(currentTrace.artifacts.some((artifact) => artifact.name === "handoff" && artifact.content?.includes("validation evidence for current"))).toBe(true);
        expect(currentTrace.trajectory.some((event) => event.kind === "simulation_tool_call" && event.rule_id === "remote-ok")).toBe(true);
        expect(terseTrace.artifacts.some((artifact) => artifact.name === "handoff" && artifact.content?.includes("validation evidence for terse"))).toBe(true);
        const reportJson = await executeCli(["eval", "report", evalRoot, "--format", "json"], tempRoot);
        expect(reportJson.exitCode).toBe(0);
        expect(JSON.parse(reportJson.stdout).benchmark.total_trials).toBe(4);
        const reportMarkdown = await executeCli(["eval", "report", evalRoot, "--format", "markdown"], tempRoot);
        expect(reportMarkdown.exitCode).toBe(0);
        expect(reportMarkdown.stdout).toContain("# Eval Suite workflow-eval-cli");
        expect(reportMarkdown.stdout).toContain("## Criteria");
        expect(reportMarkdown.stdout).toContain("Prompt pack diff:");
        const inspectResult = await executeCli(["eval", "inspect", evalRoot, "--scenario", "exec-artifact", "--variant", "current", "--trial", "1"], tempRoot);
        const inspectPayload = JSON.parse(inspectResult.stdout);
        expect(inspectResult.exitCode).toBe(0);
        expect(inspectPayload.scorecard.metrics.attempts).toBeGreaterThanOrEqual(1);
        expect(inspectPayload.scorecard.criteria_results.map((result: {
            id: string;
        }) => result.id)).toContain("packet");
        const compareResult = await executeCli(["eval", "compare", evalRoot, "--baseline", "current", "--candidate", "terse"], tempRoot);
        const comparePayload = JSON.parse(compareResult.stdout);
        expect(compareResult.exitCode).toBe(0);
        expect(comparePayload.baseline.variant_id).toBe("current");
        expect(comparePayload.candidate.variant_id).toBe("terse");
        expect(comparePayload.delta.pass_rate).toBe(0);
        expect(comparePayload.candidate_regresses_baseline).toBe(false);
        expect(comparePayload.candidate_meets_or_exceeds_baseline).toBe(true);
        expect(comparePayload.criteria_delta.some((entry: {
            criterion_id: string;
        }) => entry.criterion_id === "packet")).toBe(true);
    }, 120000);
    it("uses the positional eval surface and rejects old --suite usage", async () => {
        const result = await executeCli(["eval", "validate", "--suite", "suite.json"]);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toContain("Unexpected option(s): --suite");
    });
});
