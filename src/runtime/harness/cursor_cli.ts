import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getHarnessCapabilities } from "../../graph/harness_capabilities.js";
import { createAuthorityRequest } from "../authority.js";
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

export interface CursorCliHarnessOptions {
  binary?: string;
  sandboxUnavailableMaxRetries?: number;
  sandboxUnavailableRetryDelayMs?: number;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfigRecords(
  base: Record<string, unknown>,
  overlay: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!overlay) {
    return base;
  }

  const merged: Record<string, unknown> = { ...base };
  Object.entries(overlay).forEach(([key, value]) => {
    const baseValue = merged[key];
    merged[key] =
      isPlainRecord(baseValue) && isPlainRecord(value)
        ? mergeConfigRecords(baseValue, value)
        : value;
  });
  return merged;
}

function createCursorOutputFailure(message: string): Error {
  return new Error(`Cursor CLI structured output failed: ${message}`);
}

function isCursorSandboxUnavailable(message: string | undefined): boolean {
  return /sandbox mode is enabled but not available on this system/iu.test(message ?? "");
}

function normalizeRetryCount(value: number | undefined): number {
  return value === undefined ? 1 : Math.max(0, Math.floor(value));
}

function normalizeRetryDelayMs(value: number | undefined): number {
  return value === undefined ? 7 * 60 * 1000 : Math.max(0, Math.floor(value));
}

async function waitForRetryDelay(options: {
  delayMs: number;
  executionId: string;
  signal: AbortSignal | undefined;
  activeProcesses: Map<string, () => void>;
}): Promise<"ready" | "canceled"> {
  if (options.signal?.aborted) {
    return "canceled";
  }

  if (options.delayMs === 0) {
    return "ready";
  }

  return new Promise<"ready" | "canceled">((resolve) => {
    let settled = false;
    const finish = (result: "ready" | "canceled") => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      options.activeProcesses.delete(options.executionId);
      resolve(result);
    };
    const cancel = () => finish("canceled");
    const timer = setTimeout(() => finish("ready"), options.delayMs);

    options.activeProcesses.set(options.executionId, cancel);
    options.signal?.addEventListener("abort", cancel, { once: true });
  });
}

function normalizeCursorOutput(stdout: string, exitCode: number): {
  output_json?: Record<string, unknown>;
  last_message?: string;
  error?: string;
} {
  const output_json = parseJsonRecord(stdout);

  if (!output_json) {
    return {
      error: "stdout was not a JSON object."
    };
  }

  const subtype = typeof output_json.subtype === "string" ? output_json.subtype : undefined;
  const is_error = output_json.is_error === true;
  const result = typeof output_json.result === "string" ? output_json.result : undefined;

  if (exitCode !== 0) {
    return {
      output_json,
      ...(result ? { last_message: result } : {}),
      error: `process exited with code ${exitCode}.`
    };
  }

  if (is_error) {
    return {
      output_json,
      ...(result ? { last_message: result } : {}),
      error: "JSON envelope reported is_error=true."
    };
  }

  if (subtype && subtype !== "success") {
    return {
      output_json,
      ...(result ? { last_message: result } : {}),
      error: `JSON envelope subtype was "${subtype}", expected "success".`
    };
  }

  if (!result) {
    return {
      output_json,
      error: "JSON envelope did not include a string result field."
    };
  }

  return {
    output_json,
    last_message: result
  };
}

function mapCursorSandbox(
  sandbox: AgentInvocation["sandbox"]
): "enabled" | "disabled" {
  return sandbox === "danger-full-access" ? "disabled" : "enabled";
}

function buildCursorArgs(
  invocation: AgentInvocation,
  harnessConfig: NonNullable<AgentInvocation["harnessConfig"]>,
  prompt: string
): string[] {
  const cursorHarness = harnessConfig.cursor;
  const args = [
    "-p",
    "--output-format",
    "json",
    "--workspace",
    invocation.repoPath,
    "--sandbox",
    cursorHarness?.sandbox_mode ?? mapCursorSandbox(invocation.sandbox)
  ];

  if (invocation.sandbox !== "read-only") {
    args.push("--force");
  }

  if (invocation.model && invocation.model !== "auto") {
    args.push("--model", invocation.model);
  }

  if (cursorHarness?.approve_mcps === true) {
    args.push("--approve-mcps");
  }

  if (cursorHarness?.trust_workspace === true) {
    args.push("--trust");
  }

  args.push(prompt);
  return args;
}

function redactPromptArg(args: string[]): string[] {
  return args.map((arg, index) => index === args.length - 1 ? "<prompt:redacted>" : arg);
}

function cursorPermissionEntry(kind: "Read" | "Write", path: string): string {
  return `${kind}(${path})`;
}

