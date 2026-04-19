import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import {
  resolveExecutionArtifactsDirectory,
  resolveNodeExecutionDirectory
} from "../../src/artifacts/paths.js";
import { buildExecutionId } from "../../src/runtime/attempts.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";
import { createCodexCliHarness } from "../../src/runtime/harness/codex_cli.js";
import type { HarnessAdapter } from "../../src/runtime/harness/types.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "seed\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
}

function compileGraph(document: AuthoredGraphDocument) {
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

async function waitFor(
  predicate: () => Promise<boolean>,
  options: {
    timeout_ms?: number;
    interval_ms?: number;
  } = {}
): Promise<void> {
  const timeout_ms = options.timeout_ms ?? 1000;
  const interval_ms = options.interval_ms ?? 20;
  const started_at = Date.now();

  while (Date.now() - started_at < timeout_ms) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, interval_ms));
  }

  throw new Error(`Condition not met within ${timeout_ms}ms.`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function createHarness(
  kind: HarnessAdapter["kind"],
  run: HarnessAdapter["run"],
  overrides: Partial<HarnessAdapter> = {}
): HarnessAdapter {
  return {
    kind,
    capabilities: getHarnessCapabilities(kind)!,
    run,
    async cancel() {
      return;
    },
    ...overrides
  };
}

describe("runtime engine", () => {
  it("executes sequence, parallel, repeat, and context handoff over a compiled graph", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-engine",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "setup",
            command: "placeholder"
          },
          {
            type: "parallel",
            id: "fanout",
            max_concurrency: 2,
            steps: [
              {
                type: "exec",
                id: "a",
                command: "placeholder"
              },
              {
                type: "exec",
                id: "b",
                command: "placeholder"
              }
            ]
          },
          {
            type: "repeat",
            id: "retry",
            max_attempts: 3,
            body: {
              type: "sequence",
              id: "body",
              steps: [
                {
                  type: "agent",
                  id: "implement",
                  prompt: "Increment the counter.",
                  artifacts: {
                    notes: {
                      from: "output_dir",
                      path: "notes.md",
                      description: "Test artifact produced at notes.md."
                    }
                  }
                },
                {
                  type: "check",
                  id: "verify",
                  check_kind: "deterministic",
                  command: "placeholder",
                  artifacts: {
                    verification: {
                      from: "output_dir",
                      path: "result.json",
                      description: "Test artifact produced at result.json."
                    }
                  }
                }
              ]
            },
            until: {
              node: "verify"
            }
          },
          {
            type: "exec",
            id: "finalize",
            command: "placeholder",
            context: [
              {
                name: "operator_note",
                from: "text",
                text: "done"
              },
              {
                ref: "verify.verification",
                name: "verification",
                node: "verify",
                artifact: "verification",
                iteration: "latest_passed"
              }
            ]
          }
        ]
      }
    });

    let counter = 0;
    let activeParallel = 0;
    let maxParallel = 0;
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        exec: async ({ node, workspace_path, context_packet_path }) => {
          if (node.authored_id === "setup") {
            await writeFile(join(workspace_path, "counter.txt"), "0\n");
          }

          if (node.authored_id === "a" || node.authored_id === "b") {
            activeParallel += 1;
            maxParallel = Math.max(maxParallel, activeParallel);
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 35));
            activeParallel -= 1;
          }

          if (node.authored_id === "finalize") {
            const packet = JSON.parse(await readFile(context_packet_path, "utf8")) as {
              materials: unknown[];
            };
            expect(packet.materials).toHaveLength(2);
          }

          return {
            status: "passed",
            outcome: "passed",
            result: {
              node: node.authored_id
            },
            stdout: "",
            stderr: ""
          };
        },
        agent: async ({ workspace_path, execution_dir }) => {
          counter += 1;
          await writeFile(join(workspace_path, "counter.txt"), `${counter}\n`);
          await writeFile(
            join(resolveExecutionArtifactsDirectory(execution_dir), "notes.md"),
            `iteration ${counter}\n`
          );
          return {
            status: "passed",
            outcome: "passed",
            result: {
              counter
            },
            stdout: "",
            stderr: ""
          };
        },
        check: async ({ workspace_path }) => {
          const currentCounter = Number((await readFile(join(workspace_path, "counter.txt"), "utf8")).trim());
          const passed = currentCounter >= 2;

          return {
            status: passed ? "passed" : "failed",
            outcome: passed ? "passed" : "failed",
            result: {
              passed,
              currentCounter
            },
            stdout: JSON.stringify({
              passed,
              currentCounter
            }),
            stderr: "",
            check: {
              check_kind: "deterministic",
              passed,
              summary: passed ? "verification passed" : "retry required"
            }
          };
        }
      }
    });

    expect(run.outcome).toBe("passed");
    expect(maxParallel).toBe(2);
    expect(run.state.status).toBe("passed");
    expect(run.attempts[0]?.execution_dir).toMatch(/\/nodes\/\d{3}-[^/]+-[0-9a-f]{12}\/executions\/001-exec-[0-9a-f]{16}$/);
    expect(run.state.repeat_scopes.scope__root__retry.latest_iteration_index).toBe(2);
    expect(run.state.repeat_scopes.scope__root__retry.status).toBe("passed");
    expect(
      run.attempts.filter((attempt) => attempt.authored_id === "implement").map((attempt) => ({
        iteration_index: attempt.iteration_index,
        iteration_attempt_index: attempt.iteration_attempt_index,
        execution_dir: attempt.execution_dir
      }))
    ).toEqual([
      {
        iteration_index: 1,
        iteration_attempt_index: 1,
        execution_dir: expect.stringMatching(/\/executions\/i001-a001-exec-[0-9a-f]{16}$/)
      },
      {
        iteration_index: 2,
        iteration_attempt_index: 1,
        execution_dir: expect.stringMatching(/\/executions\/i002-a001-exec-[0-9a-f]{16}$/)
      }
    ]);
    expect(
      run.attempts.filter((attempt) => attempt.authored_id === "verify").map((attempt) => attempt.outcome)
    ).toEqual(["failed", "passed"]);
    expect(run.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.started",
        "repeat.iteration.started",
        "repeat.iteration.completed",
        "node.completed",
        "run.completed"
      ])
    );
    expect(await readFile(join(repoDir, "counter.txt"), "utf8")).toContain("2");
    expect(JSON.parse(await readFile(join(runRoot, "run.json"), "utf8"))).toEqual(
      expect.objectContaining({
        run_id: run.run_id,
        graph_id: "runtime-engine",
        launch_profile: "default",
        workspace_backend: "inplace",
        status: "passed",
        ended_at: expect.any(String)
      })
    );
    expect(JSON.parse(await readFile(join(runRoot, "execution_manifest.json"), "utf8"))).toEqual(
      expect.objectContaining({
        run_id: run.run_id,
        repo_workspaces: {
          main: expect.objectContaining({
            repo_alias: "main",
            source_path: repoDir,
            workspace_path: repoDir,
            backend: "inplace"
          })
        }
      })
    );
    expect(await pathExists(join(runRoot, "repos"))).toBe(false);
    await Promise.all(
      run.attempts.map(async (attempt) => {
        expect(await pathExists(resolveExecutionArtifactsDirectory(attempt.execution_dir))).toBe(true);
      })
    );
    const summary = await readFile(join(runRoot, "summary.md"), "utf8");
    expect(summary).toContain("- Control-flow status: `passed`");
    expect(summary).toContain("- Evidence status: `clean`");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("continues past a soft-failing exec verifier and records evidence warnings", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-soft-exec-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-soft-exec",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "verify",
            command: "sh",
            args: ["-lc", "exit 7"],
            on_failure: "continue"
          },
          {
            type: "exec",
            id: "after",
            command: "sh",
            args: ["-lc", "exit 0"]
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      }
    });

    const verifyAttempt = run.attempts.find((attempt) => attempt.authored_id === "verify");
    expect(run.outcome).toBe("passed");
    expect(run.state.node_statuses.root__verify).toBe("passed");
    expect(run.state.node_statuses.root__after).toBe("passed");
    expect(run.state.evidence_status).toBe("warnings");
    expect(run.state.soft_verification_counts).toEqual({
      passed: 0,
      failed: 1
    });
    expect(run.state.failed_soft_verifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authored_id: "verify",
          verifier_kind: "exec",
          passed: false,
          exit_code: 7
        })
      ])
    );
    expect(JSON.parse(await readFile(verifyAttempt!.result_path!, "utf8"))).toEqual(
      expect.objectContaining({
        soft_verification: true,
        verifier_kind: "exec",
        passed: false,
        exit_code: 7
      })
    );
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "verification.recorded",
          compiled_id: "root__verify",
          payload: expect.objectContaining({
            verifier_kind: "exec",
            passed: false,
            exit_code: 7
          })
        })
      ])
    );

    const summary = await readFile(join(runRoot, "summary.md"), "utf8");
    expect(summary).toContain("- Evidence status: `warnings`");
    expect(summary).toContain("## Failed Soft Verifications");
    expect(summary).toContain("Command exited with code 7.");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("continues past a soft deterministic check failure and keeps check evidence visible", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-soft-check-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-soft-check",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
      },
      profiles: {
        default: {}
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "check",
            id: "verify",
            check_kind: "deterministic",
            command: "sh",
            args: ["-lc", "exit 2"],
            pass_if: {
              exit_code: 0
            },
            on_failure: "continue"
          },
          {
            type: "exec",
            id: "after",
            command: "sh",
            args: ["-lc", "exit 0"]
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      }
    });

    const verifyAttempt = run.attempts.find((attempt) => attempt.authored_id === "verify");
    expect(run.outcome).toBe("passed");
    expect(run.state.node_statuses.root__verify).toBe("passed");
    expect(run.state.evidence_status).toBe("warnings");
    expect(run.state.soft_verification_counts.failed).toBe(1);
    expect(JSON.parse(await readFile(verifyAttempt!.result_path!, "utf8"))).toEqual(
      expect.objectContaining({
        soft_verification: true,
        verifier_kind: "check",
        check_kind: "deterministic",
        passed: false,
        exit_code: 2,
        summary: "Deterministic check failed."
      })
    );
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "check.evaluated",
          payload: expect.objectContaining({
            check_kind: "deterministic",
            passed: false,
            summary: "Deterministic check failed."
          })
        }),
        expect.objectContaining({
          type: "verification.recorded",
          payload: expect.objectContaining({
            verifier_kind: "check",
            check_kind: "deterministic",
            passed: false,
            summary: "Deterministic check failed."
          })
        })
      ])
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("keeps operational exec failures hard even when on_failure is continue", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-soft-exec-hard-failure-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-soft-exec-hard-failure",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "verify",
            command: "definitely-missing-command",
            on_failure: "continue"
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      }
    });

    const verifyAttempt = run.attempts.find((attempt) => attempt.authored_id === "verify");
    expect(run.outcome).toBe("failed");
    expect(run.state.node_statuses.root__verify).toBe("failed");
    expect(run.state.evidence_status).toBe("clean");
    expect(run.events.some((event) => event.type === "verification.recorded")).toBe(false);
    expect(JSON.parse(await readFile(verifyAttempt!.result_path!, "utf8"))).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("definitely-missing-command")
      })
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("creates artifacts only when workspace outputs are materialized", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-workspace-output-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-workspace-output",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "produce-report",
            command: "placeholder",
            artifacts: {
              report: {
                from: "workspace",
                path: "reports/report.md",
                description: "Test artifact produced at reports/report.md."
              }
            }
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        exec: async ({ workspace_path, node }) => {
          await mkdir(join(workspace_path, "reports"), { recursive: true });
          await writeFile(join(workspace_path, "reports", "report.md"), `report for ${node.authored_id}\n`);
          return {
            status: "passed",
            outcome: "passed",
            result: {
              node: node.authored_id
            },
            stdout: "",
            stderr: ""
          };
        }
      }
    });

    const attempt = run.attempts[0];
    const copiedArtifactPath = join(attempt!.execution_dir, "artifacts", "reports", "report.md");

    expect(run.outcome).toBe("passed");
    expect(attempt?.artifacts).toEqual(expect.objectContaining({
      report: copiedArtifactPath
    }));
    expect(await pathExists(join(attempt!.execution_dir, "artifacts"))).toBe(true);
    expect(await readFile(copiedArtifactPath, "utf8")).toBe("report for produce-report\n");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("lets exec nodes publish declared output_dir artifacts through the runtime environment", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-output-dir-env-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-output-dir-env",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "produce_handoff",
            command: process.execPath,
            args: [
              "-e",
              [
                "const fs = require('node:fs');",
                "const path = require('node:path');",
                "const payload = {",
                "  workspace: process.env.AGENTFLOW_WORKSPACE,",
                "  output_dir: process.env.AGENTFLOW_OUTPUT_DIR,",
                "  packet_exists: fs.existsSync(process.env.AGENTFLOW_CONTEXT_PACKET),",
                "  manifest_exists: fs.existsSync(process.env.AGENTFLOW_CONTEXT_MANIFEST)",
                "};",
                "fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR, 'handoff.json'), JSON.stringify(payload));"
              ].join(" ")
            ],
            artifacts: {
              handoff: {
                from: "output_dir",
                path: "handoff.json",
                description: "Test artifact produced at handoff.json."
              }
            }
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      }
    });

    const attempt = run.attempts[0]!;
    const handoff = JSON.parse(await readFile(attempt.artifacts.handoff!, "utf8"));

    expect(run.outcome).toBe("passed");
    expect(attempt.artifacts.handoff).toBe(
      join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "handoff.json")
    );
    expect(handoff).toEqual({
      workspace: repoDir,
      output_dir: resolveExecutionArtifactsDirectory(attempt.execution_dir),
      packet_exists: true,
      manifest_exists: true
    });
    await expect(access(join(attempt.execution_dir, "handoff.json"))).rejects.toThrow();

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("exposes per-context AGENTFLOW_CONTEXT_<UPPER_NAME> env vars to exec nodes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-context-env-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-context-env",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: {} },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "produce_seed",
            command: process.execPath,
            args: [
              "-e",
              [
                "const fs = require('node:fs');",
                "const path = require('node:path');",
                "fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR, 'seed.txt'), 'hello-context');"
              ].join(" ")
            ],
            artifacts: {
              seed: {
                from: "output_dir",
                path: "seed.txt",
                description: "Seed payload for the consumer."
              }
            }
          },
          {
            type: "exec",
            id: "consume_seed",
            command: process.execPath,
            args: [
              "-e",
              [
                "const fs = require('node:fs');",
                "const path = require('node:path');",
                "const seedPath = process.env.AGENTFLOW_CONTEXT_SEED_PAYLOAD;",
                "const payload = {",
                "  seed_path: seedPath,",
                "  seed_text: seedPath ? fs.readFileSync(seedPath, 'utf8') : null",
                "};",
                "fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR, 'consume.json'), JSON.stringify(payload));"
              ].join(" ")
            ],
            context: [
              { ref: "produce_seed.seed", name: "seed_payload", node: "produce_seed", artifact: "seed" }
            ],
            artifacts: {
              consume: {
                from: "output_dir",
                path: "consume.json",
                description: "Consumer payload that captures the materialized context path."
              }
            }
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: { main: repoDir }
    });

    expect(run.outcome).toBe("passed");
    const consumeAttempt = run.attempts.find((attempt) => attempt.authored_id === "consume_seed");
    expect(consumeAttempt).toBeDefined();
    const consume = JSON.parse(await readFile(consumeAttempt!.artifacts.consume!, "utf8"));
    expect(typeof consume.seed_path).toBe("string");
    expect(consume.seed_path.length).toBeGreaterThan(0);
    expect(consume.seed_text).toBe("hello-context");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("does not accept legacy execution-root files as output_dir artifacts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-output-dir-root-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-output-dir-root",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "legacy_writer",
            command: "placeholder",
            artifacts: {
              handoff: {
                from: "output_dir",
                path: "handoff.md",
                description: "Markdown handoff for downstream nodes."
              }
            }
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        exec: async ({ execution_dir }) => {
          await writeFile(join(execution_dir, "handoff.md"), "legacy root handoff\n");
          return {
            status: "passed",
            outcome: "passed",
            result: { ok: true },
            stdout: "",
            stderr: ""
          };
        }
      }
    });

    const attempt = run.attempts[0]!;

    expect(run.outcome).toBe("failed");
    expect(await readFile(join(attempt.execution_dir, "handoff.md"), "utf8")).toBe("legacy root handoff\n");
    expect(attempt.artifacts.handoff).toBeUndefined();
    expect(attempt.artifacts.result_json).toBe(
      join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "result.json")
    );
    expect(JSON.parse(await readFile(attempt.artifacts.result_json!, "utf8"))).toEqual({
      error: 'Required output_dir artifact "handoff" is missing at handoff.md.'
    });

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("passes declared artifact contracts into agent harness invocations", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-artifact-contract-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-agent-artifact-contract",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "agent",
            id: "package_handoff",
            prompt: "Write the handoff file.",
            artifacts: {
              handoff: {
                from: "output_dir",
                path: "handoff.md",
                description: "Test artifact produced at handoff.md."
              }
            }
          }
        ]
      }
    });

    let capturedInvocation: Parameters<HarnessAdapter["run"]>[0] | undefined;
    const harness = createHarness("codex-cli", async (invocation) => {
      capturedInvocation = invocation;
      await writeFile(join(invocation.outputDir, "handoff.md"), "handoff\n");

      return {
        status: "passed",
        exitCode: 0,
        transcript: {
          last_message: "published handoff"
        }
      };
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      harnesses: {
        "codex-cli": harness
      }
    });

    const attempt = run.attempts[0]!;

    expect(run.outcome).toBe("passed");
    expect(capturedInvocation?.promptKind).toBe("agent");
    expect(capturedInvocation).toEqual(
      expect.objectContaining({
        repoPath: repoDir,
        outputDir: resolveExecutionArtifactsDirectory(attempt.execution_dir),
        artifacts: {
          handoff: {
            from: "output_dir",
            path: "handoff.md",
            description: "Test artifact produced at handoff.md."
          }
        }
      })
    );
    expect(attempt.artifacts.handoff).toBe(
      join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "handoff.md")
    );
    expect(attempt.artifacts.agent_response).toBe(
      join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "agent-response.md")
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("repairs missing agent artifacts before finalizing the node", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-artifact-repair-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-agent-artifact-repair",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "agent",
            id: "write_handoff",
            prompt: "Write a handoff after inspecting the repo.",
            artifact_repair: {
              max_attempts: 2
            },
            artifacts: {
              handoff: {
                from: "output_dir",
                path: "handoff.md",
                description: "Markdown handoff for downstream nodes."
              }
            }
          }
        ]
      }
    });

    const invocations: Parameters<HarnessAdapter["run"]>[0][] = [];
    const harness = createHarness("codex-cli", async (invocation) => {
      invocations.push(invocation);

      if (invocation.executionId.endsWith("__artifact_repair_2")) {
        await writeFile(join(invocation.outputDir, "handoff.md"), "repaired handoff\n");
      }

      return {
        status: "passed",
        exitCode: 0,
        stdout: `stdout for ${invocation.executionId}`,
        stderr: "",
        transcript: {
          last_message: invocation.executionId.includes("__artifact_repair_")
            ? "repair response"
            : "initial response"
        }
      };
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      harnesses: {
        "codex-cli": harness
      }
    });

    const attempt = run.attempts[0]!;
    const artifactsRoot = resolveExecutionArtifactsDirectory(attempt.execution_dir);

    expect(run.outcome).toBe("passed");
    expect(invocations).toHaveLength(3);
    expect(invocations.map((invocation) => invocation.executionId)).toEqual([
      attempt.execution_id,
      `${attempt.execution_id}__artifact_repair_1`,
      `${attempt.execution_id}__artifact_repair_2`
    ]);
    expect(invocations[1]?.prompt).toContain("## Agentflow Artifact Repair");
    expect(invocations[1]?.prompt).toContain("Write a handoff after inspecting the repo.");
    expect(invocations[1]?.prompt).toContain("expected absolute path");
    expect(attempt.artifacts.handoff).toBe(join(artifactsRoot, "handoff.md"));
    expect(await readFile(attempt.artifacts.handoff!, "utf8")).toBe("repaired handoff\n");
    expect(attempt.metadata.artifact_repair).toEqual({
      status: "passed",
      max_attempts: 2,
      attempt_count: 2,
      missing_artifacts: []
    });
    expect(run.events.filter((event) => event.type === "artifact_repair.started")).toHaveLength(2);
    expect(run.events.filter((event) => event.type === "artifact_repair.failed")).toHaveLength(1);
    expect(run.events.filter((event) => event.type === "artifact_repair.completed")).toHaveLength(1);
    expect(await pathExists(join(attempt.execution_dir, "artifact-repairs", "001", "prompt.md"))).toBe(true);
    expect(await pathExists(join(attempt.execution_dir, "artifact-repairs", "002", "result.json"))).toBe(true);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("accepts a repair attempt when the missing artifact exists after the harness returns failed", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-artifact-repair-failed-status-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-agent-artifact-repair-failed-status",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "agent",
            id: "write_handoff",
            prompt: "Write a handoff.",
            artifacts: {
              handoff: {
                from: "output_dir",
                path: "handoff.md",
                description: "Markdown handoff for downstream nodes."
              }
            }
          }
        ]
      }
    });

    const harness = createHarness("codex-cli", async (invocation) => {
      if (invocation.executionId.includes("__artifact_repair_")) {
        await writeFile(join(invocation.outputDir, "handoff.md"), "handoff from failed repair\n");
        return {
          status: "failed",
          exitCode: 1,
          stdout: "repair wrote the artifact but exited nonzero",
          stderr: "nonzero",
          transcript: {
            last_message: "repair failed after writing"
          }
        };
      }

      return {
        status: "passed",
        exitCode: 0,
        stdout: "initial",
        stderr: "",
        transcript: {
          last_message: "initial response"
        }
      };
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      harnesses: {
        "codex-cli": harness
      }
    });

    const attempt = run.attempts[0]!;

    expect(run.outcome).toBe("passed");
    expect(await readFile(attempt.artifacts.handoff!, "utf8")).toBe("handoff from failed repair\n");
    expect(attempt.metadata.artifact_repair).toEqual({
      status: "passed",
      max_attempts: 1,
      attempt_count: 1,
      missing_artifacts: []
    });
    expect(run.events.filter((event) => event.type === "artifact_repair.failed")).toHaveLength(0);
    expect(run.events.filter((event) => event.type === "artifact_repair.completed")).toHaveLength(1);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("writes a diagnostic agent response artifact when an agent returns no final text", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-empty-agent-response-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-empty-agent-response",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "agent",
            id: "silent_agent",
            prompt: "Return nothing."
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        agent: async () => ({
          status: "passed",
          outcome: "passed",
          result: { ok: true },
          stdout: "",
          stderr: "",
          agent_response: ""
        })
      }
    });

    const attempt = run.attempts[0]!;

    expect(run.outcome).toBe("passed");
    expect(attempt.artifacts.agent_response).toBe(
      join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "agent-response.md")
    );
    expect(await readFile(attempt.artifacts.agent_response!, "utf8")).toBe(
      "Agent completed without a captured final response.\n"
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("keeps the automatic agent response artifact when declared artifact materialization fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-agent-response-materialization-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-agent-response-materialization",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "agent",
            id: "write_handoff",
            prompt: "Write a handoff.",
            artifacts: {
              handoff: {
                from: "output_dir",
                path: "handoff.md",
                description: "Test artifact produced at handoff.md."
              }
            }
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        agent: async () => ({
          status: "passed",
          outcome: "passed",
          result: { ok: true },
          stdout: "stdout fallback",
          stderr: "",
          agent_response: "final response"
        })
      }
    });

    const attempt = run.attempts[0];

    expect(run.outcome).toBe("failed");
    expect(attempt?.status).toBe("failed");
    expect(attempt?.artifacts).toEqual(
      expect.objectContaining({
        result_json: join(resolveExecutionArtifactsDirectory(attempt!.execution_dir), "result.json"),
        agent_response: join(resolveExecutionArtifactsDirectory(attempt!.execution_dir), "agent-response.md")
      })
    );
    expect(await readFile(attempt!.artifacts.agent_response!, "utf8")).toBe("final response\n");
    expect(JSON.parse(await readFile(attempt!.result_path!, "utf8"))).toEqual({
      error: "Required artifact contract is missing after 1 artifact repair attempt: handoff at handoff.md."
    });
    expect(attempt?.metadata.artifact_repair).toEqual({
      status: "failed",
      max_attempts: 1,
      attempt_count: 1,
      missing_artifacts: ["handoff"]
    });
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "artifact_repair.started",
          compiled_id: "root__write_handoff"
        }),
        expect.objectContaining({
          type: "artifact_repair.failed",
          compiled_id: "root__write_handoff",
          payload: expect.objectContaining({
            summary: "Artifact repair could not run because the resolved harness adapter is unavailable."
          })
        })
      ])
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("fails a node cleanly when required context cannot be resolved at runtime", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-context-failure-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-context-failure",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
                ref: "source.agent_response",
                name: "missing_artifact",
                node: "source",
                artifact: "agent_response"
              }
            ]
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        exec: async ({ node }) => ({
          status: "passed",
          outcome: "passed",
          result: {
            node: node.authored_id
          },
          stdout: "",
          stderr: ""
        })
      }
    });

    const consumerAttempt = run.attempts.find((attempt) => attempt.authored_id === "consumer");

    expect(run.outcome).toBe("failed");
    expect(consumerAttempt?.status).toBe("failed");
    expect(consumerAttempt?.result_path).toBeDefined();
    expect(JSON.parse(await readFile(consumerAttempt!.result_path!, "utf8"))).toEqual({
      error: 'Required context artifact is missing for "source".'
    });

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("fails when a file input escapes the repo root at runtime", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-input-escape-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(join(tempRoot, "secret.txt"), "outside\n");

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-input-escape",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "agent",
            id: "reader",
            prompt: "Read the input.",
            context: [
              {
                name: "secret",
                from: "workspace_file",
                path: "../secret.txt"
              }
            ]
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        agent: async () => ({
          status: "passed",
          outcome: "passed",
          result: {},
          stdout: "",
          stderr: ""
        })
      }
    });

    expect(run.outcome).toBe("failed");
    expect(run.attempts).toHaveLength(1);
    expect(run.state.node_statuses.root__reader).toBe("failed");
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "node.completed",
          compiled_id: "root__reader"
        })
      ])
    );
    expect((run.attempts[0]?.metadata as { error?: string } | undefined)?.error).toContain(
      'Context path "../secret.txt" must be a relative path that stays within its repo or workspace root.'
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("fails when exec cwd escapes the workspace root", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-cwd-escape-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-cwd-escape",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "escape",
            command: "pwd",
            cwd: "../outside"
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      }
    });

    expect(run.outcome).toBe("failed");
    expect(run.attempts[0]?.status).toBe("failed");
    expect(run.attempts[0]?.metadata.error).toContain(
      'cwd "../outside" must be a relative path that stays within its repo or workspace root.'
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("marks downstream nodes blocked after a terminal failure outside repeat scopes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-failure-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-terminal-failure",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "build",
            command: "placeholder"
          },
          {
            type: "exec",
            id: "handoff",
            command: "placeholder"
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        exec: async ({ node }) => ({
          status: node.authored_id === "build" ? "failed" : "passed",
          outcome: node.authored_id === "build" ? "failed" : "passed",
          result: {
            node: node.authored_id
          },
          stdout: "",
          stderr: node.authored_id === "build" ? "build failed" : ""
        })
      }
    });

    expect(run.outcome).toBe("failed");
    expect(run.state.status).toBe("failed");
    expect(run.state.node_statuses.root__build).toBe("failed");
    expect(run.state.node_statuses.root__handoff).toBe("blocked");
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "node.blocked",
          payload: expect.objectContaining({
            reason: "terminal_failure",
            upstream_compiled_id: "root__build"
          })
        }),
        expect.objectContaining({
          type: "run.completed",
          payload: expect.objectContaining({
            outcome: "failed"
          })
        })
      ])
    );
    expect(run.attempts.map((attempt) => attempt.authored_id)).toEqual(["build"]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("cancels sibling executions when a parallel node causes terminal failure", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-terminal-cancel-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-terminal-cancel",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "parallel",
            id: "fanout",
            max_concurrency: 2,
            steps: [
              {
                type: "exec",
                id: "fail_fast",
                command: "placeholder"
              },
              {
                type: "exec",
                id: "long_running",
                command: "placeholder"
              }
            ]
          },
          {
            type: "exec",
            id: "after_failure",
            command: "placeholder"
          }
        ]
      }
    });

    let longRunningCanceled = false;
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        exec: async ({ node, signal }) => {
          if (node.authored_id === "fail_fast") {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
            return {
              status: "failed",
              outcome: "failed",
              result: {
                node: node.authored_id
              },
              stdout: "",
              stderr: "boom"
            };
          }

          if (node.authored_id === "long_running") {
            await new Promise<void>((resolveCancel, rejectCancel) => {
              const timeout = setTimeout(() => {
                rejectCancel(new Error("long_running executor was not canceled"));
              }, 500);

              if (signal?.aborted) {
                longRunningCanceled = true;
                clearTimeout(timeout);
                resolveCancel();
                return;
              }

              signal?.addEventListener("abort", () => {
                longRunningCanceled = true;
                clearTimeout(timeout);
                resolveCancel();
              }, { once: true });
            });

            return {
              status: "canceled",
              result: {
                node: node.authored_id
              },
              stdout: "",
              stderr: ""
            };
          }

          return {
            status: "passed",
            outcome: "passed",
            result: {
              node: node.authored_id
            },
            stdout: "",
            stderr: ""
          };
        }
      }
    });

    const longRunningAttempt = run.attempts.find((attempt) => attempt.authored_id === "long_running");

    expect(run.outcome).toBe("failed");
    expect(longRunningCanceled).toBe(true);
    expect(run.state.status).toBe("failed");
    expect(run.state.node_statuses.root__fanout__fail_fast).toBe("failed");
    expect(run.state.node_statuses.root__fanout__long_running).toBe("canceled");
    expect(run.state.node_statuses.root__after_failure).toBe("blocked");
    expect(longRunningAttempt?.status).toBe("canceled");
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "node.canceled",
          compiled_id: "root__fanout__long_running",
          payload: expect.objectContaining({
            reason: "terminal_failure"
          })
        }),
        expect.objectContaining({
          type: "run.completed",
          payload: expect.objectContaining({
            outcome: "failed"
          })
        })
      ])
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("cancels active execution attempts and skips pending nodes when the run signal aborts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-cancel-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-cancel",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "long_running",
            command: "placeholder"
          },
          {
            type: "exec",
            id: "after_cancel",
            command: "placeholder"
          }
        ]
      }
    });

    const controller = new AbortController();
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      signal: controller.signal,
      executors: {
        exec: async ({ node, signal }) => {
          if (node.authored_id === "long_running") {
            setTimeout(() => controller.abort(), 10);

            if (!signal?.aborted) {
              await new Promise<void>((resolveAbort) => {
                signal?.addEventListener("abort", () => resolveAbort(), { once: true });
              });
            }

            return {
              status: "canceled",
              result: {
                node: node.authored_id
              },
              stdout: "",
              stderr: ""
            };
          }

          return {
            status: "passed",
            outcome: "passed",
            result: {
              node: node.authored_id
            },
            stdout: "",
            stderr: ""
          };
        }
      }
    });

    expect(run.outcome).toBe("canceled");
    expect(run.state.status).toBe("canceled");
    expect(run.state.node_statuses.root__long_running).toBe("canceled");
    expect(run.state.node_statuses.root__after_cancel).toBe("skipped");
    expect(run.state.counts.canceled).toBe(1);
    expect(run.state.counts.skipped).toBe(1);
    expect(run.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "node.canceled",
        "node.skipped",
        "run.canceled"
      ])
    );
    expect(run.events.some((event) => event.type === "run.completed")).toBe(false);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("fails a reachable agent when a required harness binary is unavailable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-preflight-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-preflight-harness",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "agent",
            id: "implement",
            prompt: "Attempt a harness run."
          }
        ]
      }
    });

    const missingBinary = join(tempRoot, "missing-codex");
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      harnesses: {
        "codex-cli": createCodexCliHarness({
          binary: missingBinary
        })
      }
    });

    const attempt = run.attempts.find((candidate) => candidate.authored_id === "implement");

    expect(run.outcome).toBe("failed");
    expect(run.attempts).toHaveLength(1);
    expect(run.state.status).toBe("failed");
    expect(run.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run.preflight_failed"
        })
      ])
    );
    expect(attempt?.metadata).toEqual(
      expect.objectContaining({
        error: expect.stringContaining(`codex-cli harness binary "${missingBinary}" is unavailable.`),
        context_status: "failed"
      })
    );
    expect(JSON.parse(await readFile(join(runRoot, "run.json"), "utf8"))).toEqual(
      expect.objectContaining({
        run_id: run.run_id,
        graph_id: "runtime-preflight-harness",
        launch_profile: "default",
        workspace_backend: "inplace",
        status: "failed",
        ended_at: expect.any(String)
      })
    );
    const summary = await readFile(join(runRoot, "summary.md"), "utf8");
    expect(summary).toContain(`codex-cli harness binary "${missingBinary}" is unavailable.`);
    expect(summary).not.toContain("No node executions were recorded.");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("fails a reachable checkpoint when no checkpoint executor is configured", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-checkpoint-preflight-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-preflight-checkpoint",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            max_attempts: 2,
            body: {
              type: "sequence",
              id: "body",
              steps: [
                {
                  type: "exec",
                  id: "draft",
                  command: "placeholder",
                  artifacts: {
                    draft_spec: {
                      from: "output_dir",
                      path: "draft.md",
                      description: "Test artifact produced at draft.md."
                    }
                  }
                },
                {
                  type: "checkpoint",
                  id: "review",
                  prompt: "Review the draft.",
                  review_from: {
                    node: "draft",
                    artifact: "draft_spec"
                  }
                }
              ]
            },
            until: {
              node: "review"
            }
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        exec: async ({ execution_dir }) => {
          await writeFile(join(resolveExecutionArtifactsDirectory(execution_dir), "draft.md"), "draft\n");
          return {
            status: "passed",
            outcome: "passed",
            stdout: "",
            stderr: "",
            result: { ok: true }
          };
        }
      }
    });

    const draftAttempt = run.attempts.find((candidate) => candidate.authored_id === "draft");
    const reviewAttempt = run.attempts.find((candidate) => candidate.authored_id === "review");

    expect(run.outcome).toBe("failed");
    expect(draftAttempt?.status).toBe("passed");
    expect(reviewAttempt?.status).toBe("failed");
    expect(reviewAttempt?.metadata).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("requires a checkpoint executor"),
        context_status: "failed"
      })
    );
    expect(run.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run.preflight_failed"
        })
      ])
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("records AI harness launch errors as failed check evaluations", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-ai-check-failure-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-ai-check-harness-failure",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "check",
            id: "judge",
            check_kind: "ai",
            prompt: "Evaluate the latest patch."
          }
        ]
      }
    });

    const failingHarness = createHarness("codex-cli", async () => {
      throw new Error("spawnSync codex ETIMEDOUT");
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      harnesses: {
        "codex-cli": failingHarness
      }
    });

    const judgeAttempt = run.attempts.find((attempt) => attempt.authored_id === "judge");

    expect(run.outcome).toBe("failed");
    expect(run.state.node_statuses.root__judge).toBe("failed");
    expect(judgeAttempt?.status).toBe("failed");
    expect(judgeAttempt?.result_path).toBeDefined();
    expect(JSON.parse(await readFile(judgeAttempt!.result_path!, "utf8"))).toEqual(
      expect.objectContaining({
        passed: false,
        summary: expect.stringContaining("spawnSync codex ETIMEDOUT")
      })
    );
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "check.evaluated",
          compiled_id: "root__judge",
          payload: expect.objectContaining({
            check_kind: "ai",
            passed: false,
            summary: expect.stringContaining("spawnSync codex ETIMEDOUT")
          })
        })
      ])
    );
    expect(await readFile(join(runRoot, "summary.md"), "utf8")).toContain("spawnSync codex ETIMEDOUT");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("records failed AI harness results as harness failures even when stdout contains passing JSON", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-ai-check-timeout-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-ai-check-harness-timeout",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "check",
            id: "judge",
            check_kind: "ai",
            prompt: "Evaluate the latest patch."
          }
        ]
      }
    });

    const failingHarness = createHarness("codex-cli", async () => {
      return {
        status: "failed",
        exitCode: 1,
        stdout: '{"passed":true,"score":1,"summary":"ok"}',
        metadata: {
          timed_out: true,
          force_killed: true
        }
      };
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      harnesses: {
        "codex-cli": failingHarness
      }
    });

    const judgeAttempt = run.attempts.find((attempt) => attempt.authored_id === "judge");

    expect(run.outcome).toBe("failed");
    expect(run.state.node_statuses.root__judge).toBe("failed");
    expect(judgeAttempt?.status).toBe("failed");
    expect(JSON.parse(await readFile(judgeAttempt!.result_path!, "utf8"))).toEqual(
      expect.objectContaining({
        passed: false,
        summary: "AI check harness timed out and required a force kill."
      })
    );
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "check.evaluated",
          compiled_id: "root__judge",
          payload: expect.objectContaining({
            check_kind: "ai",
            passed: false,
            summary: "AI check harness timed out and required a force kill."
          })
        })
      ])
    );
    expect(await readFile(join(runRoot, "summary.md"), "utf8")).toContain(
      "AI check harness timed out and required a force kill."
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("streams agent stdout into logs/stdout.log before the node completes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-streaming-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-streaming",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "agent",
            id: "stream_logs",
            prompt: "Stream a partial response before completion."
          }
        ]
      }
    });

    const agentNode = graph.nodes.find((node) => node.authored_id === "stream_logs");
    expect(agentNode?.kind).toBe("agent");
    const executionId = buildExecutionId(agentNode!.compiled_id, 1);
    const nodeIndex = graph.nodes.findIndex((node) => node.compiled_id === agentNode!.compiled_id);
    const stdoutLogPath = join(
      resolveNodeExecutionDirectory(runRoot, agentNode!.compiled_id, executionId, {
        nodeIndex,
        nodeCount: graph.nodes.length,
        label: agentNode!.label ?? agentNode!.authored_id,
        attemptIndex: 1
      }),
      "logs",
      "stdout.log"
    );

    const harness: HarnessAdapter = {
      kind: "codex-cli",
      capabilities: getHarnessCapabilities("codex-cli")!,
      async run(invocation) {
        invocation.onStdoutChunk?.("partial output\n");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));

        return {
          status: "passed",
          exitCode: 0,
          stdout: "partial output\nfinal output\n",
          stderr: ""
        };
      },
      async cancel() {}
    };

    try {
      const runPromise = runCompiledGraph({
        run_root: runRoot,
        compiled_graph: graph,
        repo_sources: {
          main: repoDir
        },
        harnesses: {
          "codex-cli": harness
        }
      });

      await waitFor(async () => {
        try {
          return (await readFile(stdoutLogPath, "utf8")).includes("partial output");
        } catch {
          return false;
        }
      });

      const run = await runPromise;
      expect(run.outcome).toBe("passed");
      expect(await readFile(stdoutLogPath, "utf8")).toBe("partial output\nfinal output\n");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not fail when an upstream node deletes a downstream authored input file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-live-input-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(join(repoDir, "watched.txt"), "before\n");

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-live-input-omission",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "delete_file",
            repo: "main",
            command: "placeholder"
          },
          {
            type: "exec",
            id: "consume",
            repo: "main",
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

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        exec: async ({ node, workspace_path, context_packet_path }) => {
          if (node.authored_id === "delete_file") {
            await rm(join(workspace_path, "watched.txt"), { force: true });
            return {
              status: "passed",
              outcome: "passed",
              stdout: "",
              stderr: "",
              result: { deleted: true }
            };
          }

          const packet = JSON.parse(await readFile(context_packet_path, "utf8")) as {
            materials: unknown[];
            omitted: Array<{ key: string; reason: string; if_available: boolean }>;
          };
          expect(packet.materials).toEqual([]);
          expect(packet.omitted).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                key: "watched",
                reason: 'Requested context workspace file "watched.txt" was not found at execution time.',
                if_available: false
              })
            ])
          );

          return {
            status: "passed",
            outcome: "passed",
            stdout: "",
            stderr: "",
            result: { consumed: true }
          };
        }
      }
    });

    expect(run.outcome).toBe("passed");
    expect(run.state.node_statuses.root__consume).toBe("passed");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("does not preflight-fail a blocked node with a bad authored input path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-blocked-input-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-blocked-input",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "fail_first",
            repo: "main",
            command: "placeholder"
          },
          {
            type: "exec",
            id: "never_runs",
            repo: "main",
            command: "placeholder",
            context: [
              {
                name: "missing",
                from: "workspace_file",
                path: "missing.txt"
              }
            ]
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        exec: async ({ node }) => ({
          status: node.authored_id === "fail_first" ? "failed" : "passed",
          outcome: node.authored_id === "fail_first" ? "failed" : "passed",
          stdout: "",
          stderr: "",
          result: { node: node.authored_id }
        })
      }
    });

    expect(run.outcome).toBe("failed");
    expect(run.state.node_statuses.root__fail_first).toBe("failed");
    expect(run.state.node_statuses.root__never_runs).toBe("blocked");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("preflight-fails required prerequisites before execution begins", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-prereq-blocked-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-prereq-blocked",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
      },
      profiles: {
        default: {}
      },
      prerequisites: {
        checks: [
          {
            kind: "command",
            command: "definitely-missing-command"
          }
        ]
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "ok",
            command: "sh",
            args: ["-lc", "exit 0"]
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      }
    });

    expect(run.outcome).toBe("failed");
    expect(run.attempts).toEqual([]);
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run.preflight_failed",
          payload: expect.objectContaining({
            reason: "readiness_blocked",
            message: expect.stringContaining("definitely-missing-command")
          })
        })
      ])
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("continues when prerequisites only emit readiness warnings", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-prereq-warning-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-prereq-warning",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
      },
      profiles: {
        default: {}
      },
      prerequisites: {
        checks: [
          {
            kind: "env",
            name: "AGENTFLOW_TEST_MISSING_ENV",
            required: false
          }
        ]
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "ok",
            command: "sh",
            args: ["-lc", "exit 0"]
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      }
    });

    expect(run.outcome).toBe("passed");
    expect(run.events.some((event) => event.type === "run.preflight_failed")).toBe(false);
    expect(run.attempts).toHaveLength(1);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("does not fail a blocked agent node just because its harness is unavailable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-blocked-harness-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-blocked-harness",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "fail_first",
            repo: "main",
            command: "placeholder"
          },
          {
            type: "agent",
            id: "never_runs",
            repo: "main",
            prompt: "Should stay blocked."
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      executors: {
        exec: async () => ({
          status: "failed",
          outcome: "failed",
          stdout: "",
          stderr: "",
          result: { ok: false }
        })
      }
    });

    expect(run.outcome).toBe("failed");
    expect(run.state.node_statuses.root__fail_first).toBe("failed");
    expect(run.state.node_statuses.root__never_runs).toBe("blocked");
    expect(run.attempts.find((attempt) => attempt.authored_id === "never_runs")).toBeUndefined();

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("fails a reachable node lazily when harness readiness fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-lazy-readiness-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-lazy-readiness",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            type: "agent",
            id: "implement",
            repo: "main",
            prompt: "Implement the change."
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      },
      harnesses: {
        "codex-cli": createHarness(
          "codex-cli",
          async () => ({
            status: "passed",
            exitCode: 0
          }),
          {
            checkReadiness() {
              return ['codex-cli harness binary "missing-codex" is unavailable.'];
            }
          }
        )
      }
    });

    const attempt = run.attempts.find((candidate) => candidate.authored_id === "implement");
    expect(run.outcome).toBe("failed");
    expect(run.state.node_statuses.root__implement).toBe("failed");
    expect(attempt?.status).toBe("failed");
    expect(attempt?.context_packet_path).toBeUndefined();
    expect(JSON.parse(await readFile(attempt!.result_path!, "utf8"))).toEqual({
      error: 'codex-cli harness binary "missing-codex" is unavailable.'
    });

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("does not record nonexistent context artifacts when context resolution fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-engine-context-error-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-context-error",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default",
        workspace_backend: "inplace"
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
            id: "consume",
            repo: "main",
            command: "placeholder",
            context: [
              {
                name: "escape",
                from: "workspace_file",
                path: "../escape.txt"
              }
            ]
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: {
        main: repoDir
      }
    });

    const attempt = run.attempts.find((candidate) => candidate.authored_id === "consume");
    const executionRecord = JSON.parse(
      await readFile(join(attempt!.execution_dir, "execution.json"), "utf8")
    ) as Record<string, unknown>;

    expect(run.outcome).toBe("failed");
    expect(attempt?.context_packet_path).toBeUndefined();
    expect(attempt?.context_manifest_path).toBeUndefined();
    expect(executionRecord.context_packet_path).toBeUndefined();
    expect(executionRecord.context_manifest_path).toBeUndefined();
    expect(attempt?.metadata).toEqual(
      expect.objectContaining({
        context_status: "failed"
      })
    );

    await rm(tempRoot, { recursive: true, force: true });
  });
});
