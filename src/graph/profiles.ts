import type {
  AuthoredGraphDocument,
  CheckNode,
  ExecutableGraphNode,
  GraphProfile,
  InputRules
} from "./authored.js";
import type {
  GraphDiagnostic,
  HarnessName,
  ReasoningEffort,
  SandboxMode,
  WorkspaceBackend
} from "./schema.js";
import { workspaceBackends } from "./schema.js";

export interface EffectiveInputRules {
  max_total_bytes: number;
  max_bytes_per_item: number;
}

export interface EffectiveNodePolicy {
  profile_name: string;
  workspace_backend: WorkspaceBackend;
  harness?: HarnessName;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  sandbox?: SandboxMode;
  timeout_sec: number;
  input_rules: EffectiveInputRules;
}

export interface LaunchResolution {
  launch_profile: string;
  workspace_backend: WorkspaceBackend;
  profile?: GraphProfile;
  diagnostics: GraphDiagnostic[];
}

export interface LaunchOverrides {
  launchProfile?: string;
  workspaceBackend?: string;
}

export const builtInInputRules: EffectiveInputRules = {
  max_total_bytes: 524288,
  max_bytes_per_item: 131072
};

export const builtInTimeoutSeconds = 1800;
export const builtInCodexReasoningEffort: ReasoningEffort = "medium";

function mergeInputRules(...rules: Array<InputRules | undefined>): EffectiveInputRules {
  return rules.reduce<EffectiveInputRules>(
    (current, next) => ({
      max_total_bytes: next?.max_total_bytes ?? current.max_total_bytes,
      max_bytes_per_item: next?.max_bytes_per_item ?? current.max_bytes_per_item
    }),
    builtInInputRules
  );
}

function isAiCheck(node: ExecutableGraphNode): node is CheckNode & { check_kind: "ai" } {
  return node.type === "check" && node.check_kind === "ai";
}

function canInheritLaunchModel(
  launchProfile: GraphProfile | undefined,
  nodeProfile: GraphProfile | undefined
): boolean {
  return !nodeProfile?.harness || nodeProfile.harness === launchProfile?.harness;
}

function defaultReasoningEffortForHarness(
  harness: HarnessName | undefined
): ReasoningEffort | undefined {
  return harness === "codex-cli" ? builtInCodexReasoningEffort : undefined;
}

function resolveAiCheckModel(
  launchProfile: GraphProfile | undefined,
  nodeProfile: GraphProfile | undefined,
  node: CheckNode & { check_kind: "ai" }
): string | undefined {
  const launchModel =
    canInheritLaunchModel(launchProfile, nodeProfile)
      ? launchProfile?.ai_check_defaults?.model ?? launchProfile?.model
      : undefined;

  return (
    node.model ??
    nodeProfile?.ai_check_defaults?.model ??
    nodeProfile?.model ??
    launchModel
  );
}

function resolveAiCheckReasoningEffort(
  launchProfile: GraphProfile | undefined,
  nodeProfile: GraphProfile | undefined,
  node: CheckNode & { check_kind: "ai" },
  harness: HarnessName | undefined
): ReasoningEffort | undefined {
  const launchReasoning =
    canInheritLaunchModel(launchProfile, nodeProfile)
      ? launchProfile?.ai_check_defaults?.reasoning_effort ??
        launchProfile?.reasoning_effort ??
        defaultReasoningEffortForHarness(launchProfile?.harness)
      : undefined;

  return (
    node.reasoning_effort ??
    nodeProfile?.ai_check_defaults?.reasoning_effort ??
    nodeProfile?.reasoning_effort ??
    launchReasoning ??
    defaultReasoningEffortForHarness(harness)
  );
}

