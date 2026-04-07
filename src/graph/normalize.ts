import type {
  AgentNode,
  AiCheckDefaults,
  AuthoredGraphDocument,
  AuthoredGraphNode,
  BaseExecutableNode,
  CheckNode,
  CheckpointNode,
  ContainerGraphNode,
  ContextReference,
  DeterministicCheckDefaults,
  DeterministicPassIf,
  ExecNode,
  FileInput,
  GlobInput,
  GraphDefaults,
  GraphProfile,
  InputItem,
  InputRules,
  OutputDefinition,
  ParallelNode,
  RepeatNode,
  RepoDefinition,
  SequenceNode,
  TextInput
} from "./authored.js";
import {
  authoredNodeKinds,
  checkKinds,
  contextIncludes,
  contextSelectors,
  graphVersion,
  harnessNames,
  managedWorkflowKinds,
  outputSourceKinds,
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
  buildDeepResearchWorkflow,
  type DeepResearchDeliverable,
  type DeepResearchOrchestration,
  type DeepResearchSourcePolicy
} from "../managed/deep_research.js";
import {
  buildSpecDesignWorkflow,
  type SpecDesignDeliverable,
  type SpecDesignOrchestration,
  type SpecDesignResearchPolicy,
  type SpecDesignScope
} from "../managed/spec_design.js";
import {
  buildExecuteSpecWorkflow,
  type ExecuteSpecArtifactBundleSource,
  type ExecuteSpecDelivery,
  type ExecuteSpecExecutionPolicy,
  type ExecuteSpecImplementationResearch,
  type ExecuteSpecManagedNodeSource,
  type ExecuteSpecScope,
  type ExecuteSpecSource,
  type ExecuteSpecSourceRef,
  type ExecuteSpecValidation
} from "../managed/execute_spec.js";
import {
  buildReviewChangeWorkflow,
  type ReviewChangeArtifactBundleSource,
  type ReviewChangeCriteria,
  type ReviewChangeDelivery,
  type ReviewChangeManagedNodeSource,
  type ReviewChangeOrchestration,
  type ReviewChangeScope,
  type ReviewChangeSource,
  type ReviewChangeSourceRef
} from "../managed/review_change.js";

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
    ["max_files", "max_total_bytes", "max_bytes_per_item"],
    diagnostics
  );

  const max_files = readPositiveInteger(record.max_files, `${path}.max_files`, diagnostics);
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
    ...(max_files !== undefined ? { max_files } : {}),
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
      "env"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const command = readRequiredString(record.command, `${path}.command`, diagnostics);
  const args = readStringArray(record.args, `${path}.args`, diagnostics);
  const cwd = readOptionalString(record.cwd, `${path}.cwd`, diagnostics);
  const env = readStringRecord(record.env, `${path}.env`, diagnostics);

  if (!base || !command) {
    return undefined;
  }

  return {
    type: "exec",
    ...base,
    command,
    ...(args ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {})
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
      "env",
      "pass_if",
      "prompt",
      "rubric",
      "model",
      "reasoning_effort"
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
  const env = readStringRecord(record.env, `${path}.env`, diagnostics);
  const pass_if = normalizePassIf(record.pass_if, `${path}.pass_if`, diagnostics);
  const prompt = readOptionalString(record.prompt, `${path}.prompt`, diagnostics);
  const rubric = readOptionalString(record.rubric, `${path}.rubric`, diagnostics);
  const model = readOptionalString(record.model, `${path}.model`, diagnostics);
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
    for (const field of ["command", "args", "cwd", "env", "pass_if"] as const) {
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
    ...(check_kind === "deterministic" && env ? { env } : {}),
    ...(check_kind === "deterministic" && pass_if ? { pass_if } : {}),
    ...(check_kind === "ai" && prompt ? { prompt } : {}),
    ...(check_kind === "ai" && rubric ? { rubric } : {}),
    ...(check_kind === "ai" && model ? { model } : {}),
    ...(check_kind === "ai" && reasoning_effort ? { reasoning_effort } : {})
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

function normalizeDeepResearchSources(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): DeepResearchSourcePolicy {
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
      message: "deep_research.sources must be an object."
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
    ["web", "files", "apps", "allow_domains", "deny_domains"],
    diagnostics
  );

  const web = readBoolean(record.web, `${path}.web`, diagnostics);
  const files = readBoolean(record.files, `${path}.files`, diagnostics);
  const apps = readBoolean(record.apps, `${path}.apps`, diagnostics);
  const allow_domains = readStringArray(record.allow_domains, `${path}.allow_domains`, diagnostics);
  const deny_domains = readStringArray(record.deny_domains, `${path}.deny_domains`, diagnostics);

  return {
    ...(web !== undefined ? { web } : { web: true }),
    ...(files !== undefined ? { files } : { files: true }),
    ...(apps !== undefined ? { apps } : { apps: false }),
    ...(allow_domains && allow_domains.length > 0 ? { allow_domains } : {}),
    ...(deny_domains && deny_domains.length > 0 ? { deny_domains } : {})
  };
}

function normalizeDeepResearchDeliverable(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): DeepResearchDeliverable {
  if (value === undefined) {
    return {
      format: "report",
      citations: "inline"
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "deep_research.deliverable must be an object."
    });
    return {
      format: "report",
      citations: "inline"
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["format", "citations", "sections"], diagnostics);

  const format = readOptionalString(record.format, `${path}.format`, diagnostics);
  const citations = readOptionalString(record.citations, `${path}.citations`, diagnostics);
  const sections = readStringArray(record.sections, `${path}.sections`, diagnostics);

  return {
    ...(format ? { format } : { format: "report" }),
    ...(citations ? { citations } : { citations: "inline" }),
    ...(sections && sections.length > 0 ? { sections } : {})
  };
}

function normalizeDeepResearchOrchestration(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): DeepResearchOrchestration {
  if (value === undefined) {
    return {
      track_count: 6,
      max_parallel_tracks: 6,
      summary_fan_in: 3,
      final_critique: false
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "deep_research.orchestration must be an object."
    });
    return {
      track_count: 6,
      max_parallel_tracks: 6,
      summary_fan_in: 3,
      final_critique: false
    };
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["track_count", "max_parallel_tracks", "summary_fan_in", "final_critique"],
    diagnostics
  );

  const track_count = readPositiveInteger(record.track_count, `${path}.track_count`, diagnostics) ?? 6;
  const max_parallel_tracks =
    readPositiveInteger(record.max_parallel_tracks, `${path}.max_parallel_tracks`, diagnostics) ?? track_count;
  const summary_fan_in =
    readPositiveInteger(record.summary_fan_in, `${path}.summary_fan_in`, diagnostics) ?? 3;
  const final_critique = readBoolean(record.final_critique, `${path}.final_critique`, diagnostics) ?? false;

  if (summary_fan_in < 2) {
    diagnostics.push({
      path: `${path}.summary_fan_in`,
      message: "deep_research.orchestration.summary_fan_in must be at least 2."
    });
  }

  return {
    track_count,
    max_parallel_tracks: Math.min(max_parallel_tracks, track_count),
    summary_fan_in: Math.max(summary_fan_in, 2),
    final_critique
  };
}

