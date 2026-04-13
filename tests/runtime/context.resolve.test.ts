import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { closeNodeAttempt, createAttemptRegistry, openNodeAttempt } from "../../src/runtime/attempts.js";
import { resolveExecutionContext } from "../../src/runtime/context/resolve.js";

function compileGraph(document: Parameters<typeof normalizeAuthoredGraphDocument>[0]) {
  const normalized = normalizeAuthoredGraphDocument(document);
  expect(normalized.diagnostics).toEqual([]);
  const launch = resolveLaunchConfig(normalized.document!);
  const compilation = compileAuthoredGraph(
    normalized.document!,
    launch,
    normalized.lowered_managed_nodes
  );

  expect(compilation.diagnostics).toEqual([]);
  expect(compilation.compiled_graph).toBeDefined();
  return compilation.compiled_graph!;
}

describe("context resolution", () => {
  it("materializes live inputs and upstream output references into a context packet", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-"));
    const repoDir = join(tempRoot, "repo");
    const upstreamDir = join(tempRoot, "upstream");
    await mkdir(repoDir, { recursive: true });
    await mkdir(join(repoDir, ".cursor", "rules"), { recursive: true });
    await mkdir(upstreamDir, { recursive: true });
    await writeFile(join(repoDir, "src.txt"), "source file\n");
    await writeFile(join(repoDir, "AGENTS.md"), "Follow repo instructions.\n");
    await writeFile(join(repoDir, ".cursor", "rules", "review.mdc"), "Review rule.\n");
    await writeFile(join(upstreamDir, "context_summary.md"), "# Summary\n");
    await writeFile(join(upstreamDir, "result.json"), JSON.stringify({ passed: true }));
    await writeFile(join(upstreamDir, "artifact.json"), JSON.stringify({ passed: true }));

    const graph = compileGraph({
      version: "1",
      graph_id: "context-resolution",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {
          harness: "codex-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "source",
            command: "placeholder",
            outputs: [
              {
                name: "verification",
                from: "attempt",
                path: "result.json",
                required: true
              }
            ]
          },
          {
            type: "exec",
            id: "consume",
            command: "placeholder",
            inputs: [
              {
                kind: "file",
                path: "src.txt"
              },
              {
                kind: "text",
                name: "note",
                text: "operator note"
              }
            ],
            context_from: [
              {
                node: "source",
                include: "output",
                output: "verification"
              }
            ]
          }
        ]
      }
    });

    const sourceNode = graph.nodes.find((node) => node.authored_id === "source")!;
    const consumeNode = graph.nodes.find((node) => node.authored_id === "consume")!;
    const attempts = createAttemptRegistry();
    const sourceAttempt = openNodeAttempt(attempts, sourceNode, upstreamDir);
    closeNodeAttempt(attempts, sourceAttempt.execution_id, {
      status: "passed",
      outcome: "passed",
      result_path: join(upstreamDir, "result.json"),
      context_summary_path: join(upstreamDir, "context_summary.md"),
      output_artifacts: {
        verification: join(upstreamDir, "artifact.json")
      }
    });

    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: consumeNode,
      execution_id: "exec__consume__attempt_1",
      execution_dir: join(tempRoot, "consume"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts
    });

    expect(resolved.packet.materials).toHaveLength(3);
    expect(resolved.packet.tokenizer).toBe("o200k_base");
    expect(resolved.packet.omitted).toEqual([]);
    expect(await readFile(resolved.summary_path, "utf8")).toContain("Materialized items");
    expect(await readFile(resolved.summary_path, "utf8")).toContain('requested "src.txt"');
    expect(await readFile(resolved.provenance_path, "utf8")).toContain("\"compiled_id\"");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("records optional missing context references instead of failing resolution", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-optional-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });

    const graph = compileGraph({
      version: "1",
      graph_id: "context-optional-missing",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {
          harness: "codex-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "source",
            command: "placeholder"
          },
          {
            type: "exec",
            id: "consumer",
            command: "placeholder",
            context_from: [
              {
                node: "source",
                include: "summary",
                optional: true
              }
            ]
          }
        ]
      }
    });

    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: consumerNode,
      execution_id: "exec__consumer__attempt_1",
      execution_dir: join(tempRoot, "consumer"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts: createAttemptRegistry()
    });

    expect(resolved.packet.materials).toEqual([]);
    expect(resolved.packet.omitted).toEqual([
      {
        key: "context_1",
        source: {
          node: "source",
          include: "summary",
          optional: true
        },
        reason: 'No execution matched "source".',
        optional: true
      }
    ]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("resolves context selectors against repeat iteration and attempt filters", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-selectors-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });

    const graph = compileGraph({
      version: "1",
      graph_id: "context-selector-resolution",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {
          harness: "codex-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "repeat",
            id: "retry",
            max_attempts: 3,
            body: {
              type: "sequence",
              id: "body",
              steps: [
                {
                  type: "exec",
                  id: "produce",
                  command: "placeholder",
                  outputs: [
                    {
                      name: "report",
                      from: "attempt",
                      path: "report.md",
                      required: true
                    }
                  ]
                },
                {
                  type: "check",
                  id: "verify",
                  check_kind: "deterministic",
                  command: "placeholder"
                }
              ]
            },
            until: {
              node: "verify"
            }
          },
          {
            type: "exec",
            id: "consumer",
            command: "placeholder",
            context_from: [
              {
                node: "produce",
                include: "output",
                output: "report",
                iteration: "latest_passed",
                attempt: "latest"
              },
              {
                node: "produce",
                include: "output",
                output: "report",
                iteration: 2,
                attempt: 2
              }
            ]
          }
        ]
      }
    });

    const produceNode = graph.nodes.find((node) => node.authored_id === "produce")!;
    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    const attempts = createAttemptRegistry();
    const repeatScopeId = produceNode.repeat_scope_id!;
    const reportOne = join(tempRoot, "iteration-1-report.md");
    const reportTwoFailed = join(tempRoot, "iteration-2-attempt-2-report.md");
    const reportTwoLatest = join(tempRoot, "iteration-2-latest-report.md");
    await writeFile(reportOne, "iteration 1\n");
    await writeFile(reportTwoFailed, "iteration 2 attempt 2\n");
    await writeFile(reportTwoLatest, "iteration 2 latest\n");

    const firstAttempt = openNodeAttempt(attempts, produceNode, join(tempRoot, "attempt-1"), {
      repeat_scope_id: repeatScopeId,
      iteration_index: 1
    });
    closeNodeAttempt(attempts, firstAttempt.execution_id, {
      status: "passed",
      outcome: "passed",
      output_artifacts: { report: reportOne }
    });

    const secondAttempt = openNodeAttempt(attempts, produceNode, join(tempRoot, "attempt-2"), {
      repeat_scope_id: repeatScopeId,
      iteration_index: 2
    });
    closeNodeAttempt(attempts, secondAttempt.execution_id, {
      status: "failed",
      outcome: "failed",
      output_artifacts: { report: reportTwoFailed }
    });

    const thirdAttempt = openNodeAttempt(attempts, produceNode, join(tempRoot, "attempt-3"), {
      repeat_scope_id: repeatScopeId,
      iteration_index: 2
    });
    closeNodeAttempt(attempts, thirdAttempt.execution_id, {
      status: "passed",
      outcome: "passed",
      output_artifacts: { report: reportTwoLatest }
    });

    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: consumerNode,
      execution_id: "exec__consumer__attempt_1",
      execution_dir: join(tempRoot, "consumer"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts
    });

    expect(resolved.packet.materials).toHaveLength(2);
    expect(await readFile(resolved.packet.materials[0]!.materialized_path, "utf8")).toBe("iteration 2 latest\n");
    expect(await readFile(resolved.packet.materials[1]!.materialized_path, "utf8")).toBe("iteration 2 attempt 2\n");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("marks truncated materials clearly in the packet and summary", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-truncation-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(repoDir, "large-note.md"),
      [
        "# Large note",
        "",
        "Line one should survive.",
        "Line two should survive.",
        "Line three should be cut off because the file is too large for the configured token limit."
      ].join("\n"),
      "utf8"
    );

    const graph = compileGraph({
      version: "1",
      graph_id: "context-truncation",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {
          harness: "codex-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "consumer",
            command: "placeholder",
            inputs: [
              {
                kind: "file",
                path: "large-note.md"
              }
            ]
          }
        ]
      }
    });

    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    consumerNode.effective_policy.input_rules.max_tokens_per_item = 30;

    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: consumerNode,
      execution_id: "exec__consumer__attempt_1",
      execution_dir: join(tempRoot, "consumer"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts: createAttemptRegistry()
    });

    expect(resolved.packet.materials).toHaveLength(1);
    expect(resolved.packet.materials[0]?.truncated).toBe(true);
    const materialized = await readFile(resolved.packet.materials[0]!.materialized_path, "utf8");
    const summary = await readFile(resolved.summary_path, "utf8");

    expect(materialized).toContain("Line one should survive.");
    expect(materialized).toContain("[Truncated by Agentflow. Read the original file for full context.]");
    expect(resolved.packet.materials[0]?.tokens).toBeLessThanOrEqual(30);
    expect(summary).toContain("- Truncated items: `1`");
    expect(summary).toContain("tokens, truncated");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("omits a missing live file instead of failing resolution", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-missing-file-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });

    const graph = compileGraph({
      version: "1",
      graph_id: "context-missing-live-file",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {}
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "consumer",
            command: "placeholder",
            inputs: [
              {
                kind: "file",
                path: "watched.txt"
              }
            ]
          }
        ]
      }
    });

    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: consumerNode,
      execution_id: "exec__consumer__attempt_1",
      execution_dir: join(tempRoot, "consumer"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts: createAttemptRegistry()
    });

    expect(resolved.packet.materials).toEqual([]);
    expect(resolved.packet.omitted).toEqual([
      {
        key: "input_1",
        source: {
          kind: "file",
          path: "watched.txt"
        },
        reason: 'Requested input file "watched.txt" was not found at execution time.',
        optional: false
      }
    ]);
    expect(await readFile(resolved.summary_path, "utf8")).toContain('Requested input file "watched.txt" was not found');

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("omits non-UTF-8 file inputs instead of materializing binary content", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-binary-file-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "binary.dat"), Buffer.from([0xff, 0xfe, 0xfd]));

    const graph = compileGraph({
      version: "1",
      graph_id: "context-binary-file",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {}
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "consumer",
            command: "placeholder",
            inputs: [
              {
                kind: "file",
                path: "binary.dat"
              }
            ]
          }
        ]
      }
    });

    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: consumerNode,
      execution_id: "exec__consumer__attempt_1",
      execution_dir: join(tempRoot, "consumer"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts: createAttemptRegistry()
    });

    expect(resolved.packet.materials).toEqual([]);
    expect(resolved.packet.omitted).toEqual([
      {
        key: "input_1",
        source: {
          kind: "file",
          path: "binary.dat"
        },
        reason: "Material is not valid UTF-8 text and cannot be tokenized.",
        optional: false
      }
    ]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("omits a glob when it matches no files instead of failing resolution", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-empty-glob-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });

    const graph = compileGraph({
      version: "1",
      graph_id: "context-empty-glob",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {}
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "consumer",
            command: "placeholder",
            inputs: [
              {
                kind: "glob",
                path: "*.md"
              }
            ]
          }
        ]
      }
    });

    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: consumerNode,
      execution_id: "exec__consumer__attempt_1",
      execution_dir: join(tempRoot, "consumer"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts: createAttemptRegistry()
    });

    expect(resolved.packet.materials).toEqual([]);
    expect(resolved.packet.omitted).toEqual([
      {
        key: "input_1",
        source: {
          kind: "glob",
          path: "*.md"
        },
        reason: 'Requested input glob "*.md" matched no files after ignore filtering at execution time.',
        optional: false
      }
    ]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("uses sorted filesystem glob resolution and caps matches after sorting", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-fs-glob-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "z-last.md"), "z-last\n");
    await writeFile(join(repoDir, "a-first.md"), "a-first\n");
    await writeFile(join(repoDir, "m-middle.md"), "m-middle\n");

    const graph = compileGraph({
      version: "1",
      graph_id: "context-fs-glob",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {
          harness: "codex-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "consumer",
            command: "placeholder",
            inputs: [
              {
                kind: "glob",
                path: "*.md",
                max_files: 2
              }
            ]
          }
        ]
      }
    });

    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: consumerNode,
      execution_id: "exec__consumer__attempt_1",
      execution_dir: join(tempRoot, "consumer"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts: createAttemptRegistry()
    });

    expect(resolved.packet.materials).toHaveLength(2);
    const materializedContents = await Promise.all(
      resolved.packet.materials.map((item) => readFile(item.materialized_path, "utf8"))
    );
    expect(materializedContents).toEqual(["a-first\n", "m-middle\n"]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("filters glob inputs through root ignore files and hard runtime excludes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-ignore-glob-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(join(repoDir, "src"), { recursive: true });
    await mkdir(join(repoDir, "ignored-dir"), { recursive: true });
    await mkdir(join(repoDir, "node_modules"), { recursive: true });
    await mkdir(join(repoDir, ".agentflow"), { recursive: true });
    await writeFile(join(repoDir, ".gitignore"), "ignored-dir/\n");
    await writeFile(join(repoDir, ".ignore"), "src/extra.md\n");
    await writeFile(join(repoDir, "src", "keep.md"), "keep\n");
    await writeFile(join(repoDir, "src", "extra.md"), "extra\n");
    await writeFile(join(repoDir, "ignored-dir", "nested.md"), "nested\n");
    await writeFile(join(repoDir, "node_modules", "vendor.md"), "vendor\n");
    await writeFile(join(repoDir, ".agentflow", "run.md"), "run\n");

    const graph = compileGraph({
      version: "1",
      graph_id: "context-ignore-glob",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {}
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "consumer",
            command: "placeholder",
            inputs: [
              {
                kind: "glob",
                path: "**/*.md"
              }
            ]
          }
        ]
      }
    });

    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: consumerNode,
      execution_id: "exec__consumer__attempt_1",
      execution_dir: join(tempRoot, "consumer"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts: createAttemptRegistry()
    });

    expect(resolved.packet.materials).toHaveLength(1);
    expect(await readFile(resolved.packet.materials[0]!.materialized_path, "utf8")).toBe("keep\n");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("lets explicit file inputs bypass ignore filtering", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-ignore-file-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, ".gitignore"), "ignored.md\n");
    await writeFile(join(repoDir, "ignored.md"), "still available\n");

    const graph = compileGraph({
      version: "1",
      graph_id: "context-ignore-file",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {}
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "consumer",
            command: "placeholder",
            inputs: [
              {
                kind: "file",
                path: "ignored.md"
              }
            ]
          }
        ]
      }
    });

    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: consumerNode,
      execution_id: "exec__consumer__attempt_1",
      execution_dir: join(tempRoot, "consumer"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts: createAttemptRegistry()
    });

    expect(resolved.packet.materials).toHaveLength(1);
    expect(await readFile(resolved.packet.materials[0]!.materialized_path, "utf8")).toBe(
      "still available\n"
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("does not fail solely because many small files are materialized", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-many-files-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });

    for (const [index, contents] of ["one", "two", "three", "four", "five"].entries()) {
      await writeFile(join(repoDir, `note-${index + 1}.md`), `${contents}\n`, "utf8");
    }

    const graph = compileGraph({
      version: "1",
      graph_id: "context-many-small-files",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {
          harness: "codex-cli",
          input_rules: {
            max_total_tokens: 250,
            max_tokens_per_item: 64
          }
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "consumer",
            command: "placeholder",
            inputs: [
              {
                kind: "glob",
                path: "*.md"
              }
            ]
          }
        ]
      }
    });

    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: consumerNode,
      execution_id: "exec__consumer__attempt_1",
      execution_dir: join(tempRoot, "consumer"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts: createAttemptRegistry()
    });

    expect(resolved.packet.materials).toHaveLength(5);
    expect(resolved.packet.totals).toEqual({
      material_count: 5,
      file_count: 5,
      total_tokens: expect.any(Number)
    });

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("fails incrementally when the next item would exceed max_total_tokens", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-token-budget-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "first.txt"), "one", "utf8");
    await writeFile(join(repoDir, "second.txt"), "two", "utf8");

    const graph = compileGraph({
      version: "1",
      graph_id: "context-token-budget",
      repos: {
        main: { path: "." }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {
          harness: "codex-cli",
          input_rules: {
            max_total_tokens: 1,
            max_tokens_per_item: 10
          }
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "consumer",
            command: "placeholder",
            inputs: [
              {
                kind: "file",
                path: "first.txt"
              },
              {
                kind: "file",
                path: "second.txt"
              }
            ]
          }
        ]
      }
    });

    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    const executionDir = join(tempRoot, "consumer");

    await expect(
      resolveExecutionContext({
        compiled_graph: graph,
        node: consumerNode,
        execution_id: "exec__consumer__attempt_1",
        execution_dir: executionDir,
        workspace_path: repoDir,
        repo_workspaces: {
          main: repoDir
        },
        attempts: createAttemptRegistry()
      })
    ).rejects.toThrow(
      'Materializing input_2 (file "second.txt") would exceed max_total_tokens 1. Current tokens: 1. Next item tokens: 1.'
    );

    await expect(readFile(join(executionDir, "context_materialized", "input_1", "first.txt"), "utf8")).resolves.toBe("one");
    await expect(readFile(join(executionDir, "context_materialized", "input_2", "second.txt"), "utf8")).rejects.toThrow();

    await rm(tempRoot, { recursive: true, force: true });
  });
});
