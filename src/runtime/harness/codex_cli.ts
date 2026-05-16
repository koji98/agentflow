import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getHarnessCapabilities } from "../../graph/harness_capabilities.js";
import { createProcessTerminationController } from "../process_control.js";
import { startSpawnBroker } from "./spawn_broker.js";
import {
  buildHarnessSpawnEnv,
  collectMissingHarnessBinaryDiagnostics,
  normalizeHarnessLaunchError,
  renderHarnessPrompt,
  deriveHarnessExecutionRoot,
  resolveCliBinary,
  type AgentInvocation,
  type HarnessAdapter,
  type HarnessResult
} from "./types.js";

export interface CodexCliHarnessOptions {
  binary?: string;
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isTrustCheckPrompt(invocation: AgentInvocation): boolean {
  return (
    invocation.promptKind === "ai_check" ||
    invocation.promptKind === "outcome_verification" ||
    invocation.promptKind === "supervisor_evidence"
  );
}

function resolveHarnessConfig(invocation: AgentInvocation): NonNullable<AgentInvocation["harnessConfig"]> {
  if (isTrustCheckPrompt(invocation)) {
    return {
      isolation: "isolated"
    };
  }

  return invocation.harnessConfig ?? {
    isolation: "isolated"
  };
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function formatTomlValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => formatTomlValue(item)).join(", ")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, itemValue]) => itemValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{ ${entries.map(([key, itemValue]) => `${formatTomlKey(key)} = ${formatTomlValue(itemValue)}`).join(", ")} }`;
  }

  return String(value);
}

function pushCodexConfigArgs(args: string[], config: NonNullable<AgentInvocation["harnessConfig"]>): void {
  const codexConfig = config.codex;
  if (!codexConfig) {
    return;
  }

  Object.entries(codexConfig.config ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, value]) => {
      args.push("-c", `${formatTomlKey(key)}=${formatTomlValue(value)}`);
    });

  if (codexConfig.mcp_servers !== undefined) {
    args.push("-c", `mcp_servers=${formatTomlValue(codexConfig.mcp_servers)}`);
  }

  if (codexConfig.plugins !== undefined) {
    args.push("-c", `plugins=${formatTomlValue(codexConfig.plugins)}`);
  }

  if (codexConfig.notify !== undefined) {
    args.push("-c", `notify=${formatTomlValue(codexConfig.notify)}`);
  }
}

function buildCodexSpawnEnv(invocation: AgentInvocation, codexHomePath?: string): NodeJS.ProcessEnv {
  const env = buildHarnessSpawnEnv(invocation);

  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_") && key !== "CODEX_HOME") {
      delete env[key];
    }
  }

  if (codexHomePath) {
    env.CODEX_HOME = codexHomePath;
  }

  return env;
}

async function prepareIsolatedCodexHome(invocation: AgentInvocation): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const codexHome = await mkdtemp(join(tmpdir(), "agentflow-codex-home-"));
  const sourceCodexHome = invocation.baseEnv?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");

  try {
    await symlink(join(sourceCodexHome, "auth.json"), join(codexHome, "auth.json"));
  } catch {
    // Missing auth is reported by codex itself; the harness should not invent a second readiness path.
  }

  await writeFile(
    join(codexHome, "config.toml"),
    [
      `sandbox_mode = ${JSON.stringify(invocation.sandbox)}`,
      "",
      "[sandbox_workspace_write]",
      "network_access = true",
      "",
      `[projects.${JSON.stringify(invocation.repoPath)}]`,
      'trust_level = "trusted"'
    ].join("\n"),
    "utf8"
  );

  return {
    path: codexHome,
    cleanup() {
      return rm(codexHome, { recursive: true, force: true });
    }
  };
}

function buildCodexArgs(
  invocation: AgentInvocation,
  harnessConfig: NonNullable<AgentInvocation["harnessConfig"]>
): {
  args: string[];
  last_message_path: string;
} {
  const last_message_path = join(invocation.outputDir, "last_message.txt");
  const executionRoot = deriveHarnessExecutionRoot(invocation.outputDir);
  const addedDirs = new Set<string>();
  const pushAddDir = (path: string | undefined) => {
    if (!path || addedDirs.has(path)) {
      return;
    }
    addedDirs.add(path);
    args.push("--add-dir", path);
  };
  const args = [
    "exec",
    "--cd",
    invocation.repoPath,
    "--sandbox",
    invocation.sandbox
  ];
  pushAddDir(executionRoot);
  pushAddDir(invocation.outputDir);
  pushAddDir(invocation.runtimeDir);
  args.push("--output-last-message", last_message_path);
  pushCodexConfigArgs(args, harnessConfig);

  if (invocation.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }

  if (invocation.model && invocation.model !== "auto") {
    args.push("-m", invocation.model);
  }

  if (invocation.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${invocation.reasoningEffort}"`);
  }

  args.push("-");
  return {
    args,
    last_message_path
  };
}

