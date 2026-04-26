import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadEvalSuite, renderGraphTemplate } from "../../src/evals/suite.js";

describe("eval suite loading", () => {
  it("loads cases and renders graph-template placeholders", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-eval-suite-"));
    const suiteDir = join(tempRoot, "suite");
    const repoDir = join(tempRoot, "repo");
    await mkdir(join(suiteDir, "fixtures"), { recursive: true });
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(suiteDir, "fixtures", "input.txt"), "fixture\n");
    await writeFile(
      join(suiteDir, "graph.template.json"),
      `${JSON.stringify(
        {
          version: "1",
          graph_id: "eval-{{case.id}}",
          repos: {
            main: {
              path: "{{case.repos.main.path}}"
            }
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "exec",
                id: "echo",
                command: "node",
                args: ["-e", "console.log(process.argv[1])", "{{case.task}}"]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      join(suiteDir, "cases.jsonl"),
      `${JSON.stringify({
        id: "case-1",
        task: "Say hello",
        fixtures: ["fixtures/input.txt"],
        repos: {
          main: {
            path: "../repo"
          }
        }
      })}\n`
    );
    await writeFile(
      join(suiteDir, "suite.json"),
      `${JSON.stringify({
        version: "1",
        suite_id: "demo",
        target: {
          graph_template: "graph.template.json"
        },
        cases: "cases.jsonl"
      })}\n`
    );

    const loaded = await loadEvalSuite(tempRoot, join(suiteDir, "suite.json"));
    const rendered = await renderGraphTemplate({
      suite_dir: loaded.suite_dir,
      template_path: join(suiteDir, "graph.template.json"),
      case: loaded.cases[0]!
    });
    const graph = rendered.graph as {
      graph_id: string;
      repos: { main: { path: string } };
      graph: { steps: Array<{ args: string[] }> };
    };

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.cases).toHaveLength(1);
    expect(rendered.diagnostics).toEqual([]);
    expect(graph.graph_id).toBe("eval-case-1");
    expect(graph.repos.main.path).toBe(repoDir);
    expect(graph.graph.steps[0]?.args.at(-1)).toBe("Say hello");
  });

  it("reports duplicate cases, missing fixtures, invalid thresholds, and bad placeholders", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-eval-suite-invalid-"));
    const suiteDir = join(tempRoot, "suite");
    await mkdir(suiteDir, { recursive: true });
    await writeFile(
      join(suiteDir, "graph.template.json"),
      `${JSON.stringify({
        version: "1",
        graph_id: "bad",
        repos: {
          main: {
            path: "{{case.repos.main.path}}"
          }
        },
        graph: {
          type: "sequence",
          id: "root",
          steps: [
            {
              type: "exec",
              id: "bad_placeholder",
              command: "node",
              args: ["-e", "console.log(process.argv[1])", "{{case.missing.value}}"]
            }
          ]
        }
      })}\n`
    );
    await writeFile(
      join(suiteDir, "cases.jsonl"),
      [
        JSON.stringify({
          id: "dupe",
          task: "first",
          fixtures: ["fixtures/missing.txt"],
          repos: { main: { path: "../repo" } }
        }),
        JSON.stringify({
          id: "dupe",
          task: "second",
          repos: { main: { path: "../repo" } }
        })
      ].join("\n")
    );
    await writeFile(
      join(suiteDir, "suite.json"),
      `${JSON.stringify({
        version: "1",
        suite_id: "bad-suite",
        target: {
          graph_template: "graph.template.json"
        },
        cases: "cases.jsonl",
        thresholds: {
          pass_rate: 2
        }
      })}\n`
    );

    const loaded = await loadEvalSuite(tempRoot, join(suiteDir, "suite.json"));
    const messages = loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n");

    expect(messages).toContain("pass_rate threshold");
    expect(messages).toContain("Duplicate eval case id");
    expect(messages).toContain("Fixture path does not exist");
    expect(messages).toContain("Unknown graph template placeholder");
  });

  it("loads AI rubric grader harness selection and rejects Cursor reasoning_effort", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-eval-suite-harness-"));
    const suiteDir = join(tempRoot, "suite");
    await mkdir(suiteDir, { recursive: true });
    await writeFile(
      join(suiteDir, "graph.template.json"),
      `${JSON.stringify({
        version: "1",
        graph_id: "eval",
        graph: {
          type: "sequence",
          id: "root",
          steps: [{ type: "exec", id: "noop", command: "true" }]
        }
      })}\n`
    );
    await writeFile(join(suiteDir, "cases.jsonl"), `${JSON.stringify({ id: "case", task: "Do it" })}\n`);
    await writeFile(join(suiteDir, "rubric.md"), "Grade strictly.\n");
    await writeFile(
      join(suiteDir, "suite.json"),
      `${JSON.stringify({
        version: "1",
        suite_id: "harness-suite",
        target: {
          graph_template: "graph.template.json"
        },
        cases: "cases.jsonl",
        graders: [
          {
            id: "cursor-grade",
            kind: "ai_rubric",
            harness: "cursor-cli",
            rubric: "rubric.md",
            model: "gpt-5.5-extra-high"
          },
          {
            id: "bad-cursor-grade",
            kind: "ai_rubric",
            harness: "cursor-cli",
            rubric: "rubric.md",
            reasoning_effort: "high"
          }
        ]
      })}\n`
    );

    const loaded = await loadEvalSuite(tempRoot, join(suiteDir, "suite.json"));

    expect(loaded.suite.graders).toEqual([
      expect.objectContaining({
        id: "cursor-grade",
        harness: "cursor-cli",
        model: "gpt-5.5-extra-high"
      })
    ]);
    expect(loaded.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graders[1].reasoning_effort",
          message: expect.stringContaining("Cursor AI rubric graders cannot set reasoning_effort")
        })
      ])
    );
  });
});
