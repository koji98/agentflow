import {
  resolveLaunchWorkingDirectory,
  resolveRunsRoot
} from "../../src/artifacts/paths.js";
import { graphInspectionRoutePath, inspectGraph } from "./routes/graph.js";
import { nodeArtifactRoutePaths, readNodeArtifact, readNodeLogs } from "./routes/logs.js";
import {
  listRuns,
  readRunEventPage,
  readRunNodeDetail,
  readRunSnapshot,
  runsRoutePaths,
  streamRunEvents
} from "./routes/runs.js";

export interface WebAppServerOptions {
  current_working_directory?: string;
  runs_root?: string;
}

export interface WebAppSseSink {
  write(event: string, payload: unknown): Promise<void> | void;
  close(): void;
}

export interface WebAppJsonResponse {
  kind: "json";
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface WebAppSseResponse {
  kind: "sse";
  status: number;
  headers?: Record<string, string>;
  stream: (sink: WebAppSseSink, signal?: AbortSignal) => Promise<void>;
}

export type WebAppResponse = WebAppJsonResponse | WebAppSseResponse;

function jsonResponse(status: number, body: unknown): WebAppJsonResponse {
  return {
    kind: "json",
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body
  };
}

function routeErrorResponse(error: unknown): WebAppJsonResponse {
  if (error && typeof error === "object") {
    const routeError = error as Error & {
      status?: number;
      error?: string;
      code?: string;
    };

    if (typeof routeError.status === "number") {
      return jsonResponse(routeError.status, {
        error: routeError.error ?? "request_failed",
        message: routeError.message
      });
    }

    if (routeError.code === "ENOENT") {
      return jsonResponse(404, {
        error: "not_found",
        message: routeError.message
      });
    }
  }

  return jsonResponse(500, {
    error: "internal_error",
    message: error instanceof Error ? error.message : "Unknown server error."
  });
}

function defaultRunsRoot(currentWorkingDirectory: string): string {
  return resolveRunsRoot({
    currentWorkingDirectory,
    environment: process.env
  });
}

export function createWebAppServer(options: WebAppServerOptions = {}) {
  const currentWorkingDirectory = resolveLaunchWorkingDirectory({
    ...(options.current_working_directory
      ? { currentWorkingDirectory: options.current_working_directory }
      : {}),
    environment: process.env
  });
  const runsRoot = options.runs_root ?? defaultRunsRoot(currentWorkingDirectory);

  return {
    routes: [
      graphInspectionRoutePath,
      runsRoutePaths.list,
      runsRoutePaths.detail,
      runsRoutePaths.node,
      runsRoutePaths.events,
      runsRoutePaths.stream,
      nodeArtifactRoutePaths.logs,
      nodeArtifactRoutePaths.artifact,
      "/health"
    ],
    async request(method: string, url: string | URL): Promise<WebAppResponse> {
      const requestUrl = url instanceof URL ? url : new URL(url, "http://127.0.0.1");

      if (method !== "GET") {
        return jsonResponse(405, {
          error: "method_not_allowed",
          message: `Unsupported method ${method}.`
        });
      }

      try {
        if (requestUrl.pathname === "/health") {
          return jsonResponse(200, {
            status: "ok",
            surface: "graph-native-monitor"
          });
        }

        if (requestUrl.pathname === graphInspectionRoutePath) {
          const graphPath = requestUrl.searchParams.get("path");
          const launchProfile = requestUrl.searchParams.get("launch_profile");
          const workspaceBackend = requestUrl.searchParams.get("workspace_backend");
          const includeCompiled = requestUrl.searchParams.get("compiled") === "1";

          if (!graphPath) {
            return jsonResponse(400, {
              error: "path_required",
              message: "path is required."
            });
          }

          return jsonResponse(200, await inspectGraph({
            current_working_directory: currentWorkingDirectory,
            graph_path: graphPath,
            ...(launchProfile ? { launch_profile: launchProfile } : {}),
            ...(workspaceBackend ? { workspace_backend: workspaceBackend } : {}),
            include_compiled: includeCompiled
          }));
        }

        if (requestUrl.pathname === runsRoutePaths.list) {
          const graphId = requestUrl.searchParams.get("graph_id");

          return jsonResponse(200, await listRuns({
            runs_root: runsRoot,
            ...(graphId ? { graph_id: graphId } : {})
          }));
        }

        const streamMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/events\/stream$/);

        if (streamMatch) {
          const runId = streamMatch[1];
          const afterSeq = requestUrl.searchParams.get("after_seq");

          if (!runId) {
            return jsonResponse(404, {
              error: "not_found",
              message: `No route matched ${requestUrl.pathname}.`
            });
          }

          return {
            kind: "sse",
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive"
            },
            stream: (sink, signal) =>
              streamRunEvents({
                runs_root: runsRoot,
                run_id: decodeURIComponent(runId),
                ...(afterSeq ? { after_seq: afterSeq } : {}),
                sink,
                ...(signal ? { signal } : {})
              })
          };
        }

        const eventsMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);

        if (eventsMatch) {
          const runId = eventsMatch[1];
          const afterSeq = requestUrl.searchParams.get("after_seq");
          const compiledId = requestUrl.searchParams.get("compiled_id");
          const limit = requestUrl.searchParams.get("limit");

          if (!runId) {
            return jsonResponse(404, {
              error: "not_found",
              message: `No route matched ${requestUrl.pathname}.`
            });
          }

          return jsonResponse(200, await readRunEventPage({
            runs_root: runsRoot,
            run_id: decodeURIComponent(runId),
            ...(afterSeq ? { after_seq: afterSeq } : {}),
            ...(compiledId ? { compiled_id: compiledId } : {}),
            ...(limit ? { limit } : {})
          }));
        }

        const logsMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/nodes\/([^/]+)\/logs$/);

