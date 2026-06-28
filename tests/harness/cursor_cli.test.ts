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
    AGENTFLOW_CONTEXT_MANIFEST: process.env.AGENTFLOW_CONTEXT_MANIFEST,
    CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR
  }, null, 2));
}

process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1234,
  result: process.env.MOCK_CURSOR_RESULT || "cursor final response",
  session_id: "session-1"
}));
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

  it("fails closed on malformed cursor JSON output", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-malformed-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });
    const binary_path = join(tempRoot, "malformed-agent.mjs");
    await writeFile(binary_path, "#!/usr/bin/env node\nprocess.stdout.write('not-json');\n");
    await chmod(binary_path, 0o755);

    try {
      const result = await createCursorCliHarness({
        binary: binary_path,
        sandboxUnavailableMaxRetries: 0
      }).run({
        runId: "run-malformed",
        executionId: "exec-malformed",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "read-only",
        model: "gpt-5-cursor",
        nodeGoal: "Return malformed.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
        harnessConfig: {
          isolation: "isolated"
        }
      });

      expect(result.status).toBe("failed");
      expect(result.metadata?.error).toContain("stdout was not a JSON object");
      expect(result.outputJson).toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("includes stderr in structured output failures", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-stderr-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });
    const binary_path = join(tempRoot, "stderr-agent.mjs");
    await writeFile(
      binary_path,
      "#!/usr/bin/env node\nprocess.stderr.write('Sandbox mode is enabled but not available on this system.\\n'); process.exit(1);\n"
    );
    await chmod(binary_path, 0o755);

    try {
      const result = await createCursorCliHarness({
        binary: binary_path,
        sandboxUnavailableMaxRetries: 0
      }).run({
        runId: "run-stderr",
        executionId: "exec-stderr",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-cursor",
        nodeGoal: "Fail with stderr.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined
      });

      expect(result.status).toBe("failed");
      expect(result.metadata?.error).toContain("stdout was not a JSON object");
      expect(result.metadata?.error).toContain("Sandbox mode is enabled but not available");
      expect(result.metadata?.failure_code).toBe("harness_configuration_unsupported");
      expect(result.metadata?.failure_details).toEqual(expect.objectContaining({
        harness: "cursor-cli",
        reason: "sandbox_mode_unavailable",
        requested_sandbox: "enabled"
      }));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("retries transient cursor sandbox availability failures before failing the node", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-sandbox-retry-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    const countPath = join(tempRoot, "attempt-count.txt");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });
    const binary_path = join(tempRoot, "sandbox-retry-agent.mjs");
    await writeFile(
      binary_path,
      `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const countPath = process.env.MOCK_CURSOR_ATTEMPT_COUNT_PATH;
const prior = countPath && existsSync(countPath) ? Number.parseInt(readFileSync(countPath, "utf8"), 10) : 0;
const next = Number.isFinite(prior) ? prior + 1 : 1;
if (countPath) {
  writeFileSync(countPath, String(next));
}

if (next === 1) {
  process.stderr.write("Sandbox mode is enabled but not available on this system.\\n");
  process.exit(1);
}

process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "cursor succeeded after retry"
}));
`
    );
    await chmod(binary_path, 0o755);

    const previousCountPath = process.env.MOCK_CURSOR_ATTEMPT_COUNT_PATH;
    process.env.MOCK_CURSOR_ATTEMPT_COUNT_PATH = countPath;

    try {
      const result = await createCursorCliHarness({
        binary: binary_path,
        sandboxUnavailableRetryDelayMs: 0
      }).run({
        runId: "run-sandbox-retry",
        executionId: "exec-sandbox-retry",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-cursor",
        nodeGoal: "Retry transient sandbox launch failure.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined
      });

      expect(result.status).toBe("passed");
      expect(result.transcript?.last_message).toBe("cursor succeeded after retry");
      expect(result.metadata?.cursor_sandbox_unavailable_retry).toEqual({
        attempts: 1,
        delay_ms: 0,
        exhausted: false
      });
      await expect(readFile(countPath, "utf8")).resolves.toBe("2");
    } finally {
      if (previousCountPath === undefined) {
        delete process.env.MOCK_CURSOR_ATTEMPT_COUNT_PATH;
      } else {
        process.env.MOCK_CURSOR_ATTEMPT_COUNT_PATH = previousCountPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits a typed authority request for cursor harness authentication failures", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-auth-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });
    const binary_path = join(tempRoot, "auth-agent.mjs");
    await writeFile(
      binary_path,
      "#!/usr/bin/env node\nprocess.stderr.write('Authentication required: run cursor agent login or set CURSOR_API_KEY.\\n'); process.exit(1);\n"
    );
    await chmod(binary_path, 0o755);

    try {
      const result = await createCursorCliHarness({ binary: binary_path }).run({
        runId: "run-auth",
        executionId: "exec-auth",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-cursor",
        nodeGoal: "Fail with auth.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined
      });

      expect(result.status).toBe("failed");
      expect(result.metadata?.authority_requests).toEqual([
        expect.objectContaining({
          kind: "missing_harness_auth",
          source: "harness",
          request_id: "exec-auth__missing_harness_auth",
          summary: "Cursor CLI requires login or CURSOR_API_KEY before this harness can run."
        })
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on cursor JSON envelopes without successful result text", async () => {
    const cases = [
      {
        name: "missing-result",
        payload: { type: "result", subtype: "success", is_error: false },
        expected: "result field"
      },
      {
        name: "error-envelope",
        payload: { type: "result", subtype: "success", is_error: true, result: "failed" },
        expected: "is_error=true"
      },
      {
        name: "non-success-subtype",
        payload: { type: "result", subtype: "error", is_error: false, result: "failed" },
        expected: 'subtype was "error"'
      }
    ];

    for (const testCase of cases) {
      const tempRoot = await mkdtemp(join(tmpdir(), `agentflow-cursor-${testCase.name}-`));
      const repoDir = join(tempRoot, "repo");
      const executionDir = join(tempRoot, "execution");
      await mkdir(repoDir, { recursive: true });
      await mkdir(executionDir, { recursive: true });
      const binary_path = join(tempRoot, "agent.mjs");
      await writeFile(
        binary_path,
        `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(testCase.payload))});\n`
      );
      await chmod(binary_path, 0o755);

      try {
        const result = await createCursorCliHarness({ binary: binary_path }).run({
          runId: `run-${testCase.name}`,
          executionId: `exec-${testCase.name}`,
          repoAlias: "main",
          repoPath: repoDir,
          sandbox: "read-only",
          model: "gpt-5-cursor",
          nodeGoal: "Return envelope.",
          contextPacketPath: join(executionDir, "runtime", "context.json"),
          contextManifestPath: join(executionDir, "agent", "context.md"),
          contextManifest: "",
          outputDir: executionDir,
          artifacts: {},
          timeoutSec: 10,
          signal: undefined
        });

        expect(result.status).toBe("failed");
        expect(result.metadata?.error).toContain(testCase.expected);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
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
        nodeGoal: "Review the change.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "# Context Manifest\n\n## Pointers\n\n| Name | Kind | Pointer | What | Why |\n| --- | --- | --- | --- | --- |\n| `requirements` | `workspace_file` | `/tmp/requirements.md` | Requirements. | Needed for this node. |\n",
        outputDir,
        artifacts: {
          review_report: {
            from: "output_dir",
            path: "review-report.md",
            description: "Markdown review report for downstream nodes."
          }
        },
        timeoutSec: 10,
        signal: undefined,
        harnessConfig: {
          isolation: "isolated"
        }
      });

      const argv = JSON.parse(await readFile(mock.argv_path, "utf8")) as string[];
      const prompt = argv.at(-1) ?? "";
      const env = JSON.parse(await readFile(mock.env_path, "utf8")) as Record<string, string>;

      expect(result.status).toBe("passed");
      expect(argv).toEqual(
        expect.arrayContaining([
          "-p",
          "--output-format",
          "json",
          "--workspace",
          repoDir,
          "--sandbox",
          "enabled",
          "--model",
          "gpt-5-cursor"
        ])
      );
      expect(argv).not.toContain("--force");
      expect(prompt).toContain("## Role");
      expect(prompt).toContain("You are working one graph node as part of a larger mission.");
      expect(prompt).toContain("## Success Contract");
      expect(prompt).toContain("Review the change.");
      expect(prompt).toContain("## Context");
      expect(prompt).toContain("## Pointers");
      expect(prompt).not.toContain("Context packet:");
      expect(prompt).not.toContain(join(executionDir, "runtime", "context.json"));
      expect(prompt).not.toContain("Context provenance:");
      expect(prompt).toContain("Sandbox: read-only");
      expect(prompt).toContain("## Declared Artifacts");
      expect(prompt).toContain("read-only sandbox prevents file writes");
      expect(prompt).toContain("`review_report`");
      expect(prompt).toContain("Markdown review report for downstream nodes.");
      expect(prompt).toContain("## Operating Brief");
      expect(prompt).toContain("Before final response, run `af complete check`");
      expect(env).toEqual({
        AGENTFLOW_WORKSPACE: repoDir,
        AGENTFLOW_OUTPUT_DIR: outputDir,
        AGENTFLOW_CONTEXT_PACKET: join(executionDir, "runtime", "context.json"),
        AGENTFLOW_CONTEXT_MANIFEST: join(executionDir, "agent", "context.md"),
        CURSOR_CONFIG_DIR: join(outputDir, ".cursor-config")
      });
      expect(result.outputJson).toEqual({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        result: "cursor final response",
        session_id: "session-1"
      });
      expect(result.transcript?.last_message).toBe("cursor final response");
      expect(result.metadata).toEqual(
        expect.objectContaining({
          binary: mock.binary_path,
          cursor_config_dir: join(outputDir, ".cursor-config"),
          cursor_cli_config_path: join(outputDir, ".cursor-config", "cli.json"),
          timed_out: false
        })
      );
      const cursorConfig = JSON.parse(
        await readFile(join(outputDir, ".cursor-config", "cli.json"), "utf8")
      ) as { permissions: { allow: string[]; deny: string[] } };
      expect(cursorConfig.permissions.allow).toEqual(
        expect.arrayContaining([
          `Read(${repoDir}/**)`,
          `Read(${join(executionDir, "runtime", "context.json")})`,
          `Read(${join(executionDir, "agent", "context.md")})`,
          `Read(${executionDir}/**)`
        ])
      );
      expect(cursorConfig.permissions.deny).toEqual(
        expect.arrayContaining(["Write(*)", "Shell(*)", "WebFetch(*)", "Mcp(*:*)"])
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

  it("treats model auto as harness default instead of passing a brittle model flag", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-auto-model-"));
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
      const result = await harness.run({
        runId: "run-auto",
        executionId: "exec-auto",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "read-only",
        model: "auto",
        nodeGoal: "Use the harness default model.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
        harnessConfig: {
          isolation: "isolated"
        }
      });

      expect(result.status).toBe("passed");
      const argv = JSON.parse(await readFile(mock.argv_path, "utf8")) as string[];
      expect(argv).not.toContain("--model");
      expect(argv).not.toContain("auto");
    } finally {
      if (previousArgvPath === undefined) {
        delete process.env.MOCK_ARGV_PATH;
      } else {
        process.env.MOCK_ARGV_PATH = previousArgvPath;
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
        nodeGoal: "Apply the change.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
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

  it("allows workspace and output writes in cursor config for writable sandboxes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-config-write-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    const runtimeDir = join(executionDir, "runtime");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCursorBinary(tempRoot);
    const harness = createCursorCliHarness({
      binary: mock.binary_path
    });

    try {
      const result = await harness.run({
        runId: "run-config-write",
        executionId: "exec-config-write",
        repoAlias: "main",
        repoPath: repoDir,
        runtimeDir,
        sandbox: "workspace-write",
        model: "gpt-5-cursor",
        nodeGoal: "Apply the change.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
        harnessConfig: {
          isolation: "isolated"
        }
      });

      expect(result.status).toBe("passed");
      const cursorConfig = JSON.parse(
        await readFile(join(executionDir, ".cursor-config", "cli.json"), "utf8")
      ) as { permissions: { allow: string[]; deny: string[] } };
      expect(cursorConfig.permissions.allow).toEqual(
        expect.arrayContaining([
          `Write(${repoDir}/**)`,
          `Write(${executionDir}/**)`,
          `Write(${runtimeDir}/**)`
        ])
      );
      expect(cursorConfig.permissions.deny).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("merges declared cursor config and permissions into isolated generated config", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-declared-config-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCursorBinary(tempRoot);
    const harness = createCursorCliHarness({
      binary: mock.binary_path
    });

    try {
      const result = await harness.run({
        runId: "run-declared",
        executionId: "exec-declared",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-cursor",
        nodeGoal: "Use declared Cursor config.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
        harnessConfig: {
          isolation: "isolated",
          cursor: {
            config: {
              editor: {
                vimMode: true
              },
              telemetry: {
                enabled: false
              }
            },
            permissions: {
              allow: ["Shell(npm test)"],
              deny: ["WebFetch(*)"]
            }
          }
        }
      });

      expect(result.status).toBe("passed");
      const cursorConfig = JSON.parse(
        await readFile(join(executionDir, ".cursor-config", "cli.json"), "utf8")
      ) as {
        editor: { vimMode: boolean };
        telemetry: { enabled: boolean };
        permissions: { allow: string[]; deny: string[] };
      };

      expect(cursorConfig.editor.vimMode).toBe(true);
      expect(cursorConfig.telemetry.enabled).toBe(false);
      expect(cursorConfig.permissions.allow).toEqual(
        expect.arrayContaining([
          `Read(${repoDir}/**)`,
          `Write(${repoDir}/**)`,
          "Shell(npm test)"
        ])
      );
      expect(cursorConfig.permissions.deny).toEqual(["WebFetch(*)"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("inherits user cursor config by default for normal worker prompts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-inherit-user-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    const userCursorConfigDir = join(tempRoot, "user-cursor-config");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCursorBinary(tempRoot);
    const harness = createCursorCliHarness({
      binary: mock.binary_path
    });

    const previousEnvPath = process.env.MOCK_ENV_PATH;
    process.env.MOCK_ENV_PATH = mock.env_path;

    try {
      const result = await harness.run({
        runId: "run-inherit",
        executionId: "exec-inherit",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-cursor",
        baseEnv: {
          ...process.env,
          CURSOR_CONFIG_DIR: userCursorConfigDir
        },
        nodeGoal: "Use local Cursor configuration.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
      });

      const env = JSON.parse(await readFile(mock.env_path, "utf8")) as Record<string, string>;

      expect(result.status).toBe("passed");
      expect(env.CURSOR_CONFIG_DIR).toBe(userCursorConfigDir);
      expect(result.metadata?.native_harness).toEqual(expect.objectContaining({
        config_isolation: "inherit_user",
        session_id: "session-1"
      }));
      expect(result.metadata).not.toHaveProperty("cursor_config_dir");
    } finally {
      if (previousEnvPath === undefined) {
        delete process.env.MOCK_ENV_PATH;
      } else {
        process.env.MOCK_ENV_PATH = previousEnvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records native Cursor session ids as audit metadata without resuming them", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-native-session-audit-"));
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
      const result = await harness.run({
        runId: "run-native-session-audit",
        executionId: "exec-native-session-audit",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-cursor",
        nodeGoal: "Capture native Cursor session metadata without using it as retry memory.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined
      });

      const argv = JSON.parse(await readFile(mock.argv_path, "utf8")) as string[];

      expect(result.status).toBe("passed");
      expect(argv).not.toContain("--resume");
      expect(argv).not.toContain("--continue");
      expect(result.metadata?.native_harness).toEqual(expect.objectContaining({
        session_id: "session-1"
      }));
      expect(result.metadata?.native_harness).not.toHaveProperty("resume");
    } finally {
      if (previousArgvPath === undefined) {
        delete process.env.MOCK_ARGV_PATH;
      } else {
        process.env.MOCK_ARGV_PATH = previousArgvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps explicit isolated cursor config for normal workers when authored", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-explicit-isolated-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    const userCursorConfigDir = join(tempRoot, "user-cursor-config");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCursorBinary(tempRoot);
    const harness = createCursorCliHarness({
      binary: mock.binary_path
    });

    const previousEnvPath = process.env.MOCK_ENV_PATH;
    process.env.MOCK_ENV_PATH = mock.env_path;

    try {
      const result = await harness.run({
        runId: "run-isolated",
        executionId: "exec-isolated",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-cursor",
        baseEnv: {
          ...process.env,
          CURSOR_CONFIG_DIR: userCursorConfigDir
        },
        nodeGoal: "Use isolated Cursor configuration.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
        harnessConfig: {
          isolation: "isolated"
        }
      });

      const env = JSON.parse(await readFile(mock.env_path, "utf8")) as Record<string, string>;

      expect(result.status).toBe("passed");
      expect(env.CURSOR_CONFIG_DIR).toBe(join(executionDir, ".cursor-config"));
      expect(env.CURSOR_CONFIG_DIR).not.toBe(userCursorConfigDir);
      expect(result.metadata?.native_harness).toEqual(expect.objectContaining({
        config_isolation: "isolated"
      }));
    } finally {
      if (previousEnvPath === undefined) {
        delete process.env.MOCK_ENV_PATH;
      } else {
        process.env.MOCK_ENV_PATH = previousEnvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("forces isolated cursor config for trust-check prompts even when the profile inherits user config", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-trust-check-"));
    const repoDir = join(tempRoot, "repo");
    const executionDir = join(tempRoot, "execution");
    const userCursorConfigDir = join(tempRoot, "user-cursor-config");
    await mkdir(repoDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });

    const mock = await createMockCursorBinary(tempRoot);
    const harness = createCursorCliHarness({
      binary: mock.binary_path
    });

    const previousEnvPath = process.env.MOCK_ENV_PATH;
    process.env.MOCK_ENV_PATH = mock.env_path;

    try {
      const result = await harness.run({
        promptKind: "ai_check",
        runId: "run-trust",
        executionId: "exec-trust",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "read-only",
        model: "gpt-5-cursor",
        baseEnv: {
          ...process.env,
          CURSOR_CONFIG_DIR: userCursorConfigDir
        },
        nodeGoal: "Judge the result.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
        harnessConfig: {
          isolation: "inherit_user",
          cursor: {
            permissions: {
              allow: ["Shell(npm test)"]
            }
          }
        }
      });

      const env = JSON.parse(await readFile(mock.env_path, "utf8")) as Record<string, string>;
      const cursorConfig = JSON.parse(
        await readFile(join(executionDir, ".cursor-config", "cli.json"), "utf8")
      ) as { permissions: { allow: string[]; deny: string[] } };

      expect(result.status).toBe("passed");
      expect(env.CURSOR_CONFIG_DIR).toBe(join(executionDir, ".cursor-config"));
      expect(env.CURSOR_CONFIG_DIR).not.toBe(userCursorConfigDir);
      expect(cursorConfig.permissions.allow).not.toContain("Shell(npm test)");
      expect(cursorConfig.permissions.deny).toEqual(
        expect.arrayContaining(["Write(*)", "Shell(*)", "WebFetch(*)", "Mcp(*:*)"])
      );
    } finally {
      if (previousEnvPath === undefined) {
        delete process.env.MOCK_ENV_PATH;
      } else {
        process.env.MOCK_ENV_PATH = previousEnvPath;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("passes cursor MCP, trust, and sandbox override flags from harness_config", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cursor-mcp-flags-"));
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
        runId: "run-mcp-flags",
        executionId: "exec-mcp-flags",
        repoAlias: "main",
        repoPath: repoDir,
        sandbox: "workspace-write",
        model: "gpt-5-cursor",
        nodeGoal: "Use MCP.",
        contextPacketPath: join(executionDir, "runtime", "context.json"),
        contextManifestPath: join(executionDir, "agent", "context.md"),
        contextManifest: "",
        outputDir: executionDir,
        artifacts: {},
        timeoutSec: 10,
        signal: undefined,
        harnessConfig: {
          isolation: "isolated",
          cursor: {
            sandbox_mode: "disabled",
            approve_mcps: true,
            trust_workspace: true
          }
        }
      });

      const argv = JSON.parse(await readFile(mock.argv_path, "utf8")) as string[];
      expect(argv).toEqual(
        expect.arrayContaining(["--approve-mcps", "--trust"])
      );
      expect(argv).toEqual(
        expect.arrayContaining(["--sandbox", "disabled"])
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
