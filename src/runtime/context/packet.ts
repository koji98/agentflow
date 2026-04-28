import type { ContextItem } from "../../graph/authored.js";

export interface RuntimeRepeatHistoryContext {
  name: "repeat_history";
  from: "runtime_repeat_history";
  repeat_scope_id: string;
  current_iteration: number;
}

export interface RuntimeSupervisorRetryGuidanceContext {
  name: "supervisor_retry_guidance";
  from: "runtime_supervisor_retry_guidance";
  prior_execution_id: string;
  action: string;
  classification: string;
  failure_fingerprint: string;
  repeated_fingerprint_count: number;
}

export type ContextPacketSource =
  | ContextItem
  | RuntimeRepeatHistoryContext
  | RuntimeSupervisorRetryGuidanceContext;

export interface ContextPacketLiveWorkspaceBinding {
  kind: "live_workspace_input";
  requested_path?: string;
  resolved_path: string;
}

export interface ContextPacketMaterializedItem {
  key: string;
  source: ContextPacketSource;
  description?: string;
  materialized_path: string;
  tokens: number;
  truncated: boolean;
  binding?: ContextPacketLiveWorkspaceBinding;
}

export interface ContextPacketOmittedItem {
  key: string;
  source: ContextPacketSource;
  description?: string;
  reason: string;
  if_available: boolean;
}

export interface ContextPacket {
  execution_id: string;
  compiled_id: string;
  authored_id: string;
  repo_alias: string;
  workspace_path: string;
  tokenizer: string;
  materials: ContextPacketMaterializedItem[];
  omitted: ContextPacketOmittedItem[];
  totals: {
    material_count: number;
    file_count: number;
    total_tokens: number;
  };
}

export interface ContextDigestEntry {
  path: string;
  digest: string;
}

export interface ContextResolvedDigestEntry extends ContextDigestEntry {
  resolved_path: string;
}

export interface WorkspaceFileContextProvenance {
  from: "workspace_file";
  key: string;
  repo_alias: string;
  path: string;
  digest: string;
  resolved_path: string;
}

export interface WorkspaceGlobContextProvenance {
  from: "workspace_glob";
  key: string;
  repo_alias: string;
  pattern: string;
  files: ContextResolvedDigestEntry[];
  digest: string;
}

export type ContextInputProvenance =
  | WorkspaceFileContextProvenance
  | WorkspaceGlobContextProvenance;

export interface ContextHarnessInstructionProvenance {
  repo_alias: string;
  files: ContextDigestEntry[];
  digest: string;
}

export interface ContextProvenance {
  compiled_id: string;
  authored_id: string;
  repo_alias: string;
  workspace_context: ContextInputProvenance[];
  harness_instructions?: ContextHarnessInstructionProvenance;
}
