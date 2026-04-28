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

export interface NodeWorkspaceSnapshot {
  head_sha: string;
  stash_sha: string;
  untracked_files: string[];
  status_text: string;
  capture_error?: string;
}

export interface NodeWorkspaceChangedFile {
  path: string;
  change_kind: "tracked" | "untracked_added" | "untracked_deleted";
}

export interface NodeWorkspaceDiff {
  status_text_after: string;
  diff_patch: string;
  changed_files: NodeWorkspaceChangedFile[];
  deleted_untracked: string[];
  capture_error?: string;
}

export interface NodeWorkspaceChangeArtifacts {
  baseline_path: string;
  after_path: string;
  status_path: string;
  diff_patch_path: string;
  changed_files_path: string;
  capture_error_path?: string;
  changed_file_count: number;
  status: "captured" | "degraded";
}
