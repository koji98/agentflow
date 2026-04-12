import type {
  AgentNode,
  AiCheckDefaults,
  AuthoredGraphDocument,
  AuthoredGraphNode,
  BaseExecutableNode,
  CommandPrerequisite,
  CheckNode,
  CheckpointNode,
  ContainerGraphNode,
  ContextReference,
  DeterministicCheckDefaults,
  DeterministicPassIf,
  EnvPrerequisite,
  ExecNode,
  FileInput,
  FilePrerequisite,
  GraphPrerequisiteCheck,
  GraphPrerequisites,
  GlobInput,
  GraphDefaults,
  GraphProfile,
  InputItem,
  InputRules,
  OutputDefinition,
  ParallelNode,
  RepeatNode,
  RepoPrerequisite,
  RepoDefinition,
  SequenceNode,
  TextInput
} from "./authored.js";
import {
  authoredNodeKinds,
  checkKinds,
  contextIncludes,
  contextSelectors,
  failureBehaviors,
  graphVersion,
  harnessNames,
  managedPatternKinds,
  outputSourceKinds,
  prerequisiteKinds,
  reasoningEfforts,
  sandboxModes,
  workspaceBackends
} from "./schema.js";
import type {
  ContextSelector,
  GraphDiagnostic,
  LoweredManagedKind
} from "./schema.js";
import {
  buildPatternDeepResearch,
  type PatternDeepResearchApprovalPolicy,
  type PatternDeepResearchBrief,
  type PatternDeepResearchContextPolicy,
  type PatternDeepResearchDelivery,
  type PatternDeepResearchStrategy
} from "../managed/pattern_deep_research.js";
import {
  buildPatternSpecDesign,
  type PatternSpecDesignApprovalPolicy,
  type PatternSpecDesignBrief,
  type PatternSpecDesignContextPolicy,
  type PatternSpecDesignDelivery,
  type PatternSpecDesignScope,
  type PatternSpecDesignStrategy
} from "../managed/pattern_spec_design.js";
import {
  buildPatternGenerateEvaluateFix,
  type PatternGenerateEvaluateFixArtifactBundleSource,
  type PatternGenerateEvaluateFixBrief,
  type PatternGenerateEvaluateFixContextPolicy,
  type PatternGenerateEvaluateFixEvaluation,
  type PatternGenerateEvaluateFixManagedNodeSource,
  type PatternGenerateEvaluateFixScope,
  type PatternGenerateEvaluateFixSourceRef,
  type PatternGenerateEvaluateFixStrategy,
  type PatternGenerateEvaluateFixTaskSource
} from "../managed/pattern_generate_evaluate_fix.js";
import {
  buildPatternReviewChange,
  type PatternReviewChangeArtifactBundleSource,
  type PatternReviewChangeBrief,
  type PatternReviewChangeContextPolicy,
  type PatternReviewChangeDelivery,
  type PatternReviewChangeManagedNodeSource,
  type PatternReviewChangeScope,
  type PatternReviewChangeSource,
  type PatternReviewChangeSourceRef,
  type PatternReviewChangeStrategy
} from "../managed/pattern_review_change.js";
import type { ManagedPatternRuntime } from "../managed/foundation.js";

export interface LoweredManagedNode {
  authored_id: string;
  managed_kind: LoweredManagedKind;
  lowered_to: "agent" | "sequence";
}

export interface NormalizedGraphDocument {
  document?: AuthoredGraphDocument;
  diagnostics: GraphDiagnostic[];
  lowered_managed_nodes: LoweredManagedNode[];
}

const checkpointOperatorFeedbackOutput: OutputDefinition = {
  name: "operator_feedback",
  from: "attempt",
  path: "operator-feedback.md",
  required: false
};

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

function normalizeInputRules(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): InputRules | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "input_rules must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["max_total_bytes", "max_bytes_per_item"],
    diagnostics
  );

  if (record.max_files !== undefined) {
    diagnostics.push({
      path: `${path}.max_files`,
      message:
        "input_rules.max_files is no longer supported. Use input_rules.max_total_bytes for global context budgets and glob.max_files to cap specific globs."
    });
  }

  const max_total_bytes = readPositiveInteger(
    record.max_total_bytes,
    `${path}.max_total_bytes`,
    diagnostics
  );
  const max_bytes_per_item = readPositiveInteger(
    record.max_bytes_per_item,
    `${path}.max_bytes_per_item`,
    diagnostics
  );

  return {
    ...(max_total_bytes !== undefined ? { max_total_bytes } : {}),
    ...(max_bytes_per_item !== undefined ? { max_bytes_per_item } : {})
  };
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
      "timeout_sec",
      "input_rules",
      "deterministic_check_defaults",
      "ai_check_defaults"
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
  const timeout_sec = readPositiveInteger(record.timeout_sec, `${path}.timeout_sec`, diagnostics);
  const input_rules = normalizeInputRules(record.input_rules, `${path}.input_rules`, diagnostics);
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

  return {
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    ...(reasoning_effort ? { reasoning_effort } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(skip_git_repo_check !== undefined ? { skip_git_repo_check } : {}),
    ...(env_files !== undefined ? { env_files } : {}),
    ...(timeout_sec !== undefined ? { timeout_sec } : {}),
    ...(input_rules ? { input_rules } : {}),
    ...(deterministic_check_defaults ? { deterministic_check_defaults } : {}),
    ...(ai_check_defaults ? { ai_check_defaults } : {})
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

function normalizeInputItem(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): InputItem | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "Input item must be an object."
    });
    return undefined;
  }

  const kind = readRequiredString(record.kind, `${path}.kind`, diagnostics);

  if (!kind) {
    return undefined;
  }

  if (kind === "file") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "path"], diagnostics);
    const itemPath = readRequiredString(record.path, `${path}.path`, diagnostics);
    return itemPath ? ({ kind, path: itemPath } satisfies FileInput) : undefined;
  }

  if (kind === "glob") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "path", "max_files"], diagnostics);
    const itemPath = readRequiredString(record.path, `${path}.path`, diagnostics);
    const max_files = readPositiveInteger(record.max_files, `${path}.max_files`, diagnostics);

    if (!itemPath) {
      return undefined;
    }

    return {
      kind,
      path: itemPath,
      ...(max_files !== undefined ? { max_files } : {})
    } satisfies GlobInput;
  }

  if (kind === "text") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "name", "text"], diagnostics);
    const name = readRequiredString(record.name, `${path}.name`, diagnostics);
    const text = readRequiredString(record.text, `${path}.text`, diagnostics);

    if (!name || !text) {
      return undefined;
    }

    return {
      kind,
      name,
      text
    } satisfies TextInput;
  }

  diagnostics.push({
    path: `${path}.kind`,
    message: "inputs.kind must be file, glob, or text."
  });
  return undefined;
}

