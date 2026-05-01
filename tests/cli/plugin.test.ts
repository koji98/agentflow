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
            intent: {
              goal: "Inspect the repo and use {{config.message}}.",
              acceptance_criteria: [
              "The notes artifact references the fixture config message.",
              "The notes artifact preserves enough context for the publish step."
            ],
              constraints: []
            },
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
            intent: {
              goal: "Publish the public packet.",
              acceptance_criteria: [
              "The packet artifact is written to the workflow's public artifact path.",
              "The packet reflects the inspected notes."
            ],
              constraints: []
            },
            context: [
              {
                ref: "inspect.notes",
                name: "notes"
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

async function createRootResourcePlugin(root: string): Promise<string> {
  const pluginDir = join(root, "root-resource-plugin");
  await mkdir(join(pluginDir, "workflows", "rooted", "context"), { recursive: true });
  await mkdir(join(pluginDir, "shared"), { recursive: true });
  await mkdir(join(pluginDir, "tools"), { recursive: true });

  await writeFile(
    join(pluginDir, "agentflow.plugin.json"),
    JSON.stringify(
      {
        schema: "agentflow.plugin/1",
        id: "rooted",
        version: "0.1.0",
        workflows: {
          preflight: {
            path: "./workflows/rooted/workflow.json",
            description: "Fixture workflow that references workflow-local and plugin-root files."
          }
        }
      },
      null,
      2
    )
  );
  await writeFile(
    join(pluginDir, "workflows", "rooted", "workflow.json"),
    JSON.stringify(
      {
        schema: "agentflow.workflow/1",
        id: "preflight",
        config_schema: "./config.schema.json",
        graph: "./workflow.graph.json",
        publish_node: "publish",
        published_artifacts: {
          packet: {
            from: "output_dir",
            path: "packet.json",
            description: "Root resource packet."
          }
        }
      },
      null,
      2
    )
  );
  await writeFile(
    join(pluginDir, "workflows", "rooted", "config.schema.json"),
    JSON.stringify(
      {
        type: "object",
        properties: {
          message: { type: "string" }
        },
        additionalProperties: false
      },
      null,
      2
    )
  );
  await writeFile(join(pluginDir, "workflows", "rooted", "context", "workflow.md"), "Workflow-local guidance.\n");
  await writeFile(join(pluginDir, "shared", "root.md"), "Plugin-root guidance.\n");
  await writeFile(join(pluginDir, "tools", "root-check.sh"), "#!/usr/bin/env bash\necho rooted\n");
  await writeFile(
    join(pluginDir, "workflows", "rooted", "workflow.graph.json"),
    JSON.stringify(
      {
        type: "sequence",
        id: "workflow",
        steps: [
          {
            type: "exec",
            id: "publish",
            intent: {
              goal: "Run the rooted plugin tool and publish root resource evidence.",
              acceptance_criteria: [
              "The plugin-root executable exits successfully.",
              "Workflow-local and plugin-root context resources are available to the node."
            ],
              constraints: []
            },
            command: "plugin://tools/root-check.sh",
            args: ["{{config.message}}"],
            context: [
              {
                name: "workflow_guidance",
                from: "plugin_file",
                path: "./context/workflow.md"
              },
              {
                name: "root_guidance",
                from: "plugin_file",
                path: "plugin://shared/root.md"
              }
            ]
          }
        ]
      },
      null,
      2
    )
  );

  return pluginDir;
}

describe("plugin workflows", () => {
  it("rejects plugin tools that reference unknown credential scopes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-plugin-credentials-"));
    const pluginDir = join(tempRoot, "broken-plugin");
    await mkdir(join(pluginDir, "scripts"), { recursive: true });
    await writeFile(
      join(pluginDir, "agentflow.plugin.json"),
      JSON.stringify(
        {
          schema: "agentflow.plugin/1",
          id: "broken",
          version: "0.1.0",
          workflows: {},
          credentials: {},
          tools: {
            poll: {
              executable: "./scripts/poll.sh",
              description: "Poll a fixture service.",
              credentials: ["missing"]
            }
          }
        },
        null,
        2
      )
    );
    await writeFile(join(pluginDir, "scripts", "poll.sh"), "#!/usr/bin/env bash\necho poll\n");

    const graphPath = join(tempRoot, "graph.json");
    await writeFile(
      graphPath,
      JSON.stringify(
        {
          version: "1",
          graph_id: "plugin-credential-validation",
          plugins: {
            broken: {
              path: "./broken-plugin"
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
    expect(JSON.parse(resolved.stdout).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.plugins.broken.tools.poll.credentials[0]",
          message: expect.stringContaining('unknown credential scope "missing"')
        })
      ])
    );
  });

  it("resolves a local plugin folder without requiring git source metadata", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-plugin-local-"));
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
          graph_id: "local-plugin-workflow-consumer",
          intent: {
            goal: "Resolve a local plugin workflow and consume its public artifact.",
            acceptance_criteria: ["The local plugin folder resolves and compiles."]
          },
          plugins: {
            mathboard: {
              path: "./mathboard-plugin"
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
            },
            supervisor: {
              harness: "codex-cli",
              sandbox: "read-only"
            }
          },
          supervision: {
            profile: "supervisor",
            max_total_interventions: 3
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "plugin",
                id: "handoff",
                uses: "mathboard/simple-handoff",
                config: {
                  message: "the fixture config"
                }
              },
              {
                type: "agent",
                id: "consume",
                repo: "main",
                intent: {
                  goal: "Consume the plugin packet.",
                  acceptance_criteria: [
                  "The node reads the plugin packet artifact.",
                  "The node can produce a reviewable response from the packet context."
                ],
                  constraints: []
                },
                context: [
                  {
                    ref: "handoff.packet",
                    name: "packet"
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

    const resolved = await executeCli(["plugin", "resolve", "--graph", graphPath], tempRoot);
    expect(resolved.exitCode, resolved.stdout).toBe(0);
    const resolvedPayload = JSON.parse(resolved.stdout);
    expect(resolvedPayload.resolved_plugins).toEqual([
      expect.objectContaining({
        alias: "mathboard",
        kind: "local",
        path: "./mathboard-plugin",
        commit: "local"
      })
    ]);

    const lock = JSON.parse(await readFile(join(tempRoot, "agentflow.plugins.lock.json"), "utf8"));
    expect(lock.plugins.mathboard).toEqual(
      expect.objectContaining({
        kind: "local",
        path: "./mathboard-plugin",
        commit: "local"
      })
    );

    const compiled = await executeCli(
      ["validate", "--graph", graphPath, "--show-compiled"],
      tempRoot
    );
    expect(compiled.exitCode, compiled.stdout).toBe(0);
    const payload = JSON.parse(compiled.stdout);
    expect(payload.lowered_managed_nodes[0]).toEqual(
      expect.objectContaining({
        authored_id: "handoff",
        managed_kind: "plugin:mathboard/simple-handoff"
      })
    );

    await writeFile(join(pluginDir, "workflows", "simple", "context", "guidance.md"), "Changed guidance.\n");
    const stale = await executeCli(["validate", "--graph", graphPath], tempRoot);
    expect(stale.exitCode).toBe(1);
    expect(JSON.parse(stale.stdout).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("digest changed")
        })
      ])
    );
  });

  it("resolves plugin:// from the plugin root and plain workflow paths from the workflow directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-plugin-root-resource-"));
    const pluginDir = await createRootResourcePlugin(tempRoot);
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
          graph_id: "plugin-root-resource-consumer",
          intent: {
            goal: "Resolve plugin package resources without workflow-local wrappers.",
            acceptance_criteria: ["plugin:// paths resolve from the plugin root."]
          },
          plugins: {
            rooted: {
              path: "./root-resource-plugin"
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
            },
            supervisor: {
              harness: "codex-cli",
              sandbox: "read-only"
            }
          },
          supervision: {
            profile: "supervisor",
            max_total_interventions: 3
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "plugin",
                id: "preflight",
                uses: "rooted/preflight",
                config: {
                  message: "rooted config"
                }
              }
            ]
          }
        },
        null,
        2
      )
    );

    const resolved = await executeCli(["plugin", "resolve", "--graph", graphPath], tempRoot);
    expect(resolved.exitCode, resolved.stdout).toBe(0);

    const compiled = await executeCli(["validate", "--graph", graphPath, "--show-compiled"], tempRoot);
    expect(compiled.exitCode, compiled.stdout).toBe(0);
    const payload = JSON.parse(compiled.stdout);
    expect(payload.compiled_graph.nodes[0]).toEqual(
      expect.objectContaining({
        authored_id: "preflight",
        command: join(pluginDir, "tools", "root-check.sh"),
        args: ["rooted config"]
      })
    );
    expect(payload.compiled_graph.nodes[0].context).toEqual([
      expect.objectContaining({
        name: "plugin_config",
        from: "text",
        text: expect.stringContaining("rooted config")
      }),
      expect.objectContaining({
        name: "workflow_guidance",
        from: "text",
        text: "Workflow-local guidance.\n"
      }),
      expect.objectContaining({
        name: "root_guidance",
        from: "text",
        text: "Plugin-root guidance.\n"
      })
    ]);
    expect(payload.lowered_managed_nodes[0].plugin.resources).toEqual(
      expect.objectContaining({
        "./context/workflow.md": expect.stringMatching(/^sha256:/),
        "plugin://shared/root.md": expect.stringMatching(/^sha256:/)
      })
    );
  });

  it("does not treat the generated lockfile as a local plugin content change", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-plugin-local-root-"));
    const pluginDir = await createFixturePlugin(tempRoot);
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    await writeFile(join(repoDir, "README.md"), "repo\n");
    await commitAll(repoDir, "fixture repo");

    const graphPath = join(pluginDir, "graph.json");
    await writeFile(
      graphPath,
      JSON.stringify(
        {
          version: "1",
          graph_id: "local-plugin-root-consumer",
          intent: {
            goal: "Resolve a local plugin that is also the graph directory.",
            acceptance_criteria: ["The generated lockfile does not invalidate the plugin digest."]
          },
          plugins: {
            mathboard: {
              path: "."
            }
          },
          repos: {
            main: {
              path: "../repo"
            }
          },
          defaults: {
            launch_profile: "default",
            workspace_backend: "inplace"
          },
          profiles: {
            default: {
              harness: "codex-cli"
            },
            supervisor: {
              harness: "codex-cli",
              sandbox: "read-only"
            }
          },
          supervision: {
            profile: "supervisor",
            max_total_interventions: 3
          },
          graph: {
            type: "sequence",
            id: "root",
            steps: [
              {
                type: "plugin",
                id: "handoff",
                uses: "mathboard/simple-handoff",
                config: {
                  message: "the fixture config"
                }
              }
            ]
          }
        },
        null,
        2
      )
    );

    const resolved = await executeCli(["plugin", "resolve", "--graph", graphPath], pluginDir);
    expect(resolved.exitCode, resolved.stdout).toBe(0);
    expect(await readFile(join(pluginDir, "agentflow.plugins.lock.json"), "utf8")).toContain('"mathboard"');

    const validated = await executeCli(["validate", "--graph", graphPath], pluginDir);
    expect(validated.exitCode, validated.stdout).toBe(0);
  });

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
          intent: {
            goal: "Resolve a plugin workflow and consume its public artifact.",
            acceptance_criteria: ["The plugin workflow compiles and the public artifact feeds a downstream node."]
          },
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
            },
            supervisor: {
              harness: "codex-cli",
              sandbox: "read-only"
            }
          },
          supervision: {
            profile: "supervisor",
            max_total_interventions: 3
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
                intent: {
                  goal: "Consume the plugin packet.",
                  acceptance_criteria: [
                  "The node reads the plugin packet artifact.",
                  "The node can produce a reviewable response from the packet context."
                ],
                  constraints: []
                },
                context: [
                  {
                    ref: "handoff.packet",
                    name: "packet"
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

    const compiled = await executeCli(
      ["validate", "--graph", graphPath, "--show-compiled"],
      tempRoot
    );
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