export function resolveLaunchConfig(
  document: AuthoredGraphDocument,
  overrides: LaunchOverrides = {}
): LaunchResolution {
  const profiles = document.profiles ?? {};
  const diagnostics: GraphDiagnostic[] = [];
  const fallbackLaunchProfile =
    document.defaults?.launch_profile ?? ("default" in profiles ? "default" : undefined);
  const launch_profile = overrides.launchProfile ?? fallbackLaunchProfile;
  const requestedWorkspaceBackend =
    overrides.workspaceBackend ?? document.defaults?.workspace_backend ?? "worktree";

  if (!launch_profile) {
    diagnostics.push({
      path: "$.defaults.launch_profile",
      message:
        'No launch profile could be resolved. Define defaults.launch_profile or provide a "default" profile.'
    });
  } else if (!(launch_profile in profiles)) {
    diagnostics.push({
      path: "$.defaults.launch_profile",
      message: `Unknown launch profile "${launch_profile}".`
    });
  }

  const workspace_backend = workspaceBackends.includes(requestedWorkspaceBackend as WorkspaceBackend)
    ? (requestedWorkspaceBackend as WorkspaceBackend)
    : "worktree";

  if (!workspaceBackends.includes(requestedWorkspaceBackend as WorkspaceBackend)) {
    diagnostics.push({
      path: "$.defaults.workspace_backend",
      message: `Unsupported workspace backend "${requestedWorkspaceBackend}".`
    });
  }

  return {
    launch_profile: launch_profile ?? "default",
    workspace_backend,
    ...(launch_profile && launch_profile in profiles ? { profile: profiles[launch_profile] } : {}),
    diagnostics
  };
}

export function resolveExecutableRepoAlias(
  document: AuthoredGraphDocument,
  repoAlias: string | undefined
): string | undefined {
  if (repoAlias) {
    return repoAlias;
  }

  const [onlyRepo] = Object.keys(document.repos);
  return onlyRepo;
}

export function resolveNodePolicy(
  document: AuthoredGraphDocument,
  launch: LaunchResolution,
  node: ExecutableGraphNode
): {
  policy: EffectiveNodePolicy;
  diagnostics: GraphDiagnostic[];
  profile_name: string;
  launch_profile?: GraphProfile;
  node_profile?: GraphProfile;
} {
  const diagnostics: GraphDiagnostic[] = [];
  const launch_profile = launch.profile;
  const profile_name = node.profile ?? launch.launch_profile;
  const node_profile = node.profile ? document.profiles?.[node.profile] : undefined;

  if (node.profile && !node_profile) {
    diagnostics.push({
      path: `$.graph.${node.id}.profile`,
      message: `Node references unknown profile "${node.profile}".`
    });
  }

  const timeout_sec =
    node.timeout_sec ??
    node_profile?.timeout_sec ??
    launch_profile?.timeout_sec ??
    builtInTimeoutSeconds;

  const input_rules = mergeInputRules(
    launch_profile?.input_rules,
    node_profile?.input_rules
  );

  let harness: HarnessName | undefined;
  let model: string | undefined;
  let reasoning_effort: ReasoningEffort | undefined;
  let sandbox: SandboxMode | undefined;

  if (node.type === "agent" || isAiCheck(node)) {
    harness = node_profile?.harness ?? launch_profile?.harness;
    model =
      node.type === "agent"
        ? (
            node.model ??
            node_profile?.model ??
            (canInheritLaunchModel(launch_profile, node_profile) ? launch_profile?.model : undefined)
          )
        : resolveAiCheckModel(launch_profile, node_profile, node);
    reasoning_effort =
      node.type === "agent"
        ? (
            node.reasoning_effort ??
            node_profile?.reasoning_effort ??
            (canInheritLaunchModel(launch_profile, node_profile)
              ? launch_profile?.reasoning_effort ?? defaultReasoningEffortForHarness(launch_profile?.harness)
              : undefined) ??
            defaultReasoningEffortForHarness(harness)
          )
        : resolveAiCheckReasoningEffort(launch_profile, node_profile, node, harness);
    sandbox =
      node.type === "agent"
        ? node.sandbox ?? node_profile?.sandbox ?? launch_profile?.sandbox ?? "workspace-write"
        : "read-only";

    if (!harness) {
      diagnostics.push({
        path: `$.graph.${node.id}.profile`,
        message: `${node.type} nodes require a resolved harness from the launch or node profile.`
      });
    }

    if (isAiCheck(node) && harness === "cursor-cli") {
      diagnostics.push({
        path: `$.graph.${node.id}.profile`,
        message: 'AI checks require codex-cli because cursor-cli does not provide a strict read-only evaluation contract.'
      });
    }
  }

  return {
    policy: {
      profile_name,
      workspace_backend: launch.workspace_backend,
      ...(harness ? { harness } : {}),
      ...(model ? { model } : {}),
      ...(reasoning_effort ? { reasoning_effort } : {}),
      ...(sandbox ? { sandbox } : {}),
      timeout_sec,
      input_rules
    },
    diagnostics,
    profile_name,
    ...(launch_profile ? { launch_profile } : {}),
    ...(node_profile ? { node_profile } : {})
  };
}
