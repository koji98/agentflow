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
  const judgesDir = join(suiteDir, "judges");
  const evalRoot = join(tempRoot, "eval-output");

  await mkdir(repoDir, { recursive: true });
  await mkdir(variantDir, { recursive: true });
  await mkdir(gradersDir, { recursive: true });
  await mkdir(judgesDir, { recursive: true });
  await initGitRepo(repoDir);
  await writeFile(join(repoDir, "package.json"), "{\"scripts\":{\"test\":\"node check.js\"}}\n");
  await writeFile(join(repoDir, "check.js"), "process.exit(0);\n");
  await writeFile(join(judgesDir, "artifact-quality.md"), "Return strict JSON rating artifact quality.\n");
  await writeFile(
    join(variantDir, "current.json"),
    `${JSON.stringify({
      id: "current",
      description: "Current prompts.",
      env: {
        AGENTFLOW_EVAL_PROMPT_PACK: "current"
      }
    }, null, 2)}\n`
  );
  await writeFile(
    join(variantDir, "terse.json"),
    `${JSON.stringify({
      id: "terse",
      description: "Terse prompt pack.",
      env: {
        AGENTFLOW_EVAL_PROMPT_PACK: "terse"
      }
    }, null, 2)}\n`
  );
  await writeFile(
    join(gradersDir, "packet.mjs"),
    [
      "import { readFileSync } from 'node:fs';",
      "const packet = JSON.parse(readFileSync(process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE, 'utf8'));",
      "const passed = packet.outcome.status === 'passed' && packet.artifacts.some((artifact) => artifact.name === 'handoff');",
      "console.log(JSON.stringify({",
      "  passed,",
      "  score: passed ? 5 : 1,",
      "  summary: passed ? 'packet ok' : 'packet missing expected outcome or artifact',",
      "  assertions: [{ id: 'packet', passed, evidence: process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE }],",
      "  metrics: { attempts: packet.metrics.attempts }",
      "}));"
    ].join("\n")
  );
  await writeFile(
    join(scenarioDir, "graph.template.json"),
    `${JSON.stringify({
      version: "1",
      graph_id: "eval-cli-v2-{{scenario.id}}-{{variant.id}}-{{trial.index}}",
      intent: {
        goal: "Run the workflow eval case.",
        acceptance_criteria: ["The declared handoff artifact exists."]
      },
      repos: {
        main: {
          path: "{{fixture.repo}}"
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
      },
      profiles: {
        default: {
          harness: "{{workflow.harness}}"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "write_handoff",
            repo: "main",
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
    }, null, 2)}\n`
  );
  await writeFile(
    join(scenarioDir, "scenario.json"),
    `${JSON.stringify({
      id: "exec-artifact",
      bucket: "valid-hard-execution",
      difficulty: "medium",
      description: "A deterministic workflow must write a declared handoff artifact.",
      fixture: {
        repo: "repo",
        init_git: true
      },
      workflow: {
        graph_template: "graph.template.json",
        harness: "codex-cli",
        workspace_backend: "inplace"
      },
      expected: {
        final_outcome: "passed",
        required_artifacts: [{ name: "handoff", contains: ["validation evidence"] }],
        forbidden_edits: ["forbidden.txt"]
      },
      grading: {
        dimensions: ["artifact_quality", "delivery_auditability"]
      }
    }, null, 2)}\n`
  );
  await writeFile(
    join(suiteDir, "eval.json"),
    `${JSON.stringify({
      version: "2",
      suite_id: "workflow-eval-cli",
      objective: "Exercise the v2 workflow eval CLI.",
      default_trials: 2,
      scenarios: ["scenarios/exec-artifact/scenario.json"],
      variants: ["variants/current.json", "variants/terse.json"],
      graders: [{ id: "packet", kind: "script", command: "node graders/packet.mjs" }],
      judges: [],
      thresholds: {
        pass_rate: 1,
        max_blocker_rate: 0,
        min_average_score: 4
      }
    }, null, 2)}\n`
  );

  return { suiteDir, evalRoot };
}

