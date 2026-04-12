import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getHarnessCapabilities } from "../../graph/harness_capabilities.js";
import { createProcessTerminationController } from "../process_control.js";
import {
  collectMissingHarnessBinaryDiagnostics,
  normalizeHarnessLaunchError,
  renderHarnessPrompt,
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

function buildCodexArgs(
  invocation: AgentInvocation
): {
  args: string[];
  last_message_path: string;
} {
  const last_message_path = join(invocation.outputDir, "last_message.txt");
  const args = [
    "exec",
    "--sandbox",
    invocation.sandbox,
    "--add-dir",
    invocation.outputDir,
    "--output-last-message",
    last_message_path
  ];

  if (invocation.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }

  if (invocation.model) {
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
      const { args, last_message_path } = buildCodexArgs(invocation);
      const prompt = renderHarnessPrompt(invocation);

      return new Promise<HarnessResult>((resolve, reject) => {
        const child = spawn(binary, args, {
          cwd: invocation.repoPath,
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

        child.stdin.write(prompt);
        child.stdin.end();
      });
    },
    async cancel(executionId: string): Promise<void> {
      active_processes.get(executionId)?.();
    }
  };
}
