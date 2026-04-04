import type {
  ContextReference,
  DeterministicPassIf,
  InputItem,
  OutputDefinition
} from "./authored.js";
import type {
  ContainerNodeKind,
  GraphDiagnostic,
  GraphOutcome,
  LoweredManagedKind
} from "./schema.js";
import type { CheckKind, ExecutableNodeKind } from "./schema.js";
import type { EffectiveNodePolicy, LaunchResolution } from "./profiles.js";

export interface CompiledExecutableNodeBase {
  compiled_id: string;
  authored_id: string;
  kind: ExecutableNodeKind;
  label?: string;
  repo: string;
  deps: string[];
  scope_stack: string[];
  repeat_scope_id?: string;
  effective_policy: EffectiveNodePolicy;
  inputs: InputItem[];
  context_from: ContextReference[];
  declared_outputs: OutputDefinition[];
  lowered_from?: LoweredManagedKind;
}

export interface CompiledAgentNode extends CompiledExecutableNodeBase {
  kind: "agent";
  prompt: string;
}

export interface CompiledExecNode extends CompiledExecutableNodeBase {
  kind: "exec";
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface CompiledCheckNode extends CompiledExecutableNodeBase {
  kind: "check";
  check_kind: CheckKind;
  command?: string;
  args?: string[];
  cwd?: string;
  pass_if?: DeterministicPassIf;
  prompt?: string;
  rubric?: string;
}

export type CompiledExecutableNode = CompiledAgentNode | CompiledExecNode | CompiledCheckNode;

export interface CompiledEdge {
  edge_id: string;
  from: string;
  to: string;
  on: GraphOutcome;
  kind: "flow" | "repeat-back";
  repeat_scope_id?: string;
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
  launch: Pick<LaunchResolution, "launch_profile" | "workspace_backend">;
  entry_node_ids: string[];
  nodes: CompiledExecutableNode[];
  edges: CompiledEdge[];
  scopes: CompiledScope[];
  authored_to_compiled: Record<string, string[]>;
}

export interface CompileGraphResult {
  compiled_graph?: CompiledGraph;
  diagnostics: GraphDiagnostic[];
}