export function createCodexCliHarness(
  options: CodexCliHarnessOptions = {}
): HarnessAdapter {
  const active_processes = new Map<string, () => void>();
  const binary = resolveCliBinary(options.binary, "AGENTFLOW_CODEX_CLI_BIN", "codex");

  return {
    kind: "codex-cli",
    capabilities: getHarnessCapabilities("codex-cli")!,
    checkReadiness() {
      return collectMissingHarnessBinaryDiagnostics(
        "codex-cli",
        binary,
        "AGENTFLOW_CODEX_CLI_BIN"
      );
    },
    async run(invocation: AgentInvocation): Promise<HarnessResult> {
      await mkdir(invocation.outputDir, { recursive: true });
      const harnessConfig = resolveHarnessConfig(invocation);
      const { args, last_message_path } = buildCodexArgs(invocation, harnessConfig);
      const prompt = renderHarnessPrompt(invocation);
      if (invocation.promptPath) {
        await mkdir(dirname(invocation.promptPath), { recursive: true });
        await writeFile(invocation.promptPath, `${prompt}\n`, "utf8");
      }
      const spawnBroker = startSpawnBroker(invocation);
      const codexHome = harnessConfig.isolation === "isolated"
        ? await prepareIsolatedCodexHome(invocation)
        : undefined;

      return new Promise<HarnessResult>((resolve, reject) => {
        const child = spawn(binary, args, {
          cwd: invocation.repoPath,
          env: buildCodexSpawnEnv(invocation, codexHome?.path),
          stdio: ["pipe", "pipe", "pipe"]
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        const termination = createProcessTerminationController(child);
        active_processes.set(invocation.executionId, () => termination.requestCancel());
        const timeout =
          invocation.timeoutSec > 0
            ? setTimeout(() => {
                termination.requestTimeout();
              }, invocation.timeoutSec * 1000)
            : undefined;
        const onAbort = () => {
          termination.requestCancel();
        };

        invocation.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
          stdoutChunks.push(chunk);
          invocation.onStdoutChunk?.(chunk.toString("utf8"));
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrChunks.push(chunk);
          invocation.onStderrChunk?.(chunk.toString("utf8"));
        });
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          stderrChunks.push(Buffer.from(`\n[codex-cli stdin error] ${error.message}\n`));
        });
        child.on("error", (error) => {
          if (timeout) {
            clearTimeout(timeout);
          }

          termination.dispose();
          spawnBroker.stop();
          void codexHome?.cleanup();
          invocation.signal?.removeEventListener("abort", onAbort);
          active_processes.delete(invocation.executionId);
          reject(
            normalizeHarnessLaunchError(
              error,
              "codex-cli",
              binary,
              "AGENTFLOW_CODEX_CLI_BIN"
            )
          );
        });
        child.on("close", async (code) => {
          if (timeout) {
            clearTimeout(timeout);
          }

          termination.dispose();
          spawnBroker.stop();
          await codexHome?.cleanup();
          invocation.signal?.removeEventListener("abort", onAbort);
          active_processes.delete(invocation.executionId);
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          const stderr = Buffer.concat(stderrChunks).toString("utf8");
          let last_message: string | undefined;

          try {
            last_message = await readFile(last_message_path, "utf8");
          } catch {
            last_message = undefined;
          }

          const output_json = parseJsonRecord(last_message) ?? parseJsonRecord(stdout);

          resolve({
            status:
              termination.state.canceled
                ? "canceled"
                : code === 0 && !termination.state.timed_out
                  ? "passed"
                  : "failed",
            exitCode: typeof code === "number" ? code : 1,
            ...(stdout ? { stdout } : {}),
            ...(stderr ? { stderr } : {}),
            metadata: {
              binary,
              args,
              timed_out: termination.state.timed_out,
              force_killed: termination.state.force_killed
            },
            transcript: {
              last_message_path,
              ...(last_message ? { last_message } : {})
            },
            ...(output_json ? { outputJson: output_json } : {})
          });
        });

        child.stdin.end(prompt);
      });
    },
    async cancel(executionId: string): Promise<void> {
      active_processes.get(executionId)?.();
    }
  };
}
