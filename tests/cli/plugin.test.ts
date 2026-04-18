import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { executeCli } from "../../src/cli/index.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
}

async function commitAll(repoDir: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", message], { cwd: repoDir });
}

async function createFixturePlugin(root: string): Promise<string> {
  const pluginDir = join(root, "mathboard-plugin");
  await mkdir(join(pluginDir, "workflows", "simple", "context"), { recursive: true });

  await writeFile(
    join(pluginDir, "agentflow.plugin.json"),
    JSON.stringify(
      {
        schema: "agentflow.plugin/1",
        id: "mathboard",
        version: "0.1.0",
        workflows: {
          "simple-handoff": {
            path: "./workflows/simple/workflow.json",
            description: "Fixture workflow that publishes a public packet."
          }
        }
      },
      null,
      2
    )
  );
  await writeFile(
    join(pluginDir, "workflows", "simple", "workflow.json"),
    JSON.stringify(
      {
        schema: "agentflow.workflow/1",
        id: "simple-handoff",
        config_schema: "./config.schema.json",
        graph: "./workflow.graph.json",
        publish_node: "publish",
        published_artifacts: {
          packet: {
            from: "output_dir",
            path: "packet.json",
            description: "Machine-readable public packet from the plugin workflow."
          }
        }
      },
      null,
      2
    )
  );
  await writeFile(
    join(pluginDir, "workflows", "simple", "config.schema.json"),
    JSON.stringify(
      {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" }
        },
        additionalProperties: false
      },
      null,
      2
    )
  );
  await writeFile(join(pluginDir, "workflows", "simple", "context", "guidance.md"), "Plugin guidance.\n");
  await writeFile(
    join(pluginDir, "workflows", "simple", "workflow.graph.json"),
    JSON.stringify(
      {
        type: "sequence",
        id: "workflow",
        steps: [
          {
            type: "agent",
            id: "inspect",
            repo: "main",
            prompt: "Inspect the repo and use {{config.message}}.",
            context: [
              {
                name: "guidance",
                from: "plugin_file",
                path: "./context/guidance.md"
              }
            ],
            artifacts: {
              notes: {
                from: "output_dir",
                path: "notes.md",
                description: "Internal notes for the publish step."
              }
            }
          },
          {
            type: "agent",
            id: "publish",
            repo: "main",
            prompt: "Publish the public packet.",
            context: [
              {
                name: "notes",
                from: "artifact",
                node: "inspect",
                artifact: "notes"
              }
            ]
          }
        ]
      },
      null,
      2
    )
  );

  await initGitRepo(pluginDir);
  await commitAll(pluginDir, "fixture plugin");
  return pluginDir;
}

describe("plugin workflows", () => {
  it("resolves a git plugin and compiles a workflow whose public artifact feeds a regular node", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-plugin-workflow-"));
    const pluginDir = await createFixturePlugin(tempRoot);
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(join(repoDir, "README.md"), "repo\n");
    await commitAll(repoDir, "fixture repo");

    const graphPath = join(tempRoot, "graph.json");
    await writeFile(
      graphPath,
      JSON.stringify(
        {
          version: "1",
          graph_id: "plugin-workflow-consumer",
          plugins: {
            mathboard: {
              source: pluginDir,
              ref: "HEAD"
            }
          },
          repos: {
            main: {
              path: "./repo"
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
                type: "plugin",
                id: "handoff",
                label: "Plugin Handoff",
                uses: "mathboard/simple-handoff",
                config: {
                  message: "the fixture config"
                }
              },
              {
                type: "agent",
                id: "consume",
                repo: "main",
                prompt: "Consume the plugin packet.",
                context: [
                  {
                    name: "packet",
                    from: "artifact",
                    node: "handoff",
                    artifact: "packet"
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      )
    );

    const unresolved = await executeCli(["validate", "--graph", graphPath], tempRoot);
    expect(unresolved.exitCode).toBe(1);
    expect(JSON.parse(unresolved.stdout).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("agentflow plugin resolve --graph")
        })
      ])
    );

    const resolved = await executeCli(["plugin", "resolve", "--graph", graphPath], tempRoot);
    expect(resolved.exitCode, resolved.stdout).toBe(0);
    const resolvedPayload = JSON.parse(resolved.stdout);
    expect(resolvedPayload.resolved_plugins).toEqual([
      expect.objectContaining({
        alias: "mathboard",
        source: pluginDir,
        ref: "HEAD",
        commit: expect.any(String)
      })
    ]);

    const lock = JSON.parse(await readFile(join(tempRoot, "agentflow.plugins.lock.json"), "utf8"));
    expect(lock.plugins.mathboard.commit).toEqual(expect.any(String));

    const compiled = await executeCli(["compile", "--graph", graphPath], tempRoot);
    const payload = JSON.parse(compiled.stdout);
    expect(compiled.exitCode, compiled.stdout).toBe(0);
    expect(payload.lowered_managed_nodes).toEqual([
      expect.objectContaining({
        authored_id: "handoff",
        managed_kind: "plugin:mathboard/simple-handoff",
        plugin: expect.objectContaining({
          alias: "mathboard",
          workflow: "simple-handoff"
        })
      })
    ]);
    expect(payload.compiled_graph.nodes.map((node: { authored_id: string }) => node.authored_id)).toEqual([
      "handoff__managed__plugin__mathboard__simple-handoff__inspect",
      "handoff",
      "consume"
    ]);
    expect(payload.compiled_graph.nodes[1].label).toBe("Plugin Handoff");
    expect(payload.compiled_graph.nodes[0].context).toEqual([
      expect.objectContaining({
        name: "plugin_config",
        from: "text",
        text: expect.stringContaining("the fixture config")
      }),
      expect.objectContaining({
        name: "guidance",
        from: "text",
        text: "Plugin guidance.\n"
      })
    ]);
    expect(payload.compiled_graph.nodes[1].declared_artifacts).toEqual({
      packet: {
        from: "output_dir",
        path: "packet.json",
        description: "Machine-readable public packet from the plugin workflow."
      }
    });
    expect(payload.managed_expansion[0]).toEqual(
      expect.objectContaining({
        authored_id: "handoff",
        managed_kind: "plugin:mathboard/simple-handoff",
        published_artifacts: {
          packet: {
            from: "output_dir",
            path: "packet.json",
            description: "Machine-readable public packet from the plugin workflow."
          }
        }
      })
    );
  });

  it("rejects unsafe plugin aliases before writing a lockfile", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-plugin-alias-"));
    const graphPath = join(tempRoot, "graph.json");
    await writeFile(
      graphPath,
      JSON.stringify(
        {
          version: "1",
          graph_id: "plugin-alias-validation",
          plugins: {
            "../mathboard": {
              source: ".",
              ref: "HEAD"
            }
          },
          repos: {
            main: {
              path: "."
            }
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: []
          }
        },
        null,
        2
      )
    );

    const resolved = await executeCli(["plugin", "resolve", "--graph", graphPath], tempRoot);
    expect(resolved.exitCode).toBe(1);
    expect(JSON.parse(resolved.stdout).diagnostics).toEqual([
      expect.objectContaining({
        path: "$.plugins.../mathboard",
        message: expect.stringContaining("Plugin aliases must use")
      })
    ]);
    await expect(readFile(join(tempRoot, "agentflow.plugins.lock.json"), "utf8")).rejects.toThrow();
  });
});
