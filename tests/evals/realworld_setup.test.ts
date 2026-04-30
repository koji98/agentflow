import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function initSourceRepo(repoDir: string): Promise<string> {
  await mkdir(repoDir, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
  await writeFile(join(repoDir, "LICENSE"), "MIT License\n\nCopyright fixture\n");
  await writeFile(join(repoDir, "package.json"), `${JSON.stringify({ name: "fake-realworld", scripts: { test: "node test.js" } }, null, 2)}\n`);
  await writeFile(join(repoDir, "index.js"), "module.exports = 1;\n");
  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "source init"], { cwd: repoDir });
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
}

describe("real-world eval materializer", () => {
  it("builds path-safe clone specs and materializes a fake pinned upstream repo", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-realworld-setup-"));
    const sourceRoot = join(tempRoot, "sources");
    const suiteDir = join(tempRoot, "suite");
    const scenarioDir = join(suiteDir, "scenarios", "fake-case");
    const reposDir = join(tempRoot, "eval-repos");
    const sourceRepo = join(sourceRoot, "fake__realworld");
    const baseSha = await initSourceRepo(sourceRepo);
    const setupModule = await import("../../scripts/setup-realworld-evals.mjs") as {
      sanitizeRepoKey(sourceRepo: string): string;
      buildNpmSetupSpec(setupCommand: string): { command: string; args: string[] };
      buildCloneSpec(options: { sourceRepo: string; sourceRoot?: string; destination: string }): { args: string[]; local: boolean };
      setupRealworldEvals(options: {
        suiteDir: string;
        reposDir: string;
        sourceRoot?: string;
        install?: boolean;
      }): Promise<{ materialized: Array<{ id: string; repo: string }> }>;
    };

    expect(setupModule.sanitizeRepoKey("Fake/RealWorld")).toBe("fake__realworld");
    expect(setupModule.buildNpmSetupSpec("npm install --ignore-scripts --no-audit")).toEqual({
      command: "npm",
      args: ["install", "--ignore-scripts", "--no-audit"]
    });
    expect(() => setupModule.buildNpmSetupSpec("npm install && rm -rf .")).toThrow(/Unsupported real-world eval setup argument/u);
    expect(setupModule.buildCloneSpec({
      sourceRepo: "fake/realworld",
      sourceRoot,
      destination: join(reposDir, "fake-case")
    })).toEqual({
      args: [sourceRepo, join(reposDir, "fake-case")],
      local: true
    });

    await mkdir(scenarioDir, { recursive: true });
    await mkdir(join(suiteDir, "variants"), { recursive: true });
    await mkdir(join(suiteDir, "graders"), { recursive: true });
    await writeFile(
      join(scenarioDir, "regression.patch"),
      [
        "diff --git a/AGENTFLOW_EVAL_TASK.md b/AGENTFLOW_EVAL_TASK.md",
        "new file mode 100644",
        "index 0000000..d95f3ad",
        "--- /dev/null",
        "+++ b/AGENTFLOW_EVAL_TASK.md",
        "@@ -0,0 +1 @@",
        "+# fake task",
        ""
      ].join("\n")
    );
    await writeFile(
      join(scenarioDir, "scenario.json"),
      `${JSON.stringify({
        id: "fake-case",
        fixture: { repo: join(reposDir, "fake-case") },
        metadata: {
          realworld: {
            source_repo: "fake/realworld",
            license: "MIT",
            base_sha: baseSha,
            issue_url: "https://github.com/fake/realworld/issues/1",
            pr_url: "https://github.com/fake/realworld/pull/2",
            oracle_commit_sha: "abcdef0123456789abcdef0123456789abcdef01",
            package_manager: "npm",
            regression_patch: "regression.patch",
            setup_command: "npm install",
            focused_test_command: "npm test",
            allowed_changed_globs: ["index.js"],
            forbidden_changed_globs: ["AGENTFLOW_EVAL_TASK.md"],
            hidden_oracle_changed_files: ["index.js"]
          }
        }
      }, null, 2)}\n`
    );
    await writeFile(
      join(suiteDir, "eval.json"),
      `${JSON.stringify({
        version: "2",
        suite_id: "fake-realworld",
        scenarios: ["scenarios/fake-case/scenario.json"]
      }, null, 2)}\n`
    );

    const result = await setupModule.setupRealworldEvals({
      suiteDir,
      reposDir,
      sourceRoot
    });
    const materializedRepo = result.materialized[0]?.repo ?? "";
    const status = (await execFileAsync("git", ["status", "--short"], { cwd: materializedRepo })).stdout.trim();
    const nodeModules = await lstat(join(materializedRepo, "node_modules"));

    expect(result.materialized.map((entry) => entry.id)).toEqual(["fake-case"]);
    expect(await readFile(join(materializedRepo, "AGENTFLOW_EVAL_TASK.md"), "utf8")).toContain("fake task");
    expect(nodeModules.isSymbolicLink()).toBe(true);
    expect(status).toBe("");
  });
});
