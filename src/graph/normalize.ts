import type {
  AgentNode,
  AiCheckDefaults,
  ArtifactRepairPolicy,
  AuthoredGraphDocument,
  AuthoredGraphNode,
  BaseExecutableNode,
  CheckNode,
  CheckpointNode,
  ContainerGraphNode,
  ArtifactDefinition,
  ArtifactReference,
  CapabilityDefinition,
  CliHint,
  ContextItem,
  DeterministicCheckDefaults,
  DeterministicPassIf,
  ExecNode,
  ExecutableNodeIntent,
  ExecutableGraphNode,
  GraphDefaults,
  GraphIntent,
  GraphProfile,
  HarnessConfig,
  CodexHarnessConfig,
  CursorHarnessConfig,
  CursorHarnessPermissions,
  ManagedToolDefinition,
  NodeRuntimeSelection,
  NodeSupport,
  ParallelNode,
  RepeatNode,
  RepoDefinition,
  SequenceNode,
  SkillSourceDeclaration,
  SupervisionPolicy,
} from "./authored.js";
import {
  authoredNodeKinds,
  artifactSourceKinds,
  canonicalNodeArtifacts,
  checkKinds,
  contextSourceKinds,
  contextSelectors,
  cursorSandboxModes,
  failureBehaviors,
  graphVersion,
  harnessNames,
  managedPatternKinds,
  reasoningEfforts,
  reservedArtifactNames,
  sandboxModes,
  toolNamePattern,
  workspaceBackends
} from "./schema.js";
import type {
  ContextSelector,
  GraphDiagnostic,
  LoweredManagedKind
} from "./schema.js";
import {
  buildPatternDeepResearch,
  type PatternDeepResearchConfig
} from "../managed/pattern_deep_research.js";
import {
  buildPatternDeepWork,
  type PatternDeepWorkCommandCriterion,
  type PatternDeepWorkCompletionCriterion,
  type PatternDeepWorkConfig,
  type PatternDeepWorkPhaseIntent,
  type PatternDeepWorkPhaseName,
  type PatternDeepWorkPhaseRuntime,
  type PatternDeepWorkRubricCriterion
} from "../managed/pattern_deep_work.js";
import {
  buildPatternWorkList,
  type PatternWorkListBlock,
  type PatternWorkListCommandCriterion,
  type PatternWorkListCompletionCriterion,
  type PatternWorkListConfig,
  type PatternWorkListDeepWorkCompletion,
  type PatternWorkListItemGuidance,
  type PatternWorkListItemWorker,
  type PatternWorkListRubricCriterion
} from "../managed/pattern_work_list.js";
import {
  defaultManagedPublicArtifacts,
  type ManagedPatternAgentOptions,
  type ManagedPatternRuntime
} from "../managed/foundation.js";

export interface LoweredManagedNode {
  authored_id: string;
  managed_kind: LoweredManagedKind;
  lowered_to: "agent" | "sequence";
  internal_id_prefix?: string;
  plugin?: {
    alias: string;
    workflow: string;
    source: string;
    ref: string;
    commit: string;
    manifest_digest: string;
    resources?: Record<string, string>;
  };
}

export interface NormalizedGraphDocument {
  document?: AuthoredGraphDocument;
  diagnostics: GraphDiagnostic[];
  lowered_managed_nodes: LoweredManagedNode[];
}

const checkpointOperatorFeedbackArtifact: ArtifactDefinition = {
  from: "output_dir",
  path: "operator-feedback.md",
  description: "Operator feedback captured when a checkpoint is reviewed."
};

export const defaultSupervisionPolicy: SupervisionPolicy = {
  profile: "supervisor",
  max_total_interventions: 3
};

const harnessIsolationModes = ["isolated", "inherit_user"] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pushUnknownKeyDiagnostics(
  value: Record<string, unknown>,
  path: string,
  allowedKeys: readonly string[],
  diagnostics: GraphDiagnostic[]
): void {
  const allowed = new Set(allowedKeys);

  Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort()
    .forEach((key) => {
      diagnostics.push({
        path: `${path}.${key}`,
        message: `Unknown field "${key}" is not part of the graph contract.`
      });
    });
}

function readRequiredString(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push({
      path,
      message: "Expected a non-empty string."
    });
    return undefined;
  }

  return value;
}

function readOptionalString(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push({
      path,
      message: "Expected a non-empty string when provided."
    });
    return undefined;
  }

  return value;
}

function readPositiveInteger(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[],
  options: {
    required?: boolean;
    minimum?: number;
  } = {}
): number | undefined {
  const minimum = options.minimum ?? 1;

  if (value === undefined) {
    if (options.required) {
      diagnostics.push({
        path,
        message: `Expected an integer greater than or equal to ${minimum}.`
      });
    }
    return undefined;
  }

  if (!Number.isInteger(value) || (value as number) < minimum) {
    diagnostics.push({
      path,
      message: `Expected an integer greater than or equal to ${minimum}.`
    });
    return undefined;
  }

  return value as number;
}

function readBoundedInteger(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[],
  options: {
    minimum: number;
    maximum: number;
    required?: boolean;
  }
): number | undefined {
  if (value === undefined) {
    if (options.required) {
      diagnostics.push({
        path,
        message: `Expected an integer between ${options.minimum} and ${options.maximum}.`
      });
    }
    return undefined;
  }

  if (
    !Number.isInteger(value) ||
    (value as number) < options.minimum ||
    (value as number) > options.maximum
  ) {
    diagnostics.push({
      path,
      message: `Expected an integer between ${options.minimum} and ${options.maximum}.`
    });
    return undefined;
  }

  return value as number;
}

function readBoundedNumber(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[],
  options: {
    minimum: number;
    maximum: number;
    required?: boolean;
  }
): number | undefined {
  if (value === undefined) {
    if (options.required) {
      diagnostics.push({
        path,
        message: `Expected a number between ${options.minimum} and ${options.maximum}.`
      });
    }
    return undefined;
  }

  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    value < options.minimum ||
    value > options.maximum
  ) {
    diagnostics.push({
      path,
      message: `Expected a number between ${options.minimum} and ${options.maximum}.`
    });
    return undefined;
  }

  return value;
}

function readBoolean(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    diagnostics.push({
      path,
      message: "Expected a boolean when provided."
    });
    return undefined;
  }

  return value;
}

function readStringArray(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    diagnostics.push({
      path,
      message: "Expected an array of strings."
    });
    return undefined;
  }

  const items = value
    .map((item, index) => readRequiredString(item, `${path}[${index}]`, diagnostics))
    .filter((item): item is string => typeof item === "string");

  return items;
}

function readStringRecord(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "Expected an object with string values."
    });
    return undefined;
  }

  const result: Record<string, string> = {};

  Object.entries(record).forEach(([key, itemValue]) => {
    const normalized = readRequiredString(itemValue, `${path}.${key}`, diagnostics);
    if (normalized) {
      result[key] = normalized;
    }
  });

  return result;
}

function readUnknownRecord(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[],
  label: string
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: `${label} must be an object.`
    });
    return undefined;
  }

  return { ...record };
}

function readEnumValue<T extends readonly string[]>(
  value: unknown,
  path: string,
  allowed: T,
  diagnostics: GraphDiagnostic[],
  options: {
    required?: boolean;
  } = {}
): T[number] | undefined {
  if (value === undefined) {
    if (options.required) {
      diagnostics.push({
        path,
        message: `Expected one of: ${allowed.join(", ")}.`
      });
    }
    return undefined;
  }

  if (typeof value !== "string" || !allowed.includes(value)) {
    diagnostics.push({
      path,
      message: `Expected one of: ${allowed.join(", ")}.`
    });
    return undefined;
  }

  return value as T[number];
}

function readEnumArray<T extends readonly string[]>(
  value: unknown,
  path: string,
  allowed: T,
  diagnostics: GraphDiagnostic[]
): T[number][] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    diagnostics.push({
      path,
      message: `Expected an array containing only: ${allowed.join(", ")}.`
    });
    return undefined;
  }

  return value
    .map((item, index) => readEnumValue(item, `${path}[${index}]`, allowed, diagnostics, { required: true }))
    .filter((item): item is T[number] => item !== undefined);
}

function normalizePassIf(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): DeterministicPassIf | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pass_if must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["exit_code", "json_path", "equals"], diagnostics);

  if (record.exit_code !== undefined) {
    const exit_code = readPositiveInteger(
      record.exit_code,
      `${path}.exit_code`,
      diagnostics,
      { minimum: 0 }
    );

    if (record.json_path !== undefined || record.equals !== undefined) {
      diagnostics.push({
        path,
        message: "pass_if must use either exit_code or json_path + equals, not both."
      });
      return exit_code !== undefined ? { exit_code } : undefined;
    }

    return exit_code !== undefined ? { exit_code } : undefined;
  }

  const json_path = readRequiredString(record.json_path, `${path}.json_path`, diagnostics);
  const equals = record.equals;

  if (
    equals !== undefined &&
    typeof equals !== "boolean" &&
    typeof equals !== "number" &&
    typeof equals !== "string"
  ) {
    diagnostics.push({
      path: `${path}.equals`,
      message: "equals must be a boolean, number, or string."
    });
    return undefined;
  }

  if (!json_path || equals === undefined) {
    diagnostics.push({
      path,
      message: "pass_if with json_path also requires equals."
    });
    return undefined;
  }

  return {
    json_path,
    equals
  };
}

function normalizeDeterministicCheckDefaults(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): DeterministicCheckDefaults | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "deterministic_check_defaults must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["pass_if"], diagnostics);

  const pass_if = normalizePassIf(record.pass_if, `${path}.pass_if`, diagnostics);

  return {
    ...(pass_if ? { pass_if } : {})
  };
}

