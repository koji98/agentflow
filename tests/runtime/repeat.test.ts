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
import { runCompiledGraph } from "../../src/runtime/core/engine.js";

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

describe("runtime repeat", () => {
  it("fails the run when a repeat scope exhausts attempts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-repeat-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "repeat-failure",
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
                  type: "agent",
                  id: "implement",
                  prompt: "Attempt a fix."
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
            id: "finalize",
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
        agent: async () => ({
          status: "passed",
          outcome: "passed",
          result: {
            attempted: true
          },
          stdout: "",
          stderr: ""
        }),
        check: async () => ({
          status: "failed",
          outcome: "failed",
          result: {
            passed: false
          },
          stdout: "",
          stderr: "",
          check: {
            check_kind: "deterministic",
            passed: false,
            summary: "still failing"
          }
        }),
        exec: async () => ({
          status: "passed",
          outcome: "passed",
          result: {},
          stdout: "",
          stderr: ""
        })
      }
    });

    expect(run.outcome).toBe("failed");
    expect(run.state.status).toBe("failed");
    expect(run.state.repeat_scopes.scope__root__retry.latest_iteration_index).toBe(2);
    expect(run.state.repeat_scopes.scope__root__retry.status).toBe("failed");
    expect(run.state.node_statuses.root__finalize).toBe("blocked");
    expect(run.attempts.filter((attempt) => attempt.authored_id === "verify")).toHaveLength(2);
    expect(run.events.at(-1)?.type).toBe("run.completed");

    await rm(tempRoot, { recursive: true, force: true });
  });
});