async function createCursorConfig(
  invocation: AgentInvocation,
  harnessConfig: NonNullable<AgentInvocation["harnessConfig"]>
): Promise<{
  config_dir: string;
  cli_config_path: string;
}> {
  const executionRoot = deriveHarnessExecutionRoot(invocation.outputDir);
  const config_dir = join(invocation.outputDir, ".cursor-config");
  const cli_config_path = join(config_dir, "cli.json");
  const allow = [
    cursorPermissionEntry("Read", `${invocation.repoPath}/**`),
    cursorPermissionEntry("Read", invocation.contextPacketPath),
    cursorPermissionEntry("Read", invocation.contextManifestPath),
    cursorPermissionEntry("Read", `${executionRoot}/**`),
    ...(invocation.runtimeDir ? [cursorPermissionEntry("Read", `${invocation.runtimeDir}/**`)] : [])
  ];
  const deny =
    invocation.promptKind === "ai_check"
    || invocation.promptKind === "outcome_verification"
    || invocation.sandbox === "read-only"
      ? [
          "Write(*)",
          "Shell(*)",
          "WebFetch(*)",
          "Mcp(*:*)"
        ]
      : [];
  const writeAllow = invocation.sandbox === "read-only"
    ? []
    : [
        cursorPermissionEntry("Write", `${invocation.repoPath}/**`),
        cursorPermissionEntry("Write", `${executionRoot}/**`),
        ...(invocation.runtimeDir ? [cursorPermissionEntry("Write", `${invocation.runtimeDir}/**`)] : [])
      ];
  const declaredPermissions = harnessConfig.cursor?.permissions;
  const config = mergeConfigRecords(
    {
      version: 1,
      editor: {
        vimMode: false
      }
    },
    harnessConfig.cursor?.config
  );

  await mkdir(config_dir, { recursive: true });
  await writeFile(
    cli_config_path,
    `${JSON.stringify({
      ...config,
      permissions: {
        allow: [...allow, ...writeAllow, ...(declaredPermissions?.allow ?? [])],
        deny: [...deny, ...(declaredPermissions?.deny ?? [])]
      }
    }, null, 2)}\n`,
    "utf8"
  );

  return { config_dir, cli_config_path };
}