function normalizeAiCheckDefaults(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): AiCheckDefaults | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "ai_check_defaults must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["model", "reasoning_effort", "rubric"], diagnostics);

  const model = readOptionalString(record.model, `${path}.model`, diagnostics);
  const reasoning_effort = readEnumValue(
    record.reasoning_effort,
    `${path}.reasoning_effort`,
    reasoningEfforts,
    diagnostics
  );
  const rubric = readOptionalString(record.rubric, `${path}.rubric`, diagnostics);

  return {
    ...(model ? { model } : {}),
    ...(reasoning_effort ? { reasoning_effort } : {}),
    ...(rubric ? { rubric } : {})
  };
}

function normalizeArtifactRepairPolicy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ArtifactRepairPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "artifact_repair must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["max_attempts"], diagnostics);

  const max_attempts = readBoundedInteger(
    record.max_attempts,
    `${path}.max_attempts`,
    diagnostics,
    {
      minimum: 0,
      maximum: 3
    }
  );

  return {
    ...(max_attempts !== undefined ? { max_attempts } : {})
  };
}

function normalizeCodexHarnessConfig(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): CodexHarnessConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "codex harness config must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["config", "mcp_servers", "plugins", "notify"], diagnostics);

  const config = readUnknownRecord(record.config, `${path}.config`, diagnostics, "codex.config");
  const mcp_servers = readUnknownRecord(record.mcp_servers, `${path}.mcp_servers`, diagnostics, "codex.mcp_servers");
  const plugins = readUnknownRecord(record.plugins, `${path}.plugins`, diagnostics, "codex.plugins");
  const notify =
    record.notify === undefined
      ? undefined
      : Array.isArray(record.notify)
        ? [...record.notify]
        : undefined;

  if (record.notify !== undefined && !Array.isArray(record.notify)) {
    diagnostics.push({
      path: `${path}.notify`,
      message: "codex.notify must be an array."
    });
  }

  return {
    ...(config ? { config } : {}),
    ...(mcp_servers ? { mcp_servers } : {}),
    ...(plugins ? { plugins } : {}),
    ...(notify !== undefined ? { notify } : {})
  };
}

function normalizeCursorHarnessPermissions(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): CursorHarnessPermissions | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "cursor.permissions must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["allow", "deny"], diagnostics);

  const allow = readStringArray(record.allow, `${path}.allow`, diagnostics);
  const deny = readStringArray(record.deny, `${path}.deny`, diagnostics);

  return {
    ...(allow !== undefined ? { allow } : {}),
    ...(deny !== undefined ? { deny } : {})
  };
}

function normalizeCursorHarnessConfig(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): CursorHarnessConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "cursor harness config must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["config", "permissions", "sandbox_mode", "required_mcps", "approve_mcps", "trust_workspace"],
    diagnostics
  );

  const config = readUnknownRecord(record.config, `${path}.config`, diagnostics, "cursor.config");
  const permissions = normalizeCursorHarnessPermissions(record.permissions, `${path}.permissions`, diagnostics);
  const sandbox_mode = readEnumValue(record.sandbox_mode, `${path}.sandbox_mode`, cursorSandboxModes, diagnostics);
  const required_mcps = readStringArray(record.required_mcps, `${path}.required_mcps`, diagnostics);
  const approve_mcps = readBoolean(record.approve_mcps, `${path}.approve_mcps`, diagnostics);
  const trust_workspace = readBoolean(record.trust_workspace, `${path}.trust_workspace`, diagnostics);

  return {
    ...(config ? { config } : {}),
    ...(permissions ? { permissions } : {}),
    ...(sandbox_mode ? { sandbox_mode } : {}),
    ...(required_mcps !== undefined ? { required_mcps } : {}),
    ...(approve_mcps !== undefined ? { approve_mcps } : {}),
    ...(trust_workspace !== undefined ? { trust_workspace } : {})
  };
}

function normalizeHarnessConfig(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): HarnessConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "harness_config must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["isolation", "codex", "cursor"], diagnostics);

  const isolation = readEnumValue(record.isolation, `${path}.isolation`, harnessIsolationModes, diagnostics);
  const codex = normalizeCodexHarnessConfig(record.codex, `${path}.codex`, diagnostics);
  const cursor = normalizeCursorHarnessConfig(record.cursor, `${path}.cursor`, diagnostics);

  return {
    ...(isolation ? { isolation } : {}),
    ...(codex ? { codex } : {}),
    ...(cursor ? { cursor } : {})
  };
}

function normalizeGraphProfile(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): GraphProfile | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "Profile must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    [
      "harness",
      "model",
      "reasoning_effort",
      "sandbox",
      "skip_git_repo_check",
      "env_files",
      "deterministic_check_defaults",
      "ai_check_defaults",
      "artifact_repair",
      "harness_config"
    ],
    diagnostics
  );

  const harness = readEnumValue(record.harness, `${path}.harness`, harnessNames, diagnostics);
  const model = readOptionalString(record.model, `${path}.model`, diagnostics);
  const reasoning_effort = readEnumValue(
    record.reasoning_effort,
    `${path}.reasoning_effort`,
    reasoningEfforts,
    diagnostics
  );
  const sandbox = readEnumValue(record.sandbox, `${path}.sandbox`, sandboxModes, diagnostics);
  const skip_git_repo_check = readBoolean(
    record.skip_git_repo_check,
    `${path}.skip_git_repo_check`,
    diagnostics
  );
  const env_files = readStringArray(record.env_files, `${path}.env_files`, diagnostics);
  const deterministic_check_defaults = normalizeDeterministicCheckDefaults(
    record.deterministic_check_defaults,
    `${path}.deterministic_check_defaults`,
    diagnostics
  );
  const ai_check_defaults = normalizeAiCheckDefaults(
    record.ai_check_defaults,
    `${path}.ai_check_defaults`,
    diagnostics
  );
  const artifact_repair = normalizeArtifactRepairPolicy(
    record.artifact_repair,
    `${path}.artifact_repair`,
    diagnostics
  );
  const harness_config = normalizeHarnessConfig(
    record.harness_config,
    `${path}.harness_config`,
    diagnostics
  );

  return {
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    ...(reasoning_effort ? { reasoning_effort } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(skip_git_repo_check !== undefined ? { skip_git_repo_check } : {}),
    ...(env_files !== undefined ? { env_files } : {}),
    ...(deterministic_check_defaults ? { deterministic_check_defaults } : {}),
    ...(ai_check_defaults ? { ai_check_defaults } : {}),
    ...(artifact_repair ? { artifact_repair } : {}),
    ...(harness_config ? { harness_config } : {})
  };
}

function normalizeRepoDefinition(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): RepoDefinition | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "Repo definition must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["path", "default_branch"], diagnostics);

  const repoPath = readRequiredString(record.path, `${path}.path`, diagnostics);
  const default_branch = readOptionalString(record.default_branch, `${path}.default_branch`, diagnostics);

  if (!repoPath) {
    return undefined;
  }

  return {
    path: repoPath,
    ...(default_branch ? { default_branch } : {})
  };
}

function normalizeGraphDefaults(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): GraphDefaults | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "defaults must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["launch_profile", "workspace_backend"], diagnostics);

  const launch_profile = readOptionalString(record.launch_profile, `${path}.launch_profile`, diagnostics);
  const workspace_backend = readEnumValue(
    record.workspace_backend,
    `${path}.workspace_backend`,
    workspaceBackends,
    diagnostics
  );

  return {
    ...(launch_profile ? { launch_profile } : {}),
    ...(workspace_backend ? { workspace_backend } : {})
  };
}

function normalizeGraphIntent(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): GraphIntent | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path: `${path}.goal`,
      message: "Expected a non-empty string."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["goal", "constraints", "acceptance_criteria"],
    diagnostics
  );

  const goal = readRequiredString(record.goal, `${path}.goal`, diagnostics);
  const constraints = readStringArray(record.constraints, `${path}.constraints`, diagnostics);
  const acceptance_criteria = readStringArray(
    record.acceptance_criteria,
    `${path}.acceptance_criteria`,
    diagnostics
  );

  if (!goal) {
    return undefined;
  }

  return {
    goal,
    ...(constraints ? { constraints } : {}),
    ...(acceptance_criteria ? { acceptance_criteria } : {})
  };
}

function normalizeExecutableNodeIntent(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ExecutableNodeIntent | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "Executable nodes require intent."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["goal", "constraints", "acceptance_criteria"],
    diagnostics
  );

  const goal = readRequiredString(record.goal, `${path}.goal`, diagnostics);
  const acceptance_criteria = readStringArray(
    record.acceptance_criteria,
    `${path}.acceptance_criteria`,
    diagnostics
  );
  if (record.acceptance_criteria === undefined) {
    diagnostics.push({
      path: `${path}.acceptance_criteria`,
      message: "Executable node intent requires acceptance_criteria."
    });
  } else if (acceptance_criteria && acceptance_criteria.length === 0) {
    diagnostics.push({
      path: `${path}.acceptance_criteria`,
      message: "Executable node intent requires at least one acceptance_criteria entry."
    });
  }
  const constraints = readStringArray(record.constraints, `${path}.constraints`, diagnostics) ?? [];

  if (!goal || !acceptance_criteria || acceptance_criteria.length === 0) {
    return undefined;
  }

  return {
    goal,
    acceptance_criteria,
    constraints
  };
}

