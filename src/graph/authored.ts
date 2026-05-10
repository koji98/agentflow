import type {
  AuthoredNodeKind,
  ArtifactSourceKind,
  CheckKind,
  ContextSelector,
  CursorSandboxMode,
  FailureBehavior,
  HarnessName,
  PrerequisiteKind,
  ReasoningEffort,
  SandboxMode,
  WorkspaceBackend
} from "./schema.js";

export interface RepoDefinition {
  path: string;
  default_branch?: string;
}

export interface InputRules {
  max_total_tokens?: number;
  max_tokens_per_item?: number;
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

export interface ArtifactRepairPolicy {
  max_attempts?: number;
}

export type HarnessIsolationMode = "isolated" | "inherit_user";

export interface CodexHarnessConfig {
  config?: Record<string, unknown>;
  mcp_servers?: Record<string, unknown>;
  plugins?: Record<string, unknown>;
  notify?: unknown[];
}

export interface CursorHarnessPermissions {
  allow?: string[];
  deny?: string[];
}

export interface CursorHarnessConfig {
  config?: Record<string, unknown>;
  permissions?: CursorHarnessPermissions;
  /** Overrides the Cursor CLI `--sandbox` flag. Use disabled for Cursor allowlist mode on systems without OS sandbox support. */
  sandbox_mode?: CursorSandboxMode;
  /** Cursor MCP server identifiers that must be authenticated and loadable for run-ready validation. */
  required_mcps?: string[];
  /** When true, passes `--approve-mcps` so Cursor Agent auto-approves MCP servers (needed for headless Glean/MCP use). */
  approve_mcps?: boolean;
  /** When true, passes `--trust` for headless workspace trust without prompts. */
  trust_workspace?: boolean;
}

export interface HarnessConfig {
  isolation?: HarnessIsolationMode;
  codex?: CodexHarnessConfig;
  cursor?: CursorHarnessConfig;
}

export interface PluginToolReference {
  from_plugin: string;
  tool: string;
  alias?: string;
  config?: Record<string, string>;
}

export type ToolDeclaration = PluginToolReference;

export interface GraphProfile {
  harness?: HarnessName;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  sandbox?: SandboxMode;
  skip_git_repo_check?: boolean;
  env_files?: string[];
  timeout_sec?: number;
  input_rules?: InputRules;
  deterministic_check_defaults?: DeterministicCheckDefaults;
  ai_check_defaults?: AiCheckDefaults;
  artifact_repair?: ArtifactRepairPolicy;
  harness_config?: HarnessConfig;
}

export interface GraphDefaults {
  launch_profile?: string;
  workspace_backend?: WorkspaceBackend;
}

export interface GraphIntent {
  goal: string;
  constraints?: string[];
  acceptance_criteria?: string[];
}

export interface ExecutableNodeIntent {
  goal: string;
  acceptance_criteria: string[];
  constraints: string[];
}

export interface SupervisionPolicy {
  profile: string;
  max_total_interventions: number;
}

export interface FileInput {
  name: string;
  from: "workspace_file";
  path: string;
}

export interface GlobInput {
  name: string;
  from: "workspace_glob";
  path: string;
  max_files?: number;
}

export interface TextInput {
  name: string;
  from: "text";
  text: string;
}

export interface ArtifactContextRef {
  ref: string;
  name: string;
  iteration?: ContextSelector;
  attempt?: ContextSelector;
  if_available?: boolean;
}

export interface ResolvedArtifactContextRef extends ArtifactContextRef {
  node: string;
  artifact: string;
}

export type ContextItem = FileInput | GlobInput | TextInput | ResolvedArtifactContextRef;

export interface ArtifactReference {
  node: string;
  artifact: string;
  iteration?: ContextSelector;
  attempt?: ContextSelector;
}

export interface ArtifactDefinition {
  from: ArtifactSourceKind;
  path: string;
  description: string;
}

export interface ManagedArtifactForward {
  node: string;
  artifact: string;
}

export interface FilePrerequisite {
  kind: Extract<PrerequisiteKind, "file">;
  path: string;
  required?: boolean;
}

export interface CommandPrerequisite {
  kind: Extract<PrerequisiteKind, "command">;
  command: string;
  required?: boolean;
}

export interface EnvPrerequisite {
  kind: Extract<PrerequisiteKind, "env">;
  name: string;
  required?: boolean;
}

export interface RepoPrerequisite {
  kind: Extract<PrerequisiteKind, "repo">;
  repo: string;
  required?: boolean;
}

export type GraphPrerequisiteCheck =
  | FilePrerequisite
  | CommandPrerequisite
  | EnvPrerequisite
  | RepoPrerequisite;

export interface GraphPrerequisites {
  checks: GraphPrerequisiteCheck[];
}

export interface BaseNode {
  id: string;
  label?: string;
}

export interface BaseExecutableNode extends BaseNode {
  repo?: string;
  profile?: string;
  intent: ExecutableNodeIntent;
  context?: ContextItem[];
  artifacts?: Record<string, ArtifactDefinition>;
  managed_artifact_forwards?: Record<string, ManagedArtifactForward>;
  timeout_sec?: number;
}

export interface AgentNode extends BaseExecutableNode {
  type: "agent";
  model?: string;
  reasoning_effort?: ReasoningEffort;
  sandbox?: SandboxMode;
  artifact_repair?: ArtifactRepairPolicy;
  tools?: ToolDeclaration[];
}

export interface ExecNode extends BaseExecutableNode {
  type: "exec";
  command: string;
  args?: string[];
  cwd?: string;
  env_files?: string[];
  env?: Record<string, string>;
  on_failure?: FailureBehavior;
}

export interface CheckNode extends BaseExecutableNode {
  type: "check";
  check_kind: CheckKind;
  command?: string;
  args?: string[];
  cwd?: string;
  env_files?: string[];
  env?: Record<string, string>;
  pass_if?: DeterministicPassIf;
  rubric?: string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  on_failure?: FailureBehavior;
}

export interface CheckpointNode extends BaseExecutableNode {
  type: "checkpoint";
  review_from: ArtifactReference;
}

export interface SequenceNode extends BaseNode {
  type: "sequence";
  steps: AuthoredGraphNode[];
  cleanup?: AuthoredGraphNode[];
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

export type ExecutableGraphNode = AgentNode | ExecNode | CheckNode | CheckpointNode;
export type ContainerGraphNode = SequenceNode | ParallelNode | RepeatNode;
export type AuthoredGraphNode = ExecutableGraphNode | ContainerGraphNode;

export interface AuthoredGraphDocument {
  version: "1";
  graph_id: string;
  intent: GraphIntent;
  supervision: SupervisionPolicy;
  repos: Record<string, RepoDefinition>;
  defaults?: GraphDefaults;
  profiles?: Record<string, GraphProfile>;
  prerequisites?: GraphPrerequisites;
  config?: Record<string, unknown>;
  config_schema?: Record<string, unknown>;
  tools?: ToolDeclaration[];
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
