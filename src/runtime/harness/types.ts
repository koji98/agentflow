import { accessSync, constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import type { ReasoningEffort } from "../../graph/schema.js";

export type HarnessKind = "codex-cli" | "cursor-cli";

export interface AgentInvocation {
  runId: string;
  executionId: string;
  repoAlias: string;
  repoPath: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  model: string | undefined;
  reasoningEffort?: ReasoningEffort;
  prompt: string;
  contextPacketPath: string;
  outputDir: string;
  timeoutSec: number;
  signal: AbortSignal | undefined;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export interface HarnessResult {
  status: "passed" | "failed" | "canceled";
  exitCode: number;
  stdout?: string;
  stderr?: string;
  metadata?: Record<string, unknown>;
  transcript?: {
    last_message_path?: string;
    last_message?: string;
  };
  outputJson?: Record<string, unknown>;
}

export interface HarnessAdapter {
  readonly kind: HarnessKind;
  preflight?(): string[];
  run(invocation: AgentInvocation): Promise<HarnessResult>;
  cancel(executionId: string): Promise<void>;
}

function canAccessExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    if (process.platform !== "win32") {
      return false;
    }

    try {
      accessSync(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function executableCandidates(binary: string): string[] {
  if (binary.length === 0) {
    return [];
  }

  if (binary.includes("/") || binary.includes("\\") || isAbsolute(binary)) {
    return [binary];
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const pathExtensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((value) => value.trim())
          .filter(Boolean)
      : [""];

  return pathEntries.flatMap((entry) => pathExtensions.map((extension) => join(entry, `${binary}${extension}`)));
}

export function resolveCliBinary(
  configuredBinary: string | undefined,
  envVarName: string,
  defaultBinary: string
): string {
  const envBinary = process.env[envVarName]?.trim();
  return configuredBinary?.trim() || envBinary || defaultBinary;
}

export function formatMissingHarnessBinaryMessage(
  kind: HarnessKind,
  binary: string,
  envVarName: string
): string {
  return `${kind} harness binary "${binary}" is unavailable. Install it on PATH or set ${envVarName}.`;
}

export function collectMissingHarnessBinaryDiagnostics(
  kind: HarnessKind,
  binary: string,
  envVarName: string
): string[] {
  return executableCandidates(binary).some((candidate) => canAccessExecutable(candidate))
    ? []
    : [formatMissingHarnessBinaryMessage(kind, binary, envVarName)];
}

export function normalizeHarnessLaunchError(
  error: unknown,
  kind: HarnessKind,
  binary: string,
  envVarName: string
): Error {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return new Error(formatMissingHarnessBinaryMessage(kind, binary, envVarName));
  }

  return error instanceof Error ? error : new Error(String(error));
}

export function deriveContextSummaryPath(contextPacketPath: string): string {
  return join(dirname(contextPacketPath), "context_summary.md");
}

export function renderHarnessPrompt(invocation: AgentInvocation): string {
  return [
    invocation.prompt,
    "",
    "## Agentflow Runtime Context",
    `- Run ID: ${invocation.runId}`,
    `- Execution ID: ${invocation.executionId}`,
    `- Repo alias: ${invocation.repoAlias}`,
    `- Repo path: ${invocation.repoPath}`,
    `- Sandbox: ${invocation.sandbox}`,
    `- Context packet: ${invocation.contextPacketPath}`,
    `- Context summary: ${deriveContextSummaryPath(invocation.contextPacketPath)}`,
    `- Output directory: ${invocation.outputDir}`,
    "",
    "Review the context packet and any attached rule files before acting.",
    "Write any attempt-local artifacts to the output directory when the node declares them.",
    "Follow any output-format requirements stated in the node prompt."
  ].join("\n");
}
