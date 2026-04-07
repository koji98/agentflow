import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { readExecutionManifest } from "../../src/artifacts/reader.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";
import type { HarnessAdapter } from "../../src/runtime/harness/types.js";
import { createResumedRuntimeSession } from "../../src/runtime/resume.js";

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
        async run() {
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
  attempts = fixture.result.attempts
) {
  return createResumedRuntimeSession({
    run_root: fixture.runRoot,
    prior_graph: fixture.graph,
    graph: fixture.graph,
    manifest: fixture.manifest,
    prior_state: fixture.result.state,
    attempts,
    events: fixture.result.events
  });
}

describe("runtime resume", () => {
  it("invalidates a passed node when an explicit file input changes", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-explicit-input",
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
              id: "consumer",
              repo: "main",
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
      },
      async setupRepo(repoDir) {
        await writeFile(join(repoDir, "watched.txt"), "v1\n");
      }
    });

    await writeFile(join(fixture.repoDir, "watched.txt"), "v2\n");

    const resumed = await buildResumedSession(fixture);

    expect(resumed.preserved_node_count).toBe(0);
    expect(resumed.restarted_node_count).toBe(1);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("does not invalidate a passed node for unrelated repo changes", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-unrelated-change",
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
              id: "consumer",
              repo: "main",
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
      },
      async setupRepo(repoDir) {
        await writeFile(join(repoDir, "watched.txt"), "stable\n");
      }
    });

    await writeFile(join(fixture.repoDir, "other.txt"), "new file\n");

    const resumed = await buildResumedSession(fixture);

    expect(resumed.preserved_node_count).toBe(1);
    expect(resumed.restarted_node_count).toBe(0);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("invalidates a passed node when a glob-matched file changes", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-glob-file-change",
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
              id: "consumer",
              repo: "main",
              command: "placeholder",
              inputs: [
                {
                  kind: "glob",
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

    const resumed = await buildResumedSession(fixture);

    expect(resumed.preserved_node_count).toBe(0);
    expect(resumed.restarted_node_count).toBe(1);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("invalidates a passed node when a glob match set changes", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-glob-set-change",
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
              id: "consumer",
              repo: "main",
              command: "placeholder",
              inputs: [
                {
                  kind: "glob",
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

    await writeFile(join(fixture.repoDir, "docs", "b.md"), "beta\n");

    const resumed = await buildResumedSession(fixture);

    expect(resumed.preserved_node_count).toBe(0);
    expect(resumed.restarted_node_count).toBe(1);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("invalidates a harnessed node when AGENTS.md changes", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-agents-change",
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
              prompt: "Write nothing."
            }
          ]
        }
      },
      async setupRepo(repoDir) {
        await writeFile(join(repoDir, "AGENTS.md"), "v1\n");
      }
    });

    await writeFile(join(fixture.repoDir, "AGENTS.md"), "v2\n");

    const resumed = await buildResumedSession(fixture);

    expect(resumed.preserved_node_count).toBe(0);
    expect(resumed.restarted_node_count).toBe(1);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("invalidates a harnessed node when .cursor/rules files change", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-cursor-rules-change",
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
              prompt: "Write nothing."
            }
          ]
        }
      },
      async setupRepo(repoDir) {
        await mkdir(join(repoDir, ".cursor", "rules"), { recursive: true });
        await writeFile(join(repoDir, ".cursor", "rules", "review.mdc"), "v1\n");
      }
    });

    await writeFile(join(fixture.repoDir, ".cursor", "rules", "review.mdc"), "v2\n");

    const resumed = await buildResumedSession(fixture);

    expect(resumed.preserved_node_count).toBe(0);
    expect(resumed.restarted_node_count).toBe(1);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it("restarts passed nodes from older runs that do not have context provenance", async () => {
    const fixture = await createResumeFixture({
      document: {
        version: "1",
        graph_id: "resume-missing-provenance",
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
              id: "consumer",
              repo: "main",
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
      },
      async setupRepo(repoDir) {
        await writeFile(join(repoDir, "watched.txt"), "stable\n");
      }
    });

    const attemptsWithoutProvenance = fixture.result.attempts.map((attempt) => ({
      ...attempt,
      context_provenance_path: undefined
    }));

    const resumed = await buildResumedSession(fixture, attemptsWithoutProvenance);

    expect(resumed.preserved_node_count).toBe(0);
    expect(resumed.restarted_node_count).toBe(1);

    await rm(fixture.tempRoot, { recursive: true, force: true });
  });
});
