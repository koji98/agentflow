import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const graderPath = join(repoRoot, "evals", "agentflow-realworld-issues", "graders", "realworld-deterministic.mjs");

async function initTrialFixture(options: { editPackage?: boolean; markdownHeadings?: boolean } = {}): Promise<{
  suiteDir: string;
  trialRoot: string;
  outputDir: string;
  runRoot: string;
  tracePacketFile: string;
}> {
  const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-realworld-grader-"));
  const suiteDir = join(tempRoot, "suite");
  const scenarioDir = join(suiteDir, "scenarios", "case");
  const trialRoot = join(tempRoot, "eval-root", "scenarios", "case", "current", "trial-001");
  const repoDir = join(trialRoot, "workspace", "repo");
  const runRoot = join(trialRoot, "runs", "run-1");
  const outputDir = join(trialRoot, "graders", "realworld-deterministic");
  const tracePacketFile = join(trialRoot, "trace-packet.json");

  await mkdir(scenarioDir, { recursive: true });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(runRoot, "nodes", "fix_issue", "attempt-1"), { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(suiteDir, "eval.json"), `${JSON.stringify({
    scenarios: ["scenarios/case/scenario.json"]
  }, null, 2)}\n`);
  await writeFile(join(scenarioDir, "scenario.json"), `${JSON.stringify({
    id: "case",
    metadata: {
      realworld: {
        focused_test_command: "node validate.js",
        allowed_changed_globs: ["src/index.js"],
        forbidden_changed_globs: ["package.json", "**/agentflow-realworld-*"]
      }
    }
  }, null, 2)}\n`);
  await writeFile(join(repoDir, "package.json"), "{\"name\":\"case\"}\n");
  await writeFile(join(repoDir, "validate.js"), "process.exit(0);\n");
  await writeFile(join(repoDir, "src", "index.js"), "module.exports = 1;\n");
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: repoDir });
  await writeFile(join(repoDir, "src", "index.js"), "module.exports = 2;\n");
  if (options.editPackage) {
    await writeFile(join(repoDir, "package.json"), "{\"name\":\"case\",\"changed\":true}\n");
  }
  await writeFile(join(runRoot, "nodes", "fix_issue", "attempt-1", "prompt.md"), "prompt\n");
  const handoffContent = options.markdownHeadings
    ? "# Scenario\ncase\n\n## Validation\nnode validate.js passed\n"
    : "Scenario: case\nValidation: node validate.js passed\n";
  await writeFile(tracePacketFile, `${JSON.stringify({
    outcome: { status: "passed" },
    artifacts: [{ name: "handoff", path: "/tmp/handoff.md", content: handoffContent }],
    delivery: { manifest_path: "/tmp/manifest.json", manifest: { ok: true } },
    metrics: { attempts: 1 }
  }, null, 2)}\n`);

  return { suiteDir, trialRoot, outputDir, runRoot, tracePacketFile };
}

async function runGrader(fixture: Awaited<ReturnType<typeof initTrialFixture>>): Promise<Record<string, unknown>> {
  const result = await execFileAsync("node", [graderPath], {
    cwd: fixture.suiteDir,
    env: {
      ...process.env,
      AGENTFLOW_EVAL_SCENARIO_ID: "case",
      AGENTFLOW_EVAL_TRACE_PACKET_FILE: fixture.tracePacketFile,
      AGENTFLOW_EVAL_OUTPUT_DIR: fixture.outputDir,
      AGENTFLOW_EVAL_RUN_ROOT: fixture.runRoot
    }
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("real-world deterministic grader", () => {
  it("passes focused commands and scoped source edits", async () => {
    const fixture = await initTrialFixture();
    const result = await runGrader(fixture);

    expect(result.passed).toBe(true);
  });

  it("accepts markdown section headings in handoff artifacts", async () => {
    const fixture = await initTrialFixture({ markdownHeadings: true });
    const result = await runGrader(fixture);

    expect(result.passed).toBe(true);
  });

  it("fails when package manifests are changed", async () => {
    const fixture = await initTrialFixture({ editPackage: true });
    const result = await runGrader(fixture) as { passed: boolean; assertions: Array<{ id: string; passed: boolean; evidence?: string }> };
    const forbidden = result.assertions.find((assertion) => assertion.id === "forbidden_files_unchanged");

    expect(result.passed).toBe(false);
    expect(forbidden?.passed).toBe(false);
    expect(forbidden?.evidence).toContain("package.json");
  });
});
