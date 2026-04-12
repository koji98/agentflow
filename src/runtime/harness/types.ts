import { accessSync, constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import type { HarnessCapabilities } from "../../graph/harness_capabilities.js";
import type { ReasoningEffort } from "../../graph/schema.js";

export type HarnessKind = "codex-cli" | "cursor-cli";

export interface AgentInvocation {
  runId: string;
  executionId: string;
  repoAlias: string;
  repoPath: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  skipGitRepoCheck?: boolean;
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
  readonly capabilities: HarnessCapabilities;
  checkReadiness?(): Promise<string[]> | string[];
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
    "## Agentflow Task",
    invocation.prompt,
    "",
    "## Runtime Context",
    `- Run ID: ${invocation.runId}`,
    `- Execution ID: ${invocation.executionId}`,
    `- Repo alias: ${invocation.repoAlias}`,
    `- Repo path: ${invocation.repoPath}`,
    `- Sandbox: ${invocation.sandbox}`,
    `- Context packet: ${invocation.contextPacketPath}`,
    `- Context summary: ${deriveContextSummaryPath(invocation.contextPacketPath)}`,
    `- Output directory: ${invocation.outputDir}`,
    "",
    "## Working Contract",
    "- Read the context packet first. Use the context summary to understand what materials are available.",
    "- If the context summary reports omitted or truncated items, treat the available context as partial and avoid overconfident assumptions.",
    "- Treat authored file and glob inputs in the packet as the materials Agentflow could resolve when this node started. If a requested input is omitted, handle that omission explicitly instead of assuming the file still exists.",
    "- Treat any project instructions the harness loads automatically from the repository as the default local contract, unless the task explicitly changes them or a higher-priority instruction overrides them.",
    "- Keep changes scoped to the requested task. Do not redesign the system unless the task explicitly requires it.",
    "- Make the smallest correct change that satisfies the task. If the task changes a repository convention, update that convention intentionally and coherently within the requested scope.",
    "- If the task or context names validation steps, run the relevant checks when feasible and report the results.",
    "- If blocked by missing context, failing commands, or conflicting instructions, explain the blocker clearly instead of guessing.",
    "- Write declared attempt-local artifacts to the output directory.",
    "- Follow any explicit output-format requirements stated in the node prompt."
  ].join("\n");
}
