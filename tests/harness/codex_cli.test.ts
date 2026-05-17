import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createCodexCliHarness } from "../../src/runtime/harness/codex_cli.js";

async function createMockCodexBinary(tempRoot: string): Promise<{
  binary_path: string;
  argv_path: string;
  stdin_path: string;
  env_path: string;
}> {
  const binary_path = join(tempRoot, "mock-codex.mjs");
  const argv_path = join(tempRoot, "argv.json");
  const stdin_path = join(tempRoot, "stdin.txt");
  const env_path = join(tempRoot, "env.json");
  const source = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const argvPath = process.env.MOCK_ARGV_PATH;
const stdinPath = process.env.MOCK_STDIN_PATH;
const envPath = process.env.MOCK_ENV_PATH;

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  if (argvPath) {
    writeFileSync(argvPath, JSON.stringify(process.argv.slice(2), null, 2));
  }
  if (stdinPath) {
    writeFileSync(stdinPath, stdin);
  }
  if (envPath) {
    writeFileSync(envPath, JSON.stringify({
      AGENTFLOW_WORKSPACE: process.env.AGENTFLOW_WORKSPACE,
      AGENTFLOW_OUTPUT_DIR: process.env.AGENTFLOW_OUTPUT_DIR,
      AGENTFLOW_CONTEXT_PACKET: process.env.AGENTFLOW_CONTEXT_PACKET,
      AGENTFLOW_CONTEXT_MANIFEST: process.env.AGENTFLOW_CONTEXT_MANIFEST,
      AGENTFLOW_RUNTIME_DIR: process.env.AGENTFLOW_RUNTIME_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
      CODEX_CI: process.env.CODEX_CI,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
      CODEX_SHELL: process.env.CODEX_SHELL,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID
    }, null, 2));
  }

  const args = process.argv.slice(2);
  const outputIndex = args.findIndex((arg) => arg === "--output-last-message");
  const lastMessagePath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;

  if (lastMessagePath) {
    writeFileSync(lastMessagePath, JSON.stringify({ passed: true, summary: "codex ok" }));
  }

  process.stdout.write('{"passed":true,"summary":"codex ok"}');
});
`;

  await writeFile(binary_path, source);
  await chmod(binary_path, 0o755);

  return {
    binary_path,
    argv_path,
    stdin_path,
    env_path
  };
}

async function createHangingCodexBinary(tempRoot: string): Promise<string> {
  const binary_path = join(tempRoot, "hanging-codex.sh");
  const source = `#!/bin/sh
trap '' TERM
while true; do
  sleep 1
done
`;

  await writeFile(binary_path, source);
  await chmod(binary_path, 0o755);
  return binary_path;
}

async function createStreamingCodexBinary(tempRoot: string): Promise<string> {
  const binary_path = join(tempRoot, "streaming-codex.mjs");
  const source = `#!/usr/bin/env node
process.stdout.write("chunk-one\\n");
setTimeout(() => {
  process.stderr.write("warn-one\\n");
}, 5);
setTimeout(() => {
  process.stdout.write("chunk-two\\n");
  process.exit(0);
}, 10);
`;

  await writeFile(binary_path, source);
  await chmod(binary_path, 0o755);
  return binary_path;
}

async function createKilledCodexBinary(tempRoot: string): Promise<string> {
  const binary_path = join(tempRoot, "killed-codex.mjs");
  const source = `#!/usr/bin/env node