function normalizeInputs(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): InputItem[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    diagnostics.push({
      path,
      message: "inputs must be an array."
    });
    return undefined;
  }

  const items = value
    .map((item, index) => normalizeInputItem(item, `${path}[${index}]`, diagnostics))
    .filter((item): item is InputItem => item !== undefined);

  return items;
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

function normalizeContextReference(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ContextReference | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "context_from item must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["node", "include", "output", "iteration", "attempt", "optional"],
    diagnostics
  );

  const node = readRequiredString(record.node, `${path}.node`, diagnostics);
  const include = readEnumValue(record.include, `${path}.include`, contextIncludes, diagnostics, {
    required: true
  });
  const output = readOptionalString(record.output, `${path}.output`, diagnostics);
  const iteration = normalizeSelector(record.iteration, `${path}.iteration`, diagnostics);
  const attempt = normalizeSelector(record.attempt, `${path}.attempt`, diagnostics);
  const optional = readBoolean(record.optional, `${path}.optional`, diagnostics);

  if (!node || !include) {
    return undefined;
  }

  if (include === "output" && !output) {
    diagnostics.push({
      path: `${path}.output`,
      message: "context_from.output is required when include = output."
    });
  }

  return {
    node,
    include,
    ...(output ? { output } : {}),
    ...(iteration !== undefined ? { iteration } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(optional !== undefined ? { optional } : {})
  };
}

function normalizeContextReferences(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ContextReference[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    diagnostics.push({
      path,
      message: "context_from must be an array."
    });
    return undefined;
  }

  const references = value
    .map((item, index) => normalizeContextReference(item, `${path}[${index}]`, diagnostics))
    .filter((item): item is ContextReference => item !== undefined);

  return references;
}

function normalizeOutputDefinition(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): OutputDefinition | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "outputs item must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["name", "from", "path", "required"], diagnostics);

  const name = readRequiredString(record.name, `${path}.name`, diagnostics);
  const from = readEnumValue(record.from, `${path}.from`, outputSourceKinds, diagnostics, {
    required: true
  });
  const outputPath = readRequiredString(record.path, `${path}.path`, diagnostics);
  const required = readBoolean(record.required, `${path}.required`, diagnostics);

  if (!name || !from || !outputPath) {
    return undefined;
  }

  return {
    name,
    from,
    path: outputPath,
    ...(required !== undefined ? { required } : {})
  };
}

function normalizeOutputs(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): OutputDefinition[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    diagnostics.push({
      path,
      message: "outputs must be an array."
    });
    return undefined;
  }

  const outputs = value
    .map((item, index) => normalizeOutputDefinition(item, `${path}[${index}]`, diagnostics))
    .filter((item): item is OutputDefinition => item !== undefined);

  return outputs;
}

function normalizeGraphPrerequisiteCheck(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): GraphPrerequisiteCheck | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "Prerequisite check must be an object."
    });
    return undefined;
  }

  const kind = readEnumValue(record.kind, `${path}.kind`, prerequisiteKinds, diagnostics, {
    required: true
  });
  const required = readBoolean(record.required, `${path}.required`, diagnostics);

  if (!kind) {
    return undefined;
  }

  if (kind === "file") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "path", "required"], diagnostics);
    const prerequisitePath = readRequiredString(record.path, `${path}.path`, diagnostics);

    return prerequisitePath
      ? {
          kind,
          path: prerequisitePath,
          ...(required !== undefined ? { required } : {})
        } satisfies FilePrerequisite
      : undefined;
  }

  if (kind === "command") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "command", "required"], diagnostics);
    const command = readRequiredString(record.command, `${path}.command`, diagnostics);

    return command
      ? {
          kind,
          command,
          ...(required !== undefined ? { required } : {})
        } satisfies CommandPrerequisite
      : undefined;
  }

  if (kind === "env") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "name", "required"], diagnostics);
    const name = readRequiredString(record.name, `${path}.name`, diagnostics);

    return name
      ? {
          kind,
          name,
          ...(required !== undefined ? { required } : {})
        } satisfies EnvPrerequisite
      : undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["kind", "repo", "required"], diagnostics);
  const repo = readRequiredString(record.repo, `${path}.repo`, diagnostics);

  return repo
    ? {
        kind,
        repo,
        ...(required !== undefined ? { required } : {})
      } satisfies RepoPrerequisite
    : undefined;
}

function normalizeGraphPrerequisites(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): GraphPrerequisites | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "prerequisites must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["checks"], diagnostics);

  if (!Array.isArray(record.checks)) {
    diagnostics.push({
      path: `${path}.checks`,
      message: "prerequisites.checks must be an array."
    });
    return undefined;
  }

  return {
    checks: record.checks
      .map((item, index) => normalizeGraphPrerequisiteCheck(item, `${path}.checks[${index}]`, diagnostics))
      .filter((item): item is GraphPrerequisiteCheck => item !== undefined)
  };
}

