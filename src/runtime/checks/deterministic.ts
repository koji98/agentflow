import { spawn } from "node:child_process";

import type { DeterministicPassIf } from "../../graph/authored.js";
import { createProcessTerminationController } from "../process_control.js";

export interface LocalProcessInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string> | undefined;
  timeout_sec: number;
  signal: AbortSignal | undefined;
}

export interface LocalProcessResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  canceled: boolean;
  force_killed: boolean;
}

export interface DeterministicCheckInvocation extends LocalProcessInvocation {
  pass_if: DeterministicPassIf | undefined;
}

export interface DeterministicCheckResult extends LocalProcessResult {
  passed: boolean;
  summary: string;
}

function buildLocalProcessEnv(
  cwd: string,
  envOverrides: Record<string, string> | undefined
): Record<string, string> {
  const baselineKeys =
    process.platform === "win32"
      ? ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "USERPROFILE", "TEMP", "TMP"]
      : ["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM"];
  const env = Object.fromEntries(
    baselineKeys
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );

  if (process.platform !== "win32") {
    env.PWD = cwd;
  }

  return {
    ...env,
    ...(envOverrides ?? {})
  };
}

function evaluateDeterministicPassIf(
  passIf: DeterministicPassIf | undefined,
  processResult: LocalProcessResult
): {
  passed: boolean;
  error?: string;
} {
  if (!passIf || "exit_code" in passIf) {
    const expectedExitCode = passIf?.exit_code ?? 0;
    return {
      passed: processResult.exit_code === expectedExitCode
    };
  }

  if (passIf.json_path !== "$.passed") {
    return {
      passed: false,
      error: `Unsupported deterministic json_path "${passIf.json_path}" in this release.`
    };
  }

  try {
    const parsed = JSON.parse(processResult.stdout || "{}") as Record<string, unknown>;
    return {
      passed: parsed.passed === passIf.equals
    };
  } catch {
    return {
      passed: false,
      error: "Deterministic check stdout was not valid JSON."
    };
  }
}

export async function runLocalProcess(
  invocation: LocalProcessInvocation
): Promise<LocalProcessResult> {
  return new Promise<LocalProcessResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: buildLocalProcessEnv(invocation.cwd, invocation.env),
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const termination = createProcessTerminationController(child);
    const timeout =
      invocation.timeout_sec > 0
        ? setTimeout(() => {
            termination.requestTimeout();
          }, invocation.timeout_sec * 1000)
        : undefined;

    const onAbort = () => {
      termination.requestCancel();
    };

    invocation.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      termination.dispose();
      invocation.signal?.removeEventListener("abort", onAbort);

      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      termination.dispose();
      invocation.signal?.removeEventListener("abort", onAbort);

      if (!settled) {
        settled = true;
        resolve({
          exit_code: typeof code === "number" ? code : 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          timed_out: termination.state.timed_out,
          canceled: termination.state.canceled,
          force_killed: termination.state.force_killed
        });
      }
    });
  });
}

export async function runDeterministicCheck(
  invocation: DeterministicCheckInvocation
): Promise<DeterministicCheckResult> {
  const processResult = await runLocalProcess(invocation);
  const evaluation =
    !processResult.canceled && !processResult.timed_out
      ? evaluateDeterministicPassIf(invocation.pass_if, processResult)
      : {
          passed: false
        };
  const passed = evaluation.passed;

  return {
    ...processResult,
    passed,
    summary: passed
      ? "Deterministic check passed."
      : processResult.canceled
        ? "Deterministic check canceled."
        : processResult.timed_out
          ? "Deterministic check timed out."
          : evaluation.error
            ? evaluation.error
          : "Deterministic check failed."
  };
}
