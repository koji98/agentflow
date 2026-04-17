import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createCursorCliHarness } from "../../src/runtime/harness/cursor_cli.js";

async function createMockCursorBinary(tempRoot: string): Promise<{
  binary_path: string;
  argv_path: string;
  env_path: string;
}> {
  const binary_path = join(tempRoot, "mock-agent.mjs");
  const argv_path = join(tempRoot, "argv.json");
  const env_path = join(tempRoot, "env.json");
  const source = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const argvPath = process.env.MOCK_ARGV_PATH;
const envPath = process.env.MOCK_ENV_PATH;

if (argvPath) {
  writeFileSync(argvPath, JSON.stringify(process.argv.slice(2), null, 2));
}
if (envPath) {
  writeFileSync(envPath, JSON.stringify({
    AGENTFLOW_WORKSPACE: process.env.AGENTFLOW_WORKSPACE,
    AGENTFLOW_OUTPUT_DIR: process.env.AGENTFLOW_OUTPUT_DIR,
    AGENTFLOW_CONTEXT_PACKET: process.env.AGENTFLOW_CONTEXT_PACKET,
    AGENTFLOW_CONTEXT_MANIFEST: process.env.AGENTFLOW_CONTEXT_MANIFEST
  }, null, 2));
}

process.stdout.write('{"passed":true,"summary":"cursor ok"}');
`;

  await writeFile(binary_path, source);
  await chmod(binary_path, 0o755);

  return {
    binary_path,
    argv_path,
    env_path
  };
}

async function createStreamingCursorBinary(tempRoot: string): Promise<string> {
  const binary_path = join(tempRoot, "streaming-agent.mjs");
  const source = `#!/usr/bin/env node
process.stdout.write("cursor-one\\n");
setTimeout(() => {
  process.stderr.write("cursor-warn\\n");
}, 5);
setTimeout(() => {
  process.stdout.write("cursor-two\\n");
  process.exit(0);
}, 10);
`;

  await writeFile(binary_path, source);
  await chmod(binary_path, 0o755);
  return binary_path;
}

describe("cursor cli harness", () => {
  it("reports readiness availability from the resolved binary path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-preflight-"));
    const availableBinary = await createMockCursorBinary(tempRoot);
    const missingBinary = join(tempRoot, "missing-agent");

    try {
      expect(
        createCursorCliHarness({
          binary: availableBinary.binary_path
        }).checkReadiness?.()
      ).toEqual([]);
      expect(
        createCursorCliHarness({
          binary: missingBinary
        }).checkReadiness?.()
      ).toEqual([
        `cursor-cli harness binary "${missingBinary}" is unavailable. Install it on PATH or set AGENTFLOW_CURSOR_CLI_BIN.`
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves the cursor binary from AGENTFLOW_CURSOR_CLI_BIN when no override is provided", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-env-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCursorBinary(tempRoot);
    const previousBinary = process.env.AGENTFLOW_CURSOR_CLI_BIN;
    const previousArgvPath = process.env.MOCK_ARGV_PATH;
    process.env.AGENTFLOW_CURSOR_CLI_BIN = mock.binary_path;
    process.env.MOCK_ARGV_PATH = mock.argv_path;

    try {
      const harness = createCursorCliHarness();
      const result = await harness.run({
        runId: "run-env",
        executionId: "exec-env",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "read-only",
        model: "gpt-5-cursor",
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
        delete process.env.AGENTFLOW_CURSOR_CLI_BIN;
      } else {
        process.env.AGENTFLOW_CURSOR_CLI_BIN = previousBinary;
      }

      if (previousArgvPath === undefined) {
        delete process.env.MOCK_ARGV_PATH;
      } else {
        process.env.MOCK_ARGV_PATH = previousArgvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("executes cursor with the normalized runtime contract", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-harness-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    const outputDir = join(executionDir, "artifacts");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCursorBinary(tempRoot);
    const harness = createCursorCliHarness({
      binary: mock.binary_path
    });

    const previousArgvPath = process.env.MOCK_ARGV_PATH;
    const previousEnvPath = process.env.MOCK_ENV_PATH;
    process.env.MOCK_ARGV_PATH = mock.argv_path;
    process.env.MOCK_ENV_PATH = mock.env_path;

    try {
      const result = await harness.run({
        runId: "run-1",
        executionId: "exec-1",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "read-only",
        model: "gpt-5-cursor",
        prompt: "Review the change.",
        contextPacketPath: join(executionDir, "context", "packet.json"),
        contextManifestPath: join(executionDir, "context", "manifest.md"),
        outputDir,
        artifacts: {
          review_report: {
            from: "output_dir",
            path: "review-report.md",
            description: "Markdown review report for downstream nodes."
          }
        },
        timeoutSec: 10,
        signal: undefined
      });

      const argv = JSON.parse(await readFile(mock.argv_path, "utf8")) as string[];
      const prompt = argv.at(-1) ?? "";
      const env = JSON.parse(await readFile(mock.env_path, "utf8")) as Record<string, string>;

      expect(result.status).toBe("passed");
      expect(argv).toEqual(
        expect.arrayContaining([
          "-p",
          "--output-format",
          "text",
          "--workspace",
          repoDir,
          "--sandbox",
          "enabled",
          "--model",
          "gpt-5-cursor"
        ])
      );
      expect(argv).not.toContain("--force");
      expect(prompt).toContain("## Agentflow Runtime Contract");
      expect(prompt).toContain("You are executing one node in an Agentflow graph.");
      expect(prompt).toContain("Future nodes can consume only named artifacts");
      expect(prompt).toContain("## Node Task");
      expect(prompt).toContain("Review the change.");
      expect(prompt).toContain("Exact context packet");
      expect(prompt).toContain(join(executionDir, "context", "packet.json"));
      expect(prompt).toContain("Read first");
      expect(prompt).toContain(join(executionDir, "context", "manifest.md"));
      expect(prompt).toContain("## Artifact Contract");
      expect(prompt).toContain("Every declared artifact must exist before you finish");
      expect(prompt).toContain("`review_report` (from `output_dir`)");
      expect(prompt).toContain("$AGENTFLOW_OUTPUT_DIR/review-report.md");
      expect(prompt).toContain("Expected content: Markdown review report for downstream nodes.");
      expect(prompt).toContain("## Final Response Requirements");
      expect(prompt).toContain("captured by Agentflow as the reserved `agent_response` artifact");
      expect(env).toEqual({
        AGENTFLOW_WORKSPACE: repoDir,
        AGENTFLOW_OUTPUT_DIR: outputDir,
        AGENTFLOW_CONTEXT_PACKET: join(executionDir, "context", "packet.json"),
        AGENTFLOW_CONTEXT_MANIFEST: join(executionDir, "context", "manifest.md")
      });
      expect(result.outputJson).toEqual({
        passed: true,
        summary: "cursor ok"
      });
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

      if (previousEnvPath === undefined) {
        delete process.env.MOCK_ENV_PATH;
      } else {
        process.env.MOCK_ENV_PATH = previousEnvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("forces cursor writes only for writable sandboxes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-harness-force-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCursorBinary(tempRoot);
    const harness = createCursorCliHarness({
      binary: mock.binary_path
    });

    const previousArgvPath = process.env.MOCK_ARGV_PATH;
    process.env.MOCK_ARGV_PATH = mock.argv_path;

    try {
      await harness.run({
        runId: "run-2",
        executionId: "exec-2",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-cursor",
        prompt: "Apply the change.",
        contextPacketPath: join(executionDir, "context", "packet.json"),
        contextManifestPath: join(executionDir, "context", "manifest.md"),
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined
      });

      const argv = JSON.parse(await readFile(mock.argv_path, "utf8")) as string[];

      expect(argv).toEqual(
        expect.arrayContaining([
          "--sandbox",
          "enabled",
          "--force"
        ])
      );
    } finally {
      if (previousArgvPath === undefined) {
        delete process.env.MOCK_ARGV_PATH;
      } else {
        process.env.MOCK_ARGV_PATH = previousArgvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("streams stdout and stderr chunks while buffering the final result", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-streaming-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const harness = createCursorCliHarness({
      binary: await createStreamingCursorBinary(tempRoot)
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    try {
      const result = await harness.run({
        runId: "run-stream",
        executionId: "exec-stream",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "read-only",
        model: "gpt-5-cursor",
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

      expect(stdoutChunks.join("")).toContain("cursor-one");
      expect(stdoutChunks.join("")).toContain("cursor-two");
      expect(stderrChunks.join("")).toContain("cursor-warn");
      expect(result.stdout).toContain("cursor-one");
      expect(result.stdout).toContain("cursor-two");
      expect(result.stderr).toContain("cursor-warn");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