process.stdout.write("starting\\n");
process.kill(process.pid, "SIGKILL");
`;

  await writeFile(binary_path, source);
  await chmod(binary_path, 0o755);
  return binary_path;
}

describe("codex cli harness", () => {
  it("reports readiness availability from the resolved binary path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-preflight-"));
    const availableBinary = await createMockCodexBinary(tempRoot);
    const missingBinary = join(tempRoot, "missing-codex");

    try {
      expect(
        createCodexCliHarness({
          binary: availableBinary.binary_path
        }).checkReadiness?.()
      ).toEqual([]);
      expect(
        createCodexCliHarness({
          binary: missingBinary
        }).checkReadiness?.()
      ).toEqual([
        `codex-cli harness binary "${missingBinary}" is unavailable. Install it on PATH or set AGENTFLOW_CODEX_CLI_BIN.`
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves the codex binary from AGENTFLOW_CODEX_CLI_BIN when no override is provided", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-env-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCodexBinary(tempRoot);
    const previousBinary = process.env.AGENTFLOW_CODEX_CLI_BIN;
    const previousArgvPath = process.env.MOCK_ARGV_PATH;
    const previousStdinPath = process.env.MOCK_STDIN_PATH;
    process.env.AGENTFLOW_CODEX_CLI_BIN = mock.binary_path;
    process.env.MOCK_ARGV_PATH = mock.argv_path;
    process.env.MOCK_STDIN_PATH = mock.stdin_path;

    try {
      const harness = createCodexCliHarness();
      const result = await harness.run({
        runId: "run-env",
        executionId: "exec-env",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-codex",
        nodeGoal: "Read from env override.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined
      });

      expect(result.status).toBe("passed");
      expect(result.metadata).toEqual(
        expect.objectContaining({
          binary: mock.binary_path
        })
      );
    } finally {
      if (previousBinary === undefined) {
        delete process.env.AGENTFLOW_CODEX_CLI_BIN;
      } else {
        process.env.AGENTFLOW_CODEX_CLI_BIN = previousBinary;
      }

      if (previousArgvPath === undefined) {
        delete process.env.MOCK_ARGV_PATH;
      } else {
        process.env.MOCK_ARGV_PATH = previousArgvPath;
      }

      if (previousStdinPath === undefined) {
        delete process.env.MOCK_STDIN_PATH;
      } else {
        process.env.MOCK_STDIN_PATH = previousStdinPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("executes codex with the normalized runtime contract", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-harness-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    const outputDir = join(executionDir, "artifacts");
    const runtimeDir = join(executionDir, "runtime");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCodexBinary(tempRoot);
    const harness = createCodexCliHarness({
      binary: mock.binary_path
    });

    const previousArgvPath = process.env.MOCK_ARGV_PATH;
    const previousStdinPath = process.env.MOCK_STDIN_PATH;
    const previousEnvPath = process.env.MOCK_ENV_PATH;
    process.env.MOCK_ARGV_PATH = mock.argv_path;
    process.env.MOCK_STDIN_PATH = mock.stdin_path;
    process.env.MOCK_ENV_PATH = mock.env_path;

    try {
      const result = await harness.run({
        runId: "run-1",
        executionId: "exec-1",
        repoAlias: "main",
        repoPath: repoDir,
        runtimeDir,
        sandbox: "workspace-write",
        skipGitRepoCheck: true,
        model: "gpt-5-codex",
        reasoningEffort: "xhigh",
        graphGoal: "Ship the larger change safely.",
        nodeGoal: "Implement the change.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "# Context Manifest\n\n- Pointer items: `1`\n",
        outputDir,
        artifacts: {
          handoff: {
            from: "output_dir",
            path: "handoff.md",
            description: "Markdown handoff for downstream nodes."
          },
          junit: {
            from: "workspace",
            path: "reports/junit.xml",
            description: "JUnit XML report written by the workspace validation command."
          }
        },
        timeoutSec: 10,
        signal: undefined
      });

      const argv = JSON.parse(await readFile(mock.argv_path, "utf8")) as string[];
      const prompt = await readFile(mock.stdin_path, "utf8");
      const env = JSON.parse(await readFile(mock.env_path, "utf8")) as Record<string, string>;

      expect(result.status).toBe("passed");
      expect(argv).toEqual(
        expect.arrayContaining([
          "exec",
          "--cd",
          repoDir,
          "--sandbox",
          "workspace-write",
          "--add-dir",
          executionDir,
          "--add-dir",
          outputDir,
          "--add-dir",
          runtimeDir,
          "--output-last-message",
          join(outputDir, "last_message.txt"),
          "--skip-git-repo-check",
          "-m",
          "gpt-5-codex",
          "-c",
          'model_reasoning_effort="xhigh"',
          "-"
        ])
      );
      expect(argv).not.toContain("mcp_servers={}");
      expect(argv).not.toContain("plugins={}");
      expect(argv).not.toContain("notify=[]");
      expect(prompt).toContain("## Role");
      expect(prompt).toContain("Agentflow is a local graph runner for long-running engineering work.");
      expect(prompt).toContain("You are executing one node in a wider Agentflow graph.");
      expect(prompt).toContain("## Success Contract");
      expect(prompt).toContain("Implement the change.");
      expect(prompt.indexOf("## Success Contract")).toBeLessThan(prompt.indexOf("## Graph Context"));
      expect(prompt).toContain("## Context");
      expect(prompt).toContain("# Context Manifest");
      expect(prompt).not.toContain("Context packet:");
      expect(prompt).not.toContain(join(executionDir, "runtime", "context.json"));
      expect(prompt).not.toContain("Context provenance:");
      expect(prompt).not.toContain("Output directory");
      expect(prompt).not.toContain(outputDir);
      expect(prompt).toContain("Sandbox: workspace-write - edit files in the workspace");
      expect(prompt).toContain("## Declared Artifacts");
      expect(prompt).toContain("Every declared artifact must exist before you finish");
      expect(prompt).toContain("| `handoff` |");
      expect(prompt).toContain("`af artifact write handoff`");
      expect(prompt).not.toContain("$AGENTFLOW_OUTPUT_DIR/handoff.md");
      expect(prompt).toContain("Markdown handoff for downstream nodes.");
      expect(prompt).toContain("| `junit` |");
      expect(prompt).not.toContain("$AGENTFLOW_WORKSPACE/reports/junit.xml");
      expect(prompt).toContain("JUnit XML report written by the workspace validation command.");
      expect(prompt).not.toContain(`${repoDir}/reports/junit.xml`);
      expect(prompt).toContain("## Completion Gate");
      expect(prompt).toContain("captured as the reserved `agent_response` artifact");
      expect(env).toEqual({
        AGENTFLOW_WORKSPACE: repoDir,
        AGENTFLOW_OUTPUT_DIR: outputDir,
        AGENTFLOW_CONTEXT_PACKET: join(executionDir, "runtime", "context.json"),
        AGENTFLOW_CONTEXT_MANIFEST: join(executionDir, "agent", "context.md"),
        AGENTFLOW_RUNTIME_DIR: runtimeDir,
        CODEX_HOME: expect.stringContaining("agentflow-codex-home-")
      });
      expect(result.outputJson).toEqual({
        passed: true,
        summary: "codex ok"
      });
      expect(result.transcript?.last_message_path).toBe(join(outputDir, "last_message.txt"));
      expect(result.metadata).toEqual(
        expect.objectContaining({
          binary: mock.binary_path,
          timed_out: false
        })
      );
    } finally {
      if (previousArgvPath === undefined) {
        delete process.env.MOCK_ARGV_PATH;
      } else {
        process.env.MOCK_ARGV_PATH = previousArgvPath;
      }

      if (previousStdinPath === undefined) {
        delete process.env.MOCK_STDIN_PATH;
      } else {
        process.env.MOCK_STDIN_PATH = previousStdinPath;
      }

      if (previousEnvPath === undefined) {
        delete process.env.MOCK_ENV_PATH;
      } else {
        process.env.MOCK_ENV_PATH = previousEnvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("passes declared codex harness config without stripping MCP, plugins, or notify", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-declared-config-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCodexBinary(tempRoot);
    const harness = createCodexCliHarness({
      binary: mock.binary_path
    });

    const previousArgvPath = process.env.MOCK_ARGV_PATH;
    const previousEnvPath = process.env.MOCK_ENV_PATH;
    process.env.MOCK_ARGV_PATH = mock.argv_path;
    process.env.MOCK_ENV_PATH = mock.env_path;

    try {
      const result = await harness.run({
        runId: "run-declared",
        executionId: "exec-declared",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-codex",
        nodeGoal: "Use declared harness-native tools.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
        harnessConfig: {
          isolation: "isolated",
          codex: {
            config: {
              approval_policy: "never",
              model_provider: "openai"
            },
            mcp_servers: {
              docs: {
                command: "docs-server",
                args: ["serve"]
              }
            },
            plugins: {
              figma: {
                enabled: true
              }
            },
            notify: ["terminal-notifier"]
          }
        }
      });

      const argv = JSON.parse(await readFile(mock.argv_path, "utf8")) as string[];
      const env = JSON.parse(await readFile(mock.env_path, "utf8")) as Record<string, string>;

      expect(result.status).toBe("passed");
      expect(argv).toEqual(
        expect.arrayContaining([
          "-c",
          'approval_policy="never"',
          "-c",
          'model_provider="openai"',
          "-c",
          'mcp_servers={ docs = { args = ["serve"], command = "docs-server" } }',
          "-c",
          "plugins={ figma = { enabled = true } }",
          "-c",
          'notify=["terminal-notifier"]'
        ])
      );
      expect(env.CODEX_HOME).toContain("agentflow-codex-home-");
    } finally {
      if (previousArgvPath === undefined) {
        delete process.env.MOCK_ARGV_PATH;
      } else {
        process.env.MOCK_ARGV_PATH = previousArgvPath;
      }

      if (previousEnvPath === undefined) {
        delete process.env.MOCK_ENV_PATH;
      } else {
        process.env.MOCK_ENV_PATH = previousEnvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("inherits user codex config only when the profile explicitly opts in", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-inherit-user-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    const userCodexHome = join(tempRoot, "user-codex-home");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCodexBinary(tempRoot);
    const harness = createCodexCliHarness({
      binary: mock.binary_path
    });

    const previousArgvPath = process.env.MOCK_ARGV_PATH;
    const previousEnvPath = process.env.MOCK_ENV_PATH;
    process.env.MOCK_ARGV_PATH = mock.argv_path;
    process.env.MOCK_ENV_PATH = mock.env_path;

    try {
      const result = await harness.run({
        runId: "run-inherit",
        executionId: "exec-inherit",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-codex",
        baseEnv: {
          ...process.env,
          CODEX_HOME: userCodexHome,
          CODEX_THREAD_ID: "ambient-thread",
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
          CODEX_SHELL: "1",
          CODEX_CI: "1"
        },
        nodeGoal: "Use the local Codex configuration.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
        harnessConfig: {
          isolation: "inherit_user"
        }
      });

      const argv = JSON.parse(await readFile(mock.argv_path, "utf8")) as string[];
      const env = JSON.parse(await readFile(mock.env_path, "utf8")) as Record<string, string>;

      expect(result.status).toBe("passed");
      expect(env.CODEX_HOME).toBe(userCodexHome);
      expect(env).not.toHaveProperty("CODEX_THREAD_ID");
      expect(env).not.toHaveProperty("CODEX_INTERNAL_ORIGINATOR_OVERRIDE");
      expect(env).not.toHaveProperty("CODEX_SHELL");
      expect(env).not.toHaveProperty("CODEX_CI");
      expect(argv).not.toContain("mcp_servers={}");
      expect(argv).not.toContain("plugins={}");
      expect(argv).not.toContain("notify=[]");
    } finally {
      if (previousArgvPath === undefined) {
        delete process.env.MOCK_ARGV_PATH;
      } else {
        process.env.MOCK_ARGV_PATH = previousArgvPath;
      }

      if (previousEnvPath === undefined) {
        delete process.env.MOCK_ENV_PATH;
      } else {
        process.env.MOCK_ENV_PATH = previousEnvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("scrubs ambient Codex session state from isolated child processes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-session-scrub-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCodexBinary(tempRoot);
    const harness = createCodexCliHarness({
      binary: mock.binary_path
    });

    const previousEnvPath = process.env.MOCK_ENV_PATH;
    process.env.MOCK_ENV_PATH = mock.env_path;

    try {
      const result = await harness.run({
        runId: "run-session-scrub",
        executionId: "exec-session-scrub",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-codex",
        baseEnv: {
          ...process.env,
          CODEX_HOME: join(tempRoot, "user-codex-home"),
          CODEX_THREAD_ID: "ambient-thread",
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
          CODEX_SHELL: "1",
          CODEX_CI: "1"
        },
        nodeGoal: "Complete without ambient Codex session state.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined
      });

      const env = JSON.parse(await readFile(mock.env_path, "utf8")) as Record<string, string>;

      expect(result.status).toBe("passed");
      expect(env.CODEX_HOME).toContain("agentflow-codex-home-");
      expect(env).not.toHaveProperty("CODEX_THREAD_ID");
      expect(env).not.toHaveProperty("CODEX_INTERNAL_ORIGINATOR_OVERRIDE");
      expect(env).not.toHaveProperty("CODEX_SHELL");
      expect(env).not.toHaveProperty("CODEX_CI");
    } finally {
      if (previousEnvPath === undefined) {
        delete process.env.MOCK_ENV_PATH;
      } else {
        process.env.MOCK_ENV_PATH = previousEnvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("forces isolated codex config for trust-check prompts even when the profile inherits user config", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-trust-check-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    const userCodexHome = join(tempRoot, "user-codex-home");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCodexBinary(tempRoot);
    const harness = createCodexCliHarness({
      binary: mock.binary_path
    });

    const previousArgvPath = process.env.MOCK_ARGV_PATH;
    const previousEnvPath = process.env.MOCK_ENV_PATH;
    process.env.MOCK_ARGV_PATH = mock.argv_path;
    process.env.MOCK_ENV_PATH = mock.env_path;

    try {
      const result = await harness.run({
        promptKind: "ai_check",
        runId: "run-trust",
        executionId: "exec-trust",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "read-only",
        model: "gpt-5-codex",
        baseEnv: {
          ...process.env,
          CODEX_HOME: userCodexHome
        },
        nodeGoal: "Verify the outcome.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
        harnessConfig: {
          isolation: "inherit_user",
          codex: {
            mcp_servers: {
              docs: {
                command: "docs-server"
              }
            }
          }
        }
      });

      const argv = JSON.parse(await readFile(mock.argv_path, "utf8")) as string[];
      const env = JSON.parse(await readFile(mock.env_path, "utf8")) as Record<string, string>;

      expect(result.status).toBe("passed");
      expect(env.CODEX_HOME).toContain("agentflow-codex-home-");
      expect(env.CODEX_HOME).not.toBe(userCodexHome);
      expect(argv).not.toContain("mcp_servers={ docs = { command = \"docs-server\" } }");
    } finally {
      if (previousArgvPath === undefined) {
        delete process.env.MOCK_ARGV_PATH;
      } else {
        process.env.MOCK_ARGV_PATH = previousArgvPath;
      }

      if (previousEnvPath === undefined) {
        delete process.env.MOCK_ENV_PATH;
      } else {
        process.env.MOCK_ENV_PATH = previousEnvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats model auto as harness default instead of passing a brittle model flag", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-auto-model-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCodexBinary(tempRoot);
    const harness = createCodexCliHarness({
      binary: mock.binary_path
    });

    const previousArgvPath = process.env.MOCK_ARGV_PATH;
    const previousStdinPath = process.env.MOCK_STDIN_PATH;
    process.env.MOCK_ARGV_PATH = mock.argv_path;
    process.env.MOCK_STDIN_PATH = mock.stdin_path;

    try {
      const result = await harness.run({
        runId: "run-auto",
        executionId: "exec-auto",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "auto",
        nodeGoal: "Use the harness default model.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined
      });

      expect(result.status).toBe("passed");
      const argv = JSON.parse(await readFile(mock.argv_path, "utf8")) as string[];
      expect(argv).not.toContain("-m");
      expect(argv).not.toContain("auto");
    } finally {
      if (previousArgvPath === undefined) {
        delete process.env.MOCK_ARGV_PATH;
      } else {
        process.env.MOCK_ARGV_PATH = previousArgvPath;
      }

      if (previousStdinPath === undefined) {
        delete process.env.MOCK_STDIN_PATH;
      } else {
        process.env.MOCK_STDIN_PATH = previousStdinPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("forces timed-out codex executions to exit if the child ignores SIGTERM", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-timeout-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const harness = createCodexCliHarness({
      binary: await createHangingCodexBinary(tempRoot)
    });

    try {
      const started_at = Date.now();
      const result = await harness.run({
        runId: "run-timeout",
        executionId: "exec-timeout",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-codex",
        nodeGoal: "Hang forever.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 1,
        signal: undefined
      });

      expect(Date.now() - started_at).toBeLessThan(5000);
      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(1);
      expect(result.metadata).toEqual(
        expect.objectContaining({
          timed_out: true,
          force_killed: true
        })
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records an abruptly killed codex child as a failed harness result", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-killed-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const harness = createCodexCliHarness({
      binary: await createKilledCodexBinary(tempRoot)
    });

    try {
      const result = await harness.run({
        runId: "run-killed",
        executionId: "exec-killed",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-codex",
        nodeGoal: "Exit abruptly.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined
      });

      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("starting");
      expect(result.metadata).toEqual(
        expect.objectContaining({
          timed_out: false,
          force_killed: false
        })
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns an actionable error when the codex binary is unavailable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-missing-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const harness = createCodexCliHarness({
      binary: join(tempRoot, "missing-codex")
    });

    try {
      await expect(
        harness.run({
          runId: "run-missing",
          executionId: "exec-missing",
          repoAlias: "main",
          repoPath: repoDir,
          sandbox: "workspace-write",
          model: "gpt-5-codex",
          nodeGoal: "This should fail fast.",
          contextPacketPath: join(executionDir, "runtime", "context.json"),
          contextManifestPath: join(executionDir, "agent", "context.md"),
          contextManifest: "",
          outputDir: executionDir,
          artifacts: {},
          timeoutSec: 10,
          signal: undefined
        })
      ).rejects.toThrow(
        `codex-cli harness binary "${join(tempRoot, "missing-codex")}" is unavailable.`
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("streams stdout and stderr chunks while buffering the final result", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-codex-streaming-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const harness = createCodexCliHarness({
      binary: await createStreamingCodexBinary(tempRoot)
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    try {
      const result = await harness.run({
        runId: "run-stream",
        executionId: "exec-stream",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-codex",
        nodeGoal: "Stream logs.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
        onStdoutChunk(chunk) {
          stdoutChunks.push(chunk);
        },
        onStderrChunk(chunk) {
          stderrChunks.push(chunk);
        }
      });

      expect(stdoutChunks.join("")).toContain("chunk-one");
      expect(stdoutChunks.join("")).toContain("chunk-two");
      expect(stderrChunks.join("")).toContain("warn-one");
      expect(result.stdout).toContain("chunk-one");
      expect(result.stdout).toContain("chunk-two");
      expect(result.stderr).toContain("warn-one");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
