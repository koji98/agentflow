import type {
  ArtifactDefinition,
  ArtifactReference,
  ContextItem,
  DeterministicPassIf,
  ExecutableNodeIntent,
  GraphIntent,
  ManagedArtifactForward,
  GraphPrerequisites,
  SupervisionPolicy
} from "./authored.js";
import type {
  ContainerNodeKind,
  FailureBehavior,
  GraphDiagnostic,
  GraphOutcome,
  LoweredManagedKind
} from "./schema.js";
import type { CheckKind, ExecutableNodeKind } from "./schema.js";
import type { EffectiveNodePolicy, EffectiveSupervisorPolicy, LaunchResolution } from "./profiles.js";
import type { CredentialSpecMap } from "../auth/types.js";

export interface CompiledExecutableNodeBase {
  compiled_id: string;
  authored_id: string;
  kind: ExecutableNodeKind;
  label?: string;
  intent: ExecutableNodeIntent;
  repo: string;
  deps: string[];
  scope_stack: string[];
  repeat_scope_id?: string;
  effective_policy: EffectiveNodePolicy;
  context: ContextItem[];
  declared_artifacts: Record<string, ArtifactDefinition>;
  managed_artifact_forwards?: Record<string, ManagedArtifactForward>;
  lowered_from?: LoweredManagedKind;
  is_cleanup?: boolean;
  cleanup_scope_id?: string;
}

export interface ResolvedToolPluginSource {
  kind: "plugin";
  alias: string;
  tool: string;
  plugin_root: string;
  declared_at: "graph" | "agent";
  declaration_path: string;
}

export type ResolvedToolSource = ResolvedToolPluginSource;

export interface ResolvedTool {
  callable_name: string;
  description?: string;
  executable_path: string;
  config: Record<string, string>;
  config_schema?: Record<string, unknown>;
  credentials?: string[];
  source: ResolvedToolSource;
}

export interface CompiledAgentNode extends CompiledExecutableNodeBase {
  kind: "agent";
  tools: ResolvedTool[];
}

export interface CompiledExecNode extends CompiledExecutableNodeBase {
  kind: "exec";
  command: string;
  args: string[];
  cwd?: string;
  env_files?: string[];
  env?: Record<string, string>;
  on_failure: FailureBehavior;
}

export interface CompiledCheckNode extends CompiledExecutableNodeBase {
  kind: "check";
  check_kind: CheckKind;
  command?: string;
  args?: string[];
  cwd?: string;
  env_files?: string[];
  env?: Record<string, string>;
  pass_if?: DeterministicPassIf;
  rubric?: string;
  on_failure: FailureBehavior;
}

export interface CompiledCheckpointNode extends CompiledExecutableNodeBase {
  kind: "checkpoint";
  review_from: ArtifactReference;
}

export type CompiledExecutableNode =
  | CompiledAgentNode
  | CompiledExecNode
  | CompiledCheckNode
  | CompiledCheckpointNode;

export interface CompiledEdge {
  edge_id: string;
  from: string;
  to: string;
  on: GraphOutcome;
  kind: "flow" | "repeat-back";
  repeat_scope_id?: string;
  is_cleanup?: boolean;
  cleanup_scope_id?: string;
}

export interface CompiledScopeBase {
  scope_id: string;
  authored_id: string;
  kind: ContainerNodeKind;
  parent_scope_id: string | null;
  scope_stack: string[];
  entry_node_ids: string[];
  exit_node_ids: string[];
  compiled_node_ids: string[];
}

export interface CompiledSequenceScope extends CompiledScopeBase {
  kind: "sequence";
  cleanup_entry_node_ids?: string[];
  cleanup_exit_node_ids?: string[];
  cleanup_compiled_node_ids?: string[];
}

export interface CompiledParallelScope extends CompiledScopeBase {
  kind: "parallel";
  max_concurrency?: number;
}

export interface CompiledRepeatScope extends CompiledScopeBase {
  kind: "repeat";
  max_attempts: number;
  until_compiled_id: string;
  body_entry_node_ids: string[];
  body_exit_node_ids: string[];
}

export type CompiledScope = CompiledSequenceScope | CompiledParallelScope | CompiledRepeatScope;

export interface CompiledGraph {
  graph_id: string;
  intent: GraphIntent;
  supervision: SupervisionPolicy;
  supervisor_effective_policy?: EffectiveSupervisorPolicy;
  launch: Pick<LaunchResolution, "launch_profile" | "workspace_backend">;
  entry_node_ids: string[];
  nodes: CompiledExecutableNode[];
  edges: CompiledEdge[];
  scopes: CompiledScope[];
  authored_to_compiled: Record<string, string[]>;
  prerequisites: GraphPrerequisites;
  credential_specs?: CredentialSpecMap;
}

export interface CompileGraphResult {
  compiled_graph?: CompiledGraph;
  diagnostics: GraphDiagnostic[];
}