function normalizeExecutableBase(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[],
  options: {
    allow_outputs?: boolean;
  } = {}
): BaseExecutableNode | undefined {
  const allow_outputs = options.allow_outputs ?? true;
  const id = readRequiredString(record.id, `${path}.id`, diagnostics);
  const label = readOptionalString(record.label, `${path}.label`, diagnostics);
  const repo = readOptionalString(record.repo, `${path}.repo`, diagnostics);
  const profile = readOptionalString(record.profile, `${path}.profile`, diagnostics);
  const inputs = normalizeInputs(record.inputs, `${path}.inputs`, diagnostics);
  const context_from = normalizeContextReferences(
    record.context_from,
    `${path}.context_from`,
    diagnostics
  );
  const outputs = allow_outputs
    ? normalizeOutputs(record.outputs, `${path}.outputs`, diagnostics)
    : undefined;
  const timeout_sec = readPositiveInteger(record.timeout_sec, `${path}.timeout_sec`, diagnostics);

  if (!allow_outputs && record.outputs !== undefined) {
    diagnostics.push({
      path: `${path}.outputs`,
      message: 'Field "outputs" does not apply to checkpoint nodes.'
    });
  }

  if (!id) {
    return undefined;
  }

  return {
    id,
    ...(label ? { label } : {}),
    ...(repo ? { repo } : {}),
    ...(profile ? { profile } : {}),
    ...(inputs ? { inputs } : {}),
    ...(context_from ? { context_from } : {}),
    ...(outputs ? { outputs } : {}),
    ...(timeout_sec !== undefined ? { timeout_sec } : {})
  };
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
      "repo",
      "profile",
      "inputs",
      "context_from",
      "outputs",
      "timeout_sec",
      "prompt",
      "model",
      "reasoning_effort",
      "sandbox"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const prompt = readRequiredString(record.prompt, `${path}.prompt`, diagnostics);
  const model = readOptionalString(record.model, `${path}.model`, diagnostics);
  const reasoning_effort = readEnumValue(
    record.reasoning_effort,
    `${path}.reasoning_effort`,
    reasoningEfforts,
    diagnostics
  );
  const sandbox = readEnumValue(record.sandbox, `${path}.sandbox`, sandboxModes, diagnostics);

  if (!base || !prompt) {
    return undefined;
  }

  return {
    type: "agent",
    ...base,
    prompt,
    ...(model ? { model } : {}),
    ...(reasoning_effort ? { reasoning_effort } : {}),
    ...(sandbox ? { sandbox } : {})
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
      "repo",
      "profile",
      "inputs",
      "context_from",
      "outputs",
      "timeout_sec",
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
      "repo",
      "profile",
      "inputs",
      "context_from",
      "outputs",
      "timeout_sec",
      "check_kind",
      "command",
      "args",
      "cwd",
      "env_files",
      "env",
      "pass_if",
      "prompt",
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
  const prompt = readOptionalString(record.prompt, `${path}.prompt`, diagnostics);
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
    for (const field of ["prompt", "rubric", "model", "reasoning_effort"] as const) {
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

  if (check_kind === "ai" && !prompt) {
    diagnostics.push({
      path: `${path}.prompt`,
      message: "AI checks require prompt."
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
    ...(check_kind === "ai" && prompt ? { prompt } : {}),
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
      "repo",
      "profile",
      "inputs",
      "context_from",
      "outputs",
      "timeout_sec",
      "prompt",
      "review_from"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics, {
    allow_outputs: false
  });
  const prompt = readRequiredString(record.prompt, `${path}.prompt`, diagnostics);
  const review_from = normalizeContextReference(
    record.review_from,
    `${path}.review_from`,
    diagnostics
  );

  if (!base || !prompt || !review_from) {
    return undefined;
  }

  return {
    type: "checkpoint",
    ...base,
    outputs: [...(base.outputs ?? []), checkpointOperatorFeedbackOutput],
    prompt,
    review_from
  };
}

function normalizeSequenceNode(
  record: Record<string, unknown>,
  path: string,
  diagnostics: GraphDiagnostic[],
  loweredManagedNodes: LoweredManagedNode[]
): SequenceNode | undefined {
  pushUnknownKeyDiagnostics(record, path, ["type", "id", "label", "steps"], diagnostics);

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

  if (!id) {
    return undefined;
  }

  return {
    type: "sequence",
    id,
    ...(label ? { label } : {}),
    steps
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

  pushUnknownKeyDiagnostics(record, path, ["max_concurrency"], diagnostics);

  const max_concurrency = readPositiveInteger(record.max_concurrency, `${path}.max_concurrency`, diagnostics);

  return {
    ...(max_concurrency !== undefined ? { max_concurrency } : {})
  };
}

function normalizePatternDeepResearchBrief(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternDeepResearchBrief | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_deep_research.brief must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(record, path, ["question", "objective", "audience", "scope_cues", "success_bar"], diagnostics);

  const question = readRequiredString(record.question, `${path}.question`, diagnostics);
  const objective = readRequiredString(record.objective, `${path}.objective`, diagnostics);
  const audience = readOptionalString(record.audience, `${path}.audience`, diagnostics);
  const scope_cues = readStringArray(record.scope_cues, `${path}.scope_cues`, diagnostics);
  const success_bar = readStringArray(record.success_bar, `${path}.success_bar`, diagnostics);

  if (!question || !objective) {
    return undefined;
  }

  return {
    question,
    objective,
    ...(audience ? { audience } : {}),
    ...(scope_cues && scope_cues.length > 0 ? { scope_cues } : {}),
    ...(success_bar && success_bar.length > 0 ? { success_bar } : {})
  };
}

function normalizePatternDeepResearchContextPolicy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternDeepResearchContextPolicy {
  if (value === undefined) {
    return {
      web: true,
      files: true,
      apps: false
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_deep_research.context_policy must be an object."
    });
    return {
      web: true,
      files: true,
      apps: false
    };
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["web", "files", "apps", "allow_domains", "deny_domains", "preferred_sources"],
    diagnostics
  );

  const web = readBoolean(record.web, `${path}.web`, diagnostics);
  const files = readBoolean(record.files, `${path}.files`, diagnostics);
  const apps = readBoolean(record.apps, `${path}.apps`, diagnostics);
  const allow_domains = readStringArray(record.allow_domains, `${path}.allow_domains`, diagnostics);
  const deny_domains = readStringArray(record.deny_domains, `${path}.deny_domains`, diagnostics);
  const preferred_sources = readStringArray(record.preferred_sources, `${path}.preferred_sources`, diagnostics);

  return {
    ...(web !== undefined ? { web } : { web: true }),
    ...(files !== undefined ? { files } : { files: true }),
    ...(apps !== undefined ? { apps } : { apps: false }),
    ...(allow_domains && allow_domains.length > 0 ? { allow_domains } : {}),
    ...(deny_domains && deny_domains.length > 0 ? { deny_domains } : {}),
    ...(preferred_sources && preferred_sources.length > 0 ? { preferred_sources } : {})
  };
}

function normalizePatternDeepResearchApprovalPolicy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternDeepResearchApprovalPolicy {
  if (value === undefined) {
    return {
      require_plan_approval: false
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_deep_research.approval_policy must be an object."
    });
    return {
      require_plan_approval: false
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["require_plan_approval"], diagnostics);

  return {
    require_plan_approval:
      readBoolean(record.require_plan_approval, `${path}.require_plan_approval`, diagnostics) ?? false
  };
}

function normalizePatternDeepResearchStrategy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternDeepResearchStrategy {
  if (value === undefined) {
    return {
      depth: "standard",
      coverage_mode: "balanced",
      followup_passes: 1,
      final_critique: false
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_deep_research.strategy must be an object."
    });
    return {
      depth: "standard",
      coverage_mode: "balanced",
      followup_passes: 1,
      final_critique: false
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["depth", "coverage_mode", "followup_passes", "final_critique"], diagnostics);

  return {
    depth: readEnumValue(record.depth, `${path}.depth`, ["shallow", "standard", "deep"] as const, diagnostics) ?? "standard",
    coverage_mode:
      readEnumValue(
        record.coverage_mode,
        `${path}.coverage_mode`,
        ["breadth", "balanced", "depth_first"] as const,
        diagnostics
      ) ?? "balanced",
    followup_passes: readPositiveInteger(record.followup_passes, `${path}.followup_passes`, diagnostics, { minimum: 0 }) ?? 1,
    final_critique: readBoolean(record.final_critique, `${path}.final_critique`, diagnostics) ?? false
  };
}

function normalizePatternDeepResearchDelivery(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternDeepResearchDelivery {
  if (value === undefined) {
    return {
      format: "report",
      citation_style: "inline"
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_deep_research.delivery must be an object."
    });
    return {
      format: "report",
      citation_style: "inline"
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["format", "citation_style", "sections"], diagnostics);

  const format = readOptionalString(record.format, `${path}.format`, diagnostics);
  const citation_style = readOptionalString(record.citation_style, `${path}.citation_style`, diagnostics);
  const sections = readStringArray(record.sections, `${path}.sections`, diagnostics);

  return {
    ...(format ? { format } : { format: "report" }),
    ...(citation_style ? { citation_style } : { citation_style: "inline" }),
    ...(sections && sections.length > 0 ? { sections } : {})
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
      "repo",
      "profile",
      "inputs",
      "context_from",
      "outputs",
      "timeout_sec",
      "brief",
      "context_policy",
      "approval_policy",
      "strategy",
      "delivery",
      "runtime"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const brief = normalizePatternDeepResearchBrief(record.brief, `${path}.brief`, diagnostics);
  const context_policy = normalizePatternDeepResearchContextPolicy(record.context_policy, `${path}.context_policy`, diagnostics);
  const approval_policy = normalizePatternDeepResearchApprovalPolicy(record.approval_policy, `${path}.approval_policy`, diagnostics);
  const strategy = normalizePatternDeepResearchStrategy(record.strategy, `${path}.strategy`, diagnostics);
  const delivery = normalizePatternDeepResearchDelivery(record.delivery, `${path}.delivery`, diagnostics);
  const runtime = normalizeManagedRuntime(record.runtime, `${path}.runtime`, diagnostics);

  if (!base || !brief) {
    return undefined;
  }

  loweredManagedNodes.push({
    authored_id: base.id,
    managed_kind: "pattern_deep_research",
    lowered_to: "sequence"
  });

  return buildPatternDeepResearch({
    ...base,
    brief,
    context_policy,
    approval_policy,
    strategy,
    delivery,
    runtime
  });
}

function normalizePatternSpecDesignScope(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternSpecDesignScope {
  if (value === undefined) {
    return {};
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_spec_design.scope must be an object."
    });
    return {};
  }

  pushUnknownKeyDiagnostics(record, path, ["paths", "areas"], diagnostics);

  const paths = readStringArray(record.paths, `${path}.paths`, diagnostics);
  const areas = readStringArray(record.areas, `${path}.areas`, diagnostics);

  return {
    ...(paths && paths.length > 0 ? { paths } : {}),
    ...(areas && areas.length > 0 ? { areas } : {})
  };
}

function normalizePatternSpecDesignBrief(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternSpecDesignBrief | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_spec_design.brief must be an object."
    });
    return undefined;
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["problem", "goal", "audience", "constraints", "decision_drivers", "scope"],
    diagnostics
  );

  const problem = readRequiredString(record.problem, `${path}.problem`, diagnostics);
  const goal = readRequiredString(record.goal, `${path}.goal`, diagnostics);
  const audience = readOptionalString(record.audience, `${path}.audience`, diagnostics);
  const constraints = readStringArray(record.constraints, `${path}.constraints`, diagnostics);
  const decision_drivers = readStringArray(record.decision_drivers, `${path}.decision_drivers`, diagnostics);
  const scope = normalizePatternSpecDesignScope(record.scope, `${path}.scope`, diagnostics);

  if (!problem || !goal) {
    return undefined;
  }

  return {
    problem,
    goal,
    ...(audience ? { audience } : {}),
    ...(constraints && constraints.length > 0 ? { constraints } : {}),
    ...(decision_drivers && decision_drivers.length > 0 ? { decision_drivers } : {}),
    ...(scope.paths || scope.areas ? { scope } : {})
  };
}

function normalizePatternSpecDesignContextPolicy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternSpecDesignContextPolicy {
  if (value === undefined) {
    return {
      repo_first: true,
      allow_web_fallback: true
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_spec_design.context_policy must be an object."
    });
    return {
      repo_first: true,
      allow_web_fallback: true
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["repo_first", "allow_web_fallback", "web_triggers", "allow_domains"], diagnostics);

  const repo_first = readBoolean(record.repo_first, `${path}.repo_first`, diagnostics);
  const allow_web_fallback = readBoolean(record.allow_web_fallback, `${path}.allow_web_fallback`, diagnostics);
  const web_triggers = readStringArray(record.web_triggers, `${path}.web_triggers`, diagnostics);
  const allow_domains = readStringArray(record.allow_domains, `${path}.allow_domains`, diagnostics);

  return {
    repo_first: repo_first ?? true,
    allow_web_fallback: allow_web_fallback ?? true,
    ...(web_triggers && web_triggers.length > 0 ? { web_triggers } : {}),
    ...(allow_domains && allow_domains.length > 0 ? { allow_domains } : {})
  };
}

function normalizePatternSpecDesignApprovalPolicy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternSpecDesignApprovalPolicy {
  if (value === undefined) {
    return {
      require_direction_approval: false
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_spec_design.approval_policy must be an object."
    });
    return {
      require_direction_approval: false
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["require_direction_approval"], diagnostics);

  return {
    require_direction_approval:
      readBoolean(record.require_direction_approval, `${path}.require_direction_approval`, diagnostics) ?? false
  };
}

function normalizePatternSpecDesignStrategy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternSpecDesignStrategy {
  if (value === undefined) {
    return {
      alternatives: 3,
      critique_profiles: ["architecture", "implementation", "ux"],
      max_revision_cycles: 2
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_spec_design.strategy must be an object."
    });
    return {
      alternatives: 3,
      critique_profiles: ["architecture", "implementation", "ux"],
      max_revision_cycles: 2
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["alternatives", "critique_profiles", "max_revision_cycles"], diagnostics);

  const alternatives = readPositiveInteger(record.alternatives, `${path}.alternatives`, diagnostics) ?? 3;
  const critique_profiles = readStringArray(record.critique_profiles, `${path}.critique_profiles`, diagnostics);
  const max_revision_cycles = readPositiveInteger(record.max_revision_cycles, `${path}.max_revision_cycles`, diagnostics) ?? 2;

  return {
    alternatives,
    critique_profiles:
      critique_profiles && critique_profiles.length > 0 ? critique_profiles : ["architecture", "implementation", "ux"],
    max_revision_cycles
  };
}

function normalizePatternSpecDesignDelivery(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternSpecDesignDelivery {
  if (value === undefined) {
    return {
      format: "design_spec"
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_spec_design.delivery must be an object."
    });
    return {
      format: "design_spec"
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["format", "sections"], diagnostics);

  const format = readOptionalString(record.format, `${path}.format`, diagnostics);
  const sections = readStringArray(record.sections, `${path}.sections`, diagnostics);

  return {
    ...(format ? { format } : { format: "design_spec" }),
    ...(sections && sections.length > 0 ? { sections } : {})
  };
}

function normalizePatternSpecDesignNode(
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
      "repo",
      "profile",
      "inputs",
      "context_from",
      "outputs",
      "timeout_sec",
      "brief",
      "context_policy",
      "approval_policy",
      "strategy",
      "delivery",
      "runtime"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const brief = normalizePatternSpecDesignBrief(record.brief, `${path}.brief`, diagnostics);
  const context_policy = normalizePatternSpecDesignContextPolicy(record.context_policy, `${path}.context_policy`, diagnostics);
  const approval_policy = normalizePatternSpecDesignApprovalPolicy(record.approval_policy, `${path}.approval_policy`, diagnostics);
  const strategy = normalizePatternSpecDesignStrategy(record.strategy, `${path}.strategy`, diagnostics);
  const delivery = normalizePatternSpecDesignDelivery(record.delivery, `${path}.delivery`, diagnostics);
  const runtime = normalizeManagedRuntime(record.runtime, `${path}.runtime`, diagnostics);

  if (!base || !brief) {
    return undefined;
  }

  loweredManagedNodes.push({
    authored_id: base.id,
    managed_kind: "pattern_spec_design",
    lowered_to: "sequence"
  });

  return buildPatternSpecDesign({
    ...base,
    brief,
    context_policy,
    approval_policy,
    strategy,
    delivery,
    runtime
  });
}

function normalizePatternGenerateEvaluateFixScope(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternGenerateEvaluateFixScope {
  if (value === undefined) {
    return {};
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_generate_evaluate_fix.scope must be an object."
    });
    return {};
  }

  pushUnknownKeyDiagnostics(record, path, ["paths", "areas"], diagnostics);

  const paths = readStringArray(record.paths, `${path}.paths`, diagnostics);
  const areas = readStringArray(record.areas, `${path}.areas`, diagnostics);

  return {
    ...(paths && paths.length > 0 ? { paths } : {}),
    ...(areas && areas.length > 0 ? { areas } : {})
  };
}

function normalizePatternGenerateEvaluateFixBrief(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternGenerateEvaluateFixBrief {
  if (value === undefined) {
    return {};
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_generate_evaluate_fix.brief must be an object."
    });
    return {};
  }

  pushUnknownKeyDiagnostics(record, path, ["objective", "scope"], diagnostics);

  const objective = readOptionalString(record.objective, `${path}.objective`, diagnostics);
  const scope = normalizePatternGenerateEvaluateFixScope(record.scope, `${path}.scope`, diagnostics);

  return {
    ...(objective ? { objective } : {}),
    ...(scope.paths || scope.areas ? { scope } : {})
  };
}

function normalizePatternGenerateEvaluateFixSourceRef(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternGenerateEvaluateFixSourceRef | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_generate_evaluate_fix task source reference must be an object."
    });
    return undefined;
  }

  const kind = readRequiredString(record.kind, `${path}.kind`, diagnostics);

  if (!kind) {
    return undefined;
  }

  if (kind === "file") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "path"], diagnostics);
    const filePath = readRequiredString(record.path, `${path}.path`, diagnostics);

    if (!filePath) {
      return undefined;
    }

    return {
      kind: "file",
      path: filePath
    };
  }

  if (kind === "managed_output") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "node", "output"], diagnostics);
    const node = readRequiredString(record.node, `${path}.node`, diagnostics);
    const output = readRequiredString(record.output, `${path}.output`, diagnostics);

    if (!node || !output) {
      return undefined;
    }

    return {
      kind: "managed_output",
      node,
      output
    };
  }

  diagnostics.push({
    path: `${path}.kind`,
    message: 'pattern_generate_evaluate_fix task source reference kind must be "file" or "managed_output".'
  });
  return undefined;
}