describe("eval CLI v2", () => {
  it("validates, runs trials, reports, inspects, and compares workflow evals", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-eval-v2-"));
    const { suiteDir, evalRoot } = await writeWorkflowEvalFixture(tempRoot);

    const validateResult = await executeCli(["eval", "validate", suiteDir], tempRoot);
    const validatePayload = JSON.parse(validateResult.stdout);

    expect(validateResult.exitCode).toBe(0);
    expect(validatePayload.command).toBe("eval validate");
    expect(validatePayload.status).toBe("passed");
    expect(validatePayload.scenario_count).toBe(1);
    expect(validatePayload.variants).toEqual(["current", "terse"]);

    const runResult = await executeCli(
      ["eval", "run", suiteDir, "--eval-root", evalRoot, "--variant", "all", "--trials", "2", "--concurrency", "2"],
      tempRoot
    );
    const runPayload = JSON.parse(runResult.stdout);
    const benchmark = JSON.parse(await readFile(join(evalRoot, "benchmark.json"), "utf8"));
    const scorecard = JSON.parse(
      await readFile(join(evalRoot, "scenarios", "exec-artifact", "current", "trial-001", "scorecard.json"), "utf8")
    );
    const currentTrialOneRoot = (
      await readFile(join(evalRoot, "scenarios", "exec-artifact", "current", "trial-001", "run-root.txt"), "utf8")
    ).trim();
    const currentTrialTwoRoot = (
      await readFile(join(evalRoot, "scenarios", "exec-artifact", "current", "trial-002", "run-root.txt"), "utf8")
    ).trim();
    const terseTrialOneRoot = (
      await readFile(join(evalRoot, "scenarios", "exec-artifact", "terse", "trial-001", "run-root.txt"), "utf8")
    ).trim();
    const terseTrialTwoRoot = (
      await readFile(join(evalRoot, "scenarios", "exec-artifact", "terse", "trial-002", "run-root.txt"), "utf8")
    ).trim();
    const currentTrace = JSON.parse(
      await readFile(join(evalRoot, "scenarios", "exec-artifact", "current", "trial-001", "trace-packet.json"), "utf8")
    ) as { artifacts: Array<{ name: string; content?: string }> };
    const terseTrace = JSON.parse(
      await readFile(join(evalRoot, "scenarios", "exec-artifact", "terse", "trial-001", "trace-packet.json"), "utf8")
    ) as { artifacts: Array<{ name: string; content?: string }> };

    expect(runResult.exitCode).toBe(0);
    expect(runPayload.command).toBe("eval run");
    expect(runPayload.status).toBe("passed");
    expect(benchmark.total_trials).toBe(4);
    expect(benchmark.pass_rate).toBe(1);
    expect(benchmark.average_score).toBeGreaterThanOrEqual(4);
    expect(scorecard.deterministic.blockers).toEqual([]);
    expect(scorecard.metrics.attempts).toBeGreaterThanOrEqual(1);
    expect(currentTrialOneRoot).toContain(
      join(evalRoot, "scenarios", "exec-artifact", "current", "trial-001", "runs")
    );
    expect(currentTrialTwoRoot).toContain(
      join(evalRoot, "scenarios", "exec-artifact", "current", "trial-002", "runs")
    );
    expect(terseTrialOneRoot).toContain(
      join(evalRoot, "scenarios", "exec-artifact", "terse", "trial-001", "runs")
    );
    expect(terseTrialTwoRoot).toContain(
      join(evalRoot, "scenarios", "exec-artifact", "terse", "trial-002", "runs")
    );
    expect(
      currentTrace.artifacts.some((artifact) =>
        artifact.name === "handoff" && artifact.content?.includes("validation evidence for current")
      )
    ).toBe(true);
    expect(
      terseTrace.artifacts.some((artifact) =>
        artifact.name === "handoff" && artifact.content?.includes("validation evidence for terse")
      )
    ).toBe(true);

    const reportJson = await executeCli(["eval", "report", evalRoot, "--format", "json"], tempRoot);
    expect(reportJson.exitCode).toBe(0);
    expect(JSON.parse(reportJson.stdout).benchmark.total_trials).toBe(4);

    const reportMarkdown = await executeCli(["eval", "report", evalRoot, "--format", "markdown"], tempRoot);
    expect(reportMarkdown.exitCode).toBe(0);
    expect(reportMarkdown.stdout).toContain("# Eval Suite workflow-eval-cli");

    const inspectResult = await executeCli(
      ["eval", "inspect", evalRoot, "--scenario", "exec-artifact", "--variant", "current", "--trial", "1"],
      tempRoot
    );
    const inspectPayload = JSON.parse(inspectResult.stdout);
    expect(inspectResult.exitCode).toBe(0);
    expect(inspectPayload.scorecard.metrics.attempts).toBeGreaterThanOrEqual(1);

    const compareResult = await executeCli(
      ["eval", "compare", evalRoot, "--baseline", "current", "--candidate", "terse"],
      tempRoot
    );
    const comparePayload = JSON.parse(compareResult.stdout);
    expect(compareResult.exitCode).toBe(0);
    expect(comparePayload.baseline.variant_id).toBe("current");
    expect(comparePayload.candidate.variant_id).toBe("terse");
    expect(comparePayload.delta.pass_rate).toBe(0);
  }, 120_000);

  it("uses the new positional eval surface and rejects old --suite usage", async () => {
    const result = await executeCli(["eval", "validate", "--suite", "suite.json"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Unexpected option(s): --suite");
  });
});