function normalizeDeepResearchNode(
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
      "question",
      "objective",
      "audience",
      "sources",
      "deliverable",
      "orchestration"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const question = readRequiredString(record.question, `${path}.question`, diagnostics);
  const objective = readRequiredString(record.objective, `${path}.objective`, diagnostics);
  const audience = readOptionalString(record.audience, `${path}.audience`, diagnostics);
  const sources = normalizeDeepResearchSources(record.sources, `${path}.sources`, diagnostics);
  const deliverable = normalizeDeepResearchDeliverable(record.deliverable, `${path}.deliverable`, diagnostics);
  const orchestration = normalizeDeepResearchOrchestration(
    record.orchestration,
    `${path}.orchestration`,
    diagnostics
  );

  if (!base || !question || !objective) {
    return undefined;
  }

  loweredManagedNodes.push({
    authored_id: base.id,
    managed_kind: "deep_research",
    lowered_to: "agent"
  });

  return buildDeepResearchWorkflow({
    ...base,
    question,
    objective,
    ...(audience ? { audience } : {}),
    sources,
    deliverable,
    orchestration
  });
}

function normalizeSpecDesignScope(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): SpecDesignScope {
  if (value === undefined) {
    return {};
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "spec_design.scope must be an object."
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

function normalizeSpecDesignResearchPolicy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): SpecDesignResearchPolicy {
  if (value === undefined) {
    return {
      repo_first: true,
      allow_web_fallback: true,
      max_external_research_tasks: 3
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "spec_design.research_policy must be an object."
    });
    return {
      repo_first: true,
      allow_web_fallback: true,
      max_external_research_tasks: 3
    };
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["repo_first", "allow_web_fallback", "web_triggers", "allow_domains", "max_external_research_tasks"],
    diagnostics
  );

  const repo_first = readBoolean(record.repo_first, `${path}.repo_first`, diagnostics);
  const allow_web_fallback = readBoolean(
    record.allow_web_fallback,
    `${path}.allow_web_fallback`,
    diagnostics
  );
  const web_triggers = readStringArray(record.web_triggers, `${path}.web_triggers`, diagnostics);
  const allow_domains = readStringArray(record.allow_domains, `${path}.allow_domains`, diagnostics);
  const max_external_research_tasks =
    readPositiveInteger(
      record.max_external_research_tasks,
      `${path}.max_external_research_tasks`,
      diagnostics,
      { minimum: 0 }
    ) ?? 3;

  return {
    repo_first: repo_first ?? true,
    allow_web_fallback: allow_web_fallback ?? true,
    ...(web_triggers && web_triggers.length > 0 ? { web_triggers } : {}),
    ...(allow_domains && allow_domains.length > 0 ? { allow_domains } : {}),
    max_external_research_tasks
  };
}

