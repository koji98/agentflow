import type { AuthoredGraphDocument, AuthoredGraphSummary } from "../../../src/graph/authored.js";
import type { CompiledGraph } from "../../../src/graph/compiled.js";
import type { GraphDiagnostic, WorkspaceBackend } from "../../../src/graph/schema.js";
import type { ProjectionStatus } from "../../../src/artifacts/projection.js";

export type GraphViewMode = "Authored" | "Compiled" | "Overlay";
export type GraphNodeKind = "agent" | "exec" | "check" | "sequence" | "parallel" | "repeat";
export type GraphCompileStatus = "Pending" | "Ready" | "Failed";

export interface GraphRepoInspection {
  alias: string;
  authored_path: string;
  source_path: string;
  default_branch?: string;
  workspace_path?: string;
  workspace_path_preview?: string;
}

export interface GraphLaunchResolution {
  launch_profile: string;
  workspace_backend: WorkspaceBackend;
  available_profiles: string[];
  diagnostics: GraphDiagnostic[];
}

export interface GraphNodeView {
  authored_id: string;
  compiled_id?: string;
  label: string;
  kind: GraphNodeKind;
  status?: ProjectionStatus;
  scope_stack: string[];
  repo_alias?: string;
  repeat_scope_id?: string;
  iteration_index?: number;
  attempt_index?: number;
  badge?: string;
}

export interface GraphInspectionPayload {
  graph_path: string;
  graph_id: string;
  launch_profile: string;
  workspace_backend: WorkspaceBackend;
  compile_status: GraphCompileStatus;
  validation_diagnostics: GraphDiagnostic[];
  compile_diagnostics: GraphDiagnostic[];
  launch_resolution: GraphLaunchResolution;
  repos: GraphRepoInspection[];
  authored_summary?: AuthoredGraphSummary;
  authored_graph?: AuthoredGraphDocument;
  compiled_graph?: CompiledGraph;
  kpis: Array<{
    label: string;
    value: string;
  }>;
  modes: GraphViewMode[];
  authored_nodes: GraphNodeView[];
  compiled_nodes: GraphNodeView[];
  nodes: GraphNodeView[];
}
