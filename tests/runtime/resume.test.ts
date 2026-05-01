import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { readExecutionManifest } from "../../src/artifacts/reader.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";
import type { HarnessAdapter } from "../../src/runtime/harness/types.js";
import { createResumedRuntimeSession } from "../../src/runtime/resume.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";

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
  const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults({
    intent: {
      goal: `Resume ${document.graph_id}.`,
      acceptance_criteria: ["Resume preserves only compatible completed work."]
    },
    ...document
  }));
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

async function createResumeFixture(options: {
  document: AuthoredGraphDocument;
  setupRepo?: (repoDir: string) => Promise<void>;
}): Promise<{
  tempRoot: string;
  repoDir: string;
  runRoot: string;
  graph: ReturnType<typeof compileGraph>;
  result: Awaited<ReturnType<typeof runCompiledGraph>>;
  manifest: Awaited<ReturnType<typeof readExecutionManifest>>;
}> {
  const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-runtime-resume-"));
  const repoDir = join(tempRoot, "repo");
  const runRoot = join(tempRoot, "run");
  await mkdir(repoDir, { recursive: true });
  await initGitRepo(repoDir);
  await options.setupRepo?.(repoDir);

  const graph = compileGraph(options.document);
  const result = await runCompiledGraph({
    run_root: runRoot,
    compiled_graph: graph,
    repo_sources: {
      main: repoDir
    },
    executors: {
      exec: async () => ({
        status: "passed",
        outcome: "passed",
        stdout: "",
        stderr: "",
        result: { ok: true }
      })
    },
    harnesses: {
      "codex-cli": {
        kind: "codex-cli",
        capabilities: getHarnessCapabilities("codex-cli")!,
        async run(invocation) {
          if (invocation.promptKind === "outcome_verification") {
            return {
              status: "passed",
              exitCode: 0,
              transcript: {
                last_message: [
                  "```json",
                  JSON.stringify(
                    {
                      passed: true,
                      summary: "Resume fixture verifier accepts.",
                      findings: [],
                      blockers: []
                    },
                    null,
                    2
                  ),
                  "```"
                ].join("\n")
              }
            };
          }
          return {
            status: "passed",
            exitCode: 0,
            stdout: "",
            stderr: "",
            transcript: {
              last_message: "done"
            },
            outputJson: {
              ok: true
            }
          };
        },
        async cancel() {
          return;
        }
      } satisfies HarnessAdapter
    }
  });

  expect(result.outcome).toBe("passed");
  const manifest = await readExecutionManifest(runRoot);
  return {
    tempRoot,
    repoDir,
    runRoot,
    graph,
    result,
    manifest
  };
}

async function buildResumedSession(
  fixture: Awaited<ReturnType<typeof createResumeFixture>>,
  graph = fixture.graph,
  attempts = fixture.result.attempts,
  resetSupervisorBudget = false
) {
  return createResumedRuntimeSession({
    run_root: fixture.runRoot,
    prior_graph: fixture.graph,
    graph,
    manifest: fixture.manifest,
    prior_state: fixture.result.state,
    attempts,
    events: fixture.result.events,
    reset_supervisor_budget: resetSupervisorBudget
  });
}