function normalizeSupervisionPolicy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): SupervisionPolicy | undefined {
  if (value === undefined) {
    diagnostics.push({
      path: `${path}.profile`,
      message: "supervision.profile is required."
    });
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      path,
      message: "supervision must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["profile", "max_total_interventions"],
    diagnostics
  );

  const max_total_interventions =
    readBoundedInteger(
      record.max_total_interventions,
      `${path}.max_total_interventions`,
      diagnostics,
      { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
    ) ?? defaultSupervisionPolicy.max_total_interventions;
  const profile = readRequiredString(record.profile, `${path}.profile`, diagnostics);

  if (!profile) {
    return undefined;
  }

  return {
    profile,
    max_total_interventions
  };
}

function normalizeContextItem(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ContextItem | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "context item must be an object."
    });
    return undefined;
  }

  const kind = readRequiredString(record.kind, `${path}.kind`, diagnostics);
  const what = readRequiredString(record.what, `${path}.what`, diagnostics);
  const why = readRequiredString(record.why, `${path}.why`, diagnostics);

  if (kind === "artifact") {
    return normalizeArtifactContextRef(record, path, diagnostics);
  }

  if (!kind || !what || !why) {
    return undefined;
  }

  const from = readEnumValue(kind, `${path}.kind`, contextSourceKinds, diagnostics);
  if (!from) {
    return undefined;
  }

  const name = readRequiredString(record.name, `${path}.name`, diagnostics);

  if (!name) {
    return undefined;
  }

  if (from === "workspace_file") {
    pushUnknownKeyDiagnostics(record, path, ["name", "kind", "path", "what", "why"], diagnostics);
    const itemPath = readRequiredString(record.path, `${path}.path`, diagnostics);
    return itemPath
      ? {
          name,
          from,
          path: itemPath,
          what,
          why
        }
      : undefined;
  }

  if (from === "plugin_file") {
    pushUnknownKeyDiagnostics(record, path, ["name", "kind", "path", "what", "why"], diagnostics);
    const itemPath = readRequiredString(record.path, `${path}.path`, diagnostics);
    return itemPath
      ? {
          name,
          from,
          path: itemPath,
          what,
          why
        }
      : undefined;
  }

  if (from === "workspace_glob") {
    pushUnknownKeyDiagnostics(record, path, ["name", "kind", "path", "max_files", "what", "why"], diagnostics);
    const itemPath = readRequiredString(record.path, `${path}.path`, diagnostics);
    const max_files = readPositiveInteger(record.max_files, `${path}.max_files`, diagnostics);

    if (!itemPath) {
      return undefined;
    }

    return {
      name,
      from,
      path: itemPath,
      what,
      why,
      ...(max_files !== undefined ? { max_files } : {})
    };
  }

  return undefined;
}

function normalizeArtifactContextRef(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[]
): ContextItem | undefined {
  pushUnknownKeyDiagnostics(
    record,
    path,
    ["kind", "ref", "name", "iteration", "attempt", "if_available", "what", "why"],
    diagnostics
  );

  const ref = readRequiredString(record.ref, `${path}.ref`, diagnostics);
  const what = readRequiredString(record.what, `${path}.what`, diagnostics);
  const why = readRequiredString(record.why, `${path}.why`, diagnostics);

  if (!ref || !what || !why) {
    return undefined;
  }

  const trimmedRef = ref.trim();

  if (trimmedRef.length === 0) {
    diagnostics.push({
      path: `${path}.ref`,
      message: "ref must be non-empty."
    });
    return undefined;
  }

  if (trimmedRef.startsWith(".") || trimmedRef.endsWith(".")) {
    diagnostics.push({
      path: `${path}.ref`,
      message: `ref "${trimmedRef}" must not begin or end with "."; use "node" or "node.artifact".`
    });
    return undefined;
  }

  const dotIndex = trimmedRef.indexOf(".");
  let node: string;
  let artifact: string | undefined;
  let derivedName: string;

  if (dotIndex === -1) {
    node = trimmedRef;
    artifact = undefined;
    derivedName = trimmedRef;
  } else {
    node = trimmedRef.slice(0, dotIndex);
    const remainder = trimmedRef.slice(dotIndex + 1);

    if (remainder.includes(".")) {
      diagnostics.push({
        path: `${path}.ref`,
        message: `ref "${trimmedRef}" uses "." beyond the node/artifact separator. Artifact names cannot contain "."; "." is reserved as the ref path separator.`
      });
      return undefined;
    }

    artifact = remainder;
    derivedName = remainder;
  }

  if (node.length === 0) {
    diagnostics.push({
      path: `${path}.ref`,
      message: `ref "${trimmedRef}" must include a node id before the "." separator.`
    });
    return undefined;
  }

  let name: string;

  if (record.name !== undefined) {
    const explicit = readRequiredString(record.name, `${path}.name`, diagnostics);

    if (!explicit) {
      return undefined;
    }

    name = explicit;
  } else {
    name = derivedName;
  }

  const iteration = normalizeSelector(record.iteration, `${path}.iteration`, diagnostics);
  const attempt = normalizeSelector(record.attempt, `${path}.attempt`, diagnostics);
  const if_available = readBoolean(record.if_available, `${path}.if_available`, diagnostics);

  return {
    ref: trimmedRef,
    name,
    node,
    artifact: artifact ?? "",
    what,
    why,
    ...(iteration !== undefined ? { iteration } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(if_available !== undefined ? { if_available } : {})
  };
}

function normalizeContextItems(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ContextItem[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    diagnostics.push({
      path,
      message: "context must be an array."
    });
    return undefined;
  }

  const items = value
    .map((item, index) => normalizeContextItem(item, `${path}[${index}]`, diagnostics))
    .filter((item): item is ContextItem => item !== undefined);

  return items;
}

function normalizeSupportReferences(
  value: unknown,
  path: string,
  label: string,
  diagnostics: GraphDiagnostic[]
): { ref: string }[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    diagnostics.push({
      path,
      message: `${label} must be an array of { ref } objects.`
    });
    return undefined;
  }

  return value
    .map((item, index) => {
      const itemPath = `${path}[${index}]`;
      const record = asRecord(item);
      if (!record) {
        diagnostics.push({
          path: itemPath,
          message: `${label} entries must be objects.`
        });
        return undefined;
      }
      pushUnknownKeyDiagnostics(record, itemPath, ["ref"], diagnostics);
      const ref = readRequiredString(record.ref, `${itemPath}.ref`, diagnostics);
      return ref ? { ref } : undefined;
    })
    .filter((item): item is { ref: string } => item !== undefined);
}

function normalizeCliHints(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): CliHint[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    diagnostics.push({
      path,
      message: "cli must be an array of command hint objects."
    });
    return undefined;
  }

  return value
    .map((item, index) => {
      const itemPath = `${path}[${index}]`;
      const record = asRecord(item);
      if (!record) {
        diagnostics.push({
          path: itemPath,
          message: "CLI hint must be an object."
        });
        return undefined;
      }
      pushUnknownKeyDiagnostics(record, itemPath, ["cmd", "description"], diagnostics);
      const cmd = readRequiredString(record.cmd, `${itemPath}.cmd`, diagnostics);
      const description = readOptionalString(record.description, `${itemPath}.description`, diagnostics);
      return cmd
        ? {
            cmd,
            ...(description ? { description } : {})
          }
        : undefined;
    })
    .filter((item): item is CliHint => item !== undefined);
}

function normalizeNodeSupport(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): NodeSupport | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      path,
      message: "support must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["capabilities", "skills", "tools", "cli", "context"], diagnostics);

  const capabilities = normalizeSupportReferences(record.capabilities, `${path}.capabilities`, "support.capabilities", diagnostics);
  const skills = readStringArray(record.skills, `${path}.skills`, diagnostics);
  const tools = normalizeSupportReferences(record.tools, `${path}.tools`, "support.tools", diagnostics);
  const cli = normalizeCliHints(record.cli, `${path}.cli`, diagnostics);
  const context = normalizeContextItems(record.context, `${path}.context`, diagnostics);

  return {
    ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
    ...(skills && skills.length > 0 ? { skills } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(cli && cli.length > 0 ? { cli } : {}),
    ...(context && context.length > 0 ? { context } : {})
  };
}

function normalizeRuntimeSelection(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[],
  extraKeys: readonly string[] = []
): NodeRuntimeSelection | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      path,
      message: "runtime must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["repo", "profile", ...extraKeys], diagnostics);
  const repo = readOptionalString(record.repo, `${path}.repo`, diagnostics);
  const profile = readOptionalString(record.profile, `${path}.profile`, diagnostics);

  return {
    ...(repo ? { repo } : {}),
    ...(profile ? { profile } : {})
  };
}

function normalizeArtifactReference(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ArtifactReference | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "artifact reference must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["node", "artifact", "iteration", "attempt"], diagnostics);

  const node = readRequiredString(record.node, `${path}.node`, diagnostics);
  const artifact = readRequiredString(record.artifact, `${path}.artifact`, diagnostics);
  const iteration = normalizeSelector(record.iteration, `${path}.iteration`, diagnostics);
  const attempt = normalizeSelector(record.attempt, `${path}.attempt`, diagnostics);

  if (!node || !artifact) {
    return undefined;
  }

  return {
    node,
    artifact,
    ...(iteration !== undefined ? { iteration } : {}),
    ...(attempt !== undefined ? { attempt } : {})
  };
}

function normalizeArtifactDefinition(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ArtifactDefinition | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "artifact definition must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["from", "path", "description", "content_type"], diagnostics);

  const from = readEnumValue(record.from, `${path}.from`, artifactSourceKinds, diagnostics, {
    required: true
  });
  const artifactPath = readRequiredString(record.path, `${path}.path`, diagnostics);
  const description = readRequiredString(record.description, `${path}.description`, diagnostics);
  const contentType = readOptionalString(record.content_type, `${path}.content_type`, diagnostics);

  if (!from || !artifactPath || !description) {
    return undefined;
  }

  return {
    from,
    path: artifactPath,
    description,
    ...(contentType ? { content_type: contentType.trim().toLowerCase() } : {})
  };
}

function normalizeArtifacts(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): Record<string, ArtifactDefinition> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "artifacts must be an object map."
    });
    return undefined;
  }

  const artifacts: Record<string, ArtifactDefinition> = {};

  for (const [name, definition] of Object.entries(record)) {
    if (reservedArtifactNames.includes(name as (typeof reservedArtifactNames)[number])) {
      diagnostics.push({
        path: `${path}.${name}`,
        message: `Artifact name "${name}" is reserved by Agentflow.`
      });
      continue;
    }

    if (name.includes(".")) {
      diagnostics.push({
        path: `${path}.${name}`,
        message: `Artifact name "${name}" cannot contain "."; "." is reserved as the ref path separator.`
      });
      continue;
    }

    const normalized = normalizeArtifactDefinition(definition, `${path}.${name}`, diagnostics);

    if (normalized) {
      artifacts[name] = normalized;
    }
  }

  return artifacts;
}

