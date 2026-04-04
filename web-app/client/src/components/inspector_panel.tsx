import type { NodeDetail, NodeLogPayload } from "../../../shared/contracts/runs";
import { buildRunInspectorSections, type StaticInspectorModel } from "../lib/graph_view_model";

type LogTab = "stdout" | "stderr" | "artifacts";

type InspectorPanelProps =
  | {
      surface: "launchpad";
      detail: StaticInspectorModel | null;
      loading?: boolean;
      error?: string | null;
    }
  | {
      surface: "run";
      detail: NodeDetail | null;
      logs: NodeLogPayload | null;
      selected_log_tab: LogTab;
      loading: boolean;
      error: string | null;
      timeline_panel_id: string;
      logs_panel_id: string;
      onSelectExecution: (executionId: string) => void;
      onSelectLogTab: (tab: LogTab) => void;
      onSelectArtifact: (relativePath: string) => void;
    };

function sectionId(title: string): string {
  return `inspector-${title.toLowerCase().replace(/\s+/g, "-")}`;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return "No timestamp";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

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

function pickLatestEvent(detail: NodeDetail): NodeDetail["events"][number] | undefined {
  return [...detail.events].sort((left, right) => right.seq - left.seq)[0];
}

function focusSurface(targetId: string, callback?: () => void): void {
  callback?.();

  if (typeof document !== "undefined") {
    document.getElementById(targetId)?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }
}

function renderRows(sections: Array<{
  title: string;
  empty_label: string;
  rows: Array<{
    label: string;
    value: string;
  }>;
}>) {
  return sections.map((section) => (
    <section key={section.title} id={sectionId(section.title)} className="inspector-section">
      <header className="inspector-section__header">
        <span className="eyebrow">{section.title}</span>
      </header>
      {section.rows.length > 0 ? (
        <dl className="inspector-list">
          {section.rows.map((row) => (
            <div key={`${section.title}:${row.label}`}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="section-empty">{section.empty_label}</p>
      )}
    </section>
  ));
}

export function InspectorPanel(props: InspectorPanelProps) {
  if (props.loading) {
    return (
      <aside id="inspector-panel" className="tile tile-inspector">
        <div className="tile-header">
          <div>
            <span className="eyebrow">Node Inspection</span>
            <h2>Loading node detail</h2>
          </div>
        </div>
        <div className="empty-panel">Reading node detail, execution history, and node-scoped evidence.</div>
      </aside>
    );
  }

  if (props.error) {
    return (
      <aside id="inspector-panel" className="tile tile-inspector">
        <div className="tile-header">
          <div>
            <span className="eyebrow">Node Inspection</span>
            <h2>Inspector unavailable</h2>
          </div>
        </div>
        <div className="panel-callout panel-callout--error">{props.error}</div>
      </aside>
    );
  }

  if (!props.detail) {
    return (
      <aside id="inspector-panel" className="tile tile-inspector">
        <div className="tile-header">
          <div>
            <span className="eyebrow">Node Inspection</span>
            <h2>No node selected</h2>
          </div>
        </div>
        <div className="empty-panel">Select a graph node to inspect its definition, policy, inputs, attempts, and evidence.</div>
      </aside>
    );
  }

  if (props.surface === "run") {
    const detail = props.detail;
    const selectedExecutionId = props.logs?.selected_execution_id ?? detail.selected_execution_id;
    const selectedExecution = detail.executions.find((execution) => execution.execution_id === selectedExecutionId)
      ?? detail.executions[0];
    const latestEvent = pickLatestEvent(detail);
    const baseSections = buildRunInspectorSections(detail).filter((section) =>
      section.title === "Definition" || section.title === "Profile" || section.title === "Inputs"
    );
    const artifactCount = detail.artifacts.filter((artifact) => artifact.kind !== "stdout" && artifact.kind !== "stderr").length;
    const sectionLinks = [
      { key: "overview", label: "Overview", action: () => focusSurface(sectionId("Overview")) },
      { key: "definition", label: "Definition", action: () => focusSurface(sectionId("Definition")) },
      { key: "profile", label: "Profile", action: () => focusSurface(sectionId("Profile")) },
      { key: "inputs", label: "Inputs", action: () => focusSurface(sectionId("Inputs")) },
      { key: "executions", label: "Executions", action: () => focusSurface(sectionId("Executions")) },
      { key: "checks", label: "Checks", action: () => focusSurface(sectionId("Checks")) },
      { key: "artifacts", label: "Artifacts", action: () => focusSurface(sectionId("Artifacts")) },
      { key: "events", label: "Events", action: () => focusSurface(sectionId("Events")) },
      { key: "logs", label: "Logs", action: () => focusSurface(props.logs_panel_id) },
      { key: "timeline", label: "Timeline", action: () => focusSurface(props.timeline_panel_id) }
    ];

    return (
      <aside id="inspector-panel" className="tile tile-inspector">
        <div className="tile-header">
          <div>
            <span className="eyebrow">Node Inspection</span>
            <h2>{detail.node.label}</h2>
          </div>
          <span className={`status-badge status-badge--${detail.node.status.toLowerCase()}`}>{detail.node.status}</span>
        </div>
        <div className="inspector-summary inspector-summary--layers">
          <span className="node-chip">{detail.node.kind}</span>
          <span>authored {detail.node.authored_id}</span>
          <span>compiled {detail.node.compiled_id}</span>
          <span>overlay {detail.node.status}</span>
          {detail.node.repo_alias ? <span>{detail.node.repo_alias}</span> : null}
          <span>{detail.effective_policy.profile_name}</span>
          {detail.node.repeat_scope_id ? <span>{detail.node.repeat_scope_id}</span> : null}
          {detail.node.iteration_index !== undefined ? (
            <span>
              i{detail.node.iteration_index}/a{detail.node.attempt_index ?? 1}
            </span>
          ) : null}
        </div>
        <div className="inspector-jump-strip" aria-label="Inspector sections">
          {sectionLinks.map((link) => (
            <button key={link.key} type="button" className="mode-pill" onClick={link.action}>
              {link.label}
            </button>
          ))}
        </div>

        <section id={sectionId("Overview")} className="inspector-section inspector-section--overview">
          <header className="inspector-section__header">
            <span className="eyebrow">Overview</span>
          </header>
          <div className="inspector-overview-grid">
            <article className="inspector-overview-card">
              <span className="eyebrow">Authored Layer</span>
              <strong>{detail.node.authored_id}</strong>
              <p>Source node id from the operator-authored graph.</p>
            </article>
            <article className="inspector-overview-card">
              <span className="eyebrow">Compiled Layer</span>
              <strong>{detail.node.compiled_id}</strong>
              <p>{detail.deps.length > 0 ? `${detail.deps.length} dependency edges` : "Entry node with no dependencies"}.</p>
            </article>
            <article className="inspector-overview-card">
              <span className="eyebrow">Runtime Overlay</span>
              <strong>{detail.node.status}</strong>
              <p>
                {selectedExecution
                  ? `${selectedExecution.execution_id} · ${formatDuration(selectedExecution.duration_ms)}`
                  : "No execution attempt recorded yet."}
              </p>
            </article>
            <article className="inspector-overview-card">
              <span className="eyebrow">Timeline</span>
              <strong>{detail.events.length} events</strong>
              <p>{latestEvent ? `${latestEvent.type} @ ${formatTimestamp(latestEvent.ts)}` : "No node-scoped runtime events yet."}</p>
            </article>
          </div>
        </section>

        <section id={sectionId("Logs")} className="inspector-section">
          <header className="inspector-section__header">
            <span className="eyebrow">Logs</span>
          </header>
          <div className="surface-link-panel">
            <div>
              <strong>{selectedExecution?.execution_id ?? "No execution selected"}</strong>
              <p>
                {props.logs?.stdout ? "stdout ready" : "stdout missing"} · {props.logs?.stderr ? "stderr ready" : "stderr missing"} ·
                {" "}{artifactCount} indexed artifacts
              </p>
            </div>
            <div className="surface-link-actions">
              <button
                type="button"
                className={`mode-pill${props.selected_log_tab === "stdout" ? " mode-pill-active" : ""}`}
                onClick={() => focusSurface(props.logs_panel_id, () => props.onSelectLogTab("stdout"))}
              >
                Stdout
              </button>
              <button
                type="button"
                className={`mode-pill${props.selected_log_tab === "stderr" ? " mode-pill-active" : ""}`}
                onClick={() => focusSurface(props.logs_panel_id, () => props.onSelectLogTab("stderr"))}
              >
                Stderr
              </button>
              <button
                type="button"
                className={`mode-pill${props.selected_log_tab === "artifacts" ? " mode-pill-active" : ""}`}
                onClick={() => focusSurface(props.logs_panel_id, () => props.onSelectLogTab("artifacts"))}
              >
                Artifacts
              </button>
            </div>
          </div>
        </section>

        <section id={sectionId("Timeline")} className="inspector-section">
          <header className="inspector-section__header">
            <span className="eyebrow">Timeline</span>
          </header>
          <div className="surface-link-panel">
            <div>
              <strong>{latestEvent ? latestEvent.type : "No timeline activity"}</strong>
              <p>{latestEvent ? latestEvent.summary : "Open the timeline tile to inspect node-scoped event flow in context."}</p>
            </div>
            <div className="surface-link-actions">
              <button type="button" className="mode-pill" onClick={() => focusSurface(props.timeline_panel_id)}>
                Open timeline
              </button>
            </div>
          </div>
        </section>

        {renderRows(baseSections)}

        <section id={sectionId("Executions")} className="inspector-section">
          <header className="inspector-section__header">
            <span className="eyebrow">Executions</span>
          </header>
          {detail.executions.length > 0 ? (
            <div className="attempt-grid">
              {detail.executions.map((execution) => (
                <button
                  key={execution.execution_id}
                  type="button"
                  className={`attempt-card${selectedExecutionId === execution.execution_id ? " is-selected" : ""}`}
                  onClick={() => props.onSelectExecution(execution.execution_id)}
                >
                  <div className="attempt-card__topline">
                    <strong>{execution.execution_id}</strong>
                    <span className={`status-badge status-badge--${execution.status.toLowerCase()}`}>{execution.status}</span>
                  </div>
                  <p>{formatTimestamp(execution.started_at)}</p>
                  <div className="attempt-card__meta">
                    <span>{execution.outcome ? `outcome ${execution.outcome}` : "outcome pending"}</span>
                    <span>{execution.iteration_index !== undefined ? `i${execution.iteration_index}` : "i0"}</span>
                    <span>a{execution.attempt_index}</span>
                    <span>{formatDuration(execution.duration_ms)}</span>
                    <span>{execution.artifact_count} artifacts</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="section-empty">No executions recorded for this node.</p>
          )}
        </section>

        <section id={sectionId("Checks")} className="inspector-section">
          <header className="inspector-section__header">
            <span className="eyebrow">Checks</span>
          </header>
          {detail.check_evaluations.length > 0 ? (
            <div className="inspector-card-list">
              {detail.check_evaluations.map((evaluation) => (
                <article key={`${evaluation.seq}:${evaluation.check_kind}`} className="inspector-card">
                  <div className="attempt-card__topline">
                    <strong>{evaluation.check_kind}</strong>
                    <span className={`status-badge status-badge--${evaluation.passed ? "passed" : "failed"}`}>
                      {evaluation.passed ? "Passed" : "Failed"}
                    </span>
                  </div>
                  <p>seq {evaluation.seq}{evaluation.execution_id ? ` · ${evaluation.execution_id}` : ""}</p>
                  <div className="attempt-card__meta">
                    {evaluation.score !== undefined ? <span>score {evaluation.score}</span> : null}
                    <span>{evaluation.summary ?? "No evaluator summary captured."}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="section-empty">No evaluator output recorded.</p>
          )}
        </section>

        <section id={sectionId("Artifacts")} className="inspector-section">
          <header className="inspector-section__header">
            <span className="eyebrow">Artifacts</span>
          </header>
          {detail.artifacts.length > 0 ? (
            <div className="inspector-card-list">
              {detail.artifacts.map((artifact) => (
                <button
                  key={`${artifact.execution_id}:${artifact.relative_path}`}
                  type="button"
                  className="inspector-card inspector-card--interactive"
                  onClick={() => focusSurface(props.logs_panel_id, () => props.onSelectArtifact(artifact.relative_path))}
                >
                  <div className="attempt-card__topline">
                    <strong>{artifact.relative_path}</strong>
                    <span className="node-chip">{artifact.kind}</span>
                  </div>
                  <p>{artifact.execution_id}</p>
                  <div className="attempt-card__meta">
                    <span>{artifact.size_bytes} bytes</span>
                    <span>{artifact.content_type}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="section-empty">No artifacts recorded for this node.</p>
          )}
        </section>

        <section id={sectionId("Events")} className="inspector-section">
          <header className="inspector-section__header">
            <span className="eyebrow">Events</span>
          </header>
          {detail.events.length > 0 ? (
            <div className="inspector-card-list">
              {[...detail.events].sort((left, right) => right.seq - left.seq).map((event) => (
                <button
                  key={event.seq}
                  type="button"
                  className="inspector-card inspector-card--interactive"
                  onClick={() => focusSurface(props.timeline_panel_id)}
                >
                  <div className="attempt-card__topline">
                    <strong>{event.type}</strong>
                    <span className="node-chip">seq {event.seq}</span>
                  </div>
                  <p>{formatTimestamp(event.ts)}</p>
                  <div className="attempt-card__meta">
                    <span>{event.summary}</span>
                    {event.execution_id ? <span>{event.execution_id}</span> : null}
                    {event.iteration_index !== undefined ? <span>i{event.iteration_index}</span> : null}
                    {event.attempt_index !== undefined ? <span>a{event.attempt_index}</span> : null}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="section-empty">No node-scoped events recorded.</p>
          )}
        </section>
      </aside>
    );
  }

  const detail = props.detail;

  return (
    <aside id="inspector-panel" className="tile tile-inspector">
      <div className="tile-header">
        <div>
          <span className="eyebrow">Node Inspection</span>
          <h2>{detail.label}</h2>
        </div>
        {detail.status ? <span className={`status-badge status-badge--${detail.status.toLowerCase()}`}>{detail.status}</span> : null}
      </div>
      <div className="inspector-summary inspector-summary--layers">
        <span className="node-chip">{detail.kind}</span>
        <span>authored {detail.authored_id}</span>
        {detail.compiled_id ? <span>compiled {detail.compiled_id}</span> : null}
        {detail.status ? <span>overlay {detail.status}</span> : null}
        {detail.repo_alias ? <span>{detail.repo_alias}</span> : null}
        {detail.profile_name ? <span>{detail.profile_name}</span> : null}
        {detail.repeat_scope_id ? <span>{detail.repeat_scope_id}</span> : null}
        {detail.iteration_label ? <span>{detail.iteration_label}</span> : null}
      </div>
      {renderRows(detail.sections)}
    </aside>
  );
}
