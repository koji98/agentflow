import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import type { CompiledAgentNode, ResolvedTool } from "../../src/graph/compiled.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { validateAuthoredGraphDocument } from "../../src/graph/validate.js";
import type { ResolvedPlugin } from "../../src/plugins/workflows.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";
import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import {
  buildHarnessSpawnEnv,
  formatToolContract,
  renderHarnessPrompt
} from "../../src/runtime/harness/types.js";
import type { AgentInvocation, HarnessAdapter } from "../../src/runtime/harness/types.js";
import { prepareAgentTools } from "../../src/runtime/tools/setup.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "seed\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
}

function findAgentNode(
  compiledNodes: { authored_id: string }[],
  authoredId: string
): CompiledAgentNode {
  const node = compiledNodes.find((candidate) => candidate.authored_id === authoredId);
  if (!node) {
    throw new Error(`compiled agent node "${authoredId}" not found`);
  }
  return node as unknown as CompiledAgentNode;
}

function buildPluginFixture(
  pluginRoot: string,
  pluginToolPath: string,
  toolOverrides: Partial<ResolvedPlugin["manifest"]["tools"][string]> = {},
  manifestOverrides: Partial<ResolvedPlugin["manifest"]> = {}
): ResolvedPlugin {
  return {
    alias: "babysit",
    kind: "git",
    source: ".",
    ref: "HEAD",
    commit: "deadbeef",
    manifest_digest: "digest",
    root: pluginRoot,
    manifest: {
      schema: "agentflow.plugin/1",
      id: "babysit",
      version: "1.0.0",
      workflows: {},
      ...manifestOverrides,
      tools: {
        poll: {
          executable: pluginToolPath,
          capability: toolOverrides.capability ?? "verification",
          impact: toolOverrides.impact ?? "read",
          description: "Poll a PR.",
          usage: "babysit-poll [--once]",
          args: ["--once"],
          config_schema: toolOverrides.config_schema ?? {},
          ...(toolOverrides.credentials ? { credentials: toolOverrides.credentials } : {})
        }
      }
    }
  };
}

