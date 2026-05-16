export const graphVersion = "1" as const;

export const executableNodeKinds = ["agent", "exec", "check", "checkpoint"] as const;
export const containerNodeKinds = ["sequence", "parallel", "repeat"] as const;
export const authoredNodeKinds = [...executableNodeKinds, ...containerNodeKinds] as const;
export const managedPatternKinds = [
  "pattern_deep_research",
  "pattern_deep_work"
] as const;
export const workspaceBackends = ["inplace", "worktree"] as const;
export const harnessNames = ["codex-cli", "cursor-cli"] as const;
export const sandboxModes = ["read-only", "workspace-write", "danger-full-access"] as const;
export const cursorSandboxModes = ["enabled", "disabled"] as const;
export const reasoningEfforts = ["none", "low", "medium", "high", "xhigh"] as const;
export const checkKinds = ["deterministic", "ai"] as const;
export const contextSelectors = [
  "latest",
  "latest_passed",
  "latest_failed",
  "previous"
] as const;
export const contextSourceKinds = ["workspace_file", "workspace_glob", "plugin_file"] as const;
export const artifactSourceKinds = ["output_dir", "workspace"] as const;
export const reservedArtifactNames = ["agent_response", "verification_json", "stdout", "stderr"] as const;
export const canonicalNodeArtifacts = {
  agent: "agent_response",
  exec: "stdout",
  check: "verification_json",
  checkpoint: "agent_response"
} as const;
export const reservedToolNames = ["af"] as const;
export const toolNamePattern = /^[a-z0-9][a-z0-9-]*$/;
export const edgeOutcomes = ["passed", "failed"] as const;
export const failureBehaviors = ["fail", "continue"] as const;
export const deliverySections = [
  "review_brief",
  "run_learnings",
  "audit_index",
  "artifact_index",
  "change_map",
  "validation_ledger",
  "decision_log",
  "intervention_trace",
  "milestones",
  "workspace_improvements"
] as const;

export type GraphVersion = typeof graphVersion;
export type ExecutableNodeKind = (typeof executableNodeKinds)[number];
export type ContainerNodeKind = (typeof containerNodeKinds)[number];
export type AuthoredNodeKind = (typeof authoredNodeKinds)[number];
export type ManagedPatternKind = (typeof managedPatternKinds)[number];
export type LoweredManagedKind = ManagedPatternKind | `plugin:${string}`;
export type WorkspaceBackend = (typeof workspaceBackends)[number];
export type HarnessName = (typeof harnessNames)[number];
export type SandboxMode = (typeof sandboxModes)[number];
export type CursorSandboxMode = (typeof cursorSandboxModes)[number];
export type ReasoningEffort = (typeof reasoningEfforts)[number];
export type CheckKind = (typeof checkKinds)[number];
export type ContextSelector = (typeof contextSelectors)[number] | number;
export type ContextSourceKind = (typeof contextSourceKinds)[number];
export type ArtifactSourceKind = (typeof artifactSourceKinds)[number];
export type ReservedArtifactName = (typeof reservedArtifactNames)[number];
export type CanonicalNodeArtifactKind = keyof typeof canonicalNodeArtifacts;
export type GraphOutcome = (typeof edgeOutcomes)[number];
export type FailureBehavior = (typeof failureBehaviors)[number];
export type DeliverySection = (typeof deliverySections)[number];

export interface GraphDiagnostic {
  path: string;
  message: string;
}
