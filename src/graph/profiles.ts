import type {
  ArtifactRepairPolicy,
  AuthoredGraphDocument,
  CheckNode,
  ExecutableGraphNode,
  GraphProfile,
  HarnessConfig,
  HarnessIsolationMode,
  CodexHarnessConfig,
  CursorHarnessConfig,
  InputRules
} from "./authored.js";
import type {
  GraphDiagnostic,
  HarnessName,
  ReasoningEffort,
  SandboxMode,
  WorkspaceBackend
} from "./schema.js";
import { getHarnessCapabilities } from "./harness_capabilities.js";
import { workspaceBackends } from "./schema.js";

export interface EffectiveInputRules {
  max_total_tokens: number;
  max_tokens_per_item: number;
}

export interface EffectiveHarnessConfig extends Omit<HarnessConfig, "isolation"> {
  isolation: HarnessIsolationMode;
}

export interface EffectiveNodePolicy {
  profile_name: string;
  workspace_backend: WorkspaceBackend;
  harness?: HarnessName;
  harness_config?: EffectiveHarnessConfig;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  sandbox?: SandboxMode;
  skip_git_repo_check?: boolean;
  timeout_sec: number;
  input_rules: EffectiveInputRules;
  artifact_repair?: Required<ArtifactRepairPolicy>;
}

export interface EffectiveSupervisorPolicy {
  profile_name: string;
  harness?: HarnessName;
  harness_config?: EffectiveHarnessConfig;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  sandbox?: SandboxMode;
  skip_git_repo_check?: boolean;
  timeout_sec: number;
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
  max_total_tokens: 128000,
  max_tokens_per_item: 32000
};

export const builtInTimeoutSeconds = 1800;
export const builtInCodexReasoningEffort: ReasoningEffort = "medium";
export const builtInAgentArtifactRepairPolicy: Required<ArtifactRepairPolicy> = {
  max_attempts: 1
};
export const builtInHarnessConfig: EffectiveHarnessConfig = {
  isolation: "isolated"
};

function mergeInputRules(...rules: Array<InputRules | undefined>): EffectiveInputRules {
  return rules.reduce<EffectiveInputRules>(
    (current, next) => ({
      max_total_tokens: next?.max_total_tokens ?? current.max_total_tokens,
      max_tokens_per_item: next?.max_tokens_per_item ?? current.max_tokens_per_item
    }),
    builtInInputRules
  );
}

function mergeUnknownRecordMaps(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!base && !overlay) {
    return undefined;
  }

  return {
    ...(base ?? {}),
    ...(overlay ?? {})
  };
}

function mergeCodexHarnessConfig(
  base: CodexHarnessConfig | undefined,
  overlay: CodexHarnessConfig | undefined
): CodexHarnessConfig | undefined {
  if (!base && !overlay) {
    return undefined;
  }

  const config = mergeUnknownRecordMaps(base?.config, overlay?.config);
  const mcp_servers = mergeUnknownRecordMaps(base?.mcp_servers, overlay?.mcp_servers);
  const plugins = mergeUnknownRecordMaps(base?.plugins, overlay?.plugins);
  const notify = overlay?.notify ?? base?.notify;

  return {
    ...(config ? { config } : {}),
    ...(mcp_servers ? { mcp_servers } : {}),
    ...(plugins ? { plugins } : {}),
    ...(notify !== undefined ? { notify } : {})
  };
}

function mergeCursorPermissions(
  base: CursorHarnessConfig["permissions"] | undefined,
  overlay: CursorHarnessConfig["permissions"] | undefined
): CursorHarnessConfig["permissions"] | undefined {
  if (!base && !overlay) {
    return undefined;
  }

  return {
    ...(overlay?.allow ?? base?.allow ? { allow: overlay?.allow ?? base?.allow ?? [] } : {}),
    ...(overlay?.deny ?? base?.deny ? { deny: overlay?.deny ?? base?.deny ?? [] } : {})
  };
}

