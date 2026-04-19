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

function buildPluginFixture(pluginRoot: string, pluginToolPath: string): ResolvedPlugin {
  return {
    alias: "babysit",
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
      tools: {
        poll: {
          executable: pluginToolPath,
          description: "Poll a PR.",
          usage: "babysit-poll [--once]",
          args: ["--once"],
          config_schema: {}
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
    const normalized = normalizeAuthoredGraphDocument(document);
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
            prompt: "Draft something."
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
            prompt: "Watch the PR."
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

  it("supports agent-scoped plugin tool declarations and applies tool_config overrides", () => {
    const document: AuthoredGraphDocument = {
      version: "1",
      graph_id: "tools-plugin-agent-scope",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: { default: { harness: "codex-cli" } },
      tools: [
        {
          from_plugin: "babysit",
          tool: "poll"
        }
      ],
      tool_config: {
        "babysit-poll": { mode: "graph" }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "agent",
            id: "draft",
            prompt: "Draft."
          },
          {
            type: "agent",
            id: "refine",
            prompt: "Refine.",
            tool_config: {
              "babysit-poll": { mode: "agent", verbosity: "high" }
            }
          }
        ]
      }
    };

    const compilation = compileWith(document);
    expect(compilation.diagnostics).toEqual([]);

    const draft = findAgentNode(compilation.compiled_graph!.nodes, "draft");
    const refine = findAgentNode(compilation.compiled_graph!.nodes, "refine");

    const draftPoll = draft.tools.find((tool) => tool.callable_name === "babysit-poll");
    const refinePoll = refine.tools.find((tool) => tool.callable_name === "babysit-poll");

    expect(draftPoll?.config).toEqual({ mode: "graph" });
    expect(refinePoll?.config).toEqual({ mode: "agent", verbosity: "high" });
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
            prompt: "Draft.",
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
          { type: "agent", id: "draft", prompt: "Draft." }
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
          { type: "agent", id: "draft", prompt: "Draft." }
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

  it("symlinks plugin tools, writes node-tool-state.json, and emits env vars", async () => {
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
          description: "plugin",
          executable_path: pluginPath,
          args: [],
          config: { token: "abc123" },
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
      artifacts_root: artifactsRoot
    });

    expect(setup.bin_dir).toBe(join(executionDir, "agentflow-tools/bin"));
    expect(setup.tool_state_path).toBe(join(executionDir, "agentflow-tools/state.json"));

    const linkContents = await execFileAsync(join(setup.bin_dir, "babysit-poll"));
    expect(linkContents.stdout.trim()).toBe("plugin");

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
    expect(setup.env.AGENTFLOW_PLUGIN_ROOT).toBe(join(tempRoot, "plugins/babysit"));
    expect(setup.env.AGENTFLOW_PLUGIN_ROOT_BABYSIT).toBe(join(tempRoot, "plugins/babysit"));
    expect(setup.env.AGENTFLOW_TOOL_BABYSIT_POLL_TOKEN).toBe("abc123");

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
    expect(spawnEnv.AGENTFLOW_TOOL_BABYSIT_POLL_TOKEN).toBe("abc123");
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
        description: "Alpha tool.",
        usage: "alpha-cli list\nalpha-cli show <id>",
        executable_path: "/tmp/alpha",
        args: [],
        config: { token: "abc" },
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
    expect(text).toContain("AGENTFLOW_TOOL_ALPHA_CLI_TOKEN=abc");
    expect(text).toContain("AGENTFLOW_TOOL_ZETA_POLL_MODE=fast");
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
      prompt: "Do the work.",
      contextPacketPath: "/tmp/context.json",
      contextManifestPath: "/tmp/manifest.md",
      outputDir: "/tmp/output",
      artifacts: {},
      timeoutSec: 1800,
      signal: undefined,
      tools: [
        {
          callable_name: "babysit-poll",
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
});

describe("end-to-end runtime tool wiring", () => {
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
            tool: "poll"
          }
        ],
        tool_config: {
          "babysit-poll": { mode: "test" }
        },
        graph: {
          type: "sequence",
          id: "root",
          steps: [
            {
              type: "agent",
              id: "demo",
              prompt: "Use babysit-poll."
            }
          ]
        }
      };

      const normalized = normalizeAuthoredGraphDocument(document);
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
      expect(invocation.toolEnv?.AGENTFLOW_TOOL_BABYSIT_POLL_MODE).toBe("test");

      const toolNames = (invocation.tools ?? []).map((tool) => tool.callable_name).sort();
      expect(toolNames).toEqual(["babysit-poll"]);

      const contract = formatToolContract(invocation.tools);
      expect(contract.join("\n")).toContain("### babysit-poll (from plugin \"babysit\" (tool: poll))");

      const spawnEnv = buildHarnessSpawnEnv(invocation, { PATH: "/usr/local/bin" });
      expect(spawnEnv.PATH?.startsWith(`${invocation.toolBinDir}${delimiter}`)).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