function normalizeSelector(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ContextSelector | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "number") {
    if (Number.isInteger(value) && value > 0) {
      return value;
    }

    diagnostics.push({
      path,
      message: "Selectors must be positive integers when numeric."
    });
    return undefined;
  }

  return readEnumValue(value, path, contextSelectors, diagnostics);
}

function normalizeExecutableBase(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[],
  options: {
    allow_artifacts?: boolean;
    artifacts_disallowed_message?: string;
    runtime_extra_keys?: readonly string[];
  } = {}
): BaseExecutableNode | undefined {
  const allow_artifacts = options.allow_artifacts ?? true;
  const id = readRequiredString(record.id, `${path}.id`, diagnostics);
  const label = readOptionalString(record.label, `${path}.label`, diagnostics);
  const runtime = normalizeRuntimeSelection(
    record.runtime,
    `${path}.runtime`,
    diagnostics,
    options.runtime_extra_keys ?? []
  );
  const intent = normalizeExecutableNodeIntent(record.intent, `${path}.intent`, diagnostics);
  const support = normalizeNodeSupport(record.support, `${path}.support`, diagnostics);
  const artifacts = allow_artifacts
    ? normalizeArtifacts(record.artifacts, `${path}.artifacts`, diagnostics)
    : undefined;

  if (!allow_artifacts && record.artifacts !== undefined) {
    diagnostics.push({
      path: `${path}.artifacts`,
      message: options.artifacts_disallowed_message ?? 'Field "artifacts" does not apply to this node kind.'
    });
  }

  if (!id || !intent) {
    return undefined;
  }

  return {
    id,
    ...(label ? { label } : {}),
    ...(runtime ? { runtime } : {}),
    intent,
    ...(support ? { support } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}

function parseManagedToolRef(
  ref: string,
  path: string,
  diagnostics: GraphDiagnostic[]
): { pluginAlias: string; toolName: string } | undefined {
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0 || slashIndex === ref.length - 1 || ref.indexOf("/", slashIndex + 1) !== -1) {
    diagnostics.push({
      path,
      message: 'Managed tool refs must use "pluginAlias/toolName" form.'
    });
    return undefined;
  }

  return {
    pluginAlias: ref.slice(0, slashIndex),
    toolName: ref.slice(slashIndex + 1)
  };
}

function normalizeManagedToolDefinition(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ManagedToolDefinition | undefined {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push({ path, message: "Managed tool definition must be an object." });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["ref", "alias", "config"], diagnostics);

  const ref = readRequiredString(record.ref, `${path}.ref`, diagnostics);
  const alias = readOptionalString(record.alias, `${path}.alias`, diagnostics);
  const config = readStringRecord(record.config, `${path}.config`, diagnostics);

  if (ref) {
    parseManagedToolRef(ref, `${path}.ref`, diagnostics);
  }

  if (alias !== undefined && !toolNamePattern.test(alias)) {
    diagnostics.push({
      path: `${path}.alias`,
      message: 'Tool alias must match /^[a-z0-9][a-z0-9-]*$/.'
    });
  }

  if (!ref) {
    return undefined;
  }

  return {
    ref,
    ...(alias ? { alias } : {}),
    ...(config ? { config } : {})
  };
}

function normalizeManagedToolDefinitions(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): Record<string, ManagedToolDefinition> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({ path, message: "tools must be an object map when provided." });
    return undefined;
  }

  const definitions: Record<string, ManagedToolDefinition> = {};
  Object.entries(record).forEach(([name, definition]) => {
    if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
      diagnostics.push({
        path: `${path}.${name}`,
        message: 'Tool registry names must match /^[a-z][a-z0-9_]*$/.'
      });
      return;
    }

    const normalized = normalizeManagedToolDefinition(definition, `${path}.${name}`, diagnostics);
    if (normalized) {
      definitions[name] = normalized;
    }
  });

  return definitions;
}

