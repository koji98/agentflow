import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { DeterministicPassIf } from "../../graph/authored.js";
import { createProcessTerminationController } from "../process_control.js";

export interface LocalProcessInvocation {
  command: string;
  args: string[];
  cwd: string;
  env_files?: string[];
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

async function buildLocalProcessEnv(
  cwd: string,
  envFilePaths: string[] | undefined,
  envOverrides: Record<string, string> | undefined
): Promise<Record<string, string>> {
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

  const envFileValues = await loadEnvFiles(cwd, envFilePaths);

  return {
    ...env,
    ...envFileValues,
    ...(envOverrides ?? {})
  };
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function stripTrailingComment(value: string): string {
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (quote) {
      if (character === quote && value[index - 1] !== "\\") {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value;
}

function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  contents.split(/\r?\n/u).forEach((rawLine) => {
    const trimmedLine = rawLine.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      return;
    }

    const line = trimmedLine.startsWith("export ")
      ? trimmedLine.slice("export ".length).trimStart()
      : trimmedLine;
    const equalsIndex = line.indexOf("=");

    if (equalsIndex <= 0) {
      return;
    }

    const key = line.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      return;
    }

    parsed[key] = stripWrappingQuotes(stripTrailingComment(line.slice(equalsIndex + 1).trim()));
  });

  return parsed;
}

async function loadEnvFiles(
  cwd: string,
  envFilePaths: string[] | undefined
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};

  for (const envFilePath of envFilePaths ?? []) {
    const absolutePath = isAbsolute(envFilePath) ? envFilePath : resolve(cwd, envFilePath);
    Object.assign(merged, parseEnvFile(await readFile(absolutePath, "utf8")));
  }

  return merged;
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
  const env = await buildLocalProcessEnv(invocation.cwd, invocation.env_files, invocation.env);

  return new Promise<LocalProcessResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env,
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