        if (logsMatch) {
          const runId = logsMatch[1];
          const compiledId = logsMatch[2];
          const executionId = requestUrl.searchParams.get("execution_id");

          if (!runId || !compiledId) {
            return jsonResponse(404, {
              error: "not_found",
              message: `No route matched ${requestUrl.pathname}.`
            });
          }

          return jsonResponse(200, await readNodeLogs({
            runs_root: runsRoot,
            run_id: decodeURIComponent(runId),
            compiled_id: decodeURIComponent(compiledId),
            ...(executionId ? { execution_id: executionId } : {})
          }));
        }

        const artifactMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/nodes\/([^/]+)\/artifact$/);

        if (artifactMatch) {
          const runId = artifactMatch[1];
          const compiledId = artifactMatch[2];
          const executionId = requestUrl.searchParams.get("execution_id");
          const relativePath = requestUrl.searchParams.get("relative_path");

          if (!runId || !compiledId) {
            return jsonResponse(404, {
              error: "not_found",
              message: `No route matched ${requestUrl.pathname}.`
            });
          }

          return jsonResponse(200, await readNodeArtifact({
            runs_root: runsRoot,
            run_id: decodeURIComponent(runId),
            compiled_id: decodeURIComponent(compiledId),
            ...(executionId ? { execution_id: executionId } : {}),
            ...(relativePath ? { relative_path: relativePath } : {})
          }));
        }

        const nodeMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/nodes\/([^/]+)$/);

        if (nodeMatch) {
          const runId = nodeMatch[1];
          const compiledId = nodeMatch[2];

          if (!runId || !compiledId) {
            return jsonResponse(404, {
              error: "not_found",
              message: `No route matched ${requestUrl.pathname}.`
            });
          }

          return jsonResponse(200, await readRunNodeDetail({
            runs_root: runsRoot,
            run_id: decodeURIComponent(runId),
            compiled_id: decodeURIComponent(compiledId)
          }));
        }

        const runMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)$/);

        if (runMatch) {
          const runId = runMatch[1];

          if (!runId) {
            return jsonResponse(404, {
              error: "not_found",
              message: `No route matched ${requestUrl.pathname}.`
            });
          }

          return jsonResponse(200, await readRunSnapshot({
            runs_root: runsRoot,
            run_id: decodeURIComponent(runId)
          }));
        }
      } catch (error) {
        return routeErrorResponse(error);
      }

      return jsonResponse(404, {
        error: "not_found",
        message: `No route matched ${requestUrl.pathname}.`
      });
    },
    async getJson(url: string | URL): Promise<unknown> {
      const response = await this.request("GET", url);

      if (response.kind !== "json") {
        throw new Error("Route returned a non-JSON response.");
      }

      return response.body;
    }
  };
}

export const createWebAppScaffoldServer = createWebAppServer;
