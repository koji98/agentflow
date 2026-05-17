import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRunExecutionAttempts, readSupervisorTimeline } from "../../src/artifacts/reader.js";
import { resolveExecutionHumanDebugToolDirectory } from "../../src/artifacts/paths.js";
import { executeCli } from "../../src/cli/index.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";
const execFileAsync = promisify(execFile);
async function initGitRepo(repoDir: string): Promise<void> {
    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Agentflow Golden Tests"], { cwd: repoDir });
    await writeFile(join(repoDir, "README.md"), "golden repo\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
}
async function writeExecutable(path: string, source: string): Promise<void> {
    await writeFile(path, source, "utf8");
    await chmod(path, 0o755);
}
async function writeGraph(path: string, graph: Record<string, unknown>): Promise<void> {
    await writeFile(path, `${JSON.stringify(withNodeIntentDefaults(graph as never), null, 2)}\n`, "utf8");
}
async function readJson<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, "utf8")) as T;
}
async function readMilestoneAudit(runRoot: string): Promise<string> {
    const milestoneDir = join(runRoot, "runtime", "milestones");
    const entries = await readdir(milestoneDir).catch(() => []);
    const contents = await Promise.all(entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readFile(join(milestoneDir, entry), "utf8")));
    return contents.join("\n");
}
function baseGraph(graphId: string, steps: unknown[], extra: Record<string, unknown> = {}) {
    return {
        version: "1",
        graph_id: graphId,
        intent: {
            goal: `Run ${graphId} golden workflow.`,
            constraints: ["Keep all evidence inside the test repository and Agentflow run root."],
            acceptance_criteria: [
                "The run reaches the expected terminal state.",
                "Delivery and inspect evidence name the declared artifacts."
            ]
        },
        repos: {
            main: {
                path: "./repo"
            }
        },
        defaults: {
            launch_profile: "default",
            workspace_backend: "inplace"
        },
        profiles: {
            default: {
                harness: "codex-cli",
                sandbox: "workspace-write",
            }
        },
        ...extra,
        graph: {
            type: "sequence",
            id: "root",
            steps
        }
    };
}
async function writeGoldenCodex(tempRoot: string): Promise<string> {
    const codexPath = join(tempRoot, "golden-codex.mjs");
    await writeExecutable(codexPath, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("golden-codex 0.0.0\\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  const outputDir = process.env.AGENTFLOW_OUTPUT_DIR;
  if (!outputDir) {
    process.stderr.write("missing AGENTFLOW_OUTPUT_DIR\\n");
    process.exit(2);
  }
  mkdirSync(outputDir, { recursive: true });

  const outputIndex = args.findIndex((arg) => arg === "--output-last-message");
  const lastMessagePath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const finish = (message) => {
    if (lastMessagePath) {
      mkdirSync(dirname(lastMessagePath), { recursive: true });
      writeFileSync(lastMessagePath, message);
    }
    process.stdout.write(message);
  };
  const runAf = (afArgs, input) => {
    const result = spawnSync("af", afArgs, {
      encoding: "utf8",
      input,
      env: process.env
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout || "af command failed");
      process.exit(result.status || 1);
    }
    return result.stdout;
  };
  const beginNode = (title, goal) => {
    runAf(["orient"]);
    const created = JSON.parse(runAf(["milestone", "add", "--title", title, "--goal", goal]));
    return created.milestone.id;
  };
  const logValidation = (id, command, summary) => {
    runAf(["milestone", "log", id, "--kind", "validation", "--command", command, "--result", "pass", "--summary", summary]);
  };
  const completeNode = (id, evidence) => {
    runAf(["milestone", "complete", id, "--evidence", evidence]);
  };
  const writeArtifact = (name, content) => {
    runAf(["artifact", "write", name], content);
  };

  if (prompt.includes("Agentflow outcome verifier")) {
    const verifierJson = JSON.stringify({
      passed: true,
      summary: "Golden verifier accepts agent attempt.",
      findings: [],
      blockers: []
    }, null, 2);
    finish("\`\`\`json\\n" + verifierJson + "\\n\`\`\`\\n");
    return;
  }

  if (prompt.includes("Research Package Golden")) {
    const milestone = beginNode("Publish research package", "Write all declared research artifacts.");
    writeArtifact("research_report", "# Research Report\\n\\nGolden research package.\\n");
    writeArtifact("source_ledger", JSON.stringify({ sources: ["README.md"] }, null, 2) + "\\n");
    writeArtifact("uncertainties", "No open uncertainties.\\n");
    logValidation(milestone, "af artifact write research_report/source_ledger/uncertainties", "Research package published");
    completeNode(milestone, "Research report, source ledger, and uncertainties were published.");
    finish("research package complete\\n");
    return;
  }

  if (prompt.includes("Plugin Tool Golden")) {
    const milestone = beginNode("Capture plugin tool output", "Run the managed plugin tool and publish its output.");
    const tool = spawnSync("fixture-inspect", ["--subject", "golden"], {
      encoding: "utf8",
      env: process.env
    });
    if (tool.status !== 0) {
      process.stderr.write(tool.stderr || tool.stdout || "fixture-inspect failed");
      process.exit(tool.status || 1);
    }
    writeArtifact("tool_report", tool.stdout);
    logValidation(milestone, "fixture-inspect --subject golden", "Plugin tool output captured");
    completeNode(milestone, "Plugin tool output was captured in the declared artifact.");
    finish("plugin tool complete\\n");
    return;
  }

  if (prompt.includes("Repair Task")) {
    const milestone = beginNode("Repair missing artifact", "Publish the missing repaired handoff.");
    writeArtifact("repair_handoff", "repaired handoff\\n");
    logValidation(milestone, "af artifact write repair_handoff", "Repair artifact was published");
    completeNode(milestone, "Missing artifact was repaired.");
    finish("repair artifact written\\n");
    return;
  }

  if (prompt.includes("Repairable Golden")) {
    const milestone = beginNode("Attempt repairable node", "Complete the node while intentionally omitting the declared handoff for repair coverage.");
    logValidation(milestone, "initial response", "Initial response intentionally omitted the declared artifact");
    completeNode(milestone, "Initial response was produced for artifact repair coverage.");
    finish("initial response without declared artifact\\n");
    return;
  }

  if (prompt.includes("Contract Gap Golden approved")) {
    const milestone = beginNode("Complete reviewed retry", "Complete after graph review.");
    logValidation(milestone, "graph review", "Graph-reviewed retry completed");
    completeNode(milestone, "Policy-sensitive step completed after graph review.");
    finish("contract retry approved\\n");
    return;
  }

  if (prompt.includes("Contract Gap Golden")) {
    process.stderr.write("operation escapes the workspace\\n");
    process.exit(1);
  }

  finish("golden codex default response\\n");
});
`);
    return codexPath;
}
async function assertDeliveryAndInspect(runRoot: string, expectedStatus = "passed") {
    const manifestPath = join(runRoot, "delivery", "manifest.json");
    const reviewBriefPath = join(runRoot, "delivery", "01-review-brief.md");
    const runLearningsPath = join(runRoot, "delivery", "02-run-learnings.md");
    const manifest = await readJson<{
        status: string;
        human_entrypoints: {
            review_brief: string;
            run_learnings: string;
            audit_index: string;
        };
        artifact_taxonomy: {
            declared_artifacts: Array<{
                label: string;
                path: string;
            }>;
        };
    }>(manifestPath);
    const reviewBrief = await readFile(reviewBriefPath, "utf8");
    const runLearnings = await readFile(runLearningsPath, "utf8");
    const inspect = await executeCli(["inspect", runRoot]);
    const inspectPayload = JSON.parse(inspect.stdout);
    expect(manifest.status).toBe(expectedStatus);
    expect(manifest.human_entrypoints.review_brief).toBe(reviewBriefPath);
    expect(reviewBrief).toContain("Review Brief");
    expect(reviewBrief).toContain("Final Declared Artifacts");
    expect(runLearnings).toContain("Run Learnings");
    expect(inspect.exitCode).toBe(0);
    expect(inspectPayload.run_status).toBe(expectedStatus);
    expect(inspectPayload.review_brief).toBe(reviewBriefPath);
    expect(inspectPayload.delivery_artifact_taxonomy).toEqual(expect.objectContaining({
        human_entrypoints: expect.any(Number),
        declared_artifacts: expect.any(Number),
        audit_trail: expect.any(Number)
    }));
    return { manifest, inspectPayload };
}
describe("golden end-to-end graph runs", { timeout: 90000 }, () => {
    let tempRoot: string;
    let previousCodexBin: string | undefined;
    beforeEach(async () => {
        tempRoot = await mkdtemp(join(tmpdir(), "agentflow-golden-e2e-"));
        previousCodexBin = process.env.AGENTFLOW_CODEX_CLI_BIN;
    });
    afterEach(async () => {
        if (previousCodexBin === undefined) {
            delete process.env.AGENTFLOW_CODEX_CLI_BIN;
        }
        else {
            process.env.AGENTFLOW_CODEX_CLI_BIN = previousCodexBin;
        }
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("produces a research package with delivery, runtime log, and inspect evidence", async () => {
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "research.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        process.env.AGENTFLOW_CODEX_CLI_BIN = await writeGoldenCodex(tempRoot);
        await writeGraph(graphPath, baseGraph("golden-research-package", [
            {
                type: "agent",
                id: "research",
                runtime: { repo: "main" },
                intent: {
                    goal: "Research Package Golden: publish a sourced research package.",
                    acceptance_criteria: ["The report, source ledger, and uncertainty notes are present."],
                    constraints: []
                },
                artifacts: {
                    research_report: {
                        from: "output_dir",
                        path: "research-report.md",
                        description: "Markdown research report."
                    },
                    source_ledger: {
                        from: "output_dir",
                        path: "source-ledger.json",
                        description: "JSON source ledger."
                    },
                    uncertainties: {
                        from: "output_dir",
                        path: "uncertainties.md",
                        description: "Open uncertainty notes."
                    }
                }
            }
        ]));
        const result = await executeCli(["run", "--graph", graphPath], tempRoot);
        const payload = JSON.parse(result.stdout);
        const { manifest, inspectPayload } = await assertDeliveryAndInspect(payload.run_root);
        const milestoneAudit = await readMilestoneAudit(payload.run_root);
        expect(result.exitCode).toBe(0);
        expect(manifest.artifact_taxonomy.declared_artifacts.map((entry) => entry.label)).toEqual(expect.arrayContaining([
            "research.research_report",
            "research.source_ledger",
            "research.uncertainties"
        ]));
        expect(inspectPayload.run_status).toBe("passed");
        expect(milestoneAudit).toContain("Research package published");
    });
    it("runs an implementation slice with deterministic verification and delivery evidence", async () => {
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "implementation.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeGraph(graphPath, baseGraph("golden-implementation-check", [
            {
                type: "exec",
                id: "implement_slice",
                runtime: { repo: "main" },
                command: process.execPath,
                args: [
                    "-e",
                    "const fs=require('node:fs'); const path=require('node:path'); fs.writeFileSync('feature.txt','implemented\\n'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'change-summary.md'),'implemented feature\\n');"
                ],
                artifacts: {
                    change_summary: {
                        from: "output_dir",
                        path: "change-summary.md",
                        description: "Implementation summary."
                    }
                }
            },
            {
                type: "check",
                id: "verify_slice",
                runtime: { repo: "main" },
                check_kind: "deterministic",
                command: process.execPath,
                args: [
                    "-e",
                    "const fs=require('node:fs'); const path=require('node:path'); const passed=fs.readFileSync('feature.txt','utf8').includes('implemented'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'verification.json'), JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                ],
                pass_if: {
                    json_path: "$.passed",
                    equals: true
                },
                artifacts: {
                    verification: {
                        from: "output_dir",
                        path: "verification.json",
                        description: "Deterministic verification JSON."
                    }
                }
            }
        ]));
        const result = await executeCli(["run", "--graph", graphPath], tempRoot);
        const payload = JSON.parse(result.stdout);
        const { manifest, inspectPayload } = await assertDeliveryAndInspect(payload.run_root);
        expect(result.exitCode).toBe(0);
        expect(manifest.artifact_taxonomy.declared_artifacts.map((entry) => entry.label)).toEqual(expect.arrayContaining(["implement_slice.change_summary", "verify_slice.verification"]));
        expect(inspectPayload.failed_node_count).toBe(0);
        await expect(readFile(join(repoDir, "feature.txt"), "utf8")).resolves.toBe("implemented\n");
    });
    it("executes a plugin-bundled tool through an agent and records the tool ledger", async () => {
        const repoDir = join(tempRoot, "repo");
        const pluginDir = join(tempRoot, "fixture-plugin");
        const graphPath = join(tempRoot, "plugin.graph.json");
        await mkdir(repoDir, { recursive: true });
        await mkdir(join(pluginDir, "tools"), { recursive: true });
        await initGitRepo(repoDir);
        process.env.AGENTFLOW_CODEX_CLI_BIN = await writeGoldenCodex(tempRoot);
        await writeFile(join(pluginDir, "agentflow.plugin.json"), `${JSON.stringify({
            schema: "agentflow.plugin/1",
            id: "fixture",
            version: "1.0.0",
            workflows: {},
            credentials: {},
            tools: {
                inspect: {
                    executable: "tools/inspect.mjs",
                    description: "Inspect fixture input."
                }
            }
        }, null, 2)}\n`);
        await writeExecutable(join(pluginDir, "tools", "inspect.mjs"), `#!/usr/bin/env node
const subjectIndex = process.argv.indexOf("--subject");
const subject = subjectIndex >= 0 ? process.argv[subjectIndex + 1] : "unknown";
if (process.argv.includes("--help")) {
  process.stdout.write("Usage:\\n  fixture-inspect --subject <name>\\nOptions:\\n  --subject <name> Subject. Default: unknown\\nOutput:\\n  JSON object.\\nExit codes:\\n  0 success\\nExamples:\\n  fixture-inspect --subject golden\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ subject, ok: true }) + "\\n");
`);
        await writeGraph(graphPath, baseGraph("golden-plugin-tool", [
            {
                type: "agent",
                id: "use_tool",
                runtime: { repo: "main" },
                intent: {
                    goal: "Plugin Tool Golden: call the fixture inspect tool and publish its output.",
                    acceptance_criteria: ["The plugin tool output is captured as a declared artifact."],
                    constraints: []
                },
                support: {
                    tools: [{ ref: "fixture_inspect" }]
                },
                artifacts: {
                    tool_report: {
                        from: "output_dir",
                        path: "tool-report.md",
                        description: "Plugin tool output."
                    }
                }
            }
        ], {
            plugins: {
                fixture: {
                    path: "./fixture-plugin"
                }
            },
            tools: {
                fixture_inspect: {
                    ref: "fixture/inspect",
                    alias: "fixture-inspect"
                }
            }
        }));
        const resolveResult = await executeCli(["plugin", "resolve", "--graph", graphPath], tempRoot);
        expect(resolveResult.exitCode).toBe(0);
        const result = await executeCli(["run", "--graph", graphPath], tempRoot);
        const payload = JSON.parse(result.stdout);
        const attempts = await readRunExecutionAttempts(payload.run_root);
        const toolLedger = await readFile(join(resolveExecutionHumanDebugToolDirectory(attempts[0]!.execution_dir), "index.jsonl"), "utf8");
        const milestoneAudit = await readMilestoneAudit(payload.run_root);
        const { inspectPayload } = await assertDeliveryAndInspect(payload.run_root);
        expect(result.exitCode).toBe(0);
        expect(toolLedger).toContain('"kind":"plugin_tool"');
        expect(toolLedger).toContain('"tool":"fixture-inspect"');
        expect(inspectPayload.run_status).toBe("passed");
        expect(milestoneAudit).toContain("Plugin tool output captured");
        await expect(readFile(attempts[0]!.artifacts.tool_report!, "utf8")).resolves.toContain('"subject":"golden"');
    });
    it("repairs a missing agent artifact and records supervisor intervention evidence", async () => {
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "repair.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        process.env.AGENTFLOW_CODEX_CLI_BIN = await writeGoldenCodex(tempRoot);
        await writeGraph(graphPath, baseGraph("golden-artifact-repair", [
            {
                type: "agent",
                id: "repairable",
                runtime: { repo: "main" },
                intent: {
                    goal: "Repairable Golden: initially omit the declared handoff so the supervisor repairs it.",
                    acceptance_criteria: ["The final handoff artifact exists after repair."],
                    constraints: []
                },
                artifact_repair: {
                    max_attempts: 1
                },
                artifacts: {
                    repair_handoff: {
                        from: "output_dir",
                        path: "repair-handoff.md",
                        description: "Handoff repaired by the supervisor."
                    }
                }
            }
        ], {
            supervision: { profile: "supervisor", max_total_interventions: 1 }
        }));
        const result = await executeCli(["run", "--graph", graphPath], tempRoot);
        const payload = JSON.parse(result.stdout);
        const attempts = await readRunExecutionAttempts(payload.run_root);
        const timeline = await readSupervisorTimeline(payload.run_root);
        const interventions = await readFile(join(payload.run_root, "interventions.jsonl"), "utf8");
        const { inspectPayload } = await assertDeliveryAndInspect(payload.run_root);
        expect(result.exitCode).toBe(0);
        expect(timeline.length).toBeGreaterThan(0);
        expect(interventions).toContain("repair_artifact");
        expect(attempts[0]!.metadata.artifact_repair).toEqual(expect.objectContaining({
            status: "passed",
            attempt_count: 1
        }));
        await expect(readFile(attempts[0]!.artifacts.repair_handoff!, "utf8")).resolves.toBe("repaired handoff\n");
        expect(inspectPayload.supervisor_timeline_count).toBeGreaterThan(0);
        expect(inspectPayload.intervention_count).toBe(1);
    });
    it("fails contractually and resumes after the graph changes", async () => {
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "pause.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        process.env.AGENTFLOW_CODEX_CLI_BIN = await writeGoldenCodex(tempRoot);
        const graph = (goal: string) => baseGraph("golden-pause-resume", [
            {
                type: "agent",
                id: "policy_sensitive_step",
                runtime: { repo: "main" },
                intent: {
                    goal,
                    acceptance_criteria: ["The policy-sensitive step either fails contractually or completes after graph review."],
                    constraints: []
                }
            }
        ], {
            supervision: { profile: "supervisor", max_total_interventions: 1 }
        });
        await writeGraph(graphPath, graph("Contract Gap Golden: trigger a policy failure."));
        const failed = await executeCli(["run", "--graph", graphPath], tempRoot);
        const failedPayload = JSON.parse(failed.stdout);
        await writeGraph(graphPath, graph("Contract Gap Golden approved: complete after graph review."));
        const resumed = await executeCli([
            "resume",
            "--run-root",
            failedPayload.run_root
        ], tempRoot);
        const resumedPayload = JSON.parse(resumed.stdout);
        const { inspectPayload } = await assertDeliveryAndInspect(failedPayload.run_root);
        expect(failed.exitCode).toBe(1);
        expect(failedPayload.status).toBe("failed");
        expect(resumed.exitCode).toBe(0);
        expect(resumedPayload.status).toBe("passed");
        expect(resumedPayload.resumed_from_status).toBe("failed");
        expect(resumedPayload.restarted_node_count).toBe(1);
        expect(inspectPayload.run_status).toBe("passed");
    });
});
