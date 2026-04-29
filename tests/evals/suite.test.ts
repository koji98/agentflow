import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadEvalSuite, parseJudgeResult, renderGraphTemplate } from "../../src/evals/suite.js";

async function writeMinimalV2Suite(root: string): Promise<string> {
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
  await writeFile(join(judgesDir, "artifact-quality.md"), "Rate artifact quality from 1 to 5.\n");
  await writeFile(
    join(gradersDir, "deterministic.mjs"),
    "console.log(JSON.stringify({ passed: true, score: 1, assertions: [] }));\n"
  );
  await writeFile(
    join(variantDir, "current.json"),
    `${JSON.stringify({
      id: "current",
      description: "Current production prompts.",
      env: {
        AGENTFLOW_EVAL_PROMPT_PACK: "current"
      }
    }, null, 2)}\n`
  );
  await writeFile(
    join(scenarioDir, "graph.template.json"),
    `${JSON.stringify({
      version: "1",
      graph_id: "eval-{{scenario.id}}-{{variant.id}}-{{trial.index}}",
      intent: {
        goal: "{{scenario.description}}",
        acceptance_criteria: ["Artifact exists."]
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
            id: "write_artifact",
            repo: "main",
            command: "node",
            args: ["-e", "console.log(process.argv[1])", "{{variant.id}}"]
          }
        ]
      }
    }, null, 2)}\n`
  );
  await writeFile(
    join(scenarioDir, "scenario.json"),
    `${JSON.stringify({
      id: "artifact-discipline",
      bucket: "valid-hard-execution",
      difficulty: "hard",
      description: "Node must publish a real handoff artifact.",
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
        required_artifacts: [{ name: "handoff", contains: ["validation"] }],
        forbidden_edits: ["forbidden.txt"],
        supervisor: {
          classifications: [],
          gatherers: [],
          apply_actions: []
        }
      },
      grading: {
        dimensions: ["artifact_quality", "graph_contract_adherence"]
      }
    }, null, 2)}\n`
  );
  await writeFile(
    join(suiteDir, "eval.json"),
    `${JSON.stringify({
      version: "2",
      suite_id: "workflow-quality",
      objective: "Evaluate complete Agentflow workflow behavior.",
      default_trials: 2,
      scenarios: ["scenarios/artifact-discipline/scenario.json"],
      variants: ["variants/current.json"],
      graders: [{ id: "deterministic", kind: "script", command: "node graders/deterministic.mjs" }],
      judges: [{ id: "artifact-quality", rubric: "judges/artifact-quality.md" }],
      thresholds: {
        pass_rate: 1,
        max_blocker_rate: 0,
        min_average_score: 4
      }
    }, null, 2)}\n`
  );

  return suiteDir;
}

describe("eval suite v2 loading", () => {
  it("loads scenario, variant, grader, judge, and renders graph placeholders", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-eval-v2-suite-"));
    const suiteDir = await writeMinimalV2Suite(tempRoot);

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
      fixture: {
        repo: "/tmp/trial/repo"
      }
    });
    const graph = rendered.graph as {
      graph_id: string;
      intent: { goal: string };
      repos: { main: { path: string } };
      profiles: { default: { harness: string } };
      graph: { steps: Array<{ args: string[] }> };
    };

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.suite.version).toBe("2");
    expect(loaded.suite.source_reference).toContain("Demystifying evals for AI agents");
    expect(loaded.scenarios.map((entry) => entry.id)).toEqual(["artifact-discipline"]);
    expect(loaded.variants.map((entry) => entry.id)).toEqual(["current"]);
    expect(loaded.judges.map((entry) => entry.id)).toEqual(["artifact-quality"]);
    expect(rendered.diagnostics).toEqual([]);
    expect(graph.graph_id).toBe("eval-artifact-discipline-current-1");
    expect(graph.intent.goal).toBe("Node must publish a real handoff artifact.");
    expect(graph.repos.main.path).toBe("/tmp/trial/repo");
    expect(graph.profiles.default.harness).toBe("codex-cli");
    expect(graph.graph.steps[0]?.args.at(-1)).toBe("current");
  });

  it("reports unsupported v1 suites, missing fixtures, duplicate ids, and bad placeholders", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-eval-v2-invalid-"));
    const suiteDir = await writeMinimalV2Suite(tempRoot);
    await writeFile(
      join(suiteDir, "eval.json"),
      `${JSON.stringify({
        version: "2",
        suite_id: "bad",
        objective: "bad",
        default_trials: 0,
        scenarios: [
          "scenarios/artifact-discipline/scenario.json",
          "scenarios/artifact-discipline/scenario.json"
        ],
        variants: ["variants/current.json", "variants/current.json"],
        judges: [{ id: "missing", rubric: "judges/missing.md" }],
        thresholds: { pass_rate: 2 }
      }, null, 2)}\n`
    );
    await writeFile(
      join(suiteDir, "scenarios", "artifact-discipline", "graph.template.json"),
      `${JSON.stringify({ graph_id: "{{scenario.missing}}" })}\n`
    );
    await writeFile(
      join(suiteDir, "scenarios", "artifact-discipline", "scenario.json"),
      `${JSON.stringify({
        id: "artifact-discipline",
        bucket: "valid-hard-execution",
        difficulty: "hard",
        description: "bad",
        fixture: { repo: "missing-repo" },
        workflow: { graph_template: "graph.template.json", harness: "codex-cli" },
        expected: { final_outcome: "passed" }
      }, null, 2)}\n`
    );

    const loaded = await loadEvalSuite(tempRoot, suiteDir);
    const messages = loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n");

    expect(messages).toContain("default_trials");
    expect(messages).toContain("pass_rate");
    expect(messages).toContain("Duplicate scenario id");
    expect(messages).toContain("Duplicate variant id");
    expect(messages).toContain("Fixture repo path does not exist");
    expect(messages).toContain("Judge rubric path does not exist");
    expect(messages).toContain("Unknown graph template placeholder");

    await writeFile(join(suiteDir, "eval.json"), `${JSON.stringify({ version: "1" })}\n`);
    const unsupported = await loadEvalSuite(tempRoot, suiteDir);
    expect(unsupported.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "Eval suite version must be \"2\""
    );
  });

  it("parses strict judge JSON and rejects malformed judge scores", () => {
    expect(parseJudgeResult(JSON.stringify({
      passed_quality_bar: true,
      score: 4,
      dimension_scores: { artifact_quality: 4 },
      blockers: [],
      rationale: "Good artifact.",
      prompt_feedback: {
        helpful_sections: ["Artifact Contract"],
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
