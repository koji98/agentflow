import { useState } from "react";

import type { RunEvent, RunSummary } from "../../../shared/contracts/runs";

type TimelinePanelProps =
  | {
      surface: "launchpad";
      graph_id?: string | null;
      runs: RunSummary[];
      onSelectRun: (runId: string) => void;
    }
  | {
      surface: "run";
      panel_id: string;
      events: RunEvent[];
      stream_mode: "idle" | "loading" | "live" | "polling" | "static";
      selected_compiled_id?: string | null;
      onSelectNode: (compiledId: string) => void;
    };

function formatTimestamp(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "short",
    day: "numeric"
  });
}

function summarizeScope(event: RunEvent): string[] {
  return [
    event.node_label ?? event.compiled_id ?? null,
    event.execution_id ?? null,
    event.iteration_index !== undefined ? `i${event.iteration_index}` : null,
    event.attempt_index !== undefined ? `a${event.attempt_index}` : null,
    event.repeat_scope_id ?? null
  ].filter((value): value is string => Boolean(value));
}

export function TimelinePanel(props: TimelinePanelProps) {
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("all");
  const [nodeScoped, setNodeScoped] = useState(false);

  if (props.surface === "launchpad") {
    return (
      <section className="tile tile-timeline">
        <div className="tile-header">
          <div>
            <span className="eyebrow">Recent Runs</span>
            <h2>{props.graph_id ? `Latest runs for ${props.graph_id}` : "Open a graph to inspect prior runs"}</h2>
          </div>
        </div>
        {props.runs.length > 0 ? (
          <ol className="event-list">
            {props.runs.map((run) => (
              <li key={run.run_id}>
                <span>{formatTimestamp(run.started_at)}</span>
                <button type="button" className="timeline-link" onClick={() => props.onSelectRun(run.run_id)}>
                  <strong>{run.run_id}</strong>
                </button>
                <p>{run.status} · profile {run.launch_profile} · {run.workspace_backend}</p>
              </li>
            ))}
          </ol>
        ) : (
          <div className="empty-panel">No historical runs were found for the selected graph.</div>
        )}
      </section>
    );
  }

  const availableTypes = Array.from(new Set(props.events.map((event) => event.type)));
  const visibleEvents = props.events.filter((event) => {
    if (eventTypeFilter !== "all" && event.type !== eventTypeFilter) {
      return false;
    }

    if (nodeScoped && props.selected_compiled_id && event.compiled_id && event.compiled_id !== props.selected_compiled_id) {
      return false;
    }

    return true;
  });
  const latestEvent = visibleEvents[0] ?? props.events[0] ?? null;
  const selectedNodeEvents = props.selected_compiled_id
    ? props.events.filter((event) => event.compiled_id === props.selected_compiled_id).length
    : 0;

  return (
    <section id={props.panel_id} className="tile tile-timeline">
      <div className="tile-header">
        <div>
          <span className="eyebrow">Run Activity</span>
          <h2>Event timeline</h2>
        </div>
        <span className={`status-badge status-badge--${props.stream_mode === "live" ? "running" : props.stream_mode === "polling" ? "ready" : "pending"}`}>
          {props.stream_mode}
        </span>
      </div>
      <div className="timeline-summary-grid">
        <article className="timeline-summary-card">
          <span className="eyebrow">Visible</span>
          <strong>{visibleEvents.length}</strong>
          <p>{nodeScoped && props.selected_compiled_id ? "Filtered to the selected node." : "All matching runtime events."}</p>
        </article>
        <article className="timeline-summary-card">
          <span className="eyebrow">Selected Node</span>
          <strong>{props.selected_compiled_id ? selectedNodeEvents : 0}</strong>
          <p>{props.selected_compiled_id ? props.selected_compiled_id : "No compiled node selected."}</p>
        </article>
        <article className="timeline-summary-card">
          <span className="eyebrow">Latest Event</span>
          <strong>{latestEvent?.type ?? "No events"}</strong>
          <p>{latestEvent ? formatTimestamp(latestEvent.ts) : "The event stream has not produced activity yet."}</p>
        </article>
      </div>
      <div className="timeline-filters">
        <button
          type="button"
          className={`filter-pill${eventTypeFilter === "all" ? " filter-pill-active" : ""}`}
          onClick={() => setEventTypeFilter("all")}
        >
          all
        </button>
        {availableTypes.slice(0, 6).map((type) => (
          <button
            key={type}
            type="button"
            className={`filter-pill${eventTypeFilter === type ? " filter-pill-active" : ""}`}
            onClick={() => setEventTypeFilter(type)}
          >
            {type}
          </button>
        ))}
        {props.selected_compiled_id ? (
          <button
            type="button"
            className={`filter-pill${nodeScoped ? " filter-pill-active" : ""}`}
            onClick={() => setNodeScoped((current) => !current)}
          >
            selected node
          </button>
        ) : null}
      </div>
      {visibleEvents.length > 0 ? (
        <ol className="event-stream">
          {visibleEvents.map((event) => (
            <li key={event.seq} className="event-card">
              <div className="event-card__topline">
                <span>{formatTimestamp(event.ts)}</span>
                <div className="event-card__tags">
                  <span className="node-chip">{event.type}</span>
                  <span className="node-chip">seq {event.seq}</span>
                </div>
              </div>
              <div className="event-card__headline">
                {event.compiled_id ? (
                  <button type="button" className="timeline-link" onClick={() => props.onSelectNode(event.compiled_id!)}>
                    <strong>{event.node_label ?? event.compiled_id}</strong>
                  </button>
                ) : (
                  <strong>{event.node_label ?? "run-wide event"}</strong>
                )}
              </div>
              <p>{event.summary}</p>
              <div className="event-card__meta">
                {summarizeScope(event).map((value) => (
                  <span key={`${event.seq}:${value}`}>{value}</span>
                ))}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="empty-panel">No events match the current filters.</div>
      )}
    </section>
  );
}