function normalizePatternGenerateEvaluateFixTaskSource(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternGenerateEvaluateFixTaskSource | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_generate_evaluate_fix.task_source must be an object."
    });
    return undefined;
  }

  const kind = readRequiredString(record.kind, `${path}.kind`, diagnostics);

  if (!kind) {
    return undefined;
  }

  if (kind === "managed_node") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "node"], diagnostics);
    const node = readRequiredString(record.node, `${path}.node`, diagnostics);

    if (!node) {
      return undefined;
    }

    return {
      kind: "managed_node",
      node
    } satisfies PatternGenerateEvaluateFixManagedNodeSource;
  }

  if (kind === "artifact_bundle") {
    pushUnknownKeyDiagnostics(
      record,
      path,
      [
        "kind",
        "design_packet",
        "design_spec",
        "direction_proposal",
        "tradeoff_matrix",
        "decision_log",
        "implementation_readiness",
        "additional_context"
      ],
      diagnostics
    );

    const design_packet = normalizePatternGenerateEvaluateFixSourceRef(
      record.design_packet,
      `${path}.design_packet`,
      diagnostics
    );
    const design_spec = record.design_spec
      ? normalizePatternGenerateEvaluateFixSourceRef(record.design_spec, `${path}.design_spec`, diagnostics)
      : undefined;
    const direction_proposal = record.direction_proposal
      ? normalizePatternGenerateEvaluateFixSourceRef(record.direction_proposal, `${path}.direction_proposal`, diagnostics)
      : undefined;
    const tradeoff_matrix = record.tradeoff_matrix
      ? normalizePatternGenerateEvaluateFixSourceRef(record.tradeoff_matrix, `${path}.tradeoff_matrix`, diagnostics)
      : undefined;
    const decision_log = record.decision_log
      ? normalizePatternGenerateEvaluateFixSourceRef(record.decision_log, `${path}.decision_log`, diagnostics)
      : undefined;
    const implementation_readiness = record.implementation_readiness
      ? normalizePatternGenerateEvaluateFixSourceRef(
          record.implementation_readiness,
          `${path}.implementation_readiness`,
          diagnostics
        )
      : undefined;
    const additional_context = Array.isArray(record.additional_context)
      ? record.additional_context
          .map((item, index) =>
            normalizePatternGenerateEvaluateFixSourceRef(item, `${path}.additional_context[${index}]`, diagnostics)
          )
          .filter((item): item is PatternGenerateEvaluateFixSourceRef => item !== undefined)
      : record.additional_context === undefined
        ? undefined
        : (() => {
            diagnostics.push({
              path: `${path}.additional_context`,
              message: "pattern_generate_evaluate_fix.task_source.additional_context must be an array."
            });
            return undefined;
          })();

    if (!design_packet) {
      return undefined;
    }

    return {
      kind: "artifact_bundle",
      design_packet,
      ...(design_spec ? { design_spec } : {}),
      ...(direction_proposal ? { direction_proposal } : {}),
      ...(tradeoff_matrix ? { tradeoff_matrix } : {}),
      ...(decision_log ? { decision_log } : {}),
      ...(implementation_readiness ? { implementation_readiness } : {}),
      ...(additional_context && additional_context.length > 0 ? { additional_context } : {})
    } satisfies PatternGenerateEvaluateFixArtifactBundleSource;
  }

  diagnostics.push({
    path: `${path}.kind`,
    message: 'pattern_generate_evaluate_fix.task_source.kind must be "managed_node" or "artifact_bundle".'
  });
  return undefined;
}