describe("runtime resume", () => {
  it("preserves a passed node when explicit file inputs change after the prior run", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-explicit-input",
        repos: {
          main: { path: "." }
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
              id: "consumer",
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
      },
      async setupRepo(repoDir) {
        await writeFile(join(repoDir, "watched.txt"), "v1\n");
      }
    });

    await writeFile(join(fixture.repoDir, "watched.txt"), "updated\n");
    const resumed = await buildResumedSession(fixture);

    expect(resumed.preserved_node_count).toBe(1);
    expect(resumed.restarted_node_count).toBe(0);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("preserves a passed node when glob contents or matches change after the prior run", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-glob-change",
        repos: {
          main: { path: "." }
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
              id: "consumer",
              repo: "main",
              command: "placeholder",
              context: [
                {
                  name: "docs",
                  from: "workspace_glob",
                  path: "docs/*.md"
                }
              ]
            }
          ]
        }
      },
      async setupRepo(repoDir) {
        await mkdir(join(repoDir, "docs"), { recursive: true });
        await writeFile(join(repoDir, "docs", "a.md"), "alpha\n");
      }
    });

    await writeFile(join(fixture.repoDir, "docs", "a.md"), "alpha-updated\n");
    await writeFile(join(fixture.repoDir, "docs", "b.md"), "beta\n");
    const resumed = await buildResumedSession(fixture);

    expect(resumed.preserved_node_count).toBe(1);
    expect(resumed.restarted_node_count).toBe(0);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("preserves a passed harnessed node when repo instruction files change", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-instruction-change",
        repos: {
          main: { path: "." }
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
              goal: "Write nothing."
            }
          ]
        }
      },
      async setupRepo(repoDir) {
        await mkdir(join(repoDir, ".cursor", "rules"), { recursive: true });
        await writeFile(join(repoDir, "AGENTS.md"), "v1\n");
        await writeFile(join(repoDir, ".cursor", "rules", "review.mdc"), "v1\n");
      }
    });

    await writeFile(join(fixture.repoDir, "AGENTS.md"), "updated\n");
    await writeFile(join(fixture.repoDir, ".cursor", "rules", "review.mdc"), "updated\n");
    const resumed = await buildResumedSession(fixture);

    expect(resumed.preserved_node_count).toBe(1);
    expect(resumed.restarted_node_count).toBe(0);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("preserves passed nodes even when prior attempts are missing context provenance artifacts", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-missing-provenance",
        repos: {
          main: { path: "." }
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
              id: "consumer",
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
      },
      async setupRepo(repoDir) {
        await writeFile(join(repoDir, "watched.txt"), "stable\n");
      }
    });

    const attemptsWithoutProvenance = fixture.result.attempts.map((attempt) => ({
      ...attempt,
      context_provenance_path: undefined
    }));
    const resumed = await buildResumedSession(fixture, fixture.graph, attemptsWithoutProvenance);

    expect(resumed.preserved_node_count).toBe(1);
    expect(resumed.restarted_node_count).toBe(0);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("can reset supervisor budget while preserving compatible passed work", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-reset-supervisor-budget",
        repos: {
          main: { path: "." }
        },
        defaults: {
          launch_profile: "default",
          workspace_backend: "inplace"
        },
        profiles: {
          default: {}
        },
        supervision: { max_total_interventions: 5 },
        graph: {
          type: "sequence",
          id: "root",
          steps: [
            {
              type: "exec",
              id: "done",
              repo: "main",
              command: "placeholder"
            }
          ]
        }
      }
    });

    fixture.result.state.supervisor.status = "exhausted";
    fixture.result.state.supervisor.budget_remaining = {
      max_total_interventions: 0
    };

    const resumed = await buildResumedSession(
      fixture,
      fixture.graph,
      fixture.result.attempts,
      true
    );

    expect(resumed.preserved_node_count).toBe(1);
    expect(resumed.restarted_node_count).toBe(0);
    expect(resumed.session.supervisor.status).toBe("healthy");
    expect(resumed.session.supervisor.budget_remaining.max_total_interventions).toBe(5);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("restarts passed nodes when the compiled node contract changes", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-compiled-change",
        repos: {
          main: { path: "." }
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
              id: "consumer",
              repo: "main",
              command: "placeholder"
            }
          ]
        }
      }
    });

    const changedGraph = compileGraph({
      version: "1",
      graph_id: "resume-compiled-change",
      repos: {
        main: { path: "." }
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
            id: "consumer",
            repo: "main",
            command: "placeholder",
            args: ["--changed"]
          }
        ]
      }
    });

    const resumed = await buildResumedSession(fixture, changedGraph);

    expect(resumed.preserved_node_count).toBe(0);
    expect(resumed.restarted_node_count).toBe(1);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("restarts passed nodes when the graph intent contract changes", async () => {
    const baseDocument: AuthoredGraphDocument = {
      version: "1",
      graph_id: "resume-intent-change",
      intent: {
        goal: "Ship the original goal.",
        acceptance_criteria: ["Original acceptance criteria."]
      },
      repos: {
        main: { path: "." }
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
            id: "consumer",
            repo: "main",
            command: "placeholder"
          }
        ]
      }
    };
    const fixture = await createResumeFixture({ document: baseDocument });
    const changedGraph = compileGraph({
      ...baseDocument,
      intent: {
        goal: "Ship the changed goal.",
        acceptance_criteria: ["Changed acceptance criteria."]
      }
    });

    const resumed = await buildResumedSession(fixture, changedGraph);

    expect(resumed.preserved_node_count).toBe(0);
    expect(resumed.restarted_node_count).toBe(1);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });
});