function mergeCursorHarnessConfig(
  base: CursorHarnessConfig | undefined,
  overlay: CursorHarnessConfig | undefined
): CursorHarnessConfig | undefined {
  if (!base && !overlay) {
    return undefined;
  }

  const config = mergeUnknownRecordMaps(base?.config, overlay?.config);
  const permissions = mergeCursorPermissions(base?.permissions, overlay?.permissions);

  return {
    ...(config ? { config } : {}),
    ...(permissions ? { permissions } : {})
  };
}

function filterHarnessConfigForHarness(
  config: HarnessConfig | undefined,
  harness: HarnessName | undefined
): HarnessConfig | undefined {
  if (!config || !harness) {
    return undefined;
  }

  return {
    ...(config.isolation ? { isolation: config.isolation } : {}),
    ...(harness === "codex-cli" && config.codex ? { codex: config.codex } : {}),
    ...(harness === "cursor-cli" && config.cursor ? { cursor: config.cursor } : {})
  };
}

function canInheritLaunchHarnessConfig(
  launchProfile: GraphProfile | undefined,
  overlayProfile: GraphProfile | undefined,
  harness: HarnessName | undefined
): boolean {
  return Boolean(
    harness &&
    launchProfile?.harness_config &&
    launchProfile.harness === harness &&
    (!overlayProfile?.harness || overlayProfile.harness === launchProfile.harness)
  );
}

