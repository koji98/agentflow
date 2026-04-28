import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getHarnessCapabilities } from "../../graph/harness_capabilities.js";
import { createProcessTerminationController } from "../process_control.js";
import { startSpawnBroker } from "./spawn_broker.js";
import {
  buildHarnessSpawnEnv,
  collectMissingHarnessBinaryDiagnostics,
  normalizeHarnessLaunchError,
  renderHarnessPrompt,
  resolveCliBinary,
  type AgentInvocation,
  type HarnessAdapter,
  type HarnessResult
} from "./types.js";

export interface CursorCliHarnessOptions {
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

function createCursorOutputFailure(message: string): Error {
  return new Error(`Cursor CLI structured output failed: ${message}`);
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

function buildCursorArgs(invocation: AgentInvocation): string[] {
  const prompt = renderHarnessPrompt(invocation);
  const args = [
    "-p",
    "--output-format",
    "json",
    "--workspace",
    invocation.repoPath,
    "--sandbox",
    mapCursorSandbox(invocation.sandbox)
  ];

  if (invocation.sandbox !== "read-only") {
    args.push("--force");
  }

  if (invocation.model && invocation.model !== "auto") {
    args.push("--model", invocation.model);
  }

  args.push(prompt);
  return args;
}

function cursorPermissionEntry(kind: "Read" | "Write", path: string): string {
  return `${kind}(${path})`;
}

async function createCursorConfig(invocation: AgentInvocation): Promise<{
  config_dir: string;
  cli_config_path: string;
}> {
  const config_dir = join(invocation.outputDir, ".cursor-config");
  const cli_config_path = join(config_dir, "cli.json");
  const allow = [
    cursorPermissionEntry("Read", `${invocation.repoPath}/**`),
    cursorPermissionEntry("Read", invocation.contextPacketPath),
    cursorPermissionEntry("Read", invocation.contextManifestPath),
    cursorPermissionEntry("Read", `${invocation.outputDir}/**`),
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
        cursorPermissionEntry("Write", `${invocation.outputDir}/**`),
        ...(invocation.runtimeDir ? [cursorPermissionEntry("Write", `${invocation.runtimeDir}/**`)] : [])
      ];

  await mkdir(config_dir, { recursive: true });
  await writeFile(
    cli_config_path,
    `${JSON.stringify({
      version: 1,
      editor: {
        vimMode: false
      },
      permissions: {
        allow: [...allow, ...writeAllow],
        deny
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
      const args = buildCursorArgs(invocation);
      const cursorConfig = await createCursorConfig(invocation);
      const spawnBroker = startSpawnBroker(invocation);

      return new Promise<HarnessResult>((resolve, reject) => {
        const child = spawn(binary, args, {
          cwd: invocation.repoPath,
          env: {
            ...buildHarnessSpawnEnv(invocation),
            CURSOR_CONFIG_DIR: cursorConfig.config_dir
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
              args,
              cursor_config_dir: cursorConfig.config_dir,
              cursor_cli_config_path: cursorConfig.cli_config_path,
              timed_out: termination.state.timed_out,
              force_killed: termination.state.force_killed,
              ...(structuredOutputError ? { error: createCursorOutputFailure(structuredOutputError).message } : {})
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
    },
    async cancel(executionId: string): Promise<void> {
      active_processes.get(executionId)?.();
    }
  };
}
