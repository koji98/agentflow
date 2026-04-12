export const graphVersion = "1" as const;

export const executableNodeKinds = ["agent", "exec", "check", "checkpoint"] as const;
export const containerNodeKinds = ["sequence", "parallel", "repeat"] as const;
export const authoredNodeKinds = [...executableNodeKinds, ...containerNodeKinds] as const;
export const managedPatternKinds = [
  "pattern_deep_research",
  "pattern_spec_design",
  "pattern_generate_evaluate_fix",
  "pattern_review_change"
] as const;
export const workspaceBackends = ["inplace", "worktree"] as const;
export const harnessNames = ["codex-cli", "cursor-cli"] as const;
export const sandboxModes = ["read-only", "workspace-write", "danger-full-access"] as const;
export const reasoningEfforts = ["none", "low", "medium", "high", "xhigh"] as const;
export const checkKinds = ["deterministic", "ai"] as const;
export const contextIncludes = ["summary", "result", "output"] as const;
export const contextSelectors = ["latest", "latest_passed", "latest_failed"] as const;
export const outputSourceKinds = ["workspace", "attempt"] as const;
export const edgeOutcomes = ["passed", "failed"] as const;
export const failureBehaviors = ["fail", "continue"] as const;
export const prerequisiteKinds = ["file", "command", "env", "repo"] as const;

export type GraphVersion = typeof graphVersion;
export type ExecutableNodeKind = (typeof executableNodeKinds)[number];
export type ContainerNodeKind = (typeof containerNodeKinds)[number];
export type AuthoredNodeKind = (typeof authoredNodeKinds)[number];
export type ManagedPatternKind = (typeof managedPatternKinds)[number];
export type LoweredManagedKind = ManagedPatternKind;
export type WorkspaceBackend = (typeof workspaceBackends)[number];
export type HarnessName = (typeof harnessNames)[number];
export type SandboxMode = (typeof sandboxModes)[number];
export type ReasoningEffort = (typeof reasoningEfforts)[number];
export type CheckKind = (typeof checkKinds)[number];
export type ContextInclude = (typeof contextIncludes)[number];
export type ContextSelector = (typeof contextSelectors)[number] | number;
export type OutputSourceKind = (typeof outputSourceKinds)[number];
export type GraphOutcome = (typeof edgeOutcomes)[number];
export type FailureBehavior = (typeof failureBehaviors)[number];
export type PrerequisiteKind = (typeof prerequisiteKinds)[number];

export interface GraphDiagnostic {
  path: string;
  message: string;
}
