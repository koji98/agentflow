import type { ContextItem } from "../../graph/authored.js";

export interface RuntimeRepeatHistoryContext {
  name: "repeat_history";
  from: "runtime_repeat_history";
  repeat_scope_id: string;
  current_iteration: number;
}

export interface RuntimeSupervisorRecoveryContext {
  name: "supervisor_recovery_envelope";
  from: "runtime_supervisor_recovery";
  prior_execution_id: string;
  classification: string;
  failure_fingerprint: string;
  repeated_fingerprint_count: number;
  resume_point: string;
  restart_boundary: string;
  workspace_decision: string;
  reason_code: string;
  recovery_plan_path: string;
  case_file_path: string;
}

export interface RuntimeSupervisorContextRepairContext {
  name: "supervisor_context_repair";
  from: "runtime_supervisor_context_repair";
  patch_id: string;
  strategy: string;
  reason: string;
}

export type ContextPacketSource =
  | ContextItem
  | RuntimeRepeatHistoryContext
  | RuntimeSupervisorRecoveryContext
  | RuntimeSupervisorContextRepairContext;

export interface ContextPacketLiveWorkspaceBinding {
  kind: "live_workspace_input";
  requested_path?: string;
  resolved_path: string;
}

export interface ContextPacketMaterializedItem {
  key: string;
  source: ContextPacketSource;
  description?: string;
  pointer_path: string;
  digest?: string;
  size_bytes?: number;
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
  materials: ContextPacketMaterializedItem[];
  omitted: ContextPacketOmittedItem[];
  totals: {
    pointer_count: number;
    file_count: number;
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

export interface PluginFileContextProvenance {
  from: "plugin_file";
  key: string;
  path: string;
  digest: string;
}

export type ContextInputProvenance =
  | WorkspaceFileContextProvenance
  | WorkspaceGlobContextProvenance
  | PluginFileContextProvenance;

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
