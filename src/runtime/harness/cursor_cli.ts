import { spawn } from "node:child_process";

import { getHarnessCapabilities } from "../../graph/harness_capabilities.js";
import { createProcessTerminationController } from "../process_control.js";
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
    "text",
    "--workspace",
    invocation.repoPath,
    "--sandbox",
    mapCursorSandbox(invocation.sandbox)
  ];

  if (invocation.sandbox !== "read-only") {
    args.push("--force");
  }

  if (invocation.model) {
    args.push("--model", invocation.model);
  }

  args.push(prompt);
  return args;
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
      const args = buildCursorArgs(invocation);

      return new Promise<HarnessResult>((resolve, reject) => {
        const child = spawn(binary, args, {
          cwd: invocation.repoPath,
          env: buildHarnessSpawnEnv(invocation),
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
          invocation.signal?.removeEventListener("abort", onAbort);
          active_processes.delete(invocation.executionId);
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          const stderr = Buffer.concat(stderrChunks).toString("utf8");
          const output_json = parseJsonRecord(stdout);
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
            ...(output_json ? { outputJson: output_json } : {})
          });
        });
      });
    },
    async cancel(executionId: string): Promise<void> {
      active_processes.get(executionId)?.();
    }
  };
}
