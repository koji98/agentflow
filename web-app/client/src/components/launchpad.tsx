import { useEffect, useState } from "react";

import type { GraphInspectionPayload } from "../../../shared/contracts/graph";

interface LaunchpadProps {
  surface: "launchpad" | "inspect";
  graph: GraphInspectionPayload | null;
  graph_path: string;
  launch_profile: string;
  workspace_backend: "inplace" | "worktree";
  recent_graph_paths: string[];
  busy_action: "validate" | "compile" | null;
  picker_open: boolean;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  onConfirmPicker: (path: string) => void;
  onLaunchProfileChange: (value: string) => void;
  onWorkspaceBackendChange: (value: "inplace" | "worktree") => void;
  onValidate: () => void;
  onCompile: () => void;
}

function pathSegments(value: string): string[] {
  return value.split(/[\\/]/).filter(Boolean);
}

export function Launchpad(props: LaunchpadProps) {
  const [draftPath, setDraftPath] = useState(props.graph_path);
  const availableProfiles = props.graph?.launch_resolution.available_profiles.length
    ? props.graph.launch_resolution.available_profiles
    : props.launch_profile
      ? [props.launch_profile]
      : ["default"];

  useEffect(() => {
    if (props.picker_open) {
      setDraftPath(props.graph_path);
    }
  }, [props.graph_path, props.picker_open]);

  return (
    <>
      <section className="tile tile-controls">
        <div className="tile-header">
          <div>
            <span className="eyebrow">{props.surface === "launchpad" ? "Launch Controls" : "Inspection Controls"}</span>
            <h2>{props.surface === "launchpad" ? "Resolve graph launch" : "Resolve graph inspection"}</h2>
          </div>
        </div>
        <div className="control-grid">
          <label className="control-field">
            <span>Graph File</span>
            <button type="button" className="action action-secondary" onClick={props.onOpenPicker}>
              {props.graph_path ? "Change authored graph" : "Choose authored graph"}
            </button>
            <small>{props.graph_path || "No graph selected yet."}</small>
          </label>
          <label className="control-field">
            <span>Launch Profile</span>
            <select value={props.launch_profile} onChange={(event) => props.onLaunchProfileChange(event.target.value)}>
              {availableProfiles.map((profile) => (
                <option key={profile} value={profile}>
                  {profile}
                </option>
              ))}
            </select>
          </label>
          <label className="control-field">
            <span>Workspace Backend</span>
            <select
              value={props.workspace_backend}
              onChange={(event) => props.onWorkspaceBackendChange(event.target.value as "inplace" | "worktree")}
            >
              <option value="worktree">worktree</option>
              <option value="inplace">inplace</option>
            </select>
            <small>Workspace backend is resolved once per run, not per node.</small>
          </label>
        </div>
        <div className="action-row">
          <button type="button" className="action action-secondary" onClick={props.onValidate} disabled={!props.graph_path || props.busy_action !== null}>
            {props.busy_action === "validate" ? "Validating..." : "Validate"}
          </button>
          <button type="button" className="action action-secondary" onClick={props.onCompile} disabled={!props.graph_path || props.busy_action !== null}>
            {props.busy_action === "compile" ? "Compiling..." : "Compile"}
          </button>
          {props.surface === "launchpad" ? (
            <button type="button" className="action action-primary" disabled>
              Run
            </button>
          ) : null}
        </div>
        <div className="panel-callout">
          <strong>{props.graph?.compile_status === "Ready" ? "Compiled graph is ready." : "Run launch stays local-first in this release."}</strong>
          <p>
            {props.graph?.compile_status === "Ready"
              ? `Use "agentflow run --graph ${props.graph.graph_path} --profile ${props.launch_profile} --workspace-backend ${props.workspace_backend}" to start a durable run.`
              : "Validate and compile first, then launch the graph from the CLI while the client monitor consumes the durable run artifacts."}
          </p>
        </div>
      </section>

      {props.picker_open ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="graph-picker-title">
            <div className="tile-header">
              <div>
                <span className="eyebrow">Graph Picker</span>
                <h2 id="graph-picker-title">Choose an authored graph path</h2>
              </div>
            </div>
            <label className="control-field">
              <span>Absolute or workspace-relative path</span>
              <input
                className="path-input"
                type="text"
                value={draftPath}
                onChange={(event) => setDraftPath(event.target.value)}
                placeholder="/path/to/agentflow.graph.json"
              />
            </label>
            <div className="picker-breadcrumbs" aria-label="Path breadcrumbs">
              {pathSegments(draftPath).length > 0 ? (
                pathSegments(draftPath).map((segment, index) => (
                  <span key={`${segment}:${index}`}>{segment}</span>
                ))
              ) : (
                <span>Enter a graph path to inspect authored structure and compile output.</span>
              )}
            </div>
            <section className="detail-stack">
              <h3>Recent graph files</h3>
              {props.recent_graph_paths.length > 0 ? (
                <div className="picker-recents">
                  {props.recent_graph_paths.map((recentPath) => (
                    <button key={recentPath} type="button" className="artifact-link" onClick={() => setDraftPath(recentPath)}>
                      <strong>{recentPath}</strong>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="section-empty">Recent graph selections will appear here after the first inspect.</p>
              )}
            </section>
            <div className="modal-actions">
              <button type="button" className="action action-secondary" onClick={props.onClosePicker}>
                Cancel
              </button>
              <button
                type="button"
                className="action action-primary"
                onClick={() => props.onConfirmPicker(draftPath.trim())}
                disabled={!draftPath.trim()}
              >
                Confirm graph
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
