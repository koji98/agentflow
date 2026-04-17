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
  it("materializes workspace context and upstream artifacts into a context packet", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-"));
    const repoDir = join(tempRoot, "repo");
    const upstreamDir = join(tempRoot, "upstream");
    await mkdir(repoDir, { recursive: true });
    await mkdir(join(repoDir, ".cursor", "rules"), { recursive: true });
    await mkdir(upstreamDir, { recursive: true });
    await writeFile(join(repoDir, "src.txt"), "source file\n");
    await writeFile(join(repoDir, "AGENTS.md"), "Follow repo instructions.\n");
    await writeFile(join(repoDir, ".cursor", "rules", "review.mdc"), "Review rule.\n");
    await mkdir(join(upstreamDir, "context"), { recursive: true });
    await writeFile(join(upstreamDir, "context", "manifest.md"), "# Manifest\n");
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
            artifacts: {
              verification: {
                from: "output_dir",
                path: "result.json",
                description: "Structured verification result from the source node."
              }
            }
          },
          {
            type: "exec",
            id: "consume",
            command: "placeholder",
            context: [
              {
                name: "source_file",
                from: "workspace_file",
                path: "src.txt"
              },
              {
                name: "note",
                from: "text",
                text: "operator note"
              },
              {
                name: "verification",
                from: "artifact",
                node: "source",
                artifact: "verification"
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
      context_manifest_path: join(upstreamDir, "context", "manifest.md"),
      artifacts: {
        result_json: join(upstreamDir, "result.json"),
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
    expect(resolved.packet.materials.find((item) => item.key === "verification")?.description).toBe(
      "Structured verification result from the source node."
    );
    expect(resolved.packet.tokenizer).toBe("o200k_base");
    expect(resolved.packet.omitted).toEqual([]);
    const manifest = await readFile(resolved.manifest_path, "utf8");
    expect(manifest).toContain("Materialized items");
    expect(manifest).toContain('requested "src.txt"');
    expect(manifest).toContain("Structured verification result from the source node.");
    expect(await readFile(resolved.provenance_path, "utf8")).toContain("\"compiled_id\"");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("records if_available missing context references instead of failing resolution", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-if-available-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });

    const graph = compileGraph({
      version: "1",
      graph_id: "context-if-available-missing",
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
            context: [
              {
                name: "source_response",
                from: "artifact",
                node: "source",
                artifact: "agent_response",
                if_available: true
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
        key: "source_response",
        source: {
          name: "source_response",
          from: "artifact",
          node: "source",
          artifact: "agent_response",
          if_available: true
        },
        description: "Final response captured from the producer node.",
        reason: 'No execution matched "source".',
        if_available: true
      }
    ]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("automatically materializes repeat history from completed prior iterations", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-repeat-history-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });

    const graph = compileGraph({
      version: "1",
      graph_id: "repeat-history",
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
            id: "repair",
            max_attempts: 3,
            body: {
              type: "sequence",
              id: "body",
              steps: [
                {
                  type: "agent",
                  id: "implement",
                  prompt: "Implement the fix.",
                  artifacts: {
                    fix_log: {
                      from: "output_dir",
                      path: "fix-log.md",
                      description: "Notes about the attempted fix."
                    }
                  }
                },
                {
                  type: "check",
                  id: "verify",
                  check_kind: "deterministic",
                  command: "npm"
                }
              ]
            },
            until: {
              node: "verify"
            }
          }
        ]
      }
    });

    const implementNode = graph.nodes.find((node) => node.authored_id === "implement")!;
    const verifyNode = graph.nodes.find((node) => node.authored_id === "verify")!;
    const repeatScopeId = implementNode.repeat_scope_id!;
    const attempts = createAttemptRegistry();
    const implementDir = join(tempRoot, "implement-iteration-1");
    const verifyDir = join(tempRoot, "verify-iteration-1");
    const currentDir = join(tempRoot, "implement-iteration-2");
    await mkdir(implementDir, { recursive: true });
    await mkdir(verifyDir, { recursive: true });
    await mkdir(currentDir, { recursive: true });
    await writeFile(join(implementDir, "agent-response.md"), "Tried parser normalization.\nNot tried tokenizer changes.\n");
    await writeFile(join(implementDir, "result.json"), JSON.stringify({ exit_code: 0 }));
    await writeFile(join(implementDir, "fix-log.md"), "Changed parser branch.\n");
    await writeFile(join(verifyDir, "result.json"), JSON.stringify({
      passed: false,
      summary: "parser.test.ts still fails",
      exit_code: 1
    }));
    await writeFile(join(verifyDir, "stdout.log"), "expected token count 3, received 2\n");
    await writeFile(join(verifyDir, "stderr.log"), "parser.test.ts failed\n");

    const priorImplement = openNodeAttempt(attempts, implementNode, implementDir, {
      repeat_scope_id: repeatScopeId,
      iteration_index: 1
    });
    closeNodeAttempt(attempts, priorImplement.execution_id, {
      status: "passed",
      outcome: "passed",
      result_path: join(implementDir, "result.json"),
      artifacts: {
        agent_response: join(implementDir, "agent-response.md"),
        result_json: join(implementDir, "result.json"),
        fix_log: join(implementDir, "fix-log.md")
      }
    });
    const priorVerify = openNodeAttempt(attempts, verifyNode, verifyDir, {
      repeat_scope_id: repeatScopeId,
      iteration_index: 1
    });
    closeNodeAttempt(attempts, priorVerify.execution_id, {
      status: "failed",
      outcome: "failed",
      result_path: join(verifyDir, "result.json"),
      stdout_log_path: join(verifyDir, "stdout.log"),
      stderr_log_path: join(verifyDir, "stderr.log"),
      artifacts: {
        result_json: join(verifyDir, "result.json")
      }
    });
    const currentAttempt = openNodeAttempt(attempts, implementNode, currentDir, {
      repeat_scope_id: repeatScopeId,
      iteration_index: 2
    });

    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: implementNode,
      execution_id: currentAttempt.execution_id,
      execution_dir: currentDir,
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts
    });

    const history = resolved.packet.materials.find((item) => item.key === "repeat_history");
    expect(history).toEqual(
      expect.objectContaining({
        description: "Deterministic summary of completed prior iterations in the enclosing repeat scope."
      })
    );
    expect(history?.source).toEqual({
      name: "repeat_history",
      from: "runtime_repeat_history",
      repeat_scope_id: repeatScopeId,
      current_iteration: 2
    });

    const historyText = await readFile(history!.materialized_path, "utf8");
    expect(historyText).toContain("Current iteration: 2 of 3");
    expect(historyText).toContain("Loop continued because `verify` failed.");
    expect(historyText).toContain("Tried parser normalization.");
    expect(historyText).toContain("Not tried tokenizer changes.");
    expect(historyText).toContain("parser.test.ts still fails");
    expect(historyText).toContain("parser.test.ts failed");
    expect(await readFile(resolved.manifest_path, "utf8")).toContain("repeat_history");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("records repeat history as omitted on the first repeat iteration", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-repeat-history-first-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });

    const graph = compileGraph({
      version: "1",
      graph_id: "repeat-history-first",
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
            id: "repair",
            max_attempts: 2,
            body: {
              type: "sequence",
              id: "body",
              steps: [
                {
                  type: "agent",
                  id: "implement",
                  prompt: "Implement the fix."
                },
                {
                  type: "check",
                  id: "verify",
                  check_kind: "deterministic",
                  command: "npm"
                }
              ]
            },
            until: {
              node: "verify"
            }
          }
        ]
      }
    });

    const implementNode = graph.nodes.find((node) => node.authored_id === "implement")!;
    const attempts = createAttemptRegistry();
    const currentAttempt = openNodeAttempt(attempts, implementNode, join(tempRoot, "current"), {
      repeat_scope_id: implementNode.repeat_scope_id!,
      iteration_index: 1
    });

    const resolved = await resolveExecutionContext({
      compiled_graph: graph,
      node: implementNode,
      execution_id: currentAttempt.execution_id,
      execution_dir: join(tempRoot, "current"),
      workspace_path: repoDir,
      repo_workspaces: {
        main: repoDir
      },
      attempts
    });

    expect(resolved.packet.materials.find((item) => item.key === "repeat_history")).toBeUndefined();
    expect(resolved.packet.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "repeat_history",
          reason: "No prior repeat iterations have completed.",
          if_available: true
        })
      ])
    );

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
                  artifacts: {
                    report: {
                      from: "output_dir",
                      path: "report.md",
                      description: "Markdown report produced by the repeat body."
                    }
                  }
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
            context: [
              {
                name: "latest_passed_report",
                from: "artifact",
                node: "produce",
                artifact: "report",
                iteration: "latest_passed",
                attempt: "latest"
              },
              {
                name: "iteration_2_attempt_2_report",
                from: "artifact",
                node: "produce",
                artifact: "report",
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
      artifacts: { report: reportOne }
    });

    const secondAttempt = openNodeAttempt(attempts, produceNode, join(tempRoot, "attempt-2"), {
      repeat_scope_id: repeatScopeId,
      iteration_index: 2
    });
    closeNodeAttempt(attempts, secondAttempt.execution_id, {
      status: "failed",
      outcome: "failed",
      artifacts: { report: reportTwoFailed }
    });

    const thirdAttempt = openNodeAttempt(attempts, produceNode, join(tempRoot, "attempt-3"), {
      repeat_scope_id: repeatScopeId,
      iteration_index: 2
    });
    closeNodeAttempt(attempts, thirdAttempt.execution_id, {
      status: "passed",
      outcome: "passed",
      artifacts: { report: reportTwoLatest }
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
    expect(resolved.packet.materials.map((item) => item.description)).toEqual([
      "Markdown report produced by the repeat body.",
      "Markdown report produced by the repeat body."
    ]);
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
            context: [
              {
                name: "large_note",
                from: "workspace_file",
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
    const summary = await readFile(resolved.manifest_path, "utf8");

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
            context: [
              {
                name: "watched",
                from: "workspace_file",
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
        key: "watched",
        source: {
          name: "watched",
          from: "workspace_file",
          path: "watched.txt"
        },
        reason: 'Requested context workspace file "watched.txt" was not found at execution time.',
        if_available: false
      }
    ]);
    expect(await readFile(resolved.manifest_path, "utf8")).toContain('Requested context workspace file "watched.txt" was not found');

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
            context: [
              {
                name: "binary",
                from: "workspace_file",
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
        key: "binary",
        source: {
          name: "binary",
          from: "workspace_file",
          path: "binary.dat"
        },
        reason: "Material is not valid UTF-8 text and cannot be tokenized.",
        if_available: false
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
            context: [
              {
                name: "markdown",
                from: "workspace_glob",
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
        key: "markdown",
        source: {
          name: "markdown",
          from: "workspace_glob",
          path: "*.md"
        },
        reason: 'Requested context workspace glob "*.md" matched no files after ignore filtering at execution time.',
        if_available: false
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
            context: [
              {
                name: "markdown",
                from: "workspace_glob",
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
            context: [
              {
                name: "markdown",
                from: "workspace_glob",
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
            context: [
              {
                name: "ignored",
                from: "workspace_file",
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
            context: [
              {
                name: "markdown",
                from: "workspace_glob",
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
            context: [
              {
                name: "first",
                from: "workspace_file",
                path: "first.txt"
              },
              {
                name: "second",
                from: "workspace_file",
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
      'Materializing context_2 (workspace file "second.txt") would exceed max_total_tokens 1. Current tokens: 1. Next item tokens: 1.'
    );

    await expect(readFile(join(executionDir, "context", "materialized", "first", "first.txt"), "utf8")).resolves.toBe("one");
    await expect(readFile(join(executionDir, "context", "materialized", "second", "second.txt"), "utf8")).rejects.toThrow();

    await rm(tempRoot, { recursive: true, force: true });
  });
});