function normalizeSkillSources(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): Record<string, SkillSourceDeclaration> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      path,
      message: "skill_sources must be an object keyed by source alias."
    });
    return undefined;
  }

  const sources: Record<string, SkillSourceDeclaration> = {};
  Object.entries(record).forEach(([alias, item]) => {
    const itemPath = `${path}.${alias}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(alias)) {
      diagnostics.push({
        path: itemPath,
        message: "Skill source aliases must use letters, numbers, underscores, or hyphens, and must start with a letter or number."
      });
      return;
    }

    const sourceRecord = asRecord(item);
    if (!sourceRecord) {
      diagnostics.push({
        path: itemPath,
        message: "Skill source declaration must be an object."
      });
      return;
    }

    pushUnknownKeyDiagnostics(sourceRecord, itemPath, ["source", "ref", "path"], diagnostics);
    const hasPath = sourceRecord.path !== undefined;
    const hasGit = sourceRecord.source !== undefined || sourceRecord.ref !== undefined;

    if (hasPath && hasGit) {
      diagnostics.push({
        path: itemPath,
        message: "Skill source declaration must use either { path } or { source, ref }, not both."
      });
      return;
    }

    if (hasPath) {
      const sourcePath = readRequiredString(sourceRecord.path, `${itemPath}.path`, diagnostics);
      if (sourcePath) {
        sources[alias] = { path: sourcePath };
      }
      return;
    }

    const source = readRequiredString(sourceRecord.source, `${itemPath}.source`, diagnostics);
    const ref = readRequiredString(sourceRecord.ref, `${itemPath}.ref`, diagnostics);
    if (source && ref) {
      sources[alias] = { source, ref };
    }
  });

  return sources;
}

function normalizeCapabilities(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): Record<string, CapabilityDefinition> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      path,
      message: "capabilities must be an object map."
    });
    return undefined;
  }

  const capabilities: Record<string, CapabilityDefinition> = {};
  Object.entries(record).forEach(([name, item]) => {
    const itemPath = `${path}.${name}`;
    if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
      diagnostics.push({
        path: itemPath,
        message: 'Capability names must match /^[a-z][a-z0-9_]*$/.'
      });
      return;
    }

    const capabilityRecord = asRecord(item);
    if (!capabilityRecord) {
      diagnostics.push({
        path: itemPath,
        message: "Capability definition must be an object."
      });
      return;
    }

    pushUnknownKeyDiagnostics(capabilityRecord, itemPath, ["skills", "tools", "cli"], diagnostics);
    const skills = readStringArray(capabilityRecord.skills, `${itemPath}.skills`, diagnostics);
    const tools = normalizeSupportReferences(capabilityRecord.tools, `${itemPath}.tools`, "capability.tools", diagnostics);
    const cli = normalizeCliHints(capabilityRecord.cli, `${itemPath}.cli`, diagnostics);

    capabilities[name] = {
      ...(skills && skills.length > 0 ? { skills } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(cli && cli.length > 0 ? { cli } : {})
    };
  });

  return capabilities;
}

function normalizeAgentNode(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[]
): AgentNode | undefined {
  pushUnknownKeyDiagnostics(
    record,
    path,
    [
      "type",
      "id",
      "label",
      "runtime",
      "intent",
      "support",
      "artifacts",
      "model",
      "reasoning_effort",
      "sandbox",
      "artifact_repair"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const model = readOptionalString(record.model, `${path}.model`, diagnostics);
  const reasoning_effort = readEnumValue(
    record.reasoning_effort,
    `${path}.reasoning_effort`,
    reasoningEfforts,
    diagnostics
  );
  const sandbox = readEnumValue(record.sandbox, `${path}.sandbox`, sandboxModes, diagnostics);
  const artifact_repair = normalizeArtifactRepairPolicy(
    record.artifact_repair,
    `${path}.artifact_repair`,
    diagnostics
  );

  if (!base) {
    return undefined;
  }

  return {
    type: "agent",
    ...base,
    ...(model ? { model } : {}),
    ...(reasoning_effort ? { reasoning_effort } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(artifact_repair ? { artifact_repair } : {})
  };
}

function normalizeExecNode(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[]
): ExecNode | undefined {
  pushUnknownKeyDiagnostics(
    record,
    path,
    [
      "type",
      "id",
      "label",
      "runtime",
      "intent",
      "support",
      "artifacts",
      "command",
      "args",
      "cwd",
      "env_files",
      "env",
      "on_failure"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const command = readRequiredString(record.command, `${path}.command`, diagnostics);
  const args = readStringArray(record.args, `${path}.args`, diagnostics);
  const cwd = readOptionalString(record.cwd, `${path}.cwd`, diagnostics);
  const env_files = readStringArray(record.env_files, `${path}.env_files`, diagnostics);
  const env = readStringRecord(record.env, `${path}.env`, diagnostics);
  const on_failure = readEnumValue(record.on_failure, `${path}.on_failure`, failureBehaviors, diagnostics);

  if (!base || !command) {
    return undefined;
  }

  return {
    type: "exec",
    ...base,
    command,
    ...(args ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env_files !== undefined ? { env_files } : {}),
    ...(env ? { env } : {}),
    ...(on_failure ? { on_failure } : {})
  };
}

function normalizeCheckNode(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[]
): CheckNode | undefined {
  pushUnknownKeyDiagnostics(
    record,
    path,
    [
      "type",
      "id",
      "label",
      "runtime",
      "intent",
      "support",
      "artifacts",
      "check_kind",
      "command",
      "args",
      "cwd",
      "env_files",
      "env",
      "pass_if",
      "rubric",
      "model",
      "reasoning_effort",
      "on_failure"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const check_kind = readEnumValue(record.check_kind, `${path}.check_kind`, checkKinds, diagnostics, {
    required: true
  });
  const command = readOptionalString(record.command, `${path}.command`, diagnostics);
  const args = readStringArray(record.args, `${path}.args`, diagnostics);
  const cwd = readOptionalString(record.cwd, `${path}.cwd`, diagnostics);
  const env_files = readStringArray(record.env_files, `${path}.env_files`, diagnostics);
  const env = readStringRecord(record.env, `${path}.env`, diagnostics);
  const pass_if = normalizePassIf(record.pass_if, `${path}.pass_if`, diagnostics);
  const rubric = readOptionalString(record.rubric, `${path}.rubric`, diagnostics);
  const model = readOptionalString(record.model, `${path}.model`, diagnostics);
  const on_failure = readEnumValue(record.on_failure, `${path}.on_failure`, failureBehaviors, diagnostics);
  const reasoning_effort = readEnumValue(
    record.reasoning_effort,
    `${path}.reasoning_effort`,
    reasoningEfforts,
    diagnostics
  );

  if (!base || !check_kind) {
    return undefined;
  }

  if (check_kind === "deterministic") {
    for (const field of ["rubric", "model", "reasoning_effort"] as const) {
      if (record[field] !== undefined) {
        diagnostics.push({
          path: `${path}.${field}`,
          message: `Field "${field}" does not apply to deterministic checks.`
        });
      }
    }
  }

  if (check_kind === "ai") {
    for (const field of ["command", "args", "cwd", "env_files", "env", "pass_if"] as const) {
      if (record[field] !== undefined) {
        diagnostics.push({
          path: `${path}.${field}`,
          message: `Field "${field}" does not apply to AI checks.`
        });
      }
    }
  }

  if (check_kind === "deterministic" && !command) {
    diagnostics.push({
      path: `${path}.command`,
      message: "Deterministic checks require command."
    });
  }

  return {
    type: "check",
    ...base,
    check_kind,
    ...(check_kind === "deterministic" && command ? { command } : {}),
    ...(check_kind === "deterministic" && args ? { args } : {}),
    ...(check_kind === "deterministic" && cwd ? { cwd } : {}),
    ...(check_kind === "deterministic" && env_files !== undefined ? { env_files } : {}),
    ...(check_kind === "deterministic" && env ? { env } : {}),
    ...(check_kind === "deterministic" && pass_if ? { pass_if } : {}),
    ...(check_kind === "ai" && rubric ? { rubric } : {}),
    ...(check_kind === "ai" && model ? { model } : {}),
    ...(check_kind === "ai" && reasoning_effort ? { reasoning_effort } : {}),
    ...(on_failure ? { on_failure } : {})
  };
}

function normalizeCheckpointNode(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[]
): CheckpointNode | undefined {
  pushUnknownKeyDiagnostics(
    record,
    path,
    [
      "type",
      "id",
      "label",
      "runtime",
      "intent",
      "support",
      "artifacts",
      "review_from"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics, {
    allow_artifacts: false
  });
  const review_from = normalizeArtifactReference(
    record.review_from,
    `${path}.review_from`,
    diagnostics
  );

  if (!base || !review_from) {
    return undefined;
  }

  return {
    type: "checkpoint",
    ...base,
    artifacts: {
      operator_feedback: checkpointOperatorFeedbackArtifact
    },
    review_from
  };
}

function normalizeSequenceNode(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[],
  loweredManagedNodes: LoweredManagedNode[]
): SequenceNode | undefined {
  pushUnknownKeyDiagnostics(
    record,
    path,
    ["type", "id", "label", "steps", "cleanup"],
    diagnostics
  );

  const id = readRequiredString(record.id, `${path}.id`, diagnostics);
  const label = readOptionalString(record.label, `${path}.label`, diagnostics);

  if (!Array.isArray(record.steps)) {
    diagnostics.push({
      path: `${path}.steps`,
      message: "sequence.steps must be an array."
    });
    return undefined;
  }

  const steps = record.steps
    .map((child, index) => normalizeGraphNode(child, `${path}.steps[${index}]`, diagnostics, loweredManagedNodes))
    .filter((child): child is AuthoredGraphNode => child !== undefined);

  let cleanup: AuthoredGraphNode[] | undefined;
  if (record.cleanup !== undefined) {
    if (!Array.isArray(record.cleanup)) {
      diagnostics.push({
        path: `${path}.cleanup`,
        message: "sequence.cleanup must be an array when provided."
      });
    } else {
      cleanup = record.cleanup
        .map((child, index) => normalizeGraphNode(child, `${path}.cleanup[${index}]`, diagnostics, loweredManagedNodes))
        .filter((child): child is AuthoredGraphNode => child !== undefined);
    }
  }

  if (!id) {
    return undefined;
  }

  return {
    type: "sequence",
    id,
    ...(label ? { label } : {}),
    steps,
    ...(cleanup && cleanup.length > 0 ? { cleanup } : {})
  };
}

function normalizeParallelNode(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[],
  loweredManagedNodes: LoweredManagedNode[]
): ParallelNode | undefined {
  pushUnknownKeyDiagnostics(
    record,
    path,
    ["type", "id", "label", "steps", "max_concurrency"],
    diagnostics
  );

  const id = readRequiredString(record.id, `${path}.id`, diagnostics);
  const label = readOptionalString(record.label, `${path}.label`, diagnostics);
  const max_concurrency = readPositiveInteger(
    record.max_concurrency,
    `${path}.max_concurrency`,
    diagnostics
  );

  if (!Array.isArray(record.steps)) {
    diagnostics.push({
      path: `${path}.steps`,
      message: "parallel.steps must be an array."
    });
    return undefined;
  }

  const steps = record.steps
    .map((child, index) => normalizeGraphNode(child, `${path}.steps[${index}]`, diagnostics, loweredManagedNodes))
    .filter((child): child is AuthoredGraphNode => child !== undefined);

  if (!id) {
    return undefined;
  }

  return {
    type: "parallel",
    id,
    ...(label ? { label } : {}),
    steps,
    ...(max_concurrency !== undefined ? { max_concurrency } : {})
  };
}

function normalizeRepeatNode(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[],
  loweredManagedNodes: LoweredManagedNode[]
): RepeatNode | undefined {
  pushUnknownKeyDiagnostics(
    record,
    path,
    ["type", "id", "label", "max_attempts", "body", "until"],
    diagnostics
  );

  const id = readRequiredString(record.id, `${path}.id`, diagnostics);
  const label = readOptionalString(record.label, `${path}.label`, diagnostics);
  const max_attempts = readPositiveInteger(
    record.max_attempts,
    `${path}.max_attempts`,
    diagnostics,
    { required: true }
  );
  const body = normalizeGraphNode(record.body, `${path}.body`, diagnostics, loweredManagedNodes);
  const untilRecord = asRecord(record.until);

  if (!untilRecord) {
    diagnostics.push({
      path: `${path}.until`,
      message: "repeat.until must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(untilRecord, `${path}.until`, ["node"], diagnostics);
  const untilNode = readRequiredString(untilRecord.node, `${path}.until.node`, diagnostics);

  if (!id || max_attempts === undefined || !body || !untilNode) {
    return undefined;
  }

  return {
    type: "repeat",
    id,
    ...(label ? { label } : {}),
    max_attempts,
    body,
    until: {
      node: untilNode
    }
  };
}

function normalizeManagedRuntime(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ManagedPatternRuntime {
  if (value === undefined) {
    return {};
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "managed pattern runtime must be an object."
    });
    return {};
  }

  pushUnknownKeyDiagnostics(record, path, ["repo", "profile", "max_concurrency"], diagnostics);

  const repo = readOptionalString(record.repo, `${path}.repo`, diagnostics);
  const profile = readOptionalString(record.profile, `${path}.profile`, diagnostics);
  const max_concurrency = readPositiveInteger(record.max_concurrency, `${path}.max_concurrency`, diagnostics);

  return {
    ...(repo ? { repo } : {}),
    ...(profile ? { profile } : {}),
    ...(max_concurrency !== undefined ? { max_concurrency } : {})
  };
}

function normalizeManagedAgentOptions(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[]
): ManagedPatternAgentOptions {
  const model = readOptionalString(record.model, `${path}.model`, diagnostics);
  const reasoning_effort = readEnumValue(
    record.reasoning_effort,
    `${path}.reasoning_effort`,
    reasoningEfforts,
    diagnostics
  );
  const sandbox = readEnumValue(record.sandbox, `${path}.sandbox`, sandboxModes, diagnostics);
  const artifact_repair = normalizeArtifactRepairPolicy(
    record.artifact_repair,
    `${path}.artifact_repair`,
    diagnostics
  );
  const support = normalizeNodeSupport(record.support, `${path}.support`, diagnostics);

  return {
    ...(model ? { model } : {}),
    ...(reasoning_effort ? { reasoning_effort } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(artifact_repair ? { artifact_repair } : {}),
    ...(support ? { support } : {})
  };
}

function normalizePatternDeepResearchConfig(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternDeepResearchConfig["research"] | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_deep_research.research must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["angles"], diagnostics);
  const angleValues = Array.isArray(record.angles) ? record.angles : undefined;

  if (!angleValues || angleValues.length === 0) {
    diagnostics.push({
      path: `${path}.angles`,
      message: "pattern_deep_research.research.angles must include at least one angle."
    });
    return undefined;
  }

  if (angleValues.length > 8) {
    diagnostics.push({
      path: `${path}.angles`,
      message: "pattern_deep_research.research.angles supports at most 8 angles."
    });
  }

  const angles = angleValues.flatMap((angle, index) => {
    const anglePath = `${path}.angles[${index}]`;

    if (typeof angle === "string") {
      const trimmed = angle.trim();
      if (!trimmed) {
        diagnostics.push({
          path: anglePath,
          message: "Expected a non-empty string."
        });
        return [];
      }
      if (trimmed.split(/\s+/u).length < 3) {
        diagnostics.push({
          path: anglePath,
          message: "Research angles should be sentence-style prompts, not one-word axes."
        });
      }
      return [{
        id: `angle_${String(index + 1).padStart(2, "0")}`,
        prompt: trimmed
      }];
    }

    const angleRecord = asRecord(angle);
    if (!angleRecord) {
      diagnostics.push({
        path: anglePath,
        message: "research angles must be strings or objects."
      });
      return [];
    }

    pushUnknownKeyDiagnostics(angleRecord, anglePath, ["id", "prompt"], diagnostics);
    const id = normalizeManagedLocalId(
      angleRecord.id,
      `${anglePath}.id`,
      "Research angle id",
      diagnostics
    );
    const prompt = readRequiredString(angleRecord.prompt, `${anglePath}.prompt`, diagnostics);

    if (prompt && prompt.trim().split(/\s+/u).length < 3) {
      diagnostics.push({
        path: `${anglePath}.prompt`,
        message: "Research angles should be sentence-style prompts, not one-word axes."
      });
    }

    if (!id || !prompt) {
      return [];
    }

    return [{
      id,
      prompt
    }];
  });

  const seenIds = new Set<string>();
  angles.forEach((angle, index) => {
    if (seenIds.has(angle.id)) {
      diagnostics.push({
        path: `${path}.angles[${index}].id`,
        message: `Duplicate research angle id "${angle.id}".`
      });
    }
    seenIds.add(angle.id);
  });

  return {
    angles
  };
}

function normalizePatternDeepResearchNode(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[],
  loweredManagedNodes: LoweredManagedNode[]
): SequenceNode | undefined {
  pushUnknownKeyDiagnostics(
    record,
    path,
    [
      "type",
      "id",
      "label",
      "runtime",
      "intent",
      "support",
      "model",
      "reasoning_effort",
      "sandbox",
      "artifact_repair",
      "research",
      "runtime"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics, {
    allow_artifacts: false,
    artifacts_disallowed_message: "pattern_deep_research publishes only the research artifact; raw angle and synthesis reports remain internal run evidence.",
    runtime_extra_keys: ["max_concurrency"]
  });
  const agentOptions = normalizeManagedAgentOptions(record, path, diagnostics);
  const research = normalizePatternDeepResearchConfig(
    record.research,
    `${path}.research`,
    diagnostics
  );
  const runtime = normalizeManagedRuntime(record.runtime, `${path}.runtime`, diagnostics);

  if (!base || !research) {
    return undefined;
  }

  loweredManagedNodes.push({
    authored_id: base.id,
    managed_kind: "pattern_deep_research",
    lowered_to: "sequence"
  });

  return buildPatternDeepResearch({
    ...base,
    ...agentOptions,
    research,
    runtime
  });
}

function normalizeManagedLocalId(
  value: unknown,
  path: string,
  label: string,
  diagnostics: GraphDiagnostic[]
): string | undefined {
  const id = readRequiredString(value, path, diagnostics);

  if (!id) {
    return undefined;
  }

  if (!/^[a-z][a-z0-9_]*$/u.test(id)) {
    diagnostics.push({
      path,
      message: `${label} must match /^[a-z][a-z0-9_]*$/.`
    });
    return undefined;
  }

  return id;
}

function normalizeCriterionId(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): string | undefined {
  return normalizeManagedLocalId(value, path, "Completion criterion id", diagnostics);
}

function normalizeCompletionCriterion(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[],
  publicArtifacts: Record<string, ArtifactDefinition>
): PatternDeepWorkCompletionCriterion | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "completion criteria must be objects."
    });
    return undefined;
  }

  const kind = readEnumValue(
    record.kind,
    `${path}.kind`,
    ["command", "rubric"] as const,
    diagnostics,
    { required: true }
  );
  const id = normalizeCriterionId(record.id, `${path}.id`, diagnostics);
  const weight = readBoundedNumber(record.weight, `${path}.weight`, diagnostics, {
    minimum: 0,
    maximum: 1,
    required: true
  });
  const required = readBoolean(record.required, `${path}.required`, diagnostics);

  if (kind === "command") {
    pushUnknownKeyDiagnostics(record, path, ["id", "kind", "command", "weight", "required"], diagnostics);
    const command = readRequiredString(record.command, `${path}.command`, diagnostics);

    if (!id || weight === undefined || !command) {
      return undefined;
    }

    return {
      id,
      kind,
      command,
      weight,
      ...(required !== undefined ? { required } : {})
    } satisfies PatternDeepWorkCommandCriterion;
  }

  if (kind === "rubric") {
    pushUnknownKeyDiagnostics(record, path, ["id", "kind", "target", "rubric", "weight", "required"], diagnostics);
    const target = normalizeRubricTarget(record.target, `${path}.target`, diagnostics, publicArtifacts);
    const rubric = readRequiredString(record.rubric, `${path}.rubric`, diagnostics);

    if (!id || weight === undefined || !target || !rubric) {
      return undefined;
    }

    return {
      id,
      kind,
      target,
      rubric,
      weight,
      ...(required !== undefined ? { required } : {})
    } satisfies PatternDeepWorkRubricCriterion;
  }

  return undefined;
}

function normalizeRubricTarget(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[],
  publicArtifacts: Record<string, ArtifactDefinition>
): PatternDeepWorkRubricCriterion["target"] | undefined {
  const target = readRequiredString(value, path, diagnostics);
  if (!target) {
    return undefined;
  }

  if (target === "workspace") {
    return target;
  }

  const artifactPrefix = "artifact:";
  if (!target.startsWith(artifactPrefix)) {
    diagnostics.push({
      path,
      message: 'rubric target must be "workspace" or "artifact:<name>".'
    });
    return undefined;
  }

  const artifact = target.slice(artifactPrefix.length);
  if (!artifact) {
    diagnostics.push({
      path,
      message: 'rubric target must be "workspace" or "artifact:<name>".'
    });
    return undefined;
  }

  if (!publicArtifacts[artifact]) {
    diagnostics.push({
      path,
      message: `rubric criterion target references unknown public artifact "${artifact}".`
    });
    return undefined;
  }

  return target as PatternDeepWorkRubricCriterion["target"];
}

function normalizePatternDeepWorkCompletion(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[],
  publicArtifacts: Record<string, ArtifactDefinition>
): PatternDeepWorkConfig["completion"] | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_deep_work.completion must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["max_cycles", "pass_threshold", "criteria"], diagnostics);

  const max_cycles = readBoundedInteger(record.max_cycles, `${path}.max_cycles`, diagnostics, {
    minimum: 1,
    maximum: 5
  }) ?? 3;
  const pass_threshold = readBoundedNumber(record.pass_threshold, `${path}.pass_threshold`, diagnostics, {
    minimum: 0,
    maximum: 1
  }) ?? 0.85;

  if (!Array.isArray(record.criteria)) {
    diagnostics.push({
      path: `${path}.criteria`,
      message: "pattern_deep_work.completion.criteria must be an array."
    });
    return undefined;
  }

  if (record.criteria.length === 0) {
    diagnostics.push({
      path: `${path}.criteria`,
      message: "pattern_deep_work.completion.criteria must include at least one criterion."
    });
  }

  const criteria = record.criteria
    .map((criterion, index) => normalizeCompletionCriterion(
      criterion,
      `${path}.criteria[${index}]`,
      diagnostics,
      publicArtifacts
    ))
    .filter((criterion): criterion is PatternDeepWorkCompletionCriterion => criterion !== undefined);

  const seenIds = new Set<string>();
  criteria.forEach((criterion, index) => {
    if (seenIds.has(criterion.id)) {
      diagnostics.push({
        path: `${path}.criteria[${index}].id`,
        message: `Duplicate completion criterion id "${criterion.id}".`
      });
    }
    seenIds.add(criterion.id);
  });

  const weightTotal = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (criteria.length > 0 && Math.abs(weightTotal - 1) > 0.001) {
    diagnostics.push({
      path: `${path}.criteria`,
      message: `Completion criterion weights must sum to 1. Current total is ${Number(weightTotal.toFixed(4))}.`
    });
  }

  if (criteria.length === 0) {
    return undefined;
  }

  return {
    max_cycles,
    pass_threshold,
    criteria
  };
}

const patternDeepWorkPhaseNames = ["plan", "execute", "verify", "publish"] as const;

function normalizePatternDeepWorkPhaseIntent(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternDeepWorkPhaseIntent | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_deep_work phase intent must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["goal", "acceptance_criteria", "constraints"], diagnostics);
  const goal = readOptionalString(record.goal, `${path}.goal`, diagnostics);
  const acceptance_criteria = readStringArray(record.acceptance_criteria, `${path}.acceptance_criteria`, diagnostics);
  const constraints = readStringArray(record.constraints, `${path}.constraints`, diagnostics);

  return {
    ...(goal ? { goal } : {}),
    ...(acceptance_criteria && acceptance_criteria.length > 0 ? { acceptance_criteria } : {}),
    ...(constraints && constraints.length > 0 ? { constraints } : {})
  };
}

function normalizePatternDeepWorkPhaseRuntime(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternDeepWorkPhaseRuntime | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_deep_work phase runtime must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["profile"], diagnostics);
  const profile = readOptionalString(record.profile, `${path}.profile`, diagnostics);

  return {
    ...(profile ? { profile } : {})
  };
}

function normalizePatternDeepWorkPhases(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternDeepWorkConfig["phases"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_deep_work.phases must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, patternDeepWorkPhaseNames, diagnostics);

  const phases: PatternDeepWorkConfig["phases"] = {};
  for (const phase of patternDeepWorkPhaseNames) {
    const rawPhase = record[phase];
    if (rawPhase === undefined) {
      continue;
    }

    const phasePath = `${path}.${phase}`;
    const phaseRecord = asRecord(rawPhase);
    if (!phaseRecord) {
      diagnostics.push({
        path: phasePath,
        message: "pattern_deep_work phase overrides must be objects."
      });
      continue;
    }

    pushUnknownKeyDiagnostics(
      phaseRecord,
      phasePath,
      ["intent", "support", "runtime", "model", "reasoning_effort", "sandbox"],
      diagnostics
    );

    const intent = normalizePatternDeepWorkPhaseIntent(phaseRecord.intent, `${phasePath}.intent`, diagnostics);
    const support = normalizeNodeSupport(phaseRecord.support, `${phasePath}.support`, diagnostics);
    const runtime = normalizePatternDeepWorkPhaseRuntime(phaseRecord.runtime, `${phasePath}.runtime`, diagnostics);
    const model = readOptionalString(phaseRecord.model, `${phasePath}.model`, diagnostics);
    const reasoning_effort = readEnumValue(
      phaseRecord.reasoning_effort,
      `${phasePath}.reasoning_effort`,
      reasoningEfforts,
      diagnostics
    );
    const sandbox = readEnumValue(phaseRecord.sandbox, `${phasePath}.sandbox`, sandboxModes, diagnostics);

    phases[phase as PatternDeepWorkPhaseName] = {
      ...(intent && Object.keys(intent).length > 0 ? { intent } : {}),
      ...(support ? { support } : {}),
      ...(runtime && Object.keys(runtime).length > 0 ? { runtime } : {}),
      ...(model ? { model } : {}),
      ...(reasoning_effort ? { reasoning_effort } : {}),
      ...(sandbox ? { sandbox } : {})
    };
  }

  return Object.keys(phases).length > 0 ? phases : undefined;
}

function normalizePatternDeepWorkNode(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[],
  loweredManagedNodes: LoweredManagedNode[]
): SequenceNode | undefined {
  pushUnknownKeyDiagnostics(
    record,
    path,
    [
      "type",
      "id",
      "label",
      "runtime",
      "intent",
      "support",
      "artifacts",
      "model",
      "reasoning_effort",
      "sandbox",
      "artifact_repair",
      "completion",
      "phases"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics, {
    runtime_extra_keys: ["max_concurrency"]
  });
  const agentOptions = normalizeManagedAgentOptions(record, path, diagnostics);
  const publicArtifacts = {
    ...defaultManagedPublicArtifacts(),
    ...(base?.artifacts ?? {})
  };
  const completion = normalizePatternDeepWorkCompletion(
    record.completion,
    `${path}.completion`,
    diagnostics,
    publicArtifacts
  );
  const phases = normalizePatternDeepWorkPhases(record.phases, `${path}.phases`, diagnostics);
  const runtime = normalizeManagedRuntime(record.runtime, `${path}.runtime`, diagnostics);

  if (!base || !completion) {
    return undefined;
  }

  loweredManagedNodes.push({
    authored_id: base.id,
    managed_kind: "pattern_deep_work",
    lowered_to: "sequence"
  });

  return buildPatternDeepWork({
    ...base,
    ...agentOptions,
    completion,
    ...(phases ? { phases } : {}),
    runtime
  });
}

function normalizeWorkListRubricTarget(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternWorkListRubricCriterion["target"] | undefined {
  const target = readRequiredString(value, path, diagnostics);
  if (!target) {
    return undefined;
  }

  if (target === "workspace" || target === "item_handoff" || target === "work_list_ledger") {
    return target;
  }

  diagnostics.push({
    path,
    message: 'work-list rubric target must be "workspace", "item_handoff", or "work_list_ledger".'
  });
  return undefined;
}

function normalizeWorkListCompletionCriterion(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternWorkListCompletionCriterion | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "work-list completion criteria must be objects."
    });
    return undefined;
  }

  const kind = readEnumValue(
    record.kind,
    `${path}.kind`,
    ["command", "rubric"] as const,
    diagnostics,
    { required: true }
  );
  const id = normalizeCriterionId(record.id, `${path}.id`, diagnostics);
  const weight = readBoundedNumber(record.weight, `${path}.weight`, diagnostics, {
    minimum: 0,
    maximum: 1,
    required: true
  });
  const required = readBoolean(record.required, `${path}.required`, diagnostics);

  if (kind === "command") {
    pushUnknownKeyDiagnostics(record, path, ["id", "kind", "command", "weight", "required"], diagnostics);
    const command = readRequiredString(record.command, `${path}.command`, diagnostics);

    if (!id || weight === undefined || !command) {
      return undefined;
    }

    return {
      id,
      kind,
      command,
      weight,
      ...(required !== undefined ? { required } : {})
    } satisfies PatternWorkListCommandCriterion;
  }

  if (kind === "rubric") {
    pushUnknownKeyDiagnostics(record, path, ["id", "kind", "target", "rubric", "weight", "required"], diagnostics);
    const target = normalizeWorkListRubricTarget(record.target, `${path}.target`, diagnostics);
    const rubric = readRequiredString(record.rubric, `${path}.rubric`, diagnostics);

    if (!id || weight === undefined || !target || !rubric) {
      return undefined;
    }

    return {
      id,
      kind,
      target,
      rubric,
      weight,
      ...(required !== undefined ? { required } : {})
    } satisfies PatternWorkListRubricCriterion;
  }

  return undefined;
}

function normalizeWorkListDeepWorkCompletion(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternWorkListDeepWorkCompletion | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_work_list.item_worker.completion must be an object for deep_work item workers."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["max_cycles", "pass_threshold", "criteria"], diagnostics);

  const max_cycles = readBoundedInteger(record.max_cycles, `${path}.max_cycles`, diagnostics, {
    minimum: 1,
    maximum: 5
  }) ?? 3;
  const pass_threshold = readBoundedNumber(record.pass_threshold, `${path}.pass_threshold`, diagnostics, {
    minimum: 0,
    maximum: 1
  }) ?? 0.85;

  if (!Array.isArray(record.criteria)) {
    diagnostics.push({
      path: `${path}.criteria`,
      message: "pattern_work_list.item_worker.completion.criteria must be an array."
    });
    return undefined;
  }

  if (record.criteria.length === 0) {
    diagnostics.push({
      path: `${path}.criteria`,
      message: "pattern_work_list deep_work item workers require at least one completion criterion."
    });
  }

  const criteria = record.criteria
    .map((criterion, index) => normalizeWorkListCompletionCriterion(
      criterion,
      `${path}.criteria[${index}]`,
      diagnostics
    ))
    .filter((criterion): criterion is PatternWorkListCompletionCriterion => criterion !== undefined);

  const seenIds = new Set<string>();
  criteria.forEach((criterion, index) => {
    if (seenIds.has(criterion.id)) {
      diagnostics.push({
        path: `${path}.criteria[${index}].id`,
        message: `Duplicate completion criterion id "${criterion.id}".`
      });
    }
    seenIds.add(criterion.id);
  });

  const weightTotal = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (criteria.length > 0 && Math.abs(weightTotal - 1) > 0.001) {
    diagnostics.push({
      path: `${path}.criteria`,
      message: `Completion criterion weights must sum to 1. Current total is ${Number(weightTotal.toFixed(4))}.`
    });
  }

  if (criteria.length === 0) {
    return undefined;
  }

  return {
    max_cycles,
    pass_threshold,
    criteria
  };
}

function normalizePatternWorkListItemGuidance(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternWorkListItemGuidance | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_work_list.work_list.item_guidance must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["what_counts_as_one_item", "done_when"], diagnostics);

  const what_counts_as_one_item = readRequiredString(
    record.what_counts_as_one_item,
    `${path}.what_counts_as_one_item`,
    diagnostics
  );
  const done_when = readStringArray(record.done_when, `${path}.done_when`, diagnostics);

  if (!done_when || done_when.length === 0) {
    diagnostics.push({
      path: `${path}.done_when`,
      message: "pattern_work_list.work_list.item_guidance.done_when must include at least one item."
    });
  }

  if (!what_counts_as_one_item || !done_when || done_when.length === 0) {
    return undefined;
  }

  return {
    what_counts_as_one_item,
    done_when
  };
}

function normalizePatternWorkListItemWorker(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternWorkListItemWorker | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_work_list.work_list.item_worker must be an object."
    });
    return undefined;
  }

  const kind = readEnumValue(
    record.kind,
    `${path}.kind`,
    ["agent", "deep_work"] as const,
    diagnostics,
    { required: true }
  );

  if (kind === "agent") {
    pushUnknownKeyDiagnostics(record, path, ["kind"], diagnostics);
    return { kind };
  }

  if (kind === "deep_work") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "completion"], diagnostics);
    const completion = normalizeWorkListDeepWorkCompletion(
      record.completion,
      `${path}.completion`,
      diagnostics
    );

    if (!completion) {
      return undefined;
    }

    return {
      kind,
      completion
    };
  }

  return undefined;
}

function normalizePatternWorkListBlock(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternWorkListBlock | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_work_list.work_list must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["planning_goal", "item_guidance", "item_worker"], diagnostics);

  const planning_goal = readRequiredString(record.planning_goal, `${path}.planning_goal`, diagnostics);
  const item_guidance = normalizePatternWorkListItemGuidance(
    record.item_guidance,
    `${path}.item_guidance`,
    diagnostics
  );
  const item_worker = normalizePatternWorkListItemWorker(
    record.item_worker,
    `${path}.item_worker`,
    diagnostics
  );

  if (!planning_goal || !item_guidance || !item_worker) {
    return undefined;
  }

  return {
    planning_goal,
    item_guidance,
    item_worker
  };
}

function normalizePatternWorkListNode(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[],
  loweredManagedNodes: LoweredManagedNode[]
): SequenceNode | undefined {
  pushUnknownKeyDiagnostics(
    record,
    path,
    [
      "type",
      "id",
      "label",
      "runtime",
      "intent",
      "support",
      "artifacts",
      "model",
      "reasoning_effort",
      "sandbox",
      "artifact_repair",
      "work_list"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics, {
    runtime_extra_keys: ["max_concurrency"]
  });
  const agentOptions = normalizeManagedAgentOptions(record, path, diagnostics);
  const work_list = normalizePatternWorkListBlock(
    record.work_list,
    `${path}.work_list`,
    diagnostics
  );
  const runtime = normalizeManagedRuntime(record.runtime, `${path}.runtime`, diagnostics);

  if (!base || !work_list) {
    return undefined;
  }

  loweredManagedNodes.push({
    authored_id: base.id,
    managed_kind: "pattern_work_list",
    lowered_to: "sequence"
  });

  return buildPatternWorkList({
    ...base,
    ...agentOptions,
    work_list,
    runtime
  });
}

export function normalizeGraphNode(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[],
  loweredManagedNodes: LoweredManagedNode[]
): AuthoredGraphNode | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "Node must be an object."
    });
    return undefined;
  }

  const type = readRequiredString(record.type, `${path}.type`, diagnostics);

  if (!type) {
    return undefined;
  }

  if (type === "agent") {
    return normalizeAgentNode(record, path, diagnostics);
  }

  if (type === "exec") {
    return normalizeExecNode(record, path, diagnostics);
  }

  if (type === "check") {
    return normalizeCheckNode(record, path, diagnostics);
  }

  if (type === "checkpoint") {
    return normalizeCheckpointNode(record, path, diagnostics);
  }

  if (type === "sequence") {
    return normalizeSequenceNode(record, path, diagnostics, loweredManagedNodes);
  }

  if (type === "parallel") {
    return normalizeParallelNode(record, path, diagnostics, loweredManagedNodes);
  }

  if (type === "repeat") {
    return normalizeRepeatNode(record, path, diagnostics, loweredManagedNodes);
  }

  if (type === "pattern_deep_research") {
    return normalizePatternDeepResearchNode(record, path, diagnostics, loweredManagedNodes);
  }

  if (type === "pattern_deep_work") {
    return normalizePatternDeepWorkNode(record, path, diagnostics, loweredManagedNodes);
  }

  if (type === "pattern_work_list") {
    return normalizePatternWorkListNode(record, path, diagnostics, loweredManagedNodes);
  }

  diagnostics.push({
    path: `${path}.type`,
    message: `Node type must be one of: ${[...authoredNodeKinds, ...managedPatternKinds].join(", ")}.`
  });
  return undefined;
}

export function normalizeAuthoredGraphDocument(value: unknown): NormalizedGraphDocument {
  const diagnostics: GraphDiagnostic[] = [];
  const lowered_managed_nodes: LoweredManagedNode[] = [];
  const documentRecord = asRecord(value);

  if (!documentRecord) {
    return {
      diagnostics: [
        {
          path: "$",
          message: "Graph document must be a JSON object."
        }
      ],
      lowered_managed_nodes
    };
  }

  pushUnknownKeyDiagnostics(
    documentRecord,
    "$",
    [
      "version",
      "graph_id",
      "intent",
      "supervision",
      "repos",
      "defaults",
      "profiles",
      "config",
      "config_schema",
      "skill_sources",
      "capabilities",
      "tools",
      "graph"
    ],
    diagnostics
  );

  const version = readRequiredString(documentRecord.version, "$.version", diagnostics);
  if (version && version !== graphVersion) {
    diagnostics.push({
      path: "$.version",
      message: `Graph version must be "${graphVersion}".`
    });
  }

  const graph_id = readRequiredString(documentRecord.graph_id, "$.graph_id", diagnostics);
  const intent = normalizeGraphIntent(documentRecord.intent, "$.intent", diagnostics);
  const supervision = normalizeSupervisionPolicy(documentRecord.supervision, "$.supervision", diagnostics);
  const defaults = normalizeGraphDefaults(documentRecord.defaults, "$.defaults", diagnostics);

  const repos: Record<string, RepoDefinition> = {};
  if (documentRecord.repos === undefined) {
    repos.main = { path: "." };
  } else {
    const reposRecord = asRecord(documentRecord.repos);
    if (!reposRecord || Object.keys(reposRecord).length === 0) {
      diagnostics.push({
        path: "$.repos",
        message: "At least one repo must be declared, or omit the field to default to { main: { path: \".\" } }."
      });
    } else {
      Object.entries(reposRecord).forEach(([repoAlias, repoValue]) => {
        const repo = normalizeRepoDefinition(repoValue, `$.repos.${repoAlias}`, diagnostics);
        if (repo) {
          repos[repoAlias] = repo;
        }
      });
    }
  }

  const profilesRecord = asRecord(documentRecord.profiles);
  const profiles: Record<string, GraphProfile> = {};
  if (profilesRecord) {
    Object.entries(profilesRecord).forEach(([profileName, profileValue]) => {
      const profile = normalizeGraphProfile(profileValue, `$.profiles.${profileName}`, diagnostics);
      if (profile) {
        profiles[profileName] = profile;
      }
    });
  }

  const skill_sources = normalizeSkillSources(documentRecord.skill_sources, "$.skill_sources", diagnostics);

  if (defaults?.launch_profile && !(defaults.launch_profile in profiles)) {
    diagnostics.push({
      path: "$.defaults.launch_profile",
      message: `defaults.launch_profile references unknown profile "${defaults.launch_profile}".`
    });
  }

  if (supervision && !(supervision.profile in profiles)) {
    diagnostics.push({
      path: "$.supervision.profile",
      message: `supervision.profile references unknown profile "${supervision.profile}".`
    });
  }

  const effectiveDefaults: GraphDefaults = {
    workspace_backend: defaults?.workspace_backend ?? "inplace",
    ...(defaults?.launch_profile
      ? { launch_profile: defaults.launch_profile }
      : "default" in profiles
        ? { launch_profile: "default" }
        : {})
  };

  let config: Record<string, unknown> | undefined;
  if (documentRecord.config !== undefined) {
    const configRecord = asRecord(documentRecord.config);
    if (!configRecord) {
      diagnostics.push({
        path: "$.config",
        message: "config must be an object."
      });
    } else {
      config = configRecord;
    }
  }

  let config_schema: Record<string, unknown> | undefined;
  if (documentRecord.config_schema !== undefined) {
    const schemaRecord = asRecord(documentRecord.config_schema);
    if (!schemaRecord) {
      diagnostics.push({
        path: "$.config_schema",
        message: "config_schema must be an object."
      });
    } else {
      config_schema = schemaRecord;
    }
  }

  const capabilities = normalizeCapabilities(documentRecord.capabilities, "$.capabilities", diagnostics);
  const tools = normalizeManagedToolDefinitions(documentRecord.tools, "$.tools", diagnostics);

  const normalizedGraph = normalizeGraphNode(
    documentRecord.graph,
    "$.graph",
    diagnostics,
    lowered_managed_nodes
  );

  if (normalizedGraph && !["sequence", "parallel", "repeat"].includes(normalizedGraph.type)) {
    diagnostics.push({
      path: "$.graph.type",
      message: "Top-level graph must be a container node."
    });
  }

  if (normalizedGraph) {
    resolveArtifactContextRefs(normalizedGraph, "$.graph", diagnostics);
  }

  if (diagnostics.length > 0 || !graph_id || !intent || !supervision || !normalizedGraph || Object.keys(repos).length === 0) {
    return {
      diagnostics,
      lowered_managed_nodes
    };
  }

  const document: AuthoredGraphDocument = {
    version: graphVersion,
    graph_id,
    intent,
    supervision,
    repos,
    defaults: effectiveDefaults,
    ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
    ...(config ? { config } : {}),
    ...(config_schema ? { config_schema } : {}),
    ...(skill_sources && Object.keys(skill_sources).length > 0 ? { skill_sources } : {}),
    ...(capabilities && Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    ...(tools && Object.keys(tools).length > 0 ? { tools } : {}),
    graph: normalizedGraph as ContainerGraphNode
  };

  return {
    document,
    diagnostics,
    lowered_managed_nodes
  };
}

function collectExecutableNodeKinds(
  node: AuthoredGraphNode,
  kinds: Map<string, ExecutableGraphNode["type"]>
): void {
  if (node.type === "agent" || node.type === "exec" || node.type === "check" || node.type === "checkpoint") {
    kinds.set(node.id, node.type);
    return;
  }

  if (node.type === "sequence") {
    node.steps.forEach((child) => collectExecutableNodeKinds(child, kinds));
    (node.cleanup ?? []).forEach((child) => collectExecutableNodeKinds(child, kinds));
    return;
  }

  if (node.type === "parallel") {
    node.steps.forEach((child) => collectExecutableNodeKinds(child, kinds));
    return;
  }

  collectExecutableNodeKinds(node.body, kinds);
}

function resolveArtifactContextRefs(
  rootNode: AuthoredGraphNode,
  rootPath: string,
  diagnostics: GraphDiagnostic[]
): void {
  const kinds = new Map<string, ExecutableGraphNode["type"]>();
  collectExecutableNodeKinds(rootNode, kinds);

  const visit = (node: AuthoredGraphNode, path: string): void => {
    if (node.type === "agent" || node.type === "exec" || node.type === "check" || node.type === "checkpoint") {
      const items = node.support?.context;

      if (!items) {
        return;
      }

      const nameCounts = new Map<string, number>();
      items.forEach((item) => {
        nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
      });

      items.forEach((item, index) => {
        const itemPath = `${path}.support.context[${index}]`;
        if (!("ref" in item)) {
          return;
        }

        if (item.artifact === "") {
          const targetKind = kinds.get(item.node);

          if (!targetKind) {
            diagnostics.push({
              path: `${itemPath}.ref`,
              message: `ref "${item.ref}" references unknown node "${item.node}".`
            });
            return;
          }

          item.artifact = canonicalNodeArtifacts[targetKind];
        }
      });

      nameCounts.forEach((count, name) => {
        if (count > 1) {
          diagnostics.push({
            path: `${path}.support.context`,
            message: `Duplicate context item name "${name}". Each context item in a node must have a unique name; provide an explicit "name" field to disambiguate.`
          });
        }
      });

      return;
    }

    if (node.type === "sequence") {
      node.steps.forEach((child, index) => visit(child, `${path}.steps[${index}]`));
      (node.cleanup ?? []).forEach((child, index) => visit(child, `${path}.cleanup[${index}]`));
      return;
    }

    if (node.type === "parallel") {
      node.steps.forEach((child, index) => visit(child, `${path}.steps[${index}]`));
      return;
    }

    visit(node.body, `${path}.body`);
  };

  visit(rootNode, rootPath);
}