function normalizePatternGenerateEvaluateFixContextPolicy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternGenerateEvaluateFixContextPolicy {
  if (value === undefined) {
    return {
      allow_official_docs_fallback: true
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_generate_evaluate_fix.context_policy must be an object."
    });
    return {
      allow_official_docs_fallback: true
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["allow_official_docs_fallback", "allow_domains"], diagnostics);

  const allow_domains = readStringArray(record.allow_domains, `${path}.allow_domains`, diagnostics);

  return {
    allow_official_docs_fallback:
      readBoolean(
        record.allow_official_docs_fallback,
        `${path}.allow_official_docs_fallback`,
        diagnostics
      ) ?? true,
    ...(allow_domains && allow_domains.length > 0 ? { allow_domains } : {})
  };
}

function normalizePatternGenerateEvaluateFixStrategy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternGenerateEvaluateFixStrategy {
  if (value === undefined) {
    return {
      max_fix_cycles: 2
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_generate_evaluate_fix.strategy must be an object."
    });
    return {
      max_fix_cycles: 2
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["max_fix_cycles"], diagnostics);

  return {
    max_fix_cycles: readPositiveInteger(record.max_fix_cycles, `${path}.max_fix_cycles`, diagnostics) ?? 2
  };
}

function normalizePatternGenerateEvaluateFixEvaluation(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternGenerateEvaluateFixEvaluation {
  if (value === undefined) {
    return {
      commands: [],
      required: true
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_generate_evaluate_fix.evaluation must be an object."
    });
    return {
      commands: [],
      required: true
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["commands", "required"], diagnostics);
  const commands = readStringArray(record.commands, `${path}.commands`, diagnostics) ?? [];
  const required = readBoolean(record.required, `${path}.required`, diagnostics) ?? true;

  return {
    commands,
    required
  };
}

function normalizePatternGenerateEvaluateFixNode(
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
      "repo",
      "profile",
      "inputs",
      "context_from",
      "timeout_sec",
      "brief",
      "task_source",
      "context_policy",
      "strategy",
      "evaluation",
      "runtime"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const brief = normalizePatternGenerateEvaluateFixBrief(record.brief, `${path}.brief`, diagnostics);
  const task_source = normalizePatternGenerateEvaluateFixTaskSource(
    record.task_source,
    `${path}.task_source`,
    diagnostics
  );
  const context_policy = normalizePatternGenerateEvaluateFixContextPolicy(record.context_policy, `${path}.context_policy`, diagnostics);
  const strategy = normalizePatternGenerateEvaluateFixStrategy(record.strategy, `${path}.strategy`, diagnostics);
  const evaluation = normalizePatternGenerateEvaluateFixEvaluation(
    record.evaluation,
    `${path}.evaluation`,
    diagnostics
  );
  const runtime = normalizeManagedRuntime(record.runtime, `${path}.runtime`, diagnostics);

  if (evaluation.commands.length === 0) {
    diagnostics.push({
      path: `${path}.evaluation.commands`,
      message: "pattern_generate_evaluate_fix.evaluation.commands must include at least one command."
    });
  }

  if (!base || !task_source) {
    return undefined;
  }

  loweredManagedNodes.push({
    authored_id: base.id,
    managed_kind: "pattern_generate_evaluate_fix",
    lowered_to: "sequence"
  });

  return buildPatternGenerateEvaluateFix({
    ...base,
    brief,
    task_source,
    context_policy,
    strategy,
    evaluation,
    runtime
  });
}

function normalizePatternReviewChangeScope(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternReviewChangeScope {
  if (value === undefined) {
    return {};
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_review_change.scope must be an object."
    });
    return {};
  }

  pushUnknownKeyDiagnostics(record, path, ["paths", "areas"], diagnostics);

  const paths = readStringArray(record.paths, `${path}.paths`, diagnostics);
  const areas = readStringArray(record.areas, `${path}.areas`, diagnostics);

  return {
    ...(paths && paths.length > 0 ? { paths } : {}),
    ...(areas && areas.length > 0 ? { areas } : {})
  };
}

