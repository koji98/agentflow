import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { HarnessName } from "../../graph/schema.js";
import { resolveExecutionHumanDebugToolDirectory } from "../../artifacts/paths.js";
import type { AgentInvocation } from "./types.js";

export interface HarnessWorkspaceWriteMirror {
  root_dir: string;
  output_dir: string;
  runtime_dir: string;
  tool_runtime_dir: string;
  actual_output_dir: string;
  actual_runtime_dir: string;
  execution_dir: string;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "agentflow";

  if (sanitized.length <= 120) {
    return sanitized;
  }

  const hash = createHash("sha1").update(sanitized).digest("hex").slice(0, 12);
  const prefixLength = Math.max(1, 120 - hash.length - 1);
  const prefix = sanitized.slice(0, prefixLength).replace(/_+$/g, "") || "agentflow";
  return `${prefix}_${hash}`;
}

export function createHarnessWorkspaceWriteMirror(options: {
  harness: HarnessName;
  sandbox: AgentInvocation["sandbox"];
  workspace_path: string;
  run_id: string;
  execution_id: string;
  execution_dir: string;
  output_dir: string;
  runtime_dir: string;
}): HarnessWorkspaceWriteMirror | undefined {
  if (options.harness !== "codex-cli" || options.sandbox !== "workspace-write") {
    return undefined;
  }

  const root_dir = join(
    options.workspace_path,
    ".agentflow-runtime",
    sanitizePathSegment(options.run_id),
    sanitizePathSegment(options.execution_id)
  );

  return {
    root_dir,
    output_dir: join(root_dir, "artifacts"),
    runtime_dir: join(root_dir, "runtime"),
    tool_runtime_dir: join(root_dir, "tool-runtime"),
    actual_output_dir: options.output_dir,
    actual_runtime_dir: options.runtime_dir,
    execution_dir: options.execution_dir
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectoryIfPresent(source: string, destination: string): Promise<void> {
  try {
    await cp(source, destination, {
      recursive: true,
      force: true
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function appendFileIfPresent(source: string, destination: string): Promise<void> {
  if (!await pathExists(source)) {
    return;
  }

  await mkdir(dirname(destination), { recursive: true });
  const contents = await readFile(source);
  if (contents.length > 0) {
    await appendFile(destination, contents);
  }
}

export function mapOutputArtifactPathToMirror(
  mirror: HarnessWorkspaceWriteMirror | undefined,
  expectedPath: string
): string {
  if (!mirror) {
    return expectedPath;
  }

  const relativePath = relative(mirror.actual_output_dir, expectedPath);
  if (relativePath.startsWith("..") || relativePath === "" || relativePath.includes("..")) {
    return expectedPath;
  }

  return join(mirror.output_dir, relativePath);
}

export async function prepareHarnessWorkspaceWriteMirror(
  mirror: HarnessWorkspaceWriteMirror | undefined
): Promise<void> {
  if (!mirror) {
    return;
  }

  await mkdir(mirror.output_dir, { recursive: true });
  await mkdir(mirror.runtime_dir, { recursive: true });
  await mkdir(mirror.tool_runtime_dir, { recursive: true });
}

export async function syncAndRemoveHarnessWorkspaceWriteMirror(
  mirror: HarnessWorkspaceWriteMirror | undefined
): Promise<void> {
  if (!mirror) {
    return;
  }

  try {
    await copyDirectoryIfPresent(mirror.output_dir, mirror.actual_output_dir);
    await appendFileIfPresent(
      join(mirror.runtime_dir, "log.jsonl"),
      join(mirror.actual_runtime_dir, "log.jsonl")
    );
    await copyDirectoryIfPresent(
      join(mirror.runtime_dir, "milestones"),
      join(mirror.actual_runtime_dir, "milestones")
    );
    await copyDirectoryIfPresent(
      join(mirror.tool_runtime_dir, "tools"),
      resolveExecutionHumanDebugToolDirectory(mirror.execution_dir)
    );
  } finally {
    await rm(mirror.root_dir, { recursive: true, force: true });
    await rmdir(dirname(mirror.root_dir)).catch(() => undefined);
    await rmdir(dirname(dirname(mirror.root_dir))).catch(() => undefined);
  }
}