function normalizeSpecDesignDeliverable(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): SpecDesignDeliverable {
  if (value === undefined) {
    return {
      format: "design_spec"
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "spec_design.deliverable must be an object."
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

function normalizeSpecDesignOrchestration(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): SpecDesignOrchestration {
  if (value === undefined) {
    return {
      option_count: 3,
      max_parallel_options: 3,
      critique_roles: ["architecture", "implementation", "ux"],
      revision_rounds: 2
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "spec_design.orchestration must be an object."
    });
    return {
      option_count: 3,
      max_parallel_options: 3,
      critique_roles: ["architecture", "implementation", "ux"],
      revision_rounds: 2
    };
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["option_count", "max_parallel_options", "critique_roles", "revision_rounds"],
    diagnostics
  );

  const option_count = readPositiveInteger(record.option_count, `${path}.option_count`, diagnostics) ?? 3;
  const max_parallel_options =
    readPositiveInteger(record.max_parallel_options, `${path}.max_parallel_options`, diagnostics) ?? option_count;
  const critique_roles = readStringArray(record.critique_roles, `${path}.critique_roles`, diagnostics);
  const revision_rounds =
    readPositiveInteger(record.revision_rounds, `${path}.revision_rounds`, diagnostics) ?? 2;

  return {
    option_count,
    max_parallel_options: Math.min(max_parallel_options, option_count),
    critique_roles:
      critique_roles && critique_roles.length > 0 ? critique_roles : ["architecture", "implementation", "ux"],
    revision_rounds
  };
}

function normalizeSpecDesignNode(
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
      "problem",
      "goal",
      "audience",
      "constraints",
      "decision_drivers",
      "scope",
      "research_policy",
      "deliverable",
      "orchestration"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const problem = readRequiredString(record.problem, `${path}.problem`, diagnostics);
  const goal = readRequiredString(record.goal, `${path}.goal`, diagnostics);
  const audience = readOptionalString(record.audience, `${path}.audience`, diagnostics);
  const constraints = readStringArray(record.constraints, `${path}.constraints`, diagnostics) ?? [];
  const decision_drivers =
    readStringArray(record.decision_drivers, `${path}.decision_drivers`, diagnostics) ?? [];
  const scope = normalizeSpecDesignScope(record.scope, `${path}.scope`, diagnostics);
  const research_policy = normalizeSpecDesignResearchPolicy(
    record.research_policy,
    `${path}.research_policy`,
    diagnostics
  );
  const deliverable = normalizeSpecDesignDeliverable(record.deliverable, `${path}.deliverable`, diagnostics);
  const orchestration = normalizeSpecDesignOrchestration(
    record.orchestration,
    `${path}.orchestration`,
    diagnostics
  );

  if (!base || !problem || !goal) {
    return undefined;
  }

  loweredManagedNodes.push({
    authored_id: base.id,
    managed_kind: "spec_design",
    lowered_to: "agent"
  });

  return buildSpecDesignWorkflow({
    ...base,
    problem,
    goal,
    ...(audience ? { audience } : {}),
    constraints,
    decision_drivers,
    scope,
    research_policy,
    deliverable,
    orchestration
  });
}

function normalizeExecuteSpecScope(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ExecuteSpecScope {
  if (value === undefined) {
    return {};
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "execute_spec.scope must be an object."
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

function normalizeExecuteSpecSourceRef(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ExecuteSpecSourceRef | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "execute_spec spec source reference must be an object."
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
    message: 'execute_spec spec source reference kind must be "file" or "managed_output".'
  });
  return undefined;
}

function normalizeExecuteSpecSource(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ExecuteSpecSource | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "execute_spec.spec_source must be an object."
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
    } satisfies ExecuteSpecManagedNodeSource;
  }

  if (kind === "artifact_bundle") {
    pushUnknownKeyDiagnostics(
      record,
      path,
      ["kind", "design_spec", "file_plan", "acceptance_criteria", "risks", "open_questions"],
      diagnostics
    );

    const design_spec = normalizeExecuteSpecSourceRef(
      record.design_spec,
      `${path}.design_spec`,
      diagnostics
    );
    const file_plan = record.file_plan
      ? normalizeExecuteSpecSourceRef(record.file_plan, `${path}.file_plan`, diagnostics)
      : undefined;
    const acceptance_criteria = record.acceptance_criteria
      ? normalizeExecuteSpecSourceRef(
          record.acceptance_criteria,
          `${path}.acceptance_criteria`,
          diagnostics
        )
      : undefined;
    const risks = record.risks
      ? normalizeExecuteSpecSourceRef(record.risks, `${path}.risks`, diagnostics)
      : undefined;
    const open_questions = record.open_questions
      ? normalizeExecuteSpecSourceRef(record.open_questions, `${path}.open_questions`, diagnostics)
      : undefined;

    if (!design_spec) {
      return undefined;
    }

    return {
      kind: "artifact_bundle",
      design_spec,
      ...(file_plan ? { file_plan } : {}),
      ...(acceptance_criteria ? { acceptance_criteria } : {}),
      ...(risks ? { risks } : {}),
      ...(open_questions ? { open_questions } : {})
    } satisfies ExecuteSpecArtifactBundleSource;
  }

  diagnostics.push({
    path: `${path}.kind`,
    message: 'execute_spec.spec_source.kind must be "managed_node" or "artifact_bundle".'
  });
  return undefined;
}

function normalizeExecuteSpecExecutionPolicy(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ExecuteSpecExecutionPolicy {
  if (value === undefined) {
    return {
      max_repair_rounds: 2
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "execute_spec.execution_policy must be an object."
    });
    return {
      max_repair_rounds: 2
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["max_repair_rounds"], diagnostics);

  return {
    max_repair_rounds:
      readPositiveInteger(record.max_repair_rounds, `${path}.max_repair_rounds`, diagnostics) ?? 2
  };
}

function normalizeExecuteSpecValidation(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ExecuteSpecValidation {
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
      message: "execute_spec.validation must be an object."
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

function normalizeExecuteSpecImplementationResearch(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ExecuteSpecImplementationResearch {
  if (value === undefined) {
    return {
      allow_official_docs_fallback: true,
      max_external_lookup_tasks: 2
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "execute_spec.implementation_research must be an object."
    });
    return {
      allow_official_docs_fallback: true,
      max_external_lookup_tasks: 2
    };
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["allow_official_docs_fallback", "allow_domains", "max_external_lookup_tasks"],
    diagnostics
  );

  const allow_official_docs_fallback =
    readBoolean(
      record.allow_official_docs_fallback,
      `${path}.allow_official_docs_fallback`,
      diagnostics
    ) ?? true;
  const allow_domains = readStringArray(record.allow_domains, `${path}.allow_domains`, diagnostics);
  const max_external_lookup_tasks =
    readPositiveInteger(
      record.max_external_lookup_tasks,
      `${path}.max_external_lookup_tasks`,
      diagnostics,
      { minimum: 0 }
    ) ?? 2;

  return {
    allow_official_docs_fallback,
    ...(allow_domains && allow_domains.length > 0 ? { allow_domains } : {}),
    max_external_lookup_tasks
  };
}

function normalizeExecuteSpecDelivery(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ExecuteSpecDelivery {
  if (value === undefined) {
    return {
      write_change_summary: true,
      write_validation_results: true,
      write_residual_risks: true,
      write_files_touched: true,
      write_implementation_plan: true
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "execute_spec.delivery must be an object."
    });
    return {
      write_change_summary: true,
      write_validation_results: true,
      write_residual_risks: true,
      write_files_touched: true,
      write_implementation_plan: true
    };
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    [
      "write_change_summary",
      "write_validation_results",
      "write_residual_risks",
      "write_files_touched",
      "write_implementation_plan"
    ],
    diagnostics
  );

  return {
    write_change_summary:
      readBoolean(record.write_change_summary, `${path}.write_change_summary`, diagnostics) ?? true,
    write_validation_results:
      readBoolean(
        record.write_validation_results,
        `${path}.write_validation_results`,
        diagnostics
      ) ?? true,
    write_residual_risks:
      readBoolean(record.write_residual_risks, `${path}.write_residual_risks`, diagnostics) ?? true,
    write_files_touched:
      readBoolean(record.write_files_touched, `${path}.write_files_touched`, diagnostics) ?? true,
    write_implementation_plan:
      readBoolean(
        record.write_implementation_plan,
        `${path}.write_implementation_plan`,
        diagnostics
      ) ?? true
  };
}

function normalizeExecuteSpecNode(
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
      "objective",
      "spec_source",
      "scope",
      "execution_policy",
      "validation",
      "implementation_research",
      "delivery"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const objective = readOptionalString(record.objective, `${path}.objective`, diagnostics);
  const spec_source = normalizeExecuteSpecSource(record.spec_source, `${path}.spec_source`, diagnostics);
  const scope = normalizeExecuteSpecScope(record.scope, `${path}.scope`, diagnostics);
  const execution_policy = normalizeExecuteSpecExecutionPolicy(
    record.execution_policy,
    `${path}.execution_policy`,
    diagnostics
  );
  const validation = normalizeExecuteSpecValidation(record.validation, `${path}.validation`, diagnostics);
  const implementation_research = normalizeExecuteSpecImplementationResearch(
    record.implementation_research,
    `${path}.implementation_research`,
    diagnostics
  );
  const delivery = normalizeExecuteSpecDelivery(record.delivery, `${path}.delivery`, diagnostics);

  if (validation.commands.length === 0) {
    diagnostics.push({
      path: `${path}.validation.commands`,
      message: "execute_spec.validation.commands must include at least one command."
    });
  }

  const hasCustomOutputs = Array.isArray(base?.outputs) && base.outputs.length > 0;
  const publishesManagedArtifacts =
    delivery.write_change_summary ||
    delivery.write_validation_results ||
    delivery.write_residual_risks ||
    delivery.write_files_touched ||
    delivery.write_implementation_plan;

  if (!hasCustomOutputs && !publishesManagedArtifacts) {
    diagnostics.push({
      path,
      message:
        "execute_spec must publish at least one final artifact via delivery flags or explicit outputs."
    });
  }

  if (!base || !spec_source) {
    return undefined;
  }

  loweredManagedNodes.push({
    authored_id: base.id,
    managed_kind: "execute_spec",
    lowered_to: "agent"
  });

  return buildExecuteSpecWorkflow({
    ...base,
    ...(objective ? { objective } : {}),
    spec_source,
    scope,
    execution_policy,
    validation,
    implementation_research,
    delivery
  });
}

function normalizeReviewChangeScope(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ReviewChangeScope {
  if (value === undefined) {
    return {};
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "review_change.scope must be an object."
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

function normalizeReviewChangeSourceRef(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ReviewChangeSourceRef | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "review_change source reference must be an object."
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
    message: 'review_change source reference kind must be "file" or "managed_output".'
  });
  return undefined;
}

function normalizeReviewChangeSource(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ReviewChangeSource | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "review_change.review_source must be an object."
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
    } satisfies ReviewChangeManagedNodeSource;
  }

  if (kind === "artifact_bundle") {
    pushUnknownKeyDiagnostics(
      record,
      path,
      ["kind", "diff", "summary", "validation_results", "files_touched", "additional_context"],
      diagnostics
    );

    const diff = record.diff
      ? normalizeReviewChangeSourceRef(record.diff, `${path}.diff`, diagnostics)
      : undefined;
    const summary = record.summary
      ? normalizeReviewChangeSourceRef(record.summary, `${path}.summary`, diagnostics)
      : undefined;
    const validation_results = record.validation_results
      ? normalizeReviewChangeSourceRef(record.validation_results, `${path}.validation_results`, diagnostics)
      : undefined;
    const files_touched = record.files_touched
      ? normalizeReviewChangeSourceRef(record.files_touched, `${path}.files_touched`, diagnostics)
      : undefined;
    const additional_context = Array.isArray(record.additional_context)
      ? record.additional_context
          .map((item, index) =>
            normalizeReviewChangeSourceRef(item, `${path}.additional_context[${index}]`, diagnostics)
          )
          .filter((item): item is ReviewChangeSourceRef => item !== undefined)
      : record.additional_context === undefined
        ? undefined
        : (() => {
            diagnostics.push({
              path: `${path}.additional_context`,
              message: "review_change.review_source.additional_context must be an array."
            });
            return undefined;
          })();

    if (!diff && !summary && (!additional_context || additional_context.length === 0)) {
      diagnostics.push({
        path,
        message:
          "review_change.review_source artifact_bundle must include at least one of diff, summary, or additional_context."
      });
      return undefined;
    }

    return {
      kind: "artifact_bundle",
      ...(diff ? { diff } : {}),
      ...(summary ? { summary } : {}),
      ...(validation_results ? { validation_results } : {}),
      ...(files_touched ? { files_touched } : {}),
      ...(additional_context && additional_context.length > 0 ? { additional_context } : {})
    } satisfies ReviewChangeArtifactBundleSource;
  }

  diagnostics.push({
    path: `${path}.kind`,
    message: 'review_change.review_source.kind must be "managed_node" or "artifact_bundle".'
  });
  return undefined;
}

function normalizeReviewChangeCriteria(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ReviewChangeCriteria {
  if (value === undefined) {
    return {
      focus: ["correctness", "regressions", "missing_tests", "maintainability"],
      require_file_references: true
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "review_change.criteria must be an object."
    });
    return {
      focus: ["correctness", "regressions", "missing_tests", "maintainability"],
      require_file_references: true
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["focus", "require_file_references"], diagnostics);
  const focus = readStringArray(record.focus, `${path}.focus`, diagnostics);
  const require_file_references =
    readBoolean(record.require_file_references, `${path}.require_file_references`, diagnostics) ?? true;

  return {
    focus:
      focus && focus.length > 0
        ? focus
        : ["correctness", "regressions", "missing_tests", "maintainability"],
    require_file_references
  };
}

function normalizeReviewChangeOrchestration(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ReviewChangeOrchestration {
  if (value === undefined) {
    return {
      reviewer_roles: ["correctness", "testing", "maintainability"],
      max_parallel_reviewers: 3
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "review_change.orchestration must be an object."
    });
    return {
      reviewer_roles: ["correctness", "testing", "maintainability"],
      max_parallel_reviewers: 3
    };
  }

  pushUnknownKeyDiagnostics(record, path, ["reviewer_roles", "max_parallel_reviewers"], diagnostics);
  const reviewer_roles = readStringArray(record.reviewer_roles, `${path}.reviewer_roles`, diagnostics);
  const normalizedRoles =
    reviewer_roles && reviewer_roles.length > 0
      ? reviewer_roles
      : ["correctness", "testing", "maintainability"];
  const max_parallel_reviewers =
    readPositiveInteger(record.max_parallel_reviewers, `${path}.max_parallel_reviewers`, diagnostics) ??
    normalizedRoles.length;

  return {
    reviewer_roles: normalizedRoles,
    max_parallel_reviewers: Math.min(max_parallel_reviewers, normalizedRoles.length)
  };
}

function normalizeReviewChangeDelivery(
  value: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): ReviewChangeDelivery {
  if (value === undefined) {
    return {
      write_review_report: true,
      write_findings_json: true,
      write_findings_markdown: true
    };
  }

  const record = asRecord(value);

  if (!record) {
    diagnostics.push({
      path,
      message: "review_change.delivery must be an object."
    });
    return {
      write_review_report: true,
      write_findings_json: true,
      write_findings_markdown: true
    };
  }

  pushUnknownKeyDiagnostics(
    record,
    path,
    ["write_review_report", "write_findings_json", "write_findings_markdown"],
    diagnostics
  );

  return {
    write_review_report:
      readBoolean(record.write_review_report, `${path}.write_review_report`, diagnostics) ?? true,
    write_findings_json:
      readBoolean(record.write_findings_json, `${path}.write_findings_json`, diagnostics) ?? true,
    write_findings_markdown:
      readBoolean(record.write_findings_markdown, `${path}.write_findings_markdown`, diagnostics) ?? true
  };
}

function normalizeReviewChangeNode(
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
      "review_source",
      "scope",
      "criteria",
      "orchestration",
      "delivery"
    ],
    diagnostics
  );

  const base = normalizeExecutableBase(record, path, diagnostics);
  const review_source = normalizeReviewChangeSource(
    record.review_source,
    `${path}.review_source`,
    diagnostics
  );
  const scope = normalizeReviewChangeScope(record.scope, `${path}.scope`, diagnostics);
  const criteria = normalizeReviewChangeCriteria(record.criteria, `${path}.criteria`, diagnostics);
  const orchestration = normalizeReviewChangeOrchestration(
    record.orchestration,
    `${path}.orchestration`,
    diagnostics
  );
  const delivery = normalizeReviewChangeDelivery(record.delivery, `${path}.delivery`, diagnostics);

  const hasCustomOutputs = Array.isArray(base?.outputs) && base.outputs.length > 0;
  const publishesManagedArtifacts =
    delivery.write_review_report ||
    delivery.write_findings_json ||
    delivery.write_findings_markdown;

  if (!hasCustomOutputs && !publishesManagedArtifacts) {
    diagnostics.push({
      path,
      message:
        "review_change must publish at least one final artifact via delivery flags or explicit outputs."
    });
  }

  if (!base || !review_source) {
    return undefined;
  }

  loweredManagedNodes.push({
    authored_id: base.id,
    managed_kind: "review_change",
    lowered_to: "agent"
  });

  return buildReviewChangeWorkflow({
    ...base,
    review_source,
    scope,
    criteria,
    orchestration,
    delivery
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

  if (type === "deep_research") {
    return normalizeDeepResearchNode(record, path, diagnostics, loweredManagedNodes);
  }

  if (type === "spec_design") {
    return normalizeSpecDesignNode(record, path, diagnostics, loweredManagedNodes);
  }

  if (type === "execute_spec") {
    return normalizeExecuteSpecNode(record, path, diagnostics, loweredManagedNodes);
  }

  if (type === "review_change") {
    return normalizeReviewChangeNode(record, path, diagnostics, loweredManagedNodes);
  }

  diagnostics.push({
    path: `${path}.type`,
    message: `Node type must be one of: ${[...authoredNodeKinds, ...managedWorkflowKinds].join(", ")}.`
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
    ["version", "graph_id", "repos", "defaults", "profiles", "graph"],
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
    graph: normalizedGraph as ContainerGraphNode
  };

  return {
    document,
    diagnostics,
    lowered_managed_nodes
  };
}
