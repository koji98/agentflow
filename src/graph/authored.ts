import type {
  AuthoredNodeKind,
  CheckKind,
  ContextSelector,
  HarnessName,
  OutputSourceKind,
  ReasoningEffort,
  SandboxMode,
  WorkspaceBackend
} from "./schema.js";

export interface RepoDefinition {
  path: string;
  default_branch?: string;
}

export interface InputRules {
  max_files?: number;
  max_total_bytes?: number;
  max_bytes_per_item?: number;
}

export interface DeterministicPassIfExitCode {
  exit_code: number;
}

export interface DeterministicPassIfJsonPath {
  json_path: string;
  equals: boolean | number | string;
}

export type DeterministicPassIf = DeterministicPassIfExitCode | DeterministicPassIfJsonPath;

export interface DeterministicCheckDefaults {
  pass_if?: DeterministicPassIf;
}

export interface AiCheckDefaults {
  model?: string;
  reasoning_effort?: ReasoningEffort;
  rubric?: string;
}

export interface GraphProfile {
  harness?: HarnessName;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  sandbox?: SandboxMode;
  timeout_sec?: number;
  input_rules?: InputRules;
  deterministic_check_defaults?: DeterministicCheckDefaults;
  ai_check_defaults?: AiCheckDefaults;
}

export interface GraphDefaults {
  launch_profile?: string;
  workspace_backend?: WorkspaceBackend;
}

export interface FileInput {
  kind: "file";
  path: string;
}

export interface GlobInput {
  kind: "glob";
  path: string;
  max_files?: number;
}

export interface TextInput {
  kind: "text";
  name: string;
  text: string;
}

export type InputItem = FileInput | GlobInput | TextInput;

export interface ContextReference {
  node: string;
  include: "summary" | "result" | "output";
  output?: string;
  iteration?: ContextSelector;
  attempt?: ContextSelector;
  optional?: boolean;
}

export interface OutputDefinition {
  name: string;
  from: OutputSourceKind;
  path: string;
  required?: boolean;
}

export interface BaseNode {
  id: string;
  label?: string;
}

export interface BaseExecutableNode extends BaseNode {
  repo?: string;
  profile?: string;
  inputs?: InputItem[];
  context_from?: ContextReference[];
  outputs?: OutputDefinition[];
  timeout_sec?: number;
}

export interface AgentNode extends BaseExecutableNode {
  type: "agent";
  prompt: string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  sandbox?: SandboxMode;
}

export interface ExecNode extends BaseExecutableNode {
  type: "exec";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface CheckNode extends BaseExecutableNode {
  type: "check";
  check_kind: CheckKind;
  command?: string;
  args?: string[];
  cwd?: string;
  pass_if?: DeterministicPassIf;
  prompt?: string;
  rubric?: string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
}

export interface SequenceNode extends BaseNode {
  type: "sequence";
  steps: AuthoredGraphNode[];
}

export interface ParallelNode extends BaseNode {
  type: "parallel";
  steps: AuthoredGraphNode[];
  max_concurrency?: number;
}

export interface RepeatNode extends BaseNode {
  type: "repeat";
  max_attempts: number;
  body: AuthoredGraphNode;
  until: {
    node: string;
  };
}

export type ExecutableGraphNode = AgentNode | ExecNode | CheckNode;
export type ContainerGraphNode = SequenceNode | ParallelNode | RepeatNode;
export type AuthoredGraphNode = ExecutableGraphNode | ContainerGraphNode;

export interface AuthoredGraphDocument {
  version: "1";
  graph_id: string;
  repos: Record<string, RepoDefinition>;
  defaults?: GraphDefaults;
  profiles?: Record<string, GraphProfile>;
  graph: ContainerGraphNode;
}

export interface AuthoredGraphSummary {
  graph_id: string;
  node_count: number;
  executable_node_count: number;
  container_node_count: number;
  profile_count: number;
  repo_count: number;
  repeat_count: number;
  node_kind_counts: Record<AuthoredNodeKind, number>;
}
