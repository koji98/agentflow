import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

import { resolveRunArtifactPaths } from "./paths.js";
import type { AuthoredGraphDocument } from "../graph/authored.js";
import type { CompiledGraph } from "../graph/compiled.js";
import type { GraphDiagnostic } from "../graph/schema.js";
import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import type { RuntimeEventEnvelope } from "../runtime/events.js";
import type { ExecutionManifest, RuntimeStateSnapshot } from "../runtime/session.js";
import type { RunOwnerRecord } from "./owner.js";

export interface RunRecord extends RunOwnerRecord {
  run_id: string;
  graph_id: string;
  launch_profile: string;
  workspace_backend: ExecutionManifest["workspace_backend"];
  status: string;
  started_at: string;
  ended_at?: string;
}

async function readJsonFile<TPayload>(filePath: string): Promise<TPayload> {
  const contents = await readFile(filePath, "utf8");
  return JSON.parse(contents) as TPayload;
}

export async function readRunRecord(runRoot: string): Promise<RunRecord> {
  return readJsonFile<RunRecord>(resolveRunArtifactPaths(runRoot).run_file);
}

export async function readAuthoredGraph(runRoot: string): Promise<AuthoredGraphDocument> {
  return readJsonFile<AuthoredGraphDocument>(resolveRunArtifactPaths(runRoot).authored_graph_file);
}

export async function readCompiledGraph(runRoot: string): Promise<CompiledGraph> {
  return readJsonFile<CompiledGraph>(resolveRunArtifactPaths(runRoot).compiled_graph_file);
}

export async function readExecutionManifest(runRoot: string): Promise<ExecutionManifest> {
  return readJsonFile<ExecutionManifest>(resolveRunArtifactPaths(runRoot).execution_manifest_file);
}

export async function readCompileDiagnostics(runRoot: string): Promise<GraphDiagnostic[]> {
  return readJsonFile<GraphDiagnostic[]>(resolveRunArtifactPaths(runRoot).compile_diagnostics_file);
}

export async function readRunState(runRoot: string): Promise<RuntimeStateSnapshot> {
  return readJsonFile<RuntimeStateSnapshot>(resolveRunArtifactPaths(runRoot).state_file);
}

export async function readRunEvents(runRoot: string): Promise<RuntimeEventEnvelope[]> {
  const contents = await readFile(resolveRunArtifactPaths(runRoot).events_file, "utf8");

  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeEventEnvelope);
}

async function collectFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = `${rootDir}/${entry.name}`;

      if (entry.isDirectory()) {
        return collectFiles(absolutePath);
      }

      return [absolutePath];
    })
  );

  return nestedFiles.flat();
}

export async function readRunExecutionAttempts(runRoot: string): Promise<RuntimeNodeAttempt[]> {
  const { nodes_dir } = resolveRunArtifactPaths(runRoot);
  let nodeEntries: Dirent[];

  try {
    nodeEntries = await readdir(nodes_dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const executionFiles = await Promise.all(
    nodeEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const executionsDirectory = `${nodes_dir}/${entry.name}/executions`;

        try {
          const files = await collectFiles(executionsDirectory);
          return files.filter((filePath) => filePath.endsWith("/execution.json"));
        } catch {
          return [];
        }
      })
  );

  const attempts = await Promise.all(
    executionFiles
      .flat()
      .map((filePath) => readJsonFile<RuntimeNodeAttempt>(filePath))
  );

  return attempts.sort((left, right) => {
    const leftIteration = left.iteration_index ?? 0;
    const rightIteration = right.iteration_index ?? 0;

    if (left.compiled_id !== right.compiled_id) {
      return left.compiled_id.localeCompare(right.compiled_id);
    }

    if (leftIteration !== rightIteration) {
      return leftIteration - rightIteration;
    }

    return left.attempt_index - right.attempt_index;
  });
}

export async function readExecutionFiles(executionDir: string): Promise<string[]> {
  return collectFiles(executionDir);
}

export async function readTextFileIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export async function readBinaryFile(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}
