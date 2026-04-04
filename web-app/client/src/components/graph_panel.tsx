import type { AuthoredGraphNode } from "../../../../src/graph/authored.js";
import type { GraphInspectionPayload, GraphViewMode } from "../../../shared/contracts/graph";
import type { RunSnapshot } from "../../../shared/contracts/runs";
import { buildCompiledGraphCanvas, type GraphFilterKey } from "../lib/graph_view_model";

interface GraphPanelProps {
  inspection: GraphInspectionPayload | null;
  run_snapshot: RunSnapshot | null;
  mode: GraphViewMode;
  filters: GraphFilterKey[];
  selected_authored_id?: string | null;
  selected_compiled_id?: string | null;
  onModeChange: (mode: GraphViewMode) => void;
  onToggleFilter: (filter: GraphFilterKey) => void;
  onSelectAuthoredNode: (authoredId: string) => void;
  onSelectCompiledNode: (compiledId: string) => void;
}

function countAuthoredNodes(node: AuthoredGraphNode): {
  total: number;
  executable: number;
} {
  if (node.type === "agent" || node.type === "exec" || node.type === "check") {
    return {
      total: 1,
      executable: 1
    };
  }

  if (node.type === "repeat") {
    const body = countAuthoredNodes(node.body);

    return {
      total: body.total + 1,
      executable: body.executable
    };
  }

  return node.steps.reduce(
    (summary, child) => {
      const next = countAuthoredNodes(child);

      return {
        total: summary.total + next.total,
        executable: summary.executable + next.executable
      };
    },
    {
      total: 1,
      executable: 0
    }
  );
}

function authoredBadge(node: AuthoredGraphNode): string | undefined {
  if (node.type === "repeat") {
    return `max ${node.max_attempts}`;
  }

  if (node.type === "parallel" && node.max_concurrency) {
    return `max ${node.max_concurrency}`;
  }

  if (node.type === "agent") {
    return node.profile ?? "agent";
  }

  if (node.type === "exec") {
    return node.command;
  }

  if (node.type === "check") {
    return node.check_kind;
  }

  return undefined;
}

function AuthoredLeaf(props: {
  node: AuthoredGraphNode;
  selected_authored_id: string | null | undefined;
  onSelect: (authoredId: string) => void;
}) {
  const { node, selected_authored_id: selectedAuthoredId, onSelect } = props;
  const meta = authoredBadge(node);

  return (
    <button
      type="button"
      className={`authored-leaf authored-leaf--${node.type}${selectedAuthoredId === node.id ? " is-selected" : ""}`}
      onClick={() => onSelect(node.id)}
    >
      <span className="node-chip">{node.type}</span>
      <strong>{node.label ?? node.id}</strong>
      <p>{node.id}</p>
      <div className="node-inline-meta">
        {"repo" in node && node.repo ? <span>{node.repo}</span> : <span>graph default</span>}
        {meta ? <span>{meta}</span> : null}
      </div>
    </button>
  );
}

