import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";

import {
  listProjectedRuns,
  projectNodeDetail,
  projectRunEvents,
  projectRunSnapshot,
  type ProjectedRunEvent
} from "../../../src/artifacts/projection.js";
import { readRunState } from "../../../src/artifacts/reader.js";
import type { NodeDetail, RunEventPage, RunSnapshot, RunSummary } from "../../shared/contracts/runs.js";

export const runsRoutePaths = {
  list: "/api/runs",
  detail: "/api/runs/:runId",
  node: "/api/runs/:runId/nodes/:compiledId",
  events: "/api/runs/:runId/events",
  stream: "/api/runs/:runId/events/stream"
} as const;

export interface RunEventStreamSink {
  write(event: string, payload: ProjectedRunEvent): Promise<void> | void;
  close(): void;
}

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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveRunRoot(runsRoot: string, runId: string): string {
  return resolve(runsRoot, sanitizeSegment(runId, "run_id"));
}

async function assertRunReadable(runRoot: string): Promise<void> {
  try {
    await readRunState(runRoot);
  } catch {
    fail(404, "run_not_found", `Run artifacts were not found at ${runRoot}.`);
  }
}

export async function listRuns(options: {
  runs_root: string;
  graph_id?: string;
}): Promise<{
  runs: RunSummary[];
}> {
  const runs = await listProjectedRuns(options.runs_root);

  return {
    runs: options.graph_id ? runs.filter((run) => run.graph_id === options.graph_id) : runs
  };
}

export async function readRunSnapshot(options: {
  runs_root: string;
  run_id: string;
}): Promise<RunSnapshot> {
  const runRoot = resolveRunRoot(options.runs_root, options.run_id);
  await assertRunReadable(runRoot);
  return projectRunSnapshot(runRoot);
}

export async function readRunNodeDetail(options: {
  runs_root: string;
  run_id: string;
  compiled_id: string;
}): Promise<NodeDetail> {
  const runRoot = resolveRunRoot(options.runs_root, options.run_id);
  await assertRunReadable(runRoot);

  try {
    return await projectNodeDetail(runRoot, sanitizeSegment(options.compiled_id, "compiled_id"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown compiled node")) {
      fail(404, "node_not_found", error.message);
    }

    throw error;
  }
}

export async function readRunEventPage(options: {
  runs_root: string;
  run_id: string;
  after_seq?: string;
  compiled_id?: string;
  limit?: string;
}): Promise<RunEventPage> {
  const runRoot = resolveRunRoot(options.runs_root, options.run_id);
  await assertRunReadable(runRoot);

  return projectRunEvents(runRoot, {
    after_seq: parsePositiveInteger(options.after_seq, 0),
    ...(options.compiled_id ? { compiled_id: sanitizeSegment(options.compiled_id, "compiled_id") } : {}),
    limit: parsePositiveInteger(options.limit, 200)
  });
}

export async function streamRunEvents(options: {
  runs_root: string;
  run_id: string;
  after_seq?: string;
  sink: RunEventStreamSink;
  signal?: AbortSignal;
  poll_interval_ms?: number;
}): Promise<void> {
  const runRoot = resolveRunRoot(options.runs_root, options.run_id);
  await assertRunReadable(runRoot);

  let cursor = parsePositiveInteger(options.after_seq, 0);

  while (!options.signal?.aborted) {
    const page = await projectRunEvents(runRoot, {
      after_seq: cursor
    });

    for (const event of page.events) {
      cursor = event.seq;
      await options.sink.write(event.type, event);
    }

    const state = await readRunState(runRoot);

    if (state.status !== "running") {
      break;
    }

    try {
      await delay(options.poll_interval_ms ?? 500, undefined, {
        signal: options.signal
      });
    } catch {
      break;
    }
  }

  options.sink.close();
}