export function createCursorCliHarness(
  options: CursorCliHarnessOptions = {}
): HarnessAdapter {
  const active_processes = new Map<string, () => void>();
  const binary = resolveCliBinary(options.binary, "AGENTFLOW_CURSOR_CLI_BIN", "agent");

  return {
    kind: "cursor-cli",
    capabilities: getHarnessCapabilities("cursor-cli")!,
    checkReadiness() {
      return collectMissingHarnessBinaryDiagnostics(
        "cursor-cli",
        binary,
        "AGENTFLOW_CURSOR_CLI_BIN"
      );
    },
    async run(invocation: AgentInvocation): Promise<HarnessResult> {
      await mkdir(invocation.outputDir, { recursive: true });
      const harnessConfig = resolveHarnessConfig(invocation);
      const prompt = renderHarnessPrompt(invocation);
      if (invocation.promptPath) {
        await mkdir(dirname(invocation.promptPath), { recursive: true });
        await writeFile(invocation.promptPath, `${prompt}\n`, "utf8");
      }
      const cursorConfig = harnessConfig.isolation === "isolated"
        ? await createCursorConfig(invocation, harnessConfig)
        : undefined;
      const args = buildCursorArgs(invocation, harnessConfig, prompt);
      const metadataArgs = redactPromptArg(args);
      const sandboxUnavailableMaxRetries = normalizeRetryCount(options.sandboxUnavailableMaxRetries);
      const sandboxUnavailableRetryDelayMs = normalizeRetryDelayMs(options.sandboxUnavailableRetryDelayMs);

      const runOnce = () => new Promise<HarnessResult>((resolve, reject) => {
        const spawnBroker = startSpawnBroker(invocation);
        const child = spawn(binary, args, {
          cwd: invocation.repoPath,
          env: {
            ...buildHarnessSpawnEnv(invocation),
            ...(cursorConfig ? { CURSOR_CONFIG_DIR: cursorConfig.config_dir } : {})
          },
          stdio: ["ignore", "pipe", "pipe"]
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
        child.on("error", (error) => {
          if (timeout) {
            clearTimeout(timeout);
          }

          termination.dispose();
          spawnBroker.stop();
          invocation.signal?.removeEventListener("abort", onAbort);
          active_processes.delete(invocation.executionId);
          reject(
            normalizeHarnessLaunchError(
              error,
              "cursor-cli",
              binary,
              "AGENTFLOW_CURSOR_CLI_BIN"
            )
          );
        });
        child.on("close", (code) => {
          if (timeout) {
            clearTimeout(timeout);
          }

          termination.dispose();
          spawnBroker.stop();
          invocation.signal?.removeEventListener("abort", onAbort);
          active_processes.delete(invocation.executionId);
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          const stderr = Buffer.concat(stderrChunks).toString("utf8");
          const exitCode = typeof code === "number" ? code : 1;
          const cursorOutput = normalizeCursorOutput(stdout, exitCode);
          const structuredOutputError =
            !termination.state.canceled && !termination.state.timed_out
              ? cursorOutput.error
              : undefined;
          const stderrTail = stderr.trim().split(/\r?\n/u).slice(-20).join("\n");
          const structuredOutputMessage =
            structuredOutputError && stderrTail
              ? `${structuredOutputError}\nCursor CLI stderr:\n${stderrTail}`
              : structuredOutputError;
          const authorityRequests =
            structuredOutputMessage && /authentication required|cursor agent login|cursor_api_key/iu.test(structuredOutputMessage)
              ? [
                  createAuthorityRequest({
                    kind: "missing_harness_auth",
                    source: "harness",
                    request_id: `${invocation.executionId}__missing_harness_auth`,
                    summary: "Cursor CLI requires login or CURSOR_API_KEY before this harness can run.",
                    evidence: {
                      harness: "cursor-cli"
                    }
                  })
                ]
              : [];
          const sandboxUnavailable = isCursorSandboxUnavailable(structuredOutputMessage);
          resolve({
            status:
              termination.state.canceled
                ? "canceled"
                : exitCode === 0 && !termination.state.timed_out && !structuredOutputError
                  ? "passed"
                  : "failed",
            exitCode,
            ...(stdout ? { stdout } : {}),
            ...(stderr ? { stderr } : {}),
            metadata: {
              binary,
              args: metadataArgs,
              ...(cursorConfig
                ? {
                    cursor_config_dir: cursorConfig.config_dir,
                    cursor_cli_config_path: cursorConfig.cli_config_path
                  }
                : {}),
              timed_out: termination.state.timed_out,
              force_killed: termination.state.force_killed,
              ...(authorityRequests.length > 0 ? { authority_requests: authorityRequests } : {}),
              ...(sandboxUnavailable
                ? {
                    failure_code: "harness_configuration_unsupported",
                    failure_details: {
                      harness: "cursor-cli",
                      reason: "sandbox_mode_unavailable",
                      requested_sandbox: harnessConfig.cursor?.sandbox_mode ?? mapCursorSandbox(invocation.sandbox)
                    }
                  }
                : {}),
              ...(structuredOutputMessage ? { error: createCursorOutputFailure(structuredOutputMessage).message } : {})
            },
            ...(cursorOutput.last_message
              ? {
                  transcript: {
                    last_message: cursorOutput.last_message
                  }
                }
              : {}),
            ...(cursorOutput.output_json ? { outputJson: cursorOutput.output_json } : {})
          });
        });
      });

      let sandboxUnavailableRetries = 0;
      while (true) {
        const result = await runOnce();
        const sandboxUnavailable =
          result.metadata?.failure_code === "harness_configuration_unsupported" &&
          isPlainRecord(result.metadata.failure_details) &&
          result.metadata.failure_details.reason === "sandbox_mode_unavailable";

        if (
          sandboxUnavailable &&
          result.status !== "canceled" &&
          sandboxUnavailableRetries < sandboxUnavailableMaxRetries
        ) {
          sandboxUnavailableRetries += 1;
          const waitResult = await waitForRetryDelay({
            delayMs: sandboxUnavailableRetryDelayMs,
            executionId: invocation.executionId,
            signal: invocation.signal,
            activeProcesses: active_processes
          });

          if (waitResult === "canceled") {
            return {
              status: "canceled",
              exitCode: 1,
              metadata: {
                binary,
                args: metadataArgs,
                cursor_sandbox_unavailable_retry: {
                  attempts: sandboxUnavailableRetries,
                  delay_ms: sandboxUnavailableRetryDelayMs,
                  canceled: true
                }
              }
            };
          }

          continue;
        }

        if (sandboxUnavailableRetries === 0) {
          return result;
        }

        return {
          ...result,
          metadata: {
            ...(result.metadata ?? {}),
            cursor_sandbox_unavailable_retry: {
              attempts: sandboxUnavailableRetries,
              delay_ms: sandboxUnavailableRetryDelayMs,
              exhausted: sandboxUnavailable
            }
          }
        };
      }
    },
    async cancel(executionId: string): Promise<void> {
      active_processes.get(executionId)?.();
    }
  };
}
