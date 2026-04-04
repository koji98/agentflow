import { useEffect, useState } from "react";

import type { GraphInspectionPayload, GraphViewMode } from "../../shared/contracts/graph";
import type { ArtifactRead, NodeDetail, NodeLogPayload, RunSnapshot, RunSummary } from "../../shared/contracts/runs";
import { GraphPanel } from "./components/graph_panel";
import { InspectorPanel } from "./components/inspector_panel";
import { Launchpad } from "./components/launchpad";
import { LogsPanel } from "./components/logs_panel";
import { TimelinePanel } from "./components/timeline_panel";
import { useRunEvents } from "./hooks/use_run_events";
import {
  buildStaticInspectorModel,
  createDiagnosticsList,
  createGraphKpis,
  createLaunchpadKpis,
  pickDefaultAuthoredId,
  pickDefaultCompiledId,
  resolveAuthoredId,
  resolveCompiledId,
  type GraphFilterKey
} from "./lib/graph_view_model";

type WorkspaceBackend = "inplace" | "worktree";
type LogTab = "stdout" | "stderr" | "artifacts";

type AppRoute =
  | {
      kind: "launchpad";
      graph_path?: string;
      launch_profile?: string;
      workspace_backend?: WorkspaceBackend;
      compiled?: boolean;
    }
  | {
      kind: "inspect";
      graph_path?: string;
      launch_profile?: string;
      workspace_backend?: WorkspaceBackend;
      compiled?: boolean;
    }
  | {
      kind: "run";
      run_id: string;
    };

export interface AppProps {
  initialRoute?: string;
  initialInspection?: GraphInspectionPayload | null;
  initialRecentRuns?: RunSummary[];
  initialRunSnapshot?: RunSnapshot | null;
  initialNodeDetail?: NodeDetail | null;
  initialNodeLogs?: NodeLogPayload | null;
  initialArtifact?: ArtifactRead | null;
}

const recentGraphStorageKey = "agentflow_v2_recent_graph_paths";
const timelinePanelId = "timeline-panel";
const logsPanelId = "logs-panel";

function currentLocation(initialRoute?: string): string {
  if (initialRoute) {
    return initialRoute;
  }

  if (typeof window === "undefined") {
    return "/";
  }

  return `${window.location.pathname}${window.location.search}`;
}

