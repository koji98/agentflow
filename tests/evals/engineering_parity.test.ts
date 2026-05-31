import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadEvalSuite, renderGraphTemplate } from "../../src/evals/suite.js";

describe("engineering parity eval suite", () => {
  it("loads the checked-in engineering parity suite with real task scenarios", async () => {
    const loaded = await loadEvalSuite(process.cwd(), "evals/agentflow-engineering-parity");

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.suite.suite_id).toBe("agentflow-engineering-parity");
    expect(loaded.scenarios.map((scenario) => scenario.id)).toEqual([
      "cart-total-bugfix",
      "api-user-filter",
      "settings-schema-defaults",
      "duration-parser-refactor",
      "stale-docs-code-conflict",
      "frontend-tabs-reducer"
    ]);
    expect(loaded.variants.map((variant) => variant.id)).toEqual([
      "current",
      "deep-work",
      "work-list"
    ]);
    expect(loaded.criteria.map((criterion) => [criterion.id, criterion.kind])).toEqual([
      ["outcome", "outcome"],
      ["artifact", "artifact"],
      ["workspace", "workspace"],
      ["delivery", "delivery"],
      ["engineering-parity", "custom_script"]
    ]);
  });

  it("renders a single primitive agent graph from the neutral task fixture", async () => {
    const loaded = await loadEvalSuite(process.cwd(), "evals/agentflow-engineering-parity");
    const scenario = loaded.scenarios[0]!;
    const variant = loaded.variants[0]!;
    const rendered = await renderGraphTemplate({
      suite_dir: loaded.suite_dir,
      template_path: variant.graph_template_path ?? scenario.graph_template_path,
      scenario,
      variant,
      trial: {
        id: "trial-001",
        index: 1,
        root: "/tmp/trial"
      },
      environment: {
        repo: "/tmp/trial/workspace/repo"
      }
    });
    const graph = rendered.graph as {
      graph: { steps: Array<{ type: string; support: { context: Array<{ path: string }> }; intent: { goal: string } }> };
    };

    expect(rendered.diagnostics).toEqual([]);
    expect(graph.graph.steps).toHaveLength(1);
    expect(graph.graph.steps[0]!.type).toBe("agent");
    expect(graph.graph.steps[0]!.support.context[0]!.path).toBe("task.md");
    expect(graph.graph.steps[0]!.intent.goal).toContain("Read task.md");
    expect(graph.graph.steps[0]!.intent.goal).not.toMatch(/graph template|direct codex baseline|managed pattern/iu);
  });

  it("renders managed parity variants from the same neutral task fixture", async () => {
    const loaded = await loadEvalSuite(process.cwd(), "evals/agentflow-engineering-parity");
    const scenario = loaded.scenarios[0]!;
    const variants = new Map(loaded.variants.map((variant) => [variant.id, variant]));

    const deepWork = await renderGraphTemplate({
      suite_dir: loaded.suite_dir,
      template_path: variants.get("deep-work")!.graph_template_path ?? scenario.graph_template_path,
      scenario,
      variant: variants.get("deep-work")!,
      trial: {
        id: "trial-001",
        index: 1,
        root: "/tmp/trial"
      },
      environment: {
        repo: "/tmp/trial/workspace/repo"
      }
    });
    const workList = await renderGraphTemplate({
      suite_dir: loaded.suite_dir,
      template_path: variants.get("work-list")!.graph_template_path ?? scenario.graph_template_path,
      scenario,
      variant: variants.get("work-list")!,
      trial: {
        id: "trial-001",
        index: 1,
        root: "/tmp/trial"
      },
      environment: {
        repo: "/tmp/trial/workspace/repo"
      }
    });

    expect(deepWork.diagnostics).toEqual([]);
    expect(workList.diagnostics).toEqual([]);
    expect((deepWork.graph as any).graph.steps).toEqual([
      expect.objectContaining({ type: "pattern_deep_work", id: "deep_work_worker" })
    ]);
    expect((workList.graph as any).graph.steps).toEqual([
      expect.objectContaining({ type: "pattern_work_list", id: "work_list_worker" })
    ]);
    expect(JSON.stringify(deepWork.graph)).toContain("Read task.md");
    expect(JSON.stringify(workList.graph)).toContain("Read task.md");
    expect(JSON.stringify(deepWork.graph)).not.toMatch(/direct codex baseline|codex goal mode/iu);
    expect(JSON.stringify(workList.graph)).not.toMatch(/direct codex baseline|codex goal mode/iu);
  });
});