function normalizePatternReviewChangeBrief(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternReviewChangeBrief {
  if (value === undefined) {
    return {};
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_review_change.brief must be an object."
    });
    return {};
  }

  pushUnknownKeyDiagnostics(record, path, ["review_goal", "focus", "audience", "scope"], diagnostics);

  const review_goal = readOptionalString(record.review_goal, `${path}.review_goal`, diagnostics);
  const focus = readStringArray(record.focus, `${path}.focus`, diagnostics);
  const audience = readOptionalString(record.audience, `${path}.audience`, diagnostics);
  const scope = normalizePatternReviewChangeScope(record.scope, `${path}.scope`, diagnostics);

  return {
    ...(review_goal ? { review_goal } : {}),
    ...(focus && focus.length > 0 ? { focus } : {}),
    ...(audience ? { audience } : {}),
    ...(scope.paths || scope.areas ? { scope } : {})
  };
}

function normalizePatternReviewChangeSourceRef(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternReviewChangeSourceRef | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_review_change source reference must be an object."
    });
    return undefined;
  }

  const kind = readRequiredString(record.kind, `${path}.kind`, diagnostics);

  if (!kind) {
    return undefined;
  }

  if (kind === "file") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "path"], diagnostics);
    const filePath = readRequiredString(record.path, `${path}.path`, diagnostics);

    if (!filePath) {
      return undefined;
    }

    return {
      kind: "file",
      path: filePath
    };
  }

  if (kind === "managed_output") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "node", "output"], diagnostics);
    const node = readRequiredString(record.node, `${path}.node`, diagnostics);
    const output = readRequiredString(record.output, `${path}.output`, diagnostics);

    if (!node || !output) {
      return undefined;
    }

    return {
      kind: "managed_output",
      node,
      output
    };
  }

  diagnostics.push({
    path: `${path}.kind`,
    message: 'pattern_review_change source reference kind must be "file" or "managed_output".'
  });
  return undefined;
}

