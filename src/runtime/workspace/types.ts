import type { WorkspaceBackend } from "../../graph/schema.js";

export interface WorkspaceBackendBinding {
  repo_alias: string;
  source_path: string;
  workspace_path: string;
  backend: WorkspaceBackend;
}

export interface WorkspaceSetup {
  backend: WorkspaceBackend;
  repo_workspaces: Record<string, WorkspaceBackendBinding>;
  cleanup: () => Promise<void>;
}

export interface WorkspaceBackendOptions {
  run_root: string;
  repo_sources: Record<string, string>;
}