describe("plugin tool compilation", () => {
  let tempRoot: string;
  let pluginRoot: string;
  let pluginToolPath: string;
  let pluginAbsoluteToolPath: string;
  let resolvedPlugins: ResolvedPlugin[];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentflow-tools-compile-"));
    pluginRoot = join(tempRoot, "plugins/babysit");
    pluginToolPath = "scripts/poll.sh";
    pluginAbsoluteToolPath = join(pluginRoot, pluginToolPath);
    await writeExecutable(pluginAbsoluteToolPath, "#!/usr/bin/env bash\necho poll\n");
    resolvedPlugins = [buildPluginFixture(pluginRoot, pluginToolPath)];
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  function compileWith(document: AuthoredGraphDocument) {
    const normalized = normalizeAuthoredGraphDocument({
      intent: {
        goal: `Compile tools for ${document.graph_id}.`,
        acceptance_criteria: ["Plugin tools obey their capability policy."]
      },
      ...document
    });
    expect(normalized.diagnostics).toEqual([]);
    const launch = resolveLaunchConfig(normalized.document!);
    return compileAuthoredGraph(
      normalized.document!,
      launch,
      normalized.lowered_managed_nodes,
      { graph_dir: tempRoot, resolved_plugins: resolvedPlugins }
    );
  }

  it("attaches no tools when an agent declares none and the graph has no tool references", () => {
    const compilation = compileWith({
      version: "1",
      graph_id: "tools-no-tools",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "draft",
            goal: "Draft something."
          }
        ]
      }
    });

    expect(compilation.diagnostics).toEqual([]);
    const draft = findAgentNode(compilation.compiled_graph!.nodes, "draft");
    expect(draft.tools).toEqual([]);
  });

  it("namespaces plugin tools and exposes them on agent nodes via plugin_root", () => {
    const document: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-plugin-graph-scope",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      tools: [
        {
          from_plugin: "babysit",
          tool: "poll"
        }
      ],
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "watch",
            goal: "Watch the PR."
          }
        ]
      }
    };

    const compilation = compileWith(document);
    expect(compilation.diagnostics).toEqual([]);

    const watch = findAgentNode(compilation.compiled_graph!.nodes, "watch");
    const pollTool = watch.tools.find(
      (tool: ResolvedTool) => tool.source.kind === "plugin"
    );

    expect(pollTool?.callable_name).toBe("babysit-poll");
    expect(pollTool?.executable_path).toBe(pluginAbsoluteToolPath);
    expect(pollTool?.args).toEqual(["--once"]);
    if (pollTool?.source.kind !== "plugin") {
      throw new Error("expected plugin source");
    }
    expect(pollTool.source.alias).toBe("babysit");
    expect(pollTool.source.tool).toBe("poll");
    expect(pollTool.source.plugin_root).toBe(pluginRoot);
    expect(pollTool.source.declared_at).toBe("graph");
  });

  it("supports inline graph and agent-scoped plugin tool configuration", () => {
    const document: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-plugin-agent-scope",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      tools: [
        {
          from_plugin: "babysit",
          tool: "poll",
          config: { mode: "graph" }
        }
      ],
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "draft",
            goal: "Draft."
          },
          {
            type: "agent",
            id: "refine",
            goal: "Refine.",
            tools: [
              {
                from_plugin: "babysit",
                tool: "poll",
                alias: "babysit-poll-refine",
                config: { mode: "agent", verbosity: "high" }
              }
            ]
          }
        ]
      }
    };

    const compilation = compileWith(document);
    expect(compilation.diagnostics).toEqual([]);

    const draft = findAgentNode(compilation.compiled_graph!.nodes, "draft");
    const refine = findAgentNode(compilation.compiled_graph!.nodes, "refine");

    const draftPoll = draft.tools.find((tool) => tool.callable_name === "babysit-poll");
    const refinePoll = refine.tools.find((tool) => tool.callable_name === "babysit-poll-refine");

    expect(draftPoll?.config).toEqual({ mode: "graph" });
    expect(refinePoll?.config).toEqual({ mode: "agent", verbosity: "high" });
  });

  it("validates inline plugin tool config schemas and rejects secret-looking config keys", async () => {
    resolvedPlugins = [buildPluginFixture(pluginRoot, pluginToolPath, {
      config_schema: {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: {
          mode: { type: "string" }
        }
      }
    })];
    const baseDocument: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-config-schema-policy",
      intent: {
        goal: "Validate plugin tool configuration policy."
      },
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      tools: [{ from_plugin: "babysit", tool: "poll" }],
      graph: {
        type: "sequence",
        id: "root",
        steps: [{ type: "agent", id: "use_tool", goal: "Use tool." }]
      }
    };

    await expect(validateAuthoredGraphDocument({
      ...baseDocument,
      tools: [{ from_plugin: "babysit", tool: "poll", config: { token: "ghp_should_not_be_here" } }]
    }, { resolved_plugins: resolvedPlugins })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "$.tools[0].config.token",
        message: expect.stringContaining("looks secret-bearing")
      }),
      expect.objectContaining({
        path: "$.tools[0].config.mode",
        message: expect.stringContaining("missing required")
      }),
      expect.objectContaining({
        path: "$.tools[0].config.token",
        message: expect.stringContaining("does not allow")
      })
    ]));

    const diagnostics = await validateAuthoredGraphDocument({
      ...baseDocument,
      tools: [{ from_plugin: "babysit", tool: "poll", config: { mode: "watch" } }]
    }, { resolved_plugins: resolvedPlugins });
    expect(diagnostics).toEqual([]);
  });

  it("compiles plugin credential requirements into an explicit graph credential contract", () => {
    resolvedPlugins = [
      buildPluginFixture(
        pluginRoot,
        pluginToolPath,
        { impact: "secret", credentials: ["github"] },
        {
          credentials: {
            github: {
              description: "GitHub API access for PR status.",
              fields: {
                token: {
                  secret: true,
                  required: true,
                  description: "GitHub token with read access."
                },
                host: {
                  secret: false,
                  required: false,
                  default: "api.github.com"
                }
              }
            }
          }
        }
      )
    ];

    const document: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-credentials-contract",
      repos: { main: { path: "." } },
      intent: {
        goal: "Use a secret-backed PR polling tool.",
        acceptance_criteria: ["The credential contract is compiled without exposing values."]
      },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      tools: [{ from_plugin: "babysit", tool: "poll" }],
      graph: {
        type: "sequence",
        id: "root",
        steps: [{ type: "agent", id: "watch", goal: "Watch the PR." }]
      }
    };

    const compilation = compileWith(document);
    expect(compilation.diagnostics).toEqual([]);

    const watch = findAgentNode(compilation.compiled_graph!.nodes, "watch");
    expect(watch.tools[0]?.credentials).toEqual(["github"]);
    expect(compilation.compiled_graph!.credential_specs).toEqual({
      github: {
        description: "GitHub API access for PR status.",
        fields: {
          token: {
            secret: true,
            required: true,
            description: "GitHub token with read access."
          },
          host: {
            secret: false,
            required: false,
            default: "api.github.com"
          }
        }
      }
    });
  });

  it("does not expose mutation tools to read-only agents", async () => {
    resolvedPlugins = [buildPluginFixture(pluginRoot, pluginToolPath, {
      capability: "mutation",
      impact: "write"
    })];
    const document: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-read-only-policy",
      repos: { main: { path: "." } },
      intent: {
        goal: "Inspect without mutating.",
        acceptance_criteria: ["No write-capable tool is exposed."]
      },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli", sandbox: "read-only" } },
      tools: [{ from_plugin: "babysit", tool: "poll" }],
      graph: {
        type: "sequence",
        id: "root",
        steps: [{ type: "agent", id: "inspect", goal: "Inspect only." }]
      }
    };

    await expect(validateAuthoredGraphDocument(document, { resolved_plugins: resolvedPlugins }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "$.tools[0]",
          message: expect.stringContaining("cannot be exposed to a read-only agent")
        })
      ]));

    const compilation = compileWith(document);
    const inspect = findAgentNode(compilation.compiled_graph!.nodes, "inspect");
    expect(inspect.tools.map((tool) => tool.callable_name)).toEqual(["babysit-poll"]);
  });

  it("treats declaring external-impact tools as approval to expose them", async () => {
    resolvedPlugins = [buildPluginFixture(pluginRoot, pluginToolPath, {
      capability: "reporting",
      impact: "external"
    })];
    const document: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-external-policy",
      repos: { main: { path: "." } },
      intent: {
        goal: "Report externally."
      },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      tools: [{ from_plugin: "babysit", tool: "poll" }],
      graph: {
        type: "sequence",
        id: "root",
        steps: [{ type: "agent", id: "report", goal: "Report." }]
      }
    };

    await expect(validateAuthoredGraphDocument(document, { resolved_plugins: resolvedPlugins }))
      .resolves.toEqual([]);
  });

  it("still validates policy around external-impact tools without approval-boundary fields", async () => {
    resolvedPlugins = [buildPluginFixture(pluginRoot, pluginToolPath, {
      capability: "reporting",
      impact: "external"
    })];
    const baseDocument: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-external-exact-policy",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli", sandbox: "workspace-write" } },
      tools: [{ from_plugin: "babysit", tool: "poll" }],
      graph: {
        type: "sequence",
        id: "root",
        steps: [{ type: "agent", id: "report", goal: "Report." }]
      }
    };

    const diagnostics = await validateAuthoredGraphDocument({
      ...baseDocument,
      intent: {
        goal: "Report externally.",
        constraints: ["Use the declared reporting tool only for this node."]
      }
    }, { resolved_plugins: resolvedPlugins });
    expect(diagnostics).toEqual([]);
  });

  it("rejects plugin tools that try to use the reserved af command name", async () => {
    const document: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-af-reserved-name",
      repos: { main: { path: "." } },
      intent: {
        goal: "Validate reserved runtime command names."
      },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      tools: [{ from_plugin: "babysit", tool: "poll", alias: "af" }],
      graph: {
        type: "sequence",
        id: "root",
        steps: [{ type: "agent", id: "use_tool", goal: "Use tool." }]
      }
    };

    await expect(validateAuthoredGraphDocument(document, { resolved_plugins: resolvedPlugins }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "$.tools[0]",
          message: expect.stringContaining("reserved for Agentflow runtime commands")
        })
      ]));
  });

  it("requires declared credentials for secret-impact tools", async () => {
    resolvedPlugins = [buildPluginFixture(pluginRoot, pluginToolPath, {
      capability: "context",
      impact: "secret"
    })];
    const document: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-secret-policy",
      repos: { main: { path: "." } },
      intent: {
        goal: "Use a secret-backed context tool."
      },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      tools: [{ from_plugin: "babysit", tool: "poll" }],
      graph: {
        type: "sequence",
        id: "root",
        steps: [{ type: "agent", id: "context", goal: "Read context." }]
      }
    };

    await expect(validateAuthoredGraphDocument(document, { resolved_plugins: resolvedPlugins }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "$.tools[0]",
          message: expect.stringContaining("must declare credentials")
        })
      ]));
  });

  it("hard-errors when an agent-scoped plugin tool name collides with a graph-scope tool", () => {
    const document: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-plugin-collision",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      tools: [
        {
          from_plugin: "babysit",
          tool: "poll"
        }
      ],
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "draft",
            goal: "Draft.",
            tools: [
              {
                from_plugin: "babysit",
                tool: "poll"
              }
            ]
          }
        ]
      }
    };

    const compilation = compileWith(document);
    expect(compilation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].tools[0]",
          message: expect.stringContaining("conflicts")
        })
      ])
    );
  });

  it("reports a diagnostic when a plugin reference targets an unknown plugin alias", () => {
    const document: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-plugin-missing",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      tools: [
        {
          from_plugin: "ghost",
          tool: "poll"
        }
      ],
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          { type: "agent", id: "draft", goal: "Draft." }
        ]
      }
    };

    const compilation = compileWith(document);
    expect(compilation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.tools[0].from_plugin",
          message: expect.stringContaining("not declared")
        })
      ])
    );
  });

  it("reports a diagnostic when a plugin reference targets an unknown tool key", () => {
    const document: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-plugin-missing-tool",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      tools: [
        {
          from_plugin: "babysit",
          tool: "ghost"
        }
      ],
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          { type: "agent", id: "draft", goal: "Draft." }
        ]
      }
    };

    const compilation = compileWith(document);
    expect(compilation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.tools[0].tool",
          message: expect.stringContaining("does not export tool")
        })
      ])
    );
  });
});