export function resolveRoute(value: string): AppRoute {
  const url = new URL(value, "http://127.0.0.1");
  const graphPath = url.searchParams.get("path") ?? undefined;
  const launchProfile = url.searchParams.get("launch_profile") ?? undefined;
  const workspaceBackend = url.searchParams.get("workspace_backend");
  const compiled = url.searchParams.get("compiled") === "1";

  if (url.pathname.startsWith("/runs/")) {
    return {
      kind: "run",
      run_id: decodeURIComponent(url.pathname.replace(/^\/runs\//, ""))
    };
  }

  if (url.pathname === "/graphs/inspect") {
    return {
      kind: "inspect",
      ...(graphPath ? { graph_path: graphPath } : {}),
      ...(launchProfile ? { launch_profile: launchProfile } : {}),
      ...(workspaceBackend === "inplace" || workspaceBackend === "worktree"
        ? { workspace_backend: workspaceBackend }
        : {}),
      ...(compiled ? { compiled: true } : {})
    };
  }

  return {
    kind: "launchpad",
    ...(graphPath ? { graph_path: graphPath } : {}),
    ...(launchProfile ? { launch_profile: launchProfile } : {}),
    ...(workspaceBackend === "inplace" || workspaceBackend === "worktree"
      ? { workspace_backend: workspaceBackend }
      : {}),
    ...(compiled ? { compiled: true } : {})
  };
}

export function buildGraphRoute(
  kind: "launchpad" | "inspect",
  options: {
    graph_path?: string;
    launch_profile?: string;
    workspace_backend?: WorkspaceBackend;
    compiled?: boolean;
  } = {}
): string {
  const url = new URL(kind === "inspect" ? "/graphs/inspect" : "/", "http://127.0.0.1");

  if (options.graph_path) {
    url.searchParams.set("path", options.graph_path);
  }

  if (options.launch_profile) {
    url.searchParams.set("launch_profile", options.launch_profile);
  }

  if (options.workspace_backend) {
    url.searchParams.set("workspace_backend", options.workspace_backend);
  }

  if (options.compiled) {
    url.searchParams.set("compiled", "1");
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}`;
}

function routePath(pathname: string): string {
  if (typeof window === "undefined") {
    return pathname;
  }

  return new URL(pathname, window.location.origin).toString();
}

async function readJson<T>(pathname: string): Promise<T> {
  const response = await fetch(routePath(pathname));

  if (!response.ok) {
    const body = await response.json().catch(() => null) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function loadRecentGraphPaths(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(recentGraphStorageKey) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function rememberGraphPath(current: string[], nextPath: string): string[] {
  const normalized = nextPath.trim();

  if (!normalized) {
    return current;
  }

  return [normalized, ...current.filter((value) => value !== normalized)].slice(0, 8);
}

export function App(props: AppProps) {
  const [route, setRoute] = useState<AppRoute>(() => resolveRoute(currentLocation(props.initialRoute)));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [inspection, setInspection] = useState<GraphInspectionPayload | null>(props.initialInspection ?? null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"validate" | "compile" | null>(null);
  const [recentRuns, setRecentRuns] = useState<RunSummary[]>(props.initialRecentRuns ?? []);
  const [recentGraphPaths, setRecentGraphPaths] = useState<string[]>(() => loadRecentGraphPaths());
  const [launchProfileDraft, setLaunchProfileDraft] = useState<string>(
    props.initialInspection?.launch_profile ?? "default"
  );
  const [workspaceBackendDraft, setWorkspaceBackendDraft] = useState<WorkspaceBackend>(
    props.initialInspection?.workspace_backend ?? "worktree"
  );
  const [graphMode, setGraphMode] = useState<GraphViewMode>(
    route.kind === "run" ? "Overlay" : route.compiled ? "Compiled" : "Authored"
  );
  const [graphFilters, setGraphFilters] = useState<GraphFilterKey[]>([]);
  const [selectedAuthoredId, setSelectedAuthoredId] = useState<string | null>(
    props.initialInspection?.authored_graph ? pickDefaultAuthoredId(props.initialInspection.authored_graph) : null
  );
  const [selectedCompiledId, setSelectedCompiledId] = useState<string | null>(
    props.initialRunSnapshot?.compiled_graph
      ? pickDefaultCompiledId(props.initialRunSnapshot.compiled_graph, props.initialRunSnapshot.overlay_nodes)
      : props.initialInspection?.compiled_graph
        ? resolveCompiledId(
            props.initialInspection.compiled_graph,
            pickDefaultAuthoredId(props.initialInspection.authored_graph)
          )
        : null
  );
  const [nodeDetail, setNodeDetail] = useState<NodeDetail | null>(props.initialNodeDetail ?? null);
  const [nodeLogs, setNodeLogs] = useState<NodeLogPayload | null>(props.initialNodeLogs ?? null);
  const [artifact, setArtifact] = useState<ArtifactRead | null>(props.initialArtifact ?? null);
  const [nodeLoading, setNodeLoading] = useState(false);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(
    props.initialNodeLogs?.selected_execution_id ?? props.initialNodeDetail?.selected_execution_id ?? null
  );
  const [selectedArtifactPath, setSelectedArtifactPath] = useState<string | null>(
    props.initialArtifact?.artifact.relative_path ?? null
  );
  const [selectedLogTab, setSelectedLogTab] = useState<LogTab>("stdout");
  const [showCancelGuide, setShowCancelGuide] = useState(false);
  const runEvents = useRunEvents(route.kind === "run" ? route.run_id : null, route.kind === "run" ? props.initialRunSnapshot ?? null : null);

  function selectAuthoredNode(authoredId: string): void {
    setSelectedAuthoredId(authoredId);
    setSelectedCompiledId(
      resolveCompiledId(
        route.kind === "run" ? runEvents.snapshot?.compiled_graph : inspection?.compiled_graph,
        authoredId
      )
    );
  }

  function selectCompiledNode(compiledId: string): void {
    setSelectedCompiledId(compiledId);
    setSelectedAuthoredId(
      resolveAuthoredId(
        route.kind === "run" ? runEvents.snapshot?.compiled_graph : inspection?.compiled_graph,
        compiledId
      )
    );
  }

  function loadNodeLogsForExecution(runId: string, compiledId: string, executionId: string): Promise<void> {
    setSelectedExecutionId(executionId);
    setSelectedLogTab("stdout");

    return readJson<NodeLogPayload>(
      `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(compiledId)}/logs?execution_id=${encodeURIComponent(executionId)}`
    ).then((payload) => {
      setNodeLogs(payload);
      setSelectedArtifactPath(
        payload.artifacts.find((item) => item.kind !== "stdout" && item.kind !== "stderr")?.relative_path ?? null
      );
    });
  }

  function navigate(nextRoute: string): void {
    if (typeof window !== "undefined") {
      window.history.pushState({}, "", nextRoute);
    }

    setRoute(resolveRoute(nextRoute));
  }

  function toggleGraphFilter(filter: GraphFilterKey): void {
    setGraphFilters((current) =>
      current.includes(filter) ? current.filter((value) => value !== filter) : [...current, filter]
    );
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handlePopState = () => {
      setRoute(resolveRoute(`${window.location.pathname}${window.location.search}`));
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(recentGraphStorageKey, JSON.stringify(recentGraphPaths));
  }, [recentGraphPaths]);

  useEffect(() => {
    if (route.kind === "run") {
      setGraphMode("Overlay");
      setGraphFilters([]);
      return;
    }

    setGraphMode(route.compiled ? "Compiled" : "Authored");
  }, [route.kind, route.kind === "run" ? false : route.compiled]);

  useEffect(() => {
    if (route.kind !== "run" || runEvents.snapshot?.run.status !== "Running") {
      setShowCancelGuide(false);
    }
  }, [route.kind, runEvents.snapshot?.run.status]);

  useEffect(() => {
    if (route.kind === "run") {
      return;
    }

    if (!route.graph_path) {
      setInspection(null);
      setInspectionError(null);
      setRecentRuns([]);
      setBusyAction(null);
      setSelectedAuthoredId(null);
      setSelectedCompiledId(null);
      return;
    }

    let active = true;
    setInspectionError(null);

    const search = new URLSearchParams({
      path: route.graph_path
    });

    if (route.launch_profile) {
      search.set("launch_profile", route.launch_profile);
    }

    if (route.workspace_backend) {
      search.set("workspace_backend", route.workspace_backend);
    }

    if (route.compiled) {
      search.set("compiled", "1");
    }

    void readJson<GraphInspectionPayload>(`/api/graphs/inspect?${search.toString()}`).then((payload) => {
      if (!active) {
        return;
      }

      setInspection(payload);
      setInspectionError(null);
      setBusyAction(null);
      setLaunchProfileDraft(payload.launch_profile);
      setWorkspaceBackendDraft(payload.workspace_backend);
      setRecentGraphPaths((current) => rememberGraphPath(current, route.graph_path!));

      void readJson<{ runs: RunSummary[] }>(`/api/runs?graph_id=${encodeURIComponent(payload.graph_id)}`).then((response) => {
        if (active) {
          setRecentRuns(response.runs);
        }
      }).catch(() => {
        if (active) {
          setRecentRuns([]);
        }
      });
    }).catch((error: unknown) => {
      if (!active) {
        return;
      }

      setInspection(null);
      setRecentRuns([]);
      setBusyAction(null);
      setInspectionError(error instanceof Error ? error.message : "Unable to inspect graph.");
    });

    return () => {
      active = false;
    };
  }, [route]);

  useEffect(() => {
    if (route.kind === "run") {
      return;
    }

    if (!inspection?.authored_graph) {
      setSelectedAuthoredId(null);
      setSelectedCompiledId(null);
      return;
    }

    const defaultAuthoredId = pickDefaultAuthoredId(inspection.authored_graph);
    setSelectedAuthoredId(defaultAuthoredId);
    setSelectedCompiledId(resolveCompiledId(inspection.compiled_graph, defaultAuthoredId));
  }, [inspection?.graph_id, inspection?.compiled_graph, inspection?.authored_graph, route.kind]);

  useEffect(() => {
    if (route.kind !== "run") {
      setNodeDetail(null);
      setNodeLogs(null);
      setArtifact(null);
      setNodeError(null);
      setNodeLoading(false);
      setSelectedExecutionId(null);
      setSelectedArtifactPath(null);
      return;
    }

    const compiledGraph = runEvents.snapshot?.compiled_graph;
    const defaultCompiledId = pickDefaultCompiledId(compiledGraph, runEvents.snapshot?.overlay_nodes ?? []);

    setSelectedCompiledId((current) => {
      if (!compiledGraph || compiledGraph.nodes.length === 0) {
        return null;
      }

      if (current && compiledGraph.nodes.some((node) => node.compiled_id === current)) {
        return current;
      }

      return defaultCompiledId;
    });
  }, [route.kind, runEvents.snapshot]);

  useEffect(() => {
    if (route.kind !== "run") {
      return;
    }

    setSelectedAuthoredId(resolveAuthoredId(runEvents.snapshot?.compiled_graph, selectedCompiledId));
  }, [route.kind, runEvents.snapshot?.compiled_graph, selectedCompiledId]);

  useEffect(() => {
    if (route.kind !== "run" || !selectedCompiledId) {
      return;
    }

    let active = true;
    setNodeLoading(true);
    setNodeError(null);

    const encodedRunId = encodeURIComponent(route.run_id);
    const encodedCompiledId = encodeURIComponent(selectedCompiledId);

    void Promise.all([
      readJson<NodeDetail>(`/api/runs/${encodedRunId}/nodes/${encodedCompiledId}`),
      readJson<NodeLogPayload>(`/api/runs/${encodedRunId}/nodes/${encodedCompiledId}/logs`)
    ]).then(([detail, logs]) => {
      if (!active) {
        return;
      }

      setNodeDetail(detail);
      setNodeLogs(logs);
      setNodeLoading(false);
      const nextExecutionId = logs.selected_execution_id ?? detail.selected_execution_id ?? null;
      setSelectedExecutionId(nextExecutionId);
      setSelectedArtifactPath(
        logs.artifacts.find((item) => item.kind !== "stdout" && item.kind !== "stderr")?.relative_path ?? null
      );
      setArtifact(null);
      setSelectedLogTab("stdout");
    }).catch((error: unknown) => {
      if (!active) {
        return;
      }

      setNodeLoading(false);
      setNodeError(error instanceof Error ? error.message : "Unable to inspect the selected node.");
    });

    return () => {
      active = false;
    };
  }, [route, selectedCompiledId]);

  useEffect(() => {
    if (
      route.kind !== "run"
      || selectedLogTab !== "artifacts"
      || !selectedCompiledId
      || !selectedExecutionId
      || !selectedArtifactPath
    ) {
      if (selectedLogTab !== "artifacts") {
        setArtifact(null);
      }
      return;
    }

    let active = true;
    const encodedRunId = encodeURIComponent(route.run_id);
    const encodedCompiledId = encodeURIComponent(selectedCompiledId);
    const search = new URLSearchParams({
      execution_id: selectedExecutionId,
      relative_path: selectedArtifactPath
    });

    void readJson<ArtifactRead>(
      `/api/runs/${encodedRunId}/nodes/${encodedCompiledId}/artifact?${search.toString()}`
    ).then((payload) => {
      if (active) {
        setArtifact(payload);
      }
    }).catch(() => {
      if (active) {
        setArtifact(null);
      }
    });

    return () => {
      active = false;
    };
  }, [route, selectedArtifactPath, selectedCompiledId, selectedExecutionId, selectedLogTab]);

  const currentGraphPath = route.kind === "run" ? "" : route.graph_path ?? "";
  const launchpadKpis = createLaunchpadKpis(inspection);
  const runKpis = createGraphKpis(runEvents.snapshot);
  const diagnostics = createDiagnosticsList(inspection);
  const staticInspector = inspection
    ? buildStaticInspectorModel(inspection, graphMode, {
        authored_id: selectedAuthoredId,
        compiled_id: selectedCompiledId
      })
    : null;
  const pageTitle = route.kind === "run"
    ? `Run monitor · ${runEvents.snapshot?.run.graph_id ?? route.run_id}`
    : route.kind === "inspect"
      ? "Static graph inspection"
      : "Graph launchpad";
  const pageSubtitle = route.kind === "run"
    ? "Overlay the compiled graph with durable runtime state, events, logs, and artifacts."
    : route.kind === "inspect"
      ? "Inspect authored intent and compiled runtime truth without entering a run route."
      : "Choose a graph, resolve launch config, validate, compile, and pivot into the monitor.";
  const runStatus = runEvents.snapshot?.run.status ?? "Pending";
  const runningRun = route.kind === "run" && runStatus === "Running";
  const runDiagnostics = route.kind === "run" ? runEvents.snapshot?.run_diagnostics ?? [] : [];
  const runDiagnosticsSeverity = runDiagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? "error"
    : "warning";

  return (
    <main className="console-shell">
      <header className="console-header">
        <div>
          <span className="eyebrow">Agentflow</span>
          <h1>{pageTitle}</h1>
          <p className="page-subtitle">{pageSubtitle}</p>
        </div>
        <div className="header-actions">
          <nav className="route-nav" aria-label="Primary routes">
            <button
              type="button"
              className={`mode-pill${route.kind === "launchpad" ? " mode-pill-active" : ""}`}
              onClick={() => navigate(buildGraphRoute("launchpad", inspection ? { graph_path: inspection.graph_path } : {}))}
            >
              Launchpad
            </button>
            {(route.kind !== "run" ? route.graph_path : inspection?.graph_path) ? (
              <button
                type="button"
                className={`mode-pill${route.kind === "inspect" ? " mode-pill-active" : ""}`}
                onClick={() => {
                  const inspectGraphPath = route.kind === "run" ? inspection?.graph_path : route.graph_path;

                  navigate(
                    buildGraphRoute("inspect", {
                      ...(inspectGraphPath ? { graph_path: inspectGraphPath } : {}),
                      launch_profile: launchProfileDraft,
                      workspace_backend: workspaceBackendDraft,
                      compiled: true
                    })
                  );
                }}
              >
                Inspect
              </button>
            ) : null}
          </nav>
          {route.kind === "run" ? (
            <>
              <button type="button" className="action action-secondary" onClick={() => void runEvents.refresh()}>
                Refresh
              </button>
              {runningRun ? (
                <button
                  type="button"
                  className="action action-secondary"
                  onClick={() => setShowCancelGuide((current) => !current)}
                >
                  {showCancelGuide ? "Hide cancel guide" : "Cancel in CLI"}
                </button>
              ) : null}
            </>
          ) : (
            <button type="button" className="action action-secondary" onClick={() => setPickerOpen(true)}>
              Choose graph
            </button>
          )}
          <div className="header-status">
            <span>{route.kind === "run" ? "Run Status" : "Compile Status"}</span>
            <strong>{route.kind === "run" ? runStatus : inspection?.compile_status ?? "Pending"}</strong>
          </div>
        </div>
      </header>

      {runningRun && showCancelGuide ? (
        <section className="panel-callout panel-callout--warning">
          <strong>Run cancellation stays CLI-owned in this release.</strong>
          <p>
            Press <code>Ctrl-C</code> in the terminal that launched <code>agentflow run</code> for <code>{route.run_id}</code>.
            {" "}The runtime will flush durable <code>Canceled</code> state and the monitor will update from artifacts.
          </p>
        </section>
      ) : null}

      <section className="kpi-strip" aria-label={route.kind === "run" ? "Run summary" : "Graph summary"}>
        {(route.kind === "run" ? runKpis : launchpadKpis).map((kpi) => (
          <article key={kpi.label} className="tile tile-kpi">
            <span className="eyebrow">{kpi.label}</span>
            <strong>{kpi.value}</strong>
          </article>
        ))}
      </section>

      {inspectionError ? (
        <section className="panel-callout panel-callout--error">{inspectionError}</section>
      ) : null}
      {route.kind === "run" && runEvents.error ? (
        <section className="panel-callout panel-callout--warning">{runEvents.error}</section>
      ) : null}
      {route.kind === "run" && runDiagnostics.length > 0 ? (
        <section className={`panel-callout panel-callout--${runDiagnosticsSeverity}`}>
          <strong>Run diagnostics</strong>
          <ul className="stack-list">
            {runDiagnostics.map((diagnostic) => (
              <li key={`${diagnostic.seq}:${diagnostic.event_type}`}>
                <strong>{diagnostic.node_label ?? diagnostic.event_type}</strong>
                <span>{diagnostic.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {route.kind === "run" ? (
        <section className="console-grid console-grid--monitor">
          <GraphPanel
            inspection={null}
            run_snapshot={runEvents.snapshot}
            mode={graphMode}
            filters={graphFilters}
            selected_authored_id={selectedAuthoredId}
            selected_compiled_id={selectedCompiledId}
            onModeChange={setGraphMode}
            onToggleFilter={toggleGraphFilter}
            onSelectAuthoredNode={selectAuthoredNode}
            onSelectCompiledNode={selectCompiledNode}
          />
          <InspectorPanel
            surface="run"
            detail={nodeDetail}
            logs={nodeLogs}
            selected_log_tab={selectedLogTab}
            loading={nodeLoading}
            error={nodeError}
            timeline_panel_id={timelinePanelId}
            logs_panel_id={logsPanelId}
            onSelectExecution={(executionId) => {
              if (route.kind !== "run" || !selectedCompiledId) {
                return;
              }

              void loadNodeLogsForExecution(route.run_id, selectedCompiledId, executionId).catch(() => undefined);
            }}
            onSelectLogTab={setSelectedLogTab}
            onSelectArtifact={(relativePath) => {
              setSelectedArtifactPath(relativePath);
              setSelectedLogTab("artifacts");
            }}
          />
          <TimelinePanel
            surface="run"
            events={runEvents.events}
            stream_mode={runEvents.stream_mode}
            selected_compiled_id={selectedCompiledId}
            panel_id={timelinePanelId}
            onSelectNode={selectCompiledNode}
          />
          <LogsPanel
            surface="run"
            panel_id={logsPanelId}
            node_label={nodeDetail?.node.label ?? null}
            logs={nodeLogs}
            artifact={artifact}
            selected_tab={selectedLogTab}
            selected_artifact_path={selectedArtifactPath}
            loading={nodeLoading}
            error={nodeError}
            onTabChange={setSelectedLogTab}
            onExecutionSelect={(executionId) => {
              if (route.kind !== "run" || !selectedCompiledId) {
                return;
              }

              void loadNodeLogsForExecution(route.run_id, selectedCompiledId, executionId).catch(() => undefined);
            }}
            onArtifactSelect={(relativePath) => {
              setSelectedArtifactPath(relativePath);
              setSelectedLogTab("artifacts");
            }}
          />
        </section>
      ) : (
        <section className="console-grid console-grid--launchpad">
          <GraphPanel
            inspection={inspection}
            run_snapshot={null}
            mode={graphMode}
            filters={graphFilters}
            selected_authored_id={selectedAuthoredId}
            selected_compiled_id={selectedCompiledId}
            onModeChange={setGraphMode}
            onToggleFilter={toggleGraphFilter}
            onSelectAuthoredNode={selectAuthoredNode}
            onSelectCompiledNode={selectCompiledNode}
          />
          <Launchpad
            surface={route.kind}
            graph={inspection}
            graph_path={currentGraphPath}
            launch_profile={launchProfileDraft}
            workspace_backend={workspaceBackendDraft}
            recent_graph_paths={recentGraphPaths}
            busy_action={busyAction}
            picker_open={pickerOpen}
            onOpenPicker={() => setPickerOpen(true)}
            onClosePicker={() => setPickerOpen(false)}
            onConfirmPicker={(path) => {
              setPickerOpen(false);
              navigate(
                buildGraphRoute(route.kind, {
                  graph_path: path,
                  launch_profile: launchProfileDraft,
                  workspace_backend: workspaceBackendDraft
                })
              );
            }}
            onLaunchProfileChange={setLaunchProfileDraft}
            onWorkspaceBackendChange={setWorkspaceBackendDraft}
            onValidate={() => {
              if (!currentGraphPath) {
                return;
              }

              setBusyAction("validate");
              setGraphMode("Authored");
              navigate(
                buildGraphRoute(route.kind, {
                  graph_path: currentGraphPath,
                  launch_profile: launchProfileDraft,
                  workspace_backend: workspaceBackendDraft
                })
              );
            }}
            onCompile={() => {
              if (!currentGraphPath) {
                return;
              }

              setBusyAction("compile");
              setGraphMode("Compiled");
              navigate(
                buildGraphRoute(route.kind, {
                  graph_path: currentGraphPath,
                  launch_profile: launchProfileDraft,
                  workspace_backend: workspaceBackendDraft,
                  compiled: true
                })
              );
            }}
          />
          <InspectorPanel
            surface="launchpad"
            detail={staticInspector}
            error={inspectionError}
          />
          <TimelinePanel
            surface="launchpad"
            {...(inspection?.graph_id ? { graph_id: inspection.graph_id } : {})}
            runs={recentRuns}
            onSelectRun={(runId) => navigate(`/runs/${encodeURIComponent(runId)}`)}
          />
          <LogsPanel
            surface="launchpad"
            graph={inspection}
            diagnostics={diagnostics}
          />
        </section>
      )}
    </main>
  );
}

export default App;