function AuthoredTree(props: {
  node: AuthoredGraphNode;
  depth?: number;
  selected_authored_id: string | null | undefined;
  onSelect: (authoredId: string) => void;
}) {
  const { node, depth = 0, selected_authored_id: selectedAuthoredId, onSelect } = props;

  if (node.type === "agent" || node.type === "exec" || node.type === "check") {
    return (
      <div className="authored-step">
        <AuthoredLeaf
          node={node}
          selected_authored_id={selectedAuthoredId}
          onSelect={onSelect}
        />
      </div>
    );
  }

  if (node.type === "repeat") {
    return (
      <section className={`authored-structure authored-structure--repeat${selectedAuthoredId === node.id ? " is-selected" : ""}`}>
        <button type="button" className="authored-structure__header" onClick={() => onSelect(node.id)}>
          <div>
            <span className="eyebrow">Repeat</span>
            <h3>{node.label ?? node.id}</h3>
          </div>
          <span className="structure-badge">max {node.max_attempts}</span>
        </button>
        <div className="authored-repeat-body">
          <AuthoredTree
            node={node.body}
            depth={depth + 1}
            selected_authored_id={selectedAuthoredId}
            onSelect={onSelect}
          />
        </div>
        <footer className="authored-structure__footer">until check: {node.until.node}</footer>
      </section>
    );
  }

  if (node.type === "parallel") {
    return (
      <section className={`authored-structure authored-structure--parallel${selectedAuthoredId === node.id ? " is-selected" : ""}`}>
        <button type="button" className="authored-structure__header" onClick={() => onSelect(node.id)}>
          <div>
            <span className="eyebrow">Parallel</span>
            <h3>{node.label ?? node.id}</h3>
          </div>
          <span className="structure-badge">{node.max_concurrency ? `max ${node.max_concurrency}` : "fan-out"}</span>
        </button>
        <div className="authored-parallel-columns">
          {node.steps.map((child) => (
            <div key={child.id} className="authored-parallel-branch">
              <AuthoredTree
                node={child}
                depth={depth + 1}
                selected_authored_id={selectedAuthoredId}
                onSelect={onSelect}
              />
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className={`authored-structure authored-structure--sequence${selectedAuthoredId === node.id ? " is-selected" : ""}`}>
      <button type="button" className="authored-structure__header" onClick={() => onSelect(node.id)}>
        <div>
          <span className="eyebrow">{depth === 0 ? "Graph Root" : "Sequence"}</span>
          <h3>{node.label ?? node.id}</h3>
        </div>
        <span className="structure-badge">{node.steps.length} step{node.steps.length === 1 ? "" : "s"}</span>
      </button>
      <div className="authored-sequence-lane">
        {node.steps.map((child, index) => (
          <div key={child.id} className="authored-sequence-step">
            <AuthoredTree
              node={child}
              depth={depth + 1}
              selected_authored_id={selectedAuthoredId}
              onSelect={onSelect}
            />
            {index < node.steps.length - 1 ? <div className="authored-sequence-arrow" aria-hidden="true" /> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

const filterLabels: Record<GraphFilterKey, string> = {
  active: "Active",
  failed: "Failed",
  checks: "Checks",
  repeats: "Repeats"
};

const modeNarrative: Record<GraphViewMode, {
  label: string;
  detail: string;
}> = {
  Authored: {
    label: "Operator source",
    detail: "Nested author intent stays intact here. Compile-generated detail stays hidden until you switch layers."
  },
  Compiled: {
    label: "Scheduler contract",
    detail: "Only executable nodes render. Scope ancestry and explicit edges show what the runtime will actually schedule."
  },
  Overlay: {
    label: "Runtime overlay",
    detail: "The compiled graph stays stable while one run adds status, attempts, repeat iterations, and active edges."
  }
};

export function GraphPanel(props: GraphPanelProps) {
  const {
    inspection,
    run_snapshot: runSnapshot,
    mode,
    filters,
    selected_authored_id: selectedAuthoredId,
    selected_compiled_id: selectedCompiledId,
    onModeChange,
    onToggleFilter,
    onSelectAuthoredNode,
    onSelectCompiledNode
  } = props;
  const authoredGraph = runSnapshot?.authored_graph ?? inspection?.authored_graph;
  const compiledGraph = runSnapshot?.compiled_graph ?? inspection?.compiled_graph;
  const overlayNodes = runSnapshot?.overlay_nodes ?? [];
  const availableModes: GraphViewMode[] = runSnapshot
    ? [
        ...(authoredGraph ? (["Authored"] as const) : []),
        "Compiled",
        "Overlay"
      ]
    : inspection?.modes ?? ["Authored"];
  const canvas = mode === "Authored"
    ? null
    : buildCompiledGraphCanvas(
        compiledGraph,
        mode === "Overlay" ? overlayNodes : [],
        mode === "Overlay" ? filters : []
      );
  const authoredSummary = authoredGraph ? countAuthoredNodes(authoredGraph.graph) : null;
  const layerCards = [
    {
      key: "Authored",
      title: "Authored",
      value: authoredSummary ? `${authoredSummary.total} nodes` : "Unavailable",
      detail: authoredSummary
        ? `${authoredSummary.executable} executable nodes plus authored sequence, parallel, and repeat regions.`
        : "Choose a graph to inspect authored intent."
    },
    {
      key: "Compiled",
      title: "Compiled",
      value: compiledGraph ? `${compiledGraph.nodes.length} executable nodes` : "Pending",
      detail: compiledGraph
        ? `${compiledGraph.edges.length} edges and ${compiledGraph.scopes.length} scope outlines drive runtime scheduling.`
        : "Compile the graph to materialize runtime topology."
    },
    {
      key: "Overlay",
      title: "Overlay",
      value: runSnapshot ? `${runSnapshot.run.status} · seq ${runSnapshot.snapshot_seq}` : "Run-only",
      detail: runSnapshot
        ? `${runSnapshot.run.active_nodes} active nodes and ${overlayNodes.length} overlay records for this run.`
        : "Attempts, statuses, and event-linked state appear only after a run starts."
    }
  ] as const;

  return (
    <section className="tile tile-graph">
      <div className="tile-header">
        <div>
          <span className="eyebrow">{runSnapshot ? "Run Graph" : "Graph Inspection"}</span>
          <h2>{runSnapshot ? "Compiled graph with runtime overlay" : "Authored and compiled graph views"}</h2>
        </div>
        <div className="tile-header-controls">
          <div className="mode-strip" aria-label="Graph view modes">
            {availableModes.map((availableMode) => (
              <button
                key={availableMode}
                type="button"
                className={`mode-pill${availableMode === mode ? " mode-pill-active" : ""}`}
                onClick={() => onModeChange(availableMode)}
              >
                {availableMode}
              </button>
            ))}
          </div>
          {mode === "Overlay" ? (
            <div className="filter-strip" aria-label="Overlay filters">
              {(Object.keys(filterLabels) as GraphFilterKey[]).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={`filter-pill${filters.includes(filter) ? " filter-pill-active" : ""}`}
                  onClick={() => onToggleFilter(filter)}
                >
                  {filterLabels[filter]}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="graph-layer-strip" aria-label="Authored, compiled, and overlay layers">
        {layerCards.map((layer) => (
          <article
            key={layer.key}
            className={`graph-layer-card${mode === layer.key ? " is-active" : ""}${layer.key === "Overlay" && !runSnapshot ? " is-muted" : ""}`}
          >
            <span className="eyebrow">{layer.title}</span>
            <strong>{layer.value}</strong>
            <p>{layer.detail}</p>
          </article>
        ))}
      </div>
      <div className="graph-mode-callout">
        <strong>{modeNarrative[mode].label}</strong>
        <p>{modeNarrative[mode].detail}</p>
      </div>

      {mode === "Authored" ? (
        authoredGraph ? (
          <div className="graph-scroll">
            <div className="authored-graph-shell">
              <AuthoredTree
                node={authoredGraph.graph}
                selected_authored_id={selectedAuthoredId}
                onSelect={onSelectAuthoredNode}
              />
            </div>
          </div>
        ) : (
          <div className="empty-panel">Choose a graph file to inspect the authored graph.</div>
        )
      ) : canvas?.empty_label ? (
        <div className="empty-panel">{canvas.empty_label}</div>
      ) : canvas ? (
        <div className="graph-scroll">
          <div className="compiled-graph-canvas" style={{ width: canvas.width, height: canvas.height }}>
            <svg className="compiled-graph-edges" width={canvas.width} height={canvas.height} viewBox={`0 0 ${canvas.width} ${canvas.height}`} aria-hidden="true">
              <defs>
                <marker id="graph-edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {canvas.edges.map((edge) => (
                <path
                  key={edge.id}
                  d={edge.path}
                  className={`graph-edge graph-edge--${edge.kind}${edge.active ? " is-active" : ""}${edge.muted ? " is-muted" : ""}`}
                  markerEnd="url(#graph-edge-arrow)"
                />
              ))}
            </svg>
            {canvas.scopes.map((scope) => (
              <div
                key={scope.id}
                className={`scope-outline scope-outline--${scope.kind}`}
                style={{
                  left: scope.x,
                  top: scope.y,
                  width: scope.width,
                  height: scope.height
                }}
              >
                <span>{scope.label}</span>
              </div>
            ))}
            {canvas.nodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className={`compiled-node compiled-node--${node.kind}${selectedCompiledId === node.id ? " is-selected" : ""}${node.status ? ` is-${node.status.toLowerCase()}` : ""}`}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height
                }}
                onClick={() => onSelectCompiledNode(node.id)}
              >
                <div className="compiled-node__topline">
                  <span className="node-chip">{node.kind}</span>
                  {node.status ? <span className={`status-badge status-badge--${node.status.toLowerCase()}`}>{node.status}</span> : null}
                </div>
                <strong>{node.label}</strong>
                <p>{node.id}</p>
                <div className="node-inline-meta">
                  <span>{node.repo_alias}</span>
                  {node.badge ? <span>{node.badge}</span> : null}
                  {node.iteration_index !== undefined || node.attempt_index !== undefined ? (
                    <span>
                      {node.iteration_index !== undefined ? `i${node.iteration_index}` : ""}
                      {node.attempt_index !== undefined ? `${node.iteration_index !== undefined ? "/" : ""}a${node.attempt_index}` : ""}
                    </span>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