describe("prepareAgentTools", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentflow-tools-runtime-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("installs plugin tool wrappers, writes node-tool-state.json, and emits env vars", async () => {
    const executionDir = join(tempRoot, "executions/001");
    const workspacePath = join(tempRoot, "workspace");
    const artifactsRoot = join(tempRoot, "executions/001/output");
    await mkdir(executionDir, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await mkdir(artifactsRoot, { recursive: true });

    const pluginPath = join(tempRoot, "plugins/babysit/scripts/poll.sh");
    await writeExecutable(pluginPath, "#!/usr/bin/env bash\necho plugin\n");

    const node = {
      authored_id: "draft",
      compiled_id: "main__draft",
      declared_artifacts: {
        summary: {
          from: "output_dir",
          path: "summary.md",
          description: "Summary written to output dir."
        }
      },
      tools: [
        {
          callable_name: "babysit-poll",
          capability: "verification",
          impact: "read",
          description: "plugin",
          executable_path: pluginPath,
          args: [],
          config: { mode: "fast" },
          source: {
            kind: "plugin",
            alias: "babysit",
            tool: "poll",
            plugin_root: join(tempRoot, "plugins/babysit"),
            declared_at: "graph",
            declaration_path: "$.tools[0]"
          }
        }
      ]
    } satisfies Pick<CompiledAgentNode, "authored_id" | "compiled_id" | "declared_artifacts" | "tools">;

    const setup = await prepareAgentTools({
      node: node as unknown as CompiledAgentNode,
      execution_dir: executionDir,
      workspace_path: workspacePath,
      artifacts_root: artifactsRoot,
      run_root: tempRoot,
      runtime_dir: join(tempRoot, "runtime"),
      run_id: "run-tools",
      graph_id: "tools-runtime",
      execution_id: "exec-draft",
      repo_alias: "main",
      harness: "codex-cli",
      model: "auto",
      sandbox: "workspace-write",
      timeout_sec: 30,
      context_packet_path: join(executionDir, "context.json"),
      context_manifest_path: join(executionDir, "manifest.md")
    });

    expect(setup.bin_dir).toBe(join(executionDir, "agentflow-tools/bin"));
    expect(setup.tool_state_path).toBe(join(executionDir, "agentflow-tools/state.json"));

    const wrapperSource = await readFile(join(setup.bin_dir, "babysit-poll"), "utf8");
    expect(wrapperSource.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(wrapperSource).toContain("launcher.mjs");
    expect(wrapperSource).toContain("babysit-poll");
    const afSource = await readFile(join(setup.bin_dir, "af"), "utf8");
    expect(afSource).toContain("Agentflow runtime CLI wrapper");

    const wrapperResult = await execFileAsync(join(setup.bin_dir, "babysit-poll"), ["--token", "secret-value"]);
    expect(wrapperResult.stdout.trim()).toBe("plugin");
    const invocationRecords = (await readFile(join(executionDir, "tool-invocations.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(invocationRecords).toEqual([
      expect.objectContaining({
        run_id: "run-tools",
        graph_id: "tools-runtime",
        agent_id: "exec-draft",
        execution_id: "exec-draft",
        node_id: "draft",
        compiled_id: "main__draft",
        kind: "plugin_tool",
        tool: "babysit-poll",
        capability: "verification",
        impact: "read",
        argv: ["--token", "<redacted>"],
        exit_code: 0,
        stdout_path: expect.stringMatching(/tool-invocation-logs\/.*babysit-poll\.stdout\.log$/),
        stderr_path: expect.stringMatching(/tool-invocation-logs\/.*babysit-poll\.stderr\.log$/)
      })
    ]);
    expect(await readFile(invocationRecords[0]!.stdout_path as string, "utf8")).toBe("plugin\n");

    const state = JSON.parse(await readFile(setup.tool_state_path, "utf8")) as {
      version: string;
      node_id: string;
      compiled_id: string;
      workspace_path: string;
      artifacts_root: string;
      declared_artifacts: Record<string, { from: string; path: string }>;
    };

    expect(state.version).toBe("1");
    expect(state.node_id).toBe("draft");
    expect(state.compiled_id).toBe("main__draft");
    expect(state.workspace_path).toBe(workspacePath);
    expect(state.artifacts_root).toBe(artifactsRoot);
    expect(state.declared_artifacts.summary).toEqual({
      from: "output_dir",
      path: "summary.md",
      description: "Summary written to output dir."
    });

    expect(setup.env.AGENTFLOW_TOOL_STATE).toBe(setup.tool_state_path);
    expect(setup.env.AGENTFLOW_TOOL_INVOCATIONS).toBe(join(executionDir, "tool-invocations.jsonl"));
    expect(setup.env.AGENTFLOW_RUNTIME_METADATA).toBe(join(executionDir, "agentflow-tools/runtime.json"));
    expect(setup.env.AGENTFLOW_RUN_ROOT).toBe(tempRoot);
    expect(setup.env.AGENTFLOW_RUNTIME_DIR).toBe(join(tempRoot, "runtime"));
    expect(setup.env.AGENTFLOW_RUN_ID).toBe("run-tools");
    expect(setup.env.AGENTFLOW_AGENT_ID).toBe("exec-draft");
    expect(setup.env.AGENTFLOW_PLUGIN_ROOT).toBe(join(tempRoot, "plugins/babysit"));
    expect(setup.env.AGENTFLOW_PLUGIN_ROOT_BABYSIT).toBe(join(tempRoot, "plugins/babysit"));
    expect(setup.env.AGENTFLOW_TOOL_BABYSIT_POLL_MODE).toBeUndefined();

    const runtimeMetadata = JSON.parse(await readFile(setup.env.AGENTFLOW_RUNTIME_METADATA, "utf8")) as {
      agent_id: string;
      run_id: string;
      tool_bin_dir: string;
      tool_invocations_path: string;
      runtime_dir: string;
      declared_artifacts: Record<string, { path: string }>;
    };
    expect(runtimeMetadata).toMatchObject({
      agent_id: "exec-draft",
      run_id: "run-tools",
      runtime_dir: join(tempRoot, "runtime"),
      tool_bin_dir: setup.bin_dir,
      tool_invocations_path: join(executionDir, "tool-invocations.jsonl"),
      declared_artifacts: {
        summary: { path: "summary.md" }
      }
    });

    const spawnEnv = buildHarnessSpawnEnv(
      {
        toolBinDir: setup.bin_dir,
        toolEnv: setup.env,
        repoPath: workspacePath,
        outputDir: artifactsRoot,
        contextPacketPath: join(executionDir, "context.json"),
        contextManifestPath: join(executionDir, "manifest.md")
      } as unknown as AgentInvocation,
      { PATH: "/usr/local/bin" }
    );

    expect(spawnEnv.PATH).toBe(`${setup.bin_dir}${delimiter}/usr/local/bin`);
    expect(spawnEnv.AGENTFLOW_TOOL_STATE).toBe(setup.tool_state_path);
    expect(spawnEnv.AGENTFLOW_RUNTIME_METADATA).toBe(setup.env.AGENTFLOW_RUNTIME_METADATA);
    expect(spawnEnv.AGENTFLOW_TOOL_BABYSIT_POLL_MODE).toBeUndefined();
  });

  it("keeps credential values out of the harness env and injects them only into the plugin subprocess", async () => {
    const executionDir = join(tempRoot, "executions/credential");
    const workspacePath = join(tempRoot, "workspace");
    const artifactsRoot = join(tempRoot, "executions/credential/output");
    await mkdir(executionDir, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await mkdir(artifactsRoot, { recursive: true });

    const pluginPath = join(tempRoot, "plugins/secure/scripts/print-token.sh");
    await writeExecutable(
      pluginPath,
      [
        "#!/usr/bin/env bash",
        "set -eu",
        "printf '%s\\n' \"$AGENTFLOW_CREDENTIAL_SERVICE_TOKEN\"",
        ""
      ].join("\n")
    );

    const node = {
      authored_id: "secure",
      compiled_id: "main__secure",
      declared_artifacts: {},
      tools: [
        {
          callable_name: "secure-token",
          capability: "context",
          impact: "secret",
          description: "Print a resolved credential.",
          executable_path: pluginPath,
          args: [],
          config: {},
          credentials: ["service"],
          source: {
            kind: "plugin",
            alias: "secure",
            tool: "token",
            plugin_root: join(tempRoot, "plugins/secure"),
            declared_at: "graph",
            declaration_path: "$.tools[0]"
          }
        }
      ]
    } satisfies Pick<CompiledAgentNode, "authored_id" | "compiled_id" | "declared_artifacts" | "tools">;

    const setup = await prepareAgentTools({
      node: node as unknown as CompiledAgentNode,
      execution_dir: executionDir,
      workspace_path: workspacePath,
      artifacts_root: artifactsRoot,
      credential_specs: {
        service: {
          fields: {
            token: {
              secret: false,
              required: true,
              default: "resolved-at-tool-launch"
            }
          }
        }
      }
    });

    expect(Object.keys(setup.env).filter((key) => key.startsWith("AGENTFLOW_CREDENTIAL_"))).toEqual([]);

    const spawnEnv = buildHarnessSpawnEnv(
      {
        toolBinDir: setup.bin_dir,
        toolEnv: setup.env,
        repoPath: workspacePath,
        outputDir: artifactsRoot,
        contextPacketPath: join(executionDir, "context.json"),
        contextManifestPath: join(executionDir, "manifest.md")
      } as unknown as AgentInvocation,
      {
        PATH: "/usr/bin:/bin",
        AGENTFLOW_CREDENTIAL_SERVICE_TOKEN: "must-not-leak"
      }
    );

    expect(spawnEnv.AGENTFLOW_CREDENTIAL_SERVICE_TOKEN).toBeUndefined();

    const result = await execFileAsync(
      "bash",
      ["-lc", "secure-token"],
      {
        cwd: workspacePath,
        env: spawnEnv as NodeJS.ProcessEnv
      }
    );
    expect(result.stdout.trim()).toBe("resolved-at-tool-launch");
  });
});

describe("formatToolContract", () => {
  it("returns no lines when no tools are provided", () => {
    expect(formatToolContract(undefined)).toEqual([]);
    expect(formatToolContract([])).toEqual([]);
  });

  it("renders a tool contract sorted alphabetically with origin, usage, and config env vars", () => {
    const tools: ResolvedTool[] = [
      {
        callable_name: "zeta-poll",
        capability: "verification",
        impact: "read",
        description: "Zeta tool.",
        executable_path: "/tmp/zeta",
        args: [],
        config: { mode: "fast" },
        source: {
          kind: "plugin",
          alias: "zetaplug",
          tool: "poll",
          plugin_root: "/tmp/plugin/zeta",
          declared_at: "graph",
          declaration_path: "$.tools[0]"
        }
      },
      {
        callable_name: "alpha-cli",
        capability: "context",
        impact: "secret",
        description: "Alpha tool.",
        usage: "alpha-cli list\nalpha-cli show <id>",
        executable_path: "/tmp/alpha",
        args: [],
        config: { org: "abc" },
        credentials: ["alpha"],
        source: {
          kind: "plugin",
          alias: "alphaplug",
          tool: "alpha",
          plugin_root: "/tmp/plugin",
          declared_at: "graph",
          declaration_path: "$.tools[1]"
        }
      }
    ];

    const lines = formatToolContract(tools);
    const heading = lines[0];
    expect(heading).toBe("## Available Tools");

    const text = lines.join("\n");
    expect(text.indexOf("### alpha-cli")).toBeLessThan(text.indexOf("### zeta-poll"));
    expect(text).toContain("### alpha-cli (from plugin \"alphaplug\" (tool: alpha))");
    expect(text).toContain("### zeta-poll (from plugin \"zetaplug\" (tool: poll))");
    expect(text).toContain("alpha-cli list");
    expect(text).toContain("alpha-cli show <id>");
    expect(text).toContain("Capability: context");
    expect(text).toContain("Impact: secret");
    expect(text).toContain("Capability: verification");
    expect(text).toContain("Impact: read");
    expect(text).toContain("AGENTFLOW_TOOL_ALPHA_CLI_ORG=<configured>");
    expect(text).toContain("AGENTFLOW_TOOL_ZETA_POLL_MODE=<configured>");
    expect(text).not.toContain("=abc");
    expect(text).not.toContain("=fast");
    expect(text).toContain("Credentials: alpha");
    expect(text).not.toContain("AGENTFLOW_CREDENTIAL_ALPHA");
  });

  it("appends the tool contract section to the agent prompt", () => {
    const prompt = renderHarnessPrompt({
      promptKind: "agent",
      runId: "run-1",
      executionId: "exec-1",
      repoAlias: "main",
      repoPath: "/tmp/workspace",
      sandbox: "workspace-write",
      model: undefined,
      nodeGoal: "Do the work.",
      contextPacketPath: "/tmp/context.json",
      contextManifestPath: "/tmp/manifest.md",
      contextManifest: "",
      outputDir: "/tmp/output",
      artifacts: {},
      timeoutSec: 1800,
      signal: undefined,
      tools: [
        {
          callable_name: "babysit-poll",
          capability: "verification",
          impact: "read",
          description: "Poll a PR.",
          executable_path: "/tmp/babysit-poll",
          args: [],
          config: {},
          source: {
            kind: "plugin",
            alias: "babysit",
            tool: "poll",
            plugin_root: "/tmp/plugin/babysit",
            declared_at: "graph",
            declaration_path: "$.tools[0]"
          }
        }
      ]
    });

    expect(prompt).toContain("## Available Tools");
    expect(prompt).toContain("### babysit-poll (from plugin \"babysit\" (tool: poll))");
  });

  it("renders graph and node intent into agent prompts", () => {
    const prompt = renderHarnessPrompt({
      promptKind: "agent",
      runId: "run-1",
      executionId: "exec-1",
      repoAlias: "main",
      repoPath: "/tmp/workspace",
      sandbox: "workspace-write",
      model: undefined,
      graphGoal: "Ship trustworthy checkout timeout handling.",
      graphAcceptanceCriteria: ["Targeted checkout tests pass."],
      nodeGoal: "Write the implementation and reviewer handoff.",
      nodeAcceptanceCriteria: ["Handoff names changed files and validation."],
      contextPacketPath: "/tmp/context.json",
      contextManifestPath: "/tmp/manifest.md",
      contextManifest: "",
      outputDir: "/tmp/output",
      artifacts: {},
      timeoutSec: 1800,
      signal: undefined
    });

    expect(prompt).toContain("## Graph Intent");
    expect(prompt).toContain("Ship trustworthy checkout timeout handling.");
    expect(prompt).toContain("- Targeted checkout tests pass.");
    expect(prompt).toContain("## Node Task");
    expect(prompt).toContain("Write the implementation and reviewer handoff.");
    expect(prompt).toContain("- Handoff names changed files and validation.");
  });
});

describe("end-to-end runtime tool wiring", () => {
  it("spawns the plugin tool through PATH using only the harness-provided env", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-tools-spawn-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    const pluginRoot = join(tempRoot, "plugins/babysit");
    const pluginToolPath = "scripts/poll.sh";
    const pluginAbsoluteToolPath = join(pluginRoot, pluginToolPath);

    try {
      await mkdir(repoDir, { recursive: true });
      await initGitRepo(repoDir);

      await writeExecutable(
        pluginAbsoluteToolPath,
        [
          "#!/usr/bin/env bash",
          "set -eu",
          "cat <<EOF > \"$AGENTFLOW_OUTPUT_DIR/poll-call.json\"",
          "{",
          "  \"argv\": \"$*\",",
          "  \"plugin_root\": \"$AGENTFLOW_PLUGIN_ROOT\",",
          "  \"plugin_root_alias\": \"$AGENTFLOW_PLUGIN_ROOT_BABYSIT\",",
          "  \"tool_state\": \"$AGENTFLOW_TOOL_STATE\",",
          "  \"tool_config_mode\": \"$AGENTFLOW_TOOL_BABYSIT_POLL_MODE\",",
          "  \"workspace\": \"$AGENTFLOW_WORKSPACE\",",
          "  \"output_dir\": \"$AGENTFLOW_OUTPUT_DIR\"",
          "}",
          "EOF",
          "echo '{\"poll_status\":\"ok\"}'",
          ""
        ].join("\n")
      );

      const document: AuthoredGraphDocument = {
        version: "1",
        graph_id: "tools-spawn",
        repos: { main: { path: "." } },
        defaults: { launch_profile: "default", workspace_backend: "inplace" },
        profiles: { default: { harness: "codex-cli" } },
        tools: [{ from_plugin: "babysit", tool: "poll", config: { mode: "check-pr" } }],
        graph: {
          type: "sequence",
          id: "root",
          steps: [
            {
              type: "agent",
              id: "use_tool",
              goal: "Run babysit-poll --pr 42 to check the PR."
            }
          ]
        }
      };

      const normalized = normalizeAuthoredGraphDocument({
        intent: {
          goal: "Exercise plugin tool runtime wiring.",
          acceptance_criteria: ["The harness can invoke the plugin tool from PATH."]
        },
        ...document
      });
      expect(normalized.diagnostics).toEqual([]);
      const launch = resolveLaunchConfig(normalized.document!);
      const compilation = compileAuthoredGraph(
        normalized.document!,
        launch,
        normalized.lowered_managed_nodes,
        {
          graph_dir: tempRoot,
          resolved_plugins: [buildPluginFixture(pluginRoot, pluginToolPath)]
        }
      );
      expect(compilation.diagnostics).toEqual([]);

      let observedInvocation: AgentInvocation | undefined;
      let toolStdout = "";
      let toolStderr = "";
      let toolExitCode = -1;
      let toolStateContents: string | undefined;

      const harness: HarnessAdapter = {
        kind: "codex-cli",
        capabilities: getHarnessCapabilities("codex-cli")!,
        async run(invocation) {
          observedInvocation = invocation;

          // Simulate what a real harness child process would do: spawn a tool
          // by name, relying on PATH containing agentflow-tools/bin and the
          // toolEnv injecting only the launcher state and plugin roots. Tool
          // config is resolved inside the generated launcher subprocess.
          const spawnEnv = buildHarnessSpawnEnv(invocation, {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "/tmp"
          });

          toolStateContents = await readFile(invocation.toolEnv!.AGENTFLOW_TOOL_STATE!, "utf8");

          const result = await execFileAsync(
            "bash",
            ["-lc", "babysit-poll --pr 42"],
            {
              cwd: invocation.repoPath,
              env: spawnEnv as NodeJS.ProcessEnv
            }
          ).catch((error: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }) => {
            return {
              stdout: error.stdout ?? "",
              stderr: error.stderr ?? error.message,
              code: typeof error.code === "number" ? error.code : 1
            };
          });

          toolStdout = "stdout" in result ? result.stdout ?? "" : "";
          toolStderr = "stderr" in result ? result.stderr ?? "" : "";
          toolExitCode = "code" in result && typeof result.code === "number" ? result.code : 0;

          return {
            status: "passed",
            exitCode: 0,
            stdout: toolStdout,
            stderr: toolStderr,
            transcript: { last_message: "tool executed" }
          };
        },
        async cancel() {}
      };

      const run = await runCompiledGraph({
        run_root: runRoot,
        compiled_graph: compilation.compiled_graph!,
        repo_sources: { main: repoDir },
        harnesses: { "codex-cli": harness }
      });

      expect(run.outcome).toBe("passed");
      expect(observedInvocation).toBeDefined();
      const invocation = observedInvocation!;

      // 1. Tool was discoverable via PATH and exited cleanly.
      expect(toolExitCode).toBe(0);
      expect(toolStderr).toBe("");
      expect(toolStdout.trim()).toBe('{"poll_status":"ok"}');

      // 2. Per-execution agentflow-tools/bin dir was prepared with the symlink.
      expect(invocation.toolBinDir).toMatch(/agentflow-tools\/bin$/);

      // 3. tool_state JSON exposes the node identity, declared artifacts, and
      //    workspace/output paths the tool needs to do useful work.
      const toolState = JSON.parse(toolStateContents!) as {
        version: string;
        node_id: string;
        compiled_id: string;
        workspace_path: string;
        artifacts_root: string;
        declared_artifacts: Record<string, unknown>;
      };
      expect(toolState.version).toBe("1");
      expect(toolState.node_id).toBe("use_tool");
      expect(toolState.workspace_path).toBe(repoDir);
      expect(toolState.artifacts_root).toBe(invocation.outputDir);

      // 4. Tool sentinel proves AGENTFLOW_* env vars propagated end-to-end:
      //    plugin root, tool config, workspace, output dir, manifest args.
      const sentinel = JSON.parse(
        await readFile(join(invocation.outputDir, "poll-call.json"), "utf8")
      ) as Record<string, string>;
      expect(sentinel.argv).toBe("--once --pr 42");
      expect(sentinel.plugin_root).toBe(pluginRoot);
      expect(sentinel.plugin_root_alias).toBe(pluginRoot);
      expect(sentinel.tool_state).toBe(invocation.toolEnv!.AGENTFLOW_TOOL_STATE);
      expect(sentinel.tool_config_mode).toBe("check-pr");
      expect(sentinel.workspace).toBe(repoDir);
      expect(sentinel.output_dir).toBe(invocation.outputDir);

      // 5. The agent prompt advertises the namespaced callable name, not "poll".
      const renderedPrompt = renderHarnessPrompt(invocation);
      expect(renderedPrompt).toContain("### babysit-poll (from plugin \"babysit\" (tool: poll))");
      expect(renderedPrompt).toContain("AGENTFLOW_TOOL_BABYSIT_POLL_MODE=<configured>");
      expect(renderedPrompt).not.toContain("check-pr");
      expect(renderedPrompt).not.toMatch(/^### poll /m);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("makes plugin tools resolvable on PATH and surfaces them in the agent prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-tools-e2e-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    const pluginRoot = join(tempRoot, "plugins/babysit");
    const pluginToolPath = "scripts/poll.sh";
    const pluginAbsoluteToolPath = join(pluginRoot, pluginToolPath);

    try {
      await mkdir(repoDir, { recursive: true });
      await initGitRepo(repoDir);
      await writeExecutable(pluginAbsoluteToolPath, "#!/usr/bin/env bash\necho \"poll ran\"\n");

      const document: AuthoredGraphDocument = {
        version: "1",
        graph_id: "tools-e2e",
        repos: { main: { path: "." } },
        defaults: { launch_profile: "default", workspace_backend: "inplace" },
        profiles: { default: { harness: "codex-cli" } },
        tools: [
          {
            from_plugin: "babysit",
            tool: "poll",
            config: { mode: "test" }
          }
        ],
        graph: {
          type: "sequence",
          id: "root",
          steps: [
            {
              type: "agent",
              id: "demo",
              goal: "Use babysit-poll."
            }
          ]
        }
      };

      const normalized = normalizeAuthoredGraphDocument({
        intent: {
          goal: "Surface plugin tools in the agent prompt.",
          acceptance_criteria: ["The rendered prompt names the available tool."]
        },
        ...document
      });
      expect(normalized.diagnostics).toEqual([]);
      const launch = resolveLaunchConfig(normalized.document!);
      const compilation = compileAuthoredGraph(
        normalized.document!,
        launch,
        normalized.lowered_managed_nodes,
        {
          graph_dir: tempRoot,
          resolved_plugins: [buildPluginFixture(pluginRoot, pluginToolPath)]
        }
      );
      expect(compilation.diagnostics).toEqual([]);

      let observedInvocation: AgentInvocation | undefined;
      const harness: HarnessAdapter = {
        kind: "codex-cli",
        capabilities: getHarnessCapabilities("codex-cli")!,
        async run(invocation) {
          observedInvocation = invocation;
          return {
            status: "passed",
            exitCode: 0,
            stdout: "",
            stderr: ""
          };
        },
        async cancel() {}
      };

      const run = await runCompiledGraph({
        run_root: runRoot,
        compiled_graph: compilation.compiled_graph!,
        repo_sources: { main: repoDir },
        harnesses: { "codex-cli": harness }
      });

      expect(run.outcome).toBe("passed");
      expect(observedInvocation).toBeDefined();
      const invocation = observedInvocation!;
      expect(invocation.toolBinDir).toMatch(/agentflow-tools\/bin$/);
      expect(invocation.toolEnv?.AGENTFLOW_TOOL_STATE).toMatch(/agentflow-tools\/state\.json$/);
      expect(invocation.toolEnv?.AGENTFLOW_TOOL_BABYSIT_POLL_MODE).toBeUndefined();

      const toolNames = (invocation.tools ?? []).map((tool) => tool.callable_name).sort();
      expect(toolNames).toEqual(["babysit-poll"]);

      const contract = formatToolContract(invocation.tools);
      expect(contract.join("\n")).toContain("### babysit-poll (from plugin \"babysit\" (tool: poll))");

      const spawnEnv = buildHarnessSpawnEnv(invocation, { PATH: "/usr/local/bin" });
      expect(spawnEnv.PATH?.startsWith(`${invocation.toolBinDir}${delimiter}`)).toBe(true);
      expect(spawnEnv.AGENTFLOW_TOOL_BABYSIT_POLL_MODE).toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
