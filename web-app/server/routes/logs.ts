import { readRunState } from "../../../src/artifacts/reader.js";
import { projectNodeLogs, readProjectedArtifact } from "../../../src/artifacts/projection.js";
import type { ArtifactRead, NodeLogPayload } from "../../shared/contracts/runs.js";
import { resolveRunRoot } from "./runs.js";

export const nodeArtifactRoutePaths = {
  logs: "/api/runs/:runId/nodes/:compiledId/logs",
  artifact: "/api/runs/:runId/nodes/:compiledId/artifact"
} as const;

function fail(status: number, error: string, message: string): never {
  const routeError = new Error(message) as Error & {
    status: number;
    error: string;
  };
  routeError.status = status;
  routeError.error = error;
  throw routeError;
}

function sanitizeSegment(value: string, label: string): string {
  if (!value || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    fail(400, `${label}_invalid`, `Invalid ${label}.`);
  }

  return value;
}

async function assertRunReadable(runRoot: string): Promise<void> {
  try {
    await readRunState(runRoot);
  } catch {
    fail(404, "run_not_found", `Run artifacts were not found at ${runRoot}.`);
  }
}

export async function readNodeLogs(options: {
  runs_root: string;
  run_id: string;
  compiled_id: string;
  execution_id?: string;
}): Promise<NodeLogPayload> {
  const runRoot = resolveRunRoot(options.runs_root, options.run_id);
  await assertRunReadable(runRoot);

  try {
    return await projectNodeLogs(
      runRoot,
      sanitizeSegment(options.compiled_id, "compiled_id"),
      options.execution_id ? sanitizeSegment(options.execution_id, "execution_id") : undefined
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown compiled node")) {
      fail(404, "node_not_found", error.message);
    }

    throw error;
  }
}

export async function readNodeArtifact(options: {
  runs_root: string;
  run_id: string;
  compiled_id: string;
  execution_id?: string;
  relative_path?: string;
}): Promise<ArtifactRead> {
  if (!options.execution_id) {
    fail(400, "execution_id_required", "execution_id is required.");
  }

  if (!options.relative_path) {
    fail(400, "relative_path_required", "relative_path is required.");
  }

  const runRoot = resolveRunRoot(options.runs_root, options.run_id);
  await assertRunReadable(runRoot);

  try {
    return await readProjectedArtifact(
      runRoot,
      sanitizeSegment(options.compiled_id, "compiled_id"),
      sanitizeSegment(options.execution_id, "execution_id"),
      options.relative_path
    );
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.startsWith("Unknown execution")) {
        fail(404, "execution_not_found", error.message);
      }

      if (error.message.startsWith("Unknown artifact")) {
        fail(404, "artifact_not_found", error.message);
      }
    }

    throw error;
  }
}
