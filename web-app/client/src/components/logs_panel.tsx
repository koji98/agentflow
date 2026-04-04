import type { GraphInspectionPayload } from "../../../shared/contracts/graph";
import type { ArtifactRead, NodeLogPayload } from "../../../shared/contracts/runs";

type LogTab = "stdout" | "stderr" | "artifacts";

type LogsPanelProps =
  | {
      surface: "launchpad";
      graph: GraphInspectionPayload | null;
      diagnostics: string[];
    }
  | {
      surface: "run";
      panel_id: string;
      node_label: string | null;
      logs: NodeLogPayload | null;
      artifact: ArtifactRead | null;
      selected_tab: LogTab;
      selected_artifact_path?: string | null;
      loading: boolean;
      error: string | null;
      onTabChange: (tab: LogTab) => void;
      onExecutionSelect: (executionId: string) => void;
      onArtifactSelect: (relativePath: string) => void;
    };

function formatDuration(durationMs: number | undefined): string {
  if (!durationMs || durationMs <= 0) {
    return "0ms";
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = durationMs / 1000;

  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function LogsPanel(props: LogsPanelProps) {
  if (props.surface === "launchpad") {
    return (
      <section className="tile tile-logs">
        <div className="tile-header">
          <div>
            <span className="eyebrow">Diagnostics and Repos</span>
            <h2>Validation, compile output, and workspace mapping</h2>
          </div>
        </div>
        {props.graph?.graph_path ? (
          <div className="panel-callout">
            <strong>Graph path</strong>
            <p>{props.graph.graph_path}</p>
          </div>
        ) : null}
        <div className="launchpad-details-grid">
          <section className="detail-stack">
            <h3>Diagnostics</h3>
            {props.diagnostics.length > 0 ? (
              <ul className="stack-list">
                {props.diagnostics.map((diagnostic) => (
                  <li key={diagnostic}>{diagnostic}</li>
                ))}
              </ul>
            ) : (
              <p className="section-empty">No validation or compile diagnostics are active.</p>
            )}
          </section>
          <section className="detail-stack">
            <h3>Repo Mapping</h3>
            {props.graph?.repos.length ? (
              <ul className="stack-list">
                {props.graph.repos.map((repo) => (
                  <li key={repo.alias}>
                    <strong>{repo.alias}</strong>
                    <span>{repo.source_path}</span>
                    <span>{repo.workspace_path ?? repo.workspace_path_preview ?? "workspace pending"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="section-empty">Select a graph to inspect repo aliases and workspace paths.</p>
            )}
          </section>
        </div>
      </section>
    );
  }

  if (props.loading) {
    return (
      <section id={props.panel_id} className="tile tile-logs">
        <div className="tile-header">
          <div>
            <span className="eyebrow">Logs and Artifacts</span>
            <h2>Selected node stream</h2>
          </div>
        </div>
        <div className="empty-panel">Reading stdout, stderr, artifacts, and execution history.</div>
      </section>
    );
  }

  if (props.error) {
    return (
      <section id={props.panel_id} className="tile tile-logs">
        <div className="tile-header">
          <div>
            <span className="eyebrow">Logs and Artifacts</span>
            <h2>Selected node stream</h2>
          </div>
        </div>
        <div className="panel-callout panel-callout--error">{props.error}</div>
      </section>
    );
  }

  const selectedExecution = props.logs?.executions.find((execution) => execution.execution_id === props.logs?.selected_execution_id)
    ?? props.logs?.executions[0]
    ?? null;
  const artifactCount = props.logs?.artifacts.filter((artifact) => artifact.kind !== "stdout" && artifact.kind !== "stderr").length ?? 0;

  return (
    <section id={props.panel_id} className="tile tile-logs">
      <div className="tile-header">
        <div>
          <span className="eyebrow">Logs and Artifacts</span>
          <h2>{props.node_label ? `${props.node_label} execution output` : "Selected node stream"}</h2>
        </div>
        <div className="tab-strip" aria-label="Log and artifact views">
          {([
            { key: "stdout" as const, label: "stdout" },
            { key: "stderr" as const, label: "stderr" },
            { key: "artifacts" as const, label: `artifacts ${artifactCount}` }
          ]).map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`mode-pill${props.selected_tab === tab.key ? " mode-pill-active" : ""}`}
              onClick={() => props.onTabChange(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {selectedExecution ? (
        <div className="panel-callout execution-callout">
          <strong>{selectedExecution.execution_id}</strong>
          <p>
            {selectedExecution.status} · {selectedExecution.outcome ?? "outcome pending"} ·
            {" "}i{selectedExecution.iteration_index ?? 0}/a{selectedExecution.attempt_index} ·
            {" "}{formatDuration(selectedExecution.duration_ms)} · {selectedExecution.artifact_count} artifacts
          </p>
        </div>
      ) : null}

      {props.logs?.executions.length ? (
        <div className="execution-grid" aria-label="Node executions">
          {props.logs.executions.map((execution) => (
            <button
              key={execution.execution_id}
              type="button"
              className={`execution-card${props.logs?.selected_execution_id === execution.execution_id ? " is-selected" : ""}`}
              onClick={() => props.onExecutionSelect(execution.execution_id)}
            >
              <div className="execution-card__topline">
                <strong>{execution.execution_id}</strong>
                <span className={`status-badge status-badge--${execution.status.toLowerCase()}`}>{execution.status}</span>
              </div>
              <p>{execution.outcome ?? "outcome pending"}</p>
              <div className="execution-card__meta">
                <span>i{execution.iteration_index ?? 0}</span>
                <span>a{execution.attempt_index}</span>
                <span>{formatDuration(execution.duration_ms)}</span>
                <span>{execution.artifact_count} artifacts</span>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {!props.logs ? (
        <div className="empty-panel">Select a compiled node to read its latest execution logs and artifacts.</div>
      ) : props.selected_tab === "stdout" ? (
        <pre className="log-console">{props.logs.stdout?.content ?? "stdout.log is not available for the selected execution."}</pre>
      ) : props.selected_tab === "stderr" ? (
        <pre className="log-console">{props.logs.stderr?.content ?? "stderr.log is not available for the selected execution."}</pre>
      ) : (
        <div className="artifact-browser">
          <aside className="artifact-index">
            {props.logs.artifacts.length > 0 ? (
              props.logs.artifacts.map((artifact) => (
                <button
                  key={`${artifact.execution_id}:${artifact.relative_path}`}
                  type="button"
                  className={`artifact-link${props.selected_artifact_path === artifact.relative_path ? " is-selected" : ""}`}
                  onClick={() => props.onArtifactSelect(artifact.relative_path)}
                >
                  <strong>{artifact.relative_path}</strong>
                  <span>{artifact.kind} · {artifact.size_bytes} bytes</span>
                </button>
              ))
            ) : (
              <p className="section-empty">No artifacts are indexed for the selected execution.</p>
            )}
          </aside>
          <div className="artifact-preview">
            {props.artifact ? (
              <>
                <div className="artifact-preview__meta">
                  <strong>{props.artifact.artifact.relative_path}</strong>
                  <span>{props.artifact.artifact.content_type}</span>
                </div>
                <pre className="log-console">{props.artifact.content}</pre>
              </>
            ) : (
              <div className="empty-panel">Choose an artifact to preview its captured contents.</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
