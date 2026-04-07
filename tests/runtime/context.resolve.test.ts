import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { closeNodeAttempt, createAttemptRegistry, openNodeAttempt } from "../../src/runtime/attempts.js";
import { resolveExecutionContext } from "../../src/runtime/context/resolve.js";

describe("context resolution", () => {
  it("materializes static inputs and upstream output references into a context packet", async () => {
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

    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "context-resolution",
      repos: {
        main: {
          path: "."
        }
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
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(
      normalized.document!,
      launch,
      normalized.lowered_managed_nodes
    );
    const graph = compilation.compiled_graph!;
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
    expect(resolved.packet.omitted).toEqual([]);
    expect(resolved.packet.totals).toEqual({
      material_count: 3,
      file_count: 3,
      total_bytes: expect.any(Number)
    });
    expect(await readFile(resolved.summary_path, "utf8")).toContain("Materialized items");
    expect(await readFile(resolved.summary_path, "utf8")).toContain("Truncated items");
    expect(await readFile(resolved.summary_path, "utf8")).not.toContain("Rule files");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("records optional missing context references instead of failing resolution", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-optional-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });

    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "context-optional-missing",
      repos: {
        main: {
          path: "."
        }
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
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(
      normalized.document!,
      launch,
      normalized.lowered_managed_nodes
    );
    const consumerNode = compilation.compiled_graph!.nodes.find((node) => node.authored_id === "consumer")!;

    const resolved = await resolveExecutionContext({
      compiled_graph: compilation.compiled_graph!,
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

    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "context-selector-resolution",
      repos: {
        main: {
          path: "."
        }
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
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(
      normalized.document!,
      launch,
      normalized.lowered_managed_nodes
    );
    const graph = compilation.compiled_graph!;
    const produceNode = graph.nodes.find((node) => node.authored_id === "produce")!;
    const consumerNode = graph.nodes.find((node) => node.authored_id === "consumer")!;
    const attempts = createAttemptRegistry();
    const repeatScopeId = produceNode.repeat_scope_id;

    if (!repeatScopeId) {
      throw new Error("Expected repeat-backed producer node to carry a repeat scope.");
    }

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
      output_artifacts: {
        report: reportOne
      }
    });

    const secondAttempt = openNodeAttempt(attempts, produceNode, join(tempRoot, "attempt-2"), {
      repeat_scope_id: repeatScopeId,
      iteration_index: 2
    });
    closeNodeAttempt(attempts, secondAttempt.execution_id, {
      status: "failed",
      outcome: "failed",
      output_artifacts: {
        report: reportTwoFailed
      }
    });

    const thirdAttempt = openNodeAttempt(attempts, produceNode, join(tempRoot, "attempt-3"), {
      repeat_scope_id: repeatScopeId,
      iteration_index: 2
    });
    closeNodeAttempt(attempts, thirdAttempt.execution_id, {
      status: "passed",
      outcome: "passed",
      output_artifacts: {
        report: reportTwoLatest
      }
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
        "Line three should be cut off because the file is too large for the configured byte limit."
      ].join("\n"),
      "utf8"
    );

    const normalized = normalizeAuthoredGraphDocument({
      version: "1",
      graph_id: "context-truncation",
      repos: {
        main: {
          path: "."
        }
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
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(
      normalized.document!,
      launch,
      normalized.lowered_managed_nodes
    );
    const consumerNode = compilation.compiled_graph!.nodes.find((node) => node.authored_id === "consumer")!;
    consumerNode.effective_policy.input_rules.max_bytes_per_item = 120;

    const resolved = await resolveExecutionContext({
      compiled_graph: compilation.compiled_graph!,
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
    expect(summary).toContain("- Truncated items: `1`");
    expect(summary).toContain("bytes, truncated");

    await rm(tempRoot, { recursive: true, force: true });
  });
});
