import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { DeterministicPassIf } from "../../graph/authored.js";
import { createProcessTerminationController } from "../process_control.js";

export interface LocalProcessInvocation {
  command: string;
  args: string[];
  cwd: string;
  env_files?: string[];
  env: Record<string, string> | undefined;
  runtime_env?: Record<string, string>;
  timeout_sec: number;
  signal: AbortSignal | undefined;
  on_stdout_chunk?: (chunk: string) => void;
  on_stderr_chunk?: (chunk: string) => void;
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
  verification_json: Record<string, unknown>;
}

const verificationArtifactFilename = "verification.json";

async function buildLocalProcessEnv(
  cwd: string,
  envFilePaths: string[] | undefined,
  envOverrides: Record<string, string> | undefined,
  runtimeEnv: Record<string, string> | undefined
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
    ...(runtimeEnv ?? {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVerificationPayload(
  payload: Record<string, unknown> | undefined,
  processResult: LocalProcessResult,
  defaults: {
    passed: boolean;
    summary: string;
    check_kind: "deterministic";
  }
): Record<string, unknown> {
  return {
    ...(payload ?? {}),
    ...(typeof payload?.passed === "boolean" ? {} : { passed: defaults.passed }),
    ...(typeof payload?.summary === "string" && payload.summary.trim().length > 0
      ? {}
      : { summary: defaults.summary }),
    ...(typeof payload?.check_kind === "string" ? {} : { check_kind: defaults.check_kind }),
    ...(typeof payload?.exit_code === "number" ? {} : { exit_code: processResult.exit_code })
  };
}

async function readVerificationPayload(
  outputDir: string | undefined
): Promise<{
  payload?: Record<string, unknown>;
  error?: string;
}> {
  if (!outputDir) {
    return {
      error: "Deterministic verification.json checks require AGENTFLOW_OUTPUT_DIR."
    };
  }

  try {
    const parsed = JSON.parse(
      await readFile(join(outputDir, verificationArtifactFilename), "utf8")
    ) as unknown;

    if (!isRecord(parsed)) {
      return {
        error: "Deterministic verification.json must contain a top-level JSON object."
      };
    }

    return {
      payload: parsed
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {
        error: "Deterministic verification.json checks require artifacts/verification.json."
      };
    }

    return {
      error: "Deterministic verification.json was not valid JSON."
    };
  }
}

async function evaluateDeterministicPassIf(
  passIf: DeterministicPassIf | undefined,
  processResult: LocalProcessResult,
  outputDir: string | undefined
): Promise<{
  passed: boolean;
  error?: string;
  verification_json: Record<string, unknown>;
}> {
  if (!passIf || "exit_code" in passIf) {
    const expectedExitCode = passIf?.exit_code ?? 0;
    const passed = processResult.exit_code === expectedExitCode;
    const defaultSummary = passed
      ? "Deterministic check passed."
      : `Deterministic check failed: expected exit code ${expectedExitCode}, received ${processResult.exit_code}.`;
    const verificationPayload = await readVerificationPayload(outputDir);

    return {
      passed,
      ...(verificationPayload.error ? { error: verificationPayload.error } : {}),
      verification_json: normalizeVerificationPayload(
        verificationPayload.payload,
        processResult,
        {
          passed,
          summary: defaultSummary,
          check_kind: "deterministic"
        }
      )
    };
  }

  if (passIf.json_path !== "$.passed") {
    return {
      passed: false,
      error: `Unsupported deterministic json_path "${passIf.json_path}" in this release.`,
      verification_json: normalizeVerificationPayload(undefined, processResult, {
        passed: false,
        summary: `Unsupported deterministic json_path "${passIf.json_path}" in this release.`,
        check_kind: "deterministic"
      })
    };
  }

  const verificationPayload = await readVerificationPayload(outputDir);

  if (!verificationPayload.payload) {
    return {
      passed: false,
      ...(verificationPayload.error ? { error: verificationPayload.error } : {}),
      verification_json: normalizeVerificationPayload(undefined, processResult, {
        passed: false,
        summary: verificationPayload.error ?? "Deterministic verification artifact is missing.",
        check_kind: "deterministic"
      })
    };
  }

  const passed = verificationPayload.payload.passed === passIf.equals;
  const defaultSummary = passed
    ? "Deterministic check passed."
    : "Deterministic check failed.";

  return {
    passed,
    verification_json: normalizeVerificationPayload(
      verificationPayload.payload,
      processResult,
      {
        passed,
        summary: defaultSummary,
        check_kind: "deterministic"
      }
    )
  };
}

export async function runLocalProcess(
  invocation: LocalProcessInvocation
): Promise<LocalProcessResult> {
  const env = await buildLocalProcessEnv(
    invocation.cwd,
    invocation.env_files,
    invocation.env,
    invocation.runtime_env
  );

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
      invocation.on_stdout_chunk?.(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      invocation.on_stderr_chunk?.(chunk.toString("utf8"));
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
      ? await evaluateDeterministicPassIf(
          invocation.pass_if,
          processResult,
          invocation.runtime_env?.AGENTFLOW_OUTPUT_DIR
        )
      : {
          passed: false,
          verification_json: normalizeVerificationPayload(undefined, processResult, {
            passed: false,
            summary: processResult.canceled
              ? "Deterministic check canceled."
              : "Deterministic check timed out.",
            check_kind: "deterministic"
          })
        };
  const passed = evaluation.passed;
  const summary =
    processResult.canceled
      ? "Deterministic check canceled."
      : processResult.timed_out
        ? "Deterministic check timed out."
        : (typeof evaluation.verification_json.summary === "string"
          ? evaluation.verification_json.summary
          : undefined)
          ?? evaluation.error
          ?? (passed ? "Deterministic check passed." : "Deterministic check failed.");

  return {
    ...processResult,
    passed,
    summary,
    verification_json: normalizeVerificationPayload(
      evaluation.verification_json,
      processResult,
      {
        passed,
        summary,
        check_kind: "deterministic"
      }
    )
  };
}