function resolveHarnessConfig(
  launchProfile: GraphProfile | undefined,
  overlayProfile: GraphProfile | undefined,
  harness: HarnessName | undefined
): EffectiveHarnessConfig | undefined {
  if (!harness) {
    return undefined;
  }

  const launchConfig = canInheritLaunchHarnessConfig(launchProfile, overlayProfile, harness)
    ? filterHarnessConfigForHarness(launchProfile?.harness_config, harness)
    : undefined;
  const overlayConfig = filterHarnessConfigForHarness(overlayProfile?.harness_config, harness);
  const codex = harness === "codex-cli"
    ? mergeCodexHarnessConfig(launchConfig?.codex, overlayConfig?.codex)
    : undefined;
  const cursor = harness === "cursor-cli"
    ? mergeCursorHarnessConfig(launchConfig?.cursor, overlayConfig?.cursor)
    : undefined;

  return {
    isolation: overlayConfig?.isolation ?? launchConfig?.isolation ?? builtInHarnessConfig.isolation,
    ...(codex ? { codex } : {}),
    ...(cursor ? { cursor } : {})
  };
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
    overrides.workspaceBackend ?? document.defaults?.workspace_backend ?? "inplace";

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
    : undefined;

  if (!workspaceBackends.includes(requestedWorkspaceBackend as WorkspaceBackend)) {
    diagnostics.push({
      path: "$.defaults.workspace_backend",
      message: `Unsupported workspace backend "${requestedWorkspaceBackend}".`
    });
  }

  return {
    launch_profile: launch_profile ?? "",
    workspace_backend: workspace_backend ?? (requestedWorkspaceBackend as WorkspaceBackend),
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
  const artifact_repair =
    node.type === "agent"
      ? {
          max_attempts:
            node.artifact_repair?.max_attempts ??
            node_profile?.artifact_repair?.max_attempts ??
            launch_profile?.artifact_repair?.max_attempts ??
            builtInAgentArtifactRepairPolicy.max_attempts
        }
      : undefined;

  let harness: HarnessName | undefined;
  let model: string | undefined;
  let reasoning_effort: ReasoningEffort | undefined;
  let sandbox: SandboxMode | undefined;
  let skip_git_repo_check: boolean | undefined;
  let harness_config: EffectiveHarnessConfig | undefined;

  if (node.type === "agent" || isAiCheck(node)) {
    harness = node_profile?.harness ?? launch_profile?.harness;
    harness_config = resolveHarnessConfig(launch_profile, node_profile, harness);
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
    skip_git_repo_check =
      harness === "codex-cli"
        ? node_profile?.skip_git_repo_check ??
          (canInheritLaunchModel(launch_profile, node_profile)
            ? launch_profile?.skip_git_repo_check
            : undefined)
        : undefined;

    if (!harness) {
      diagnostics.push({
        path: `$.graph.${node.id}.profile`,
        message: `${node.type} nodes require a resolved harness from the launch or node profile.`
      });
    }

    if (isAiCheck(node) && harness && !getHarnessCapabilities(harness)?.supports_ai_check) {
      diagnostics.push({
        path: `$.graph.${node.id}.profile`,
        message: `AI checks require a harness with a strict read-only evaluation contract. "${harness}" does not support AI checks.`
      });
    }
  }

  return {
    policy: {
      profile_name,
      workspace_backend: launch.workspace_backend,
      ...(harness ? { harness } : {}),
      ...(harness_config ? { harness_config } : {}),
      ...(model ? { model } : {}),
      ...(reasoning_effort ? { reasoning_effort } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(skip_git_repo_check !== undefined ? { skip_git_repo_check } : {}),
      timeout_sec,
      input_rules,
      ...(artifact_repair ? { artifact_repair } : {})
    },
    diagnostics,
    profile_name,
    ...(launch_profile ? { launch_profile } : {}),
    ...(node_profile ? { node_profile } : {})
  };
}

export function resolveSupervisorPolicy(
  document: AuthoredGraphDocument,
  launch: LaunchResolution
): {
  policy?: EffectiveSupervisorPolicy;
  diagnostics: GraphDiagnostic[];
  profile_name?: string;
  launch_profile?: GraphProfile;
  supervisor_profile?: GraphProfile;
} {
  const profile_name = document.supervision.profile;
  const diagnostics: GraphDiagnostic[] = [];
  const launch_profile = launch.profile;
  const supervisor_profile = document.profiles?.[profile_name];

  if (!supervisor_profile) {
    diagnostics.push({
      path: "$.supervision.profile",
      message: `supervision.profile references unknown profile "${profile_name}".`
    });
    return {
      diagnostics,
      profile_name,
      ...(launch_profile ? { launch_profile } : {})
    };
  }

  const harness = supervisor_profile.harness ?? launch_profile?.harness;
  const harness_config = resolveHarnessConfig(launch_profile, supervisor_profile, harness);
  const timeout_sec =
    supervisor_profile.timeout_sec ??
    launch_profile?.timeout_sec ??
    builtInTimeoutSeconds;
  const model =
    supervisor_profile.model ??
    (canInheritLaunchModel(launch_profile, supervisor_profile) ? launch_profile?.model : undefined);
  const reasoning_effort =
    supervisor_profile.reasoning_effort ??
    (canInheritLaunchModel(launch_profile, supervisor_profile)
      ? launch_profile?.reasoning_effort ?? defaultReasoningEffortForHarness(launch_profile?.harness)
      : undefined) ??
    defaultReasoningEffortForHarness(harness);
  const sandbox = supervisor_profile.sandbox ?? launch_profile?.sandbox ?? "read-only";
  const skip_git_repo_check =
    harness === "codex-cli"
      ? supervisor_profile.skip_git_repo_check ??
        (canInheritLaunchModel(launch_profile, supervisor_profile)
          ? launch_profile?.skip_git_repo_check
          : undefined)
      : undefined;

  if (!harness) {
    diagnostics.push({
      path: "$.supervision.profile",
      message: "supervision.profile must resolve a harness from the supervisor or launch profile."
    });
  }

  return {
    policy: {
      profile_name,
      ...(harness ? { harness } : {}),
      ...(harness_config ? { harness_config } : {}),
      ...(model ? { model } : {}),
      ...(reasoning_effort ? { reasoning_effort } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(skip_git_repo_check !== undefined ? { skip_git_repo_check } : {}),
      timeout_sec
    },
    diagnostics,
    profile_name,
    ...(launch_profile ? { launch_profile } : {}),
    supervisor_profile
  };
}