function normalizePatternReviewChangeSource(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternReviewChangeSource | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_review_change.review_source must be an object."
    });
    return undefined;
  }

  const kind = readRequiredString(record.kind, `${path}.kind`, diagnostics);

  if (!kind) {
    return undefined;
  }

  if (kind === "managed_node") {
    pushUnknownKeyDiagnostics(record, path, ["kind", "node"], diagnostics);
    const node = readRequiredString(record.node, `${path}.node`, diagnostics);

    if (!node) {
      return undefined;
    }

    return {
      kind: "managed_node",
      node
    } satisfies PatternReviewChangeManagedNodeSource;
  }

  if (kind === "artifact_bundle") {
    pushUnknownKeyDiagnostics(
      record,
      path,
      ["kind", "diff", "summary", "evaluation_ledger", "files_touched", "additional_context"],
      diagnostics
    );

    const diff = record.diff
      ? normalizePatternReviewChangeSourceRef(record.diff, `${path}.diff`, diagnostics)
      : undefined;
    const summary = record.summary
      ? normalizePatternReviewChangeSourceRef(record.summary, `${path}.summary`, diagnostics)
      : undefined;
    const evaluation_ledger = record.evaluation_ledger
      ? normalizePatternReviewChangeSourceRef(record.evaluation_ledger, `${path}.evaluation_ledger`, diagnostics)
      : undefined;
    const files_touched = record.files_touched
      ? normalizePatternReviewChangeSourceRef(record.files_touched, `${path}.files_touched`, diagnostics)
      : undefined;
    const additional_context = Array.isArray(record.additional_context)
      ? record.additional_context
          .map((item, index) =>
            normalizePatternReviewChangeSourceRef(item, `${path}.additional_context[${index}]`, diagnostics)
          )
          .filter((item): item is PatternReviewChangeSourceRef => item !== undefined)
      : record.additional_context === undefined
        ? undefined
        : (() => {
            diagnostics.push({
              path: `${path}.additional_context`,
              message: "pattern_review_change.review_source.additional_context must be an array."
            });
            return undefined;
          })();

    if (!diff && !summary && (!additional_context || additional_context.length === 0)) {
      diagnostics.push({
        path,
        message:
          "pattern_review_change.review_source artifact_bundle must include at least one of diff, summary, or additional_context."
      });
      return undefined;
    }

    return {
      kind: "artifact_bundle",
      ...(diff ? { diff } : {}),
      ...(summary ? { summary } : {}),
      ...(evaluation_ledger ? { evaluation_ledger } : {}),
      ...(files_touched ? { files_touched } : {}),
      ...(additional_context && additional_context.length > 0 ? { additional_context } : {})
    } satisfies PatternReviewChangeArtifactBundleSource;
  }

  diagnostics.push({
    path: `${path}.kind`,
    message: 'pattern_review_change.review_source.kind must be "managed_node" or "artifact_bundle".'
  });
  return undefined;
}

