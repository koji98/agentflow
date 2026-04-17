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
      AGENTFLOW_CONTEXT_MANIFEST: process.env.AGENTFLOW_CONTEXT_MANIFEST
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
        prompt: "Read from env override.",
        contextPacketPath: join(executionDir, "context", "packet.json"),
        contextManifestPath: join(executionDir, "context", "manifest.md"),
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
        sandbox: "workspace-write",
        skipGitRepoCheck: true,
        model: "gpt-5-codex",
        reasoningEffort: "xhigh",
        prompt: "Implement the change.",
        contextPacketPath: join(executionDir, "context", "packet.json"),
        contextManifestPath: join(executionDir, "context", "manifest.md"),
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
          "--sandbox",
          "workspace-write",
          "--add-dir",
          outputDir,
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
      expect(prompt).toContain("## Agentflow Runtime Contract");
      expect(prompt).toContain("You are executing one node in an Agentflow graph.");
      expect(prompt).toContain("Future nodes can consume only named artifacts");
      expect(prompt).toContain("## Node Task");
      expect(prompt).toContain("Implement the change.");
      expect(prompt).toContain("Exact context packet");
      expect(prompt).toContain(join(executionDir, "context", "packet.json"));
      expect(prompt).toContain("Read first");
      expect(prompt).toContain(join(executionDir, "context", "manifest.md"));
      expect(prompt).toContain("Output directory");
      expect(prompt).toContain("## Artifact Contract");
      expect(prompt).toContain("Every declared artifact must exist before you finish");
      expect(prompt).toContain("`handoff` (from `output_dir`)");
      expect(prompt).toContain("$AGENTFLOW_OUTPUT_DIR/handoff.md");
      expect(prompt).toContain("Expected content: Markdown handoff for downstream nodes.");
      expect(prompt).toContain("`junit` (from `workspace`)");
      expect(prompt).toContain("$AGENTFLOW_WORKSPACE/reports/junit.xml");
      expect(prompt).toContain("Expected content: JUnit XML report written by the workspace validation command.");
      expect(prompt).toContain("## Final Response Requirements");
      expect(prompt).toContain("captured by Agentflow as the reserved `agent_response` artifact");
      expect(prompt).toContain("Artifacts produced: names and paths of declared artifacts you wrote.");
      expect(env).toEqual({
        AGENTFLOW_WORKSPACE: repoDir,
        AGENTFLOW_OUTPUT_DIR: outputDir,
        AGENTFLOW_CONTEXT_PACKET: join(executionDir, "context", "packet.json"),
        AGENTFLOW_CONTEXT_MANIFEST: join(executionDir, "context", "manifest.md")
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
        prompt: "Hang forever.",
        contextPacketPath: join(executionDir, "context", "packet.json"),
        contextManifestPath: join(executionDir, "context", "manifest.md"),
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
          prompt: "This should fail fast.",
          contextPacketPath: join(executionDir, "context", "packet.json"),
          contextManifestPath: join(executionDir, "context", "manifest.md"),
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
        prompt: "Stream logs.",
        contextPacketPath: join(executionDir, "context", "packet.json"),
        contextManifestPath: join(executionDir, "context", "manifest.md"),
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