describe("engineering parity grader helpers", () => {
  async function importGrader(): Promise<Record<string, any>> {
    return await import("../../evals/agentflow-engineering-parity/graders/engineering-parity.mjs");
  }

  async function writeFixtureRepo(root: string): Promise<string> {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "task.md"), "Fix src.js and run npm test.\n");
    await writeFile(join(repo, "package.json"), JSON.stringify({
      type: "module",
      scripts: {
        test: "node -e \"if (!require('fs').readFileSync('src.js','utf8').includes('fixed')) process.exit(1)\""
      }
    }, null, 2));
    await writeFile(join(repo, "src.js"), "broken\n");
    return repo;
  }

  async function writeFakeCodex(root: string): Promise<string> {
    const bin = join(root, "fake-codex.mjs");
    await writeFile(bin, [
      "#!/usr/bin/env node",
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'exec' && args[1] === '--help') { console.log('Usage: codex exec'); process.exit(0); }",
      "const cwd = args[args.indexOf('--cd') + 1];",
      "const out = args[args.indexOf('--output-last-message') + 1];",
      "writeFileSync(join(cwd, 'src.js'), 'fixed\\n');",
      "mkdirSync(dirname(out), { recursive: true });",
      "writeFileSync(out, 'Changed src.js and ran npm test successfully.');",
      "readFileSync(0, 'utf8');"
    ].join("\n"));
    await chmod(bin, 0o755);
    return bin;
  }

  it("materializes a clean direct Codex workspace and captures diff plus validation", async () => {
    const grader = await importGrader();
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engineering-parity-"));
    const sourceRepo = await writeFixtureRepo(tempRoot);
    const fakeCodex = await writeFakeCodex(tempRoot);
    const result = grader.runDirectCodexBaseline({
      binary: fakeCodex,
      sourceRepo,
      outputDir: join(tempRoot, "out"),
      label: "direct-codex",
      oracle: {
        validation_commands: ["npm test"],
        required_changed_files: ["src.js"],
        allowed_changed_globs: ["src.js"],
        forbidden_changed_globs: ["task.md"],
        expected_file_substrings: [{ path: "src.js", contains: "fixed" }]
      }
    });

    expect(result.args).not.toContain("--goal");
    expect(result.workspace_result.passed).toBe(true);
    expect(result.workspace_result.git.changed_files).toEqual(["src.js"]);
    expect(await readFile(join(tempRoot, "out", "direct-codex", "workspace", "task.md"), "utf8")).toContain("Fix src.js");
  });

  it("anonymizes pairwise judge packets and keeps mapping separate", async () => {
    const grader = await importGrader();
    const packet = grader.buildPairwiseJudgePacket({
      scenarioId: "case",
      trialId: "trial-001",
      taskText: "Fix the bug.",
      oracle: { quality_anchors: ["tests pass"] },
      agentflow: {
        passed: true,
        validation: [],
        git: { changed_files: ["src.js"], diff_excerpt: "agentflow diff" },
        checks: {},
        handoff: "agentflow handoff"
      },
      direct: {
        passed: true,
        validation: [],
        git: { changed_files: ["src.js"], diff_excerpt: "direct diff" },
        checks: {},
        handoff: "direct handoff"
      }
    });

    expect(JSON.stringify(packet.judge_packet)).not.toContain("agentflow");
    expect(JSON.stringify(packet.judge_packet)).not.toContain("direct-codex");
    expect(Object.values(packet.mapping).sort()).toEqual(["agentflow", "direct-codex"].sort());
  });

  it("diagnoses ceremony-heavy managed prompt text across all Agentflow prompts", async () => {
    const grader = await importGrader();
    const diagnostics = grader.detectPromptDiagnostics({
      taskText: "Fix the local parser bug.",
      directPrompt: "Read task.md and fix the local parser bug.",
      agentflowPrompts: [
        { path: "/run/a/agent/prompt.md", content: "Task: complete the requested engineering change." },
        { path: "/run/b/agent/prompt.md", content: "This managed workflow prompt mentions public artifact shape." }
      ]
    });

    expect(diagnostics.agentflow_prompt_count).toBe(2);
    expect(diagnostics.noisy_sections).toEqual(expect.arrayContaining([
      "managed workflow",
      "public artifact"
    ]));
    expect(diagnostics.failure_taxonomy).toContain("Graph/Agentflow meta leakage");
  });

  it("fails parity when direct Codex passes but Agentflow fails deterministic checks", async () => {
    const grader = await importGrader();
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engineering-parity-verdict-"));
    const verdict = grader.buildParityVerdict({
      outputDir: tempRoot,
      direct: {
        exit_code: 0,
        workspace_result: { passed: true }
      },
      agentflow: {
        passed: false,
        checks: {
          out_of_scope_changes: [],
          forbidden_changes: []
        }
      },
      pairwiseJudge: {
        parsed: {
          preferred_candidate: "B",
          scores: { A: 2, B: 5 }
        }
      },
      mapping: {
        A: "agentflow",
        B: "direct-codex"
      }
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.blockers).toContain("Direct Codex passed deterministic checks while Agentflow did not.");
  });

  it("matches simple oracle globs for forbidden test edits", async () => {
    const grader = await importGrader();

    expect(grader.globMatches("test/*.test.js", "test/cart.test.js")).toBe(true);
    expect(grader.globMatches("test/*.test.js", "src/cart.js")).toBe(false);
  });
});