function normalizePatternReviewChangeContextPolicy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternReviewChangeContextPolicy {
  if (value === undefined) {
    return {
      include_surrounding_code: true,
      include_tests: true,
      include_docs: false,
      include_validation: true
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_review_change.context_policy must be an object."
    });
    return {
      include_surrounding_code: true,
      include_tests: true,
      include_docs: false,
      include_validation: true
    };
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["include_surrounding_code", "include_tests", "include_docs", "include_validation"],
    diagnostics
  );

  return {
    include_surrounding_code:
      readBoolean(record.include_surrounding_code, `${path}.include_surrounding_code`, diagnostics) ?? true,
    include_tests: readBoolean(record.include_tests, `${path}.include_tests`, diagnostics) ?? true,
    include_docs: readBoolean(record.include_docs, `${path}.include_docs`, diagnostics) ?? false,
    include_validation:
      readBoolean(record.include_validation, `${path}.include_validation`, diagnostics) ?? true
  };
}

function normalizePatternReviewChangeStrategy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternReviewChangeStrategy {
  if (value === undefined) {
    return {
      reviewer_profiles: ["correctness", "testing", "maintainability"],
      severity_policy: "balanced",
      include_surrounding_context: false,
      false_positive_challenge: true,
      require_file_references: true
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_review_change.strategy must be an object."
    });
    return {
      reviewer_profiles: ["correctness", "testing", "maintainability"],
      severity_policy: "balanced",
      include_surrounding_context: false,
      false_positive_challenge: true,
      require_file_references: true
    };
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    [
      "reviewer_profiles",
      "severity_policy",
      "include_surrounding_context",
      "false_positive_challenge",
      "require_file_references"
    ],
    diagnostics
  );

  const reviewer_profiles = readStringArray(record.reviewer_profiles, `${path}.reviewer_profiles`, diagnostics);
  const severity_policy =
    readEnumValue(record.severity_policy, `${path}.severity_policy`, ["balanced", "conservative", "strict"] as const, diagnostics) ??
    "balanced";

  return {
    reviewer_profiles:
      reviewer_profiles && reviewer_profiles.length > 0
        ? reviewer_profiles
        : ["correctness", "testing", "maintainability"],
    severity_policy,
    include_surrounding_context:
      readBoolean(record.include_surrounding_context, `${path}.include_surrounding_context`, diagnostics) ?? false,
    false_positive_challenge:
      readBoolean(record.false_positive_challenge, `${path}.false_positive_challenge`, diagnostics) ?? true,
    require_file_references:
      readBoolean(record.require_file_references, `${path}.require_file_references`, diagnostics) ?? true
  };
}

function normalizePatternReviewChangeDelivery(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): PatternReviewChangeDelivery {
  if (value === undefined) {
    return {
      format: "review_summary"
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "pattern_review_change.delivery must be an object."
    });
    return {
      format: "review_summary"
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["format", "sections"], diagnostics);
  const format = readOptionalString(record.format, `${path}.format`, diagnostics);
  const sections = readStringArray(record.sections, `${path}.sections`, diagnostics);

  return {
    ...(format ? { format } : { format: "review_summary" }),
    ...(sections && sections.length > 0 ? { sections } : {})
  };
}

function normalizePatternReviewChangeNode(
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
      "repo",
      "profile",
      "inputs",
      "context_from",
      "timeout_sec",
      "brief",
      "review_source",
      "context_policy",
      "strategy",
      "delivery",
      "runtime"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const brief = normalizePatternReviewChangeBrief(record.brief, `${path}.brief`, diagnostics);
  const review_source = normalizePatternReviewChangeSource(
    record.review_source,
    `${path}.review_source`,
    diagnostics
  );
  const context_policy = normalizePatternReviewChangeContextPolicy(
    record.context_policy,
    `${path}.context_policy`,
    diagnostics
  );
  const strategy = normalizePatternReviewChangeStrategy(record.strategy, `${path}.strategy`, diagnostics);
  const delivery = normalizePatternReviewChangeDelivery(record.delivery, `${path}.delivery`, diagnostics);
  const runtime = normalizeManagedRuntime(record.runtime, `${path}.runtime`, diagnostics);

  if (!base || !review_source) {
    return undefined;
  }

  loweredManagedNodes.push({
    authored_id: base.id,
    managed_kind: "pattern_review_change",
    lowered_to: "sequence"
  });

  return buildPatternReviewChange({
    ...base,
    brief,
    review_source,
    context_policy,
    strategy,
    delivery,
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

  if (type === "pattern_spec_design") {
    return normalizePatternSpecDesignNode(record, path, diagnostics, loweredManagedNodes);
  }

  if (type === "pattern_generate_evaluate_fix") {
    return normalizePatternGenerateEvaluateFixNode(record, path, diagnostics, loweredManagedNodes);
  }

  if (type === "pattern_review_change") {
    return normalizePatternReviewChangeNode(record, path, diagnostics, loweredManagedNodes);
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
    ["version", "graph_id", "repos", "defaults", "profiles", "prerequisites", "graph"],
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
  const defaults = normalizeGraphDefaults(documentRecord.defaults, "$.defaults", diagnostics);
  const prerequisites = normalizeGraphPrerequisites(
    documentRecord.prerequisites,
    "$.prerequisites",
    diagnostics
  );

  const reposRecord = asRecord(documentRecord.repos);
  const repos: Record<string, RepoDefinition> = {};
  if (!reposRecord || Object.keys(reposRecord).length === 0) {
    diagnostics.push({
      path: "$.repos",
      message: "At least one repo must be declared."
    });
  } else {
    Object.entries(reposRecord).forEach(([repoAlias, repoValue]) => {
      const repo = normalizeRepoDefinition(repoValue, `$.repos.${repoAlias}`, diagnostics);
      if (repo) {
        repos[repoAlias] = repo;
      }
    });
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

  if (defaults?.launch_profile && !(defaults.launch_profile in profiles)) {
    diagnostics.push({
      path: "$.defaults.launch_profile",
      message: `defaults.launch_profile references unknown profile "${defaults.launch_profile}".`
    });
  }

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

  if (diagnostics.length > 0 || !graph_id || !normalizedGraph || Object.keys(repos).length === 0) {
    return {
      diagnostics,
      lowered_managed_nodes
    };
  }

  const document: AuthoredGraphDocument = {
    version: graphVersion,
    graph_id,
    repos,
    ...(defaults ? { defaults } : {}),
    ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
    ...(prerequisites ? { prerequisites } : {}),
    graph: normalizedGraph as ContainerGraphNode
  };

  return {
    document,
    diagnostics,
    lowered_managed_nodes
  };
}
