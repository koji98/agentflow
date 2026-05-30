import { accessSync, constants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

import type { ArtifactDefinition } from "../../graph/authored.js";
import type { CliHint } from "../../graph/authored.js";
import type { ResolvedSkill, ResolvedTool } from "../../graph/compiled.js";
import type { HarnessCapabilities } from "../../graph/harness_capabilities.js";
import type { EffectiveHarnessConfig } from "../../graph/profiles.js";
import type { ReasoningEffort } from "../../graph/schema.js";
import type {
  SupervisorEvidenceGatherKind,
  SupervisorRecoveryEnvelope
} from "../../supervisor/types.js";
import { renderAttemptEvidenceMarkdown } from "../attempt_evidence.js";

export type HarnessKind = "codex-cli" | "cursor-cli";

export interface ArtifactRepairPromptContext {
  repairAttempt: number;
  maxAttempts: number;
  missingArtifacts: Array<{
    name: string;
    from: "output_dir" | "workspace";
    path: string;
    description: string;
    expectedPath: string;
  }>;
  repairBriefPath: string;
  priorResponsePath: string;
  previousAttemptEvidencePaths: string[];
}

export interface AgentInvocation {
  promptKind?: "agent" | "ai_check" | "artifact_repair" | "outcome_verification" | "supervisor_evidence" | "delivery_curator";
  runId: string;
  executionId: string;
  repoAlias: string;
  repoPath: string;
  runtimeDir?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  skipGitRepoCheck?: boolean;
  harnessConfig?: EffectiveHarnessConfig;
  model: string | undefined;
  reasoningEffort?: ReasoningEffort;
  baseEnv?: NodeJS.ProcessEnv;
  graphGoal?: string;
  graphAcceptanceCriteria?: string[];
  graphConstraints?: string[];
  nodeGoal?: string;
  nodeAcceptanceCriteria?: string[];
  nodeConstraints?: string[];
  rubric?: string;
  aiCheckOutputSchema?: string;
  contextPacketPath: string;
  contextManifestPath: string;
  contextManifest: string;
  outputDir: string;
  artifacts: Record<string, ArtifactDefinition>;
  timeoutSec: number;
  signal: AbortSignal | undefined;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  toolBinDir?: string;
  toolEnv?: Record<string, string>;
  tools?: ResolvedTool[];
  skills?: ResolvedSkill[];
  cli?: CliHint[];
  repair?: ArtifactRepairPromptContext;
  supervisorRecoveryEnvelope?: SupervisorRecoveryEnvelope;
  attemptMemoryPath?: string;
  attemptMemoryMarkdownPath?: string;
  attemptMemoryMarkdown?: string;
  supervisorEvidence?: {
    gatherKind: SupervisorEvidenceGatherKind;
    caseFilePath: string;
    evidencePatchPath: string;
    outputSchemaPath?: string;
    instructions: string[];
  };
  promptPath?: string;
}

export interface HarnessResult {
  status: "passed" | "failed" | "canceled";
  exitCode: number;
  stdout?: string;
  stderr?: string;
  metadata?: Record<string, unknown>;
  transcript?: {
    last_message_path?: string;
    last_message?: string;
  };
  outputJson?: Record<string, unknown>;
}

export interface HarnessAdapter {
  readonly kind: HarnessKind;
  readonly capabilities: HarnessCapabilities;
  checkReadiness?(): Promise<string[]> | string[];
  run(invocation: AgentInvocation): Promise<HarnessResult>;
  cancel(executionId: string): Promise<void>;
}

function canAccessExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    if (process.platform !== "win32") {
      return false;
    }

    try {
      accessSync(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function executableCandidates(binary: string): string[] {
  if (binary.length === 0) {
    return [];
  }

  if (binary.includes("/") || binary.includes("\\") || isAbsolute(binary)) {
    return [binary];
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const pathExtensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((value) => value.trim())
          .filter(Boolean)
      : [""];

  return pathEntries.flatMap((entry) => pathExtensions.map((extension) => join(entry, `${binary}${extension}`)));
}

export function resolveCliBinary(
  configuredBinary: string | undefined,
  envVarName: string,
  defaultBinary: string
): string {
  const envBinary = process.env[envVarName]?.trim();
  return configuredBinary?.trim() || envBinary || defaultBinary;
}

export function formatMissingHarnessBinaryMessage(
  kind: HarnessKind,
  binary: string,
  envVarName: string
): string {
  return `${kind} harness binary "${binary}" is unavailable. Install it on PATH or set ${envVarName}.`;
}

export function collectMissingHarnessBinaryDiagnostics(
  kind: HarnessKind,
  binary: string,
  envVarName: string
): string[] {
  const hasExecutable = executableCandidates(binary).some((candidate) => canAccessExecutable(candidate));
  if (!hasExecutable) {
    return [formatMissingHarnessBinaryMessage(kind, binary, envVarName)];
  }

  return [];
}

export function normalizeHarnessLaunchError(
  error: unknown,
  kind: HarnessKind,
  binary: string,
  envVarName: string
): Error {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return new Error(formatMissingHarnessBinaryMessage(kind, binary, envVarName));
  }

  return error instanceof Error ? error : new Error(String(error));
}

export function deriveContextManifestPath(contextPacketPath: string): string {
  return join(dirname(contextPacketPath), "manifest.md");
}

export function deriveContextProvenancePath(contextPacketPath: string): string {
  return join(dirname(contextPacketPath), "provenance.json");
}

export function deriveHarnessExecutionRoot(outputDir: string): string {
  return basename(outputDir) === "artifacts" ? dirname(outputDir) : outputDir;
}

export function buildHarnessSpawnEnv(
  invocation: AgentInvocation,
  baseEnv: NodeJS.ProcessEnv = invocation.baseEnv ?? process.env
): NodeJS.ProcessEnv {
  const scrubbedBaseEnv = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) =>
      !key.startsWith("AGENTFLOW_CREDENTIAL_") &&
      !key.startsWith("AGENTFLOW_TOOL_")
    )
  ) as NodeJS.ProcessEnv;
  const merged: NodeJS.ProcessEnv = {
    ...scrubbedBaseEnv,
    AGENTFLOW_WORKSPACE: invocation.repoPath,
    AGENTFLOW_OUTPUT_DIR: invocation.outputDir,
    AGENTFLOW_CONTEXT_PACKET: invocation.contextPacketPath,
    AGENTFLOW_CONTEXT_MANIFEST: invocation.contextManifestPath,
    ...(invocation.runtimeDir ? { AGENTFLOW_RUNTIME_DIR: invocation.runtimeDir } : {}),
    ...(invocation.toolEnv ?? {})
  };

  if (invocation.toolBinDir) {
    const existingPath = scrubbedBaseEnv.PATH ?? "";
    merged.PATH = existingPath.length > 0
      ? `${invocation.toolBinDir}${delimiter}${existingPath}`
      : invocation.toolBinDir;
  }

  return merged;
}

function describeToolOrigin(tool: ResolvedTool): string {
  switch (tool.source.kind) {
    case "plugin":
      return `from plugin "${tool.source.alias}" (tool: ${tool.source.tool})`;
    default:
      return "";
  }
}

export function formatToolContract(tools: ResolvedTool[] | undefined): string[] {
  if (!tools || tools.length === 0) {
    return [];
  }

  const sortedTools = [...tools].sort((left, right) =>
    left.callable_name.localeCompare(right.callable_name)
  );

  const lines: string[] = [
    "## Managed Plugin Tools",
    "These Agentflow-managed plugin CLIs are on PATH. Use a tool only when it directly fits the node task.",
    "The entries below are selection hints, not full docs; run `<tool> --help` before first use.",
    "",
    "| Callable | Description | Usage |",
    "| --- | --- | --- |"
  ];

  for (const tool of sortedTools) {
    const origin = describeToolOrigin(tool);
    const description = tool.description
      ? `${tool.description} Origin: ${origin}.`
      : `Origin: ${origin}.`;
    lines.push(`| \`${tool.callable_name}\` | ${description} | Run \`${tool.callable_name} --help\` before first use. |`);
  }

  return lines;
}

function formatSkillContract(skills: ResolvedSkill[] | undefined): string[] {
  if (!skills || skills.length === 0) {
    return [];
  }

  const lines = [
    "## Optional Skills",
    "These skills are available for this node. Open the SKILL.md only when it is relevant to the node task.",
    "If the node contract requires a skill, that requirement appears in the node intent or acceptance criteria.",
    "",
    "| Skill | Description | Open |",
    "| --- | --- | --- |"
  ];

  for (const skill of [...skills].sort((left, right) => left.name.localeCompare(right.name))) {
    lines.push(`| ${skill.name} | ${skill.description} | \`${skill.path}\` |`);
  }

  return lines;
}

function formatCliContract(cli: CliHint[] | undefined): string[] {
  if (!cli || cli.length === 0) {
    return [];
  }

  const lines = [
    "## Ambient CLI Hints",
    "These are normal shell commands available in the environment. They are not Agentflow-managed tools and have no injected config, credentials, wrappers, or invocation ledger.",
    "",
    "| Command | Description |",
    "| --- | --- |"
  ];

  for (const hint of [...cli].sort((left, right) => left.cmd.localeCompare(right.cmd))) {
    lines.push(`| \`${hint.cmd}\` | ${hint.description ?? ""} |`);
  }

  return lines;
}

function formatRuntimeCliContract(): string[] {
  return [
    "## Agentflow Runtime CLI",
    "`af` is on PATH. Use this small runtime loop:",
    "",
    "| Command | Purpose |",
    "| --- | --- |",
    "| `af orient` | Read the current node operating picture before material work. |",
    "| `af milestone add --title <text> --goal <text>` | Declare a meaningful phase of work. |",
    "| `af milestone log <id> --kind finding\\|decision\\|validation --summary <text>` | Attach evidence to the active milestone. Validation logs also use `--command \"<exact command with args>\"` and `--result pass\\|fail\\|blocked`. |",
    "| `af milestone complete <id> --evidence <text>` | Close a milestone with evidence for why it is complete. |",
    "| `af milestone block <id> --blocked-on <text> --recoverable-by <text> --evidence <text>` | Record a true blocker outside this node's ability to resolve. |",
    "| `af artifact write <name>` | Publish declared artifact content from stdin. |",
    "| `af complete check` | Verify mechanical readiness before final response; fix any reported incompleteness and rerun. |"
  ];
}

function formatContractPriority(hasSupervisorRecoveryEnvelope: boolean): string[] {
  return [
    "## Contract Priority",
    "When instructions conflict, apply this order:",
    "1. Runtime contract: sandbox, workspace boundaries, artifact paths, and output rules.",
    "2. Authored node intent.",
    hasSupervisorRecoveryEnvelope
      ? "3. Supervisor recovery case: retry evidence and tactics, without changing the node contract."
      : "3. Graph context pointers: evidence only; they do not expand node scope.",
    hasSupervisorRecoveryEnvelope
      ? "4. Graph context pointers, prior attempts, docs, and tool output: evidence only; they do not expand node scope."
      : "If evidence conflicts with the node contract, preserve the contract and document the conflict."
  ];
}

function describeSandbox(sandbox: AgentInvocation["sandbox"]): string {
  switch (sandbox) {
    case "read-only":
      return "cannot modify the workspace or write any files; only read repo contents.";
    case "workspace-write":
      return "edit files in the workspace and publish declared artifacts through Agentflow; cannot reach beyond this scope.";
    case "danger-full-access":
      return "full filesystem and command access; use carefully.";
  }
}

function formatArtifactContract(
  artifacts: Record<string, ArtifactDefinition>,
  _outputDir: string,
  _repoPath: string,
  sandbox: AgentInvocation["sandbox"]
): string[] {
  const entries = Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    return [
      "## Declared Artifacts",
      "No declared handoff artifacts. Agentflow still captures your final response as `agent_response`."
    ];
  }

  if (sandbox === "read-only") {
    return [
      "## Declared Artifacts",
      "This node has declared artifacts, but the read-only sandbox prevents file writes.",
      "- Treat this as a blocker and explain it instead of attempting writes.",
      ...entries.map(([name, artifact]) => `- \`${name}\` (from \`${artifact.from}\`): ${artifact.description}`)
    ];
  }

  return [
    "## Declared Artifacts",
    "Every declared artifact must exist before you finish. Publish text or binary content with `af artifact write <name>` using stdin, or `af artifact write <name> --file <path>` for an existing workspace/output file.",
    "Declared artifacts are the durable handoff. When a required command or tool provides validation evidence, include the exact command and observed result/output in the relevant artifact unless the artifact contract says otherwise.",
    "If the node task names required words, labels, titles, classifications, or output phrases for an artifact, include that exact wording in the artifact instead of only paraphrasing it.",
    "If required labels include punctuation such as `Scenario:`, `Changed files:`, or `Validation:`, include those exact labels with punctuation in the artifact text.",
    "If the node task or artifact description asks for named sections without exact label text, render them as Markdown headings such as `## Scenario`, `## Changed files`, and `## Validation` unless a different format is explicitly required.",
    "If the node task asks for a named deliverable such as a profile, summary, report, plan, or handoff, make that deliverable name visible in the artifact title or primary label.",
    "Do not write stale completion language such as `af complete check has not yet run`. If a completion/status section becomes stale after `af complete check`, rewrite the artifact and rerun `af complete check`.",
    "",
    "| Name | Write Command | Type | Description |",
    "| --- | --- | --- | --- |",
    ...entries.map(([name, artifact]) =>
      `| \`${name}\` | \`af artifact write ${name}\` | ${artifact.content_type ? `\`${artifact.content_type}\`` : "auto-detect"} | ${artifact.description} |`
    )
  ];
}

function formatWorkspaceContract(invocation: AgentInvocation): string[] {
  const lines = [
    "## Workspace",
    `- Workspace path: ${invocation.repoPath}`,
    `- Sandbox: ${invocation.sandbox} - ${describeSandbox(invocation.sandbox)}`
  ];

  if (invocation.sandbox === "read-only") {
    lines.push("- Inspect and report only. Do not attempt source edits, file writes, shell commands that mutate state, or artifact writes.");
  }

  return lines;
}

function formatInlineContextManifest(manifest: string | undefined): string {
  const trimmed = manifest?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "_(No context pointers.)_";
}

function formatBullets(values: string[] | undefined, emptyText: string): string[] {
  if (!values || values.length === 0) {
    return [`- ${emptyText}`];
  }

  return values.map((value) => `- ${value}`);
}

function formatGraphContext(invocation: AgentInvocation): string[] {
  if (!invocation.graphGoal && !invocation.graphAcceptanceCriteria && !invocation.graphConstraints) {
    return [];
  }

  return [
    "## Graph Context",
    "Why this node exists. The node task remains the controlling objective.",
    ...(invocation.graphGoal ? ["", invocation.graphGoal] : []),
    "",
    "Acceptance criteria:",
    ...formatBullets(invocation.graphAcceptanceCriteria, "No graph-level acceptance criteria were authored."),
    "",
    "Constraints:",
    ...formatBullets(invocation.graphConstraints, "No graph-level constraints were authored.")
  ];
}

function formatSupervisorRecoveryEnvelope(invocation: AgentInvocation): string[] {
  const envelope = invocation.supervisorRecoveryEnvelope;

  if (!envelope) {
    return [];
  }

  const directive = envelope.retry_directive;
  const evidencePointers = directive.evidence_to_read.filter(isAgentFacingEvidencePath);
  return [
    "## Supervisor Recovery Case",
    "Retry from the selected resume point while preserving the original node contract and useful prior progress.",
    "The recovery brief is also available as a context pointer named `supervisor_recovery_envelope`.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Classification | \`${envelope.classification}\` |`,
    `| Resume point | \`${envelope.resume_point}\` |`,
    `| Restart boundary | \`${envelope.resume_decision.restart_boundary}\` |`,
    `| Workspace decision | \`${envelope.workspace_decision}\` |`,
    `| Resume reason | \`${envelope.resume_decision.reason_code}\` |`,
    `| Repeated symptom count | \`${envelope.repeated_fingerprint_count}\` |`,
    `| Symptom | ${directive.summary} |`,
    `| Required next action | ${envelope.required_next_action} |`,
    "",
    ...renderAttemptEvidenceMarkdown(envelope.prior_attempt_evidence, { heading: "### Prior Attempt Evidence" }),
    "",
    "### Preserve Progress",
    ...formatBullets(envelope.preserve_progress, "Preserve in-scope prior progress unless evidence says it is unsafe."),
    "",
    "### Reuse",
    ...formatBullets(envelope.resume_decision.reuse, "Use current context pointers and artifact status."),
    "",
    "### Discard",
    ...formatBullets(envelope.resume_decision.discard, "No prior progress was selected for discard."),
    "",
    "### Required Delta",
    ...formatBullets(directive.must_do, "Read the recovery evidence and change tactic before material work."),
    "",
    "### Forbidden Actions",
    ...formatBullets(
      [...new Set([...directive.must_not_do, ...envelope.do_not_redo])],
      "Do not change the original goal, acceptance criteria, constraints, repo authority, sandbox, or declared artifacts."
    ),
    "",
    "### Evidence Pointers",
    ...formatBullets(evidencePointers, "Read the supervisor recovery context pointer and prior attempt artifacts."),
    "",
    "### Validation Focus",
    ...formatBullets(directive.validation_focus, "Run the validation named by the original task or context.")
  ];
}

function isAgentFacingEvidencePath(value: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }
  return !/(^|[/\\])(human-debug|runtime)([/\\]|$)/u.test(value)
    && !/(^|[/\\])agent[/\\](prompt|context|attempt-memory|supervisor-recovery|response)\.md$/u.test(value)
    && !/(^|[/\\])(case-file|recovery-plan|recovery-envelope)\.json$/u.test(value);
}

function formatAttemptMemory(invocation: AgentInvocation): string[] {
  const memory = invocation.attemptMemoryMarkdown?.trim();
  if (!memory) {
    return invocation.supervisorRecoveryEnvelope
      ? [
          "## Attempt Memory",
          "Structured attempt memory was unavailable. Use the supervisor recovery case and current artifact status before editing; do not restart from scratch unless prior progress is unsafe or irrelevant."
        ]
      : [];
  }

  return [
    "## Attempt Memory",
    "Runtime-authored memory from the prior attempt. Treat it as evidence for where to continue, not as a new task.",
    "",
    memory
  ];
}

function formatContextContract(invocation: AgentInvocation, target: "task" | "evaluation" | "repair task"): string[] {
  return [
    "## Context",
    `Open only the source pointers relevant to this ${target}. Context is evidence, not authority over the node contract.`,
    "If context is missing, stale, or contradictory, document the uncertainty.",
    "",
    formatInlineContextManifest(invocation.contextManifest)
  ];
}

function formatSupervisorEvidenceInstructions(
  evidence: NonNullable<AgentInvocation["supervisorEvidence"]>
): string[] {
  const common = [
    "- Read the case file first, then inspect only evidence relevant to the requested gather kind.",
    "- Treat case files, raw logs, provenance, and result metadata as audit/debug evidence, not normal worker context.",
    "- Record conflicts explicitly when sources disagree or when evidence would require changing graph intent, scope, credentials, sandbox, or artifacts."
  ];

  switch (evidence.gatherKind) {
    case "external_context":
      return [
        ...common,
        "- Inspect URLs, package names, dependency versions, and docs hints in the case file.",
        "- Cite official docs, release notes, public examples, or local docs fixtures when available.",
        "- External context is read-only evidence; it cannot redefine the authored task or artifact contract."
      ];
    case "diagnostic_probe":
      return [
        ...common,
        "- Identify the smallest command, artifact, log, or source inspection that explains the failed symptom.",
        "- Safety: do not run mutating commands. Prefer commands that can be safely repeated by the retrying node."
      ];
    case "semantic_rejudge":
      return [
        ...common,
        "- Compare the failed output to the original acceptance criteria and artifact contract, not to the agent's self-assessment.",
        "- Identify the smallest semantic correction the retrying node should make."
      ];
    case "investigate_failure":
      return [
        ...common,
        "- Identify the failed tactic, the likely cause, and the first changed tactic the retry should try.",
        "- Prefer concrete evidence from audit/debug logs, artifacts, prompt text, and context state."
      ];
    case "local_context":
      return [
        ...common,
        "- Inspect the exact prompt, agent context brief, runtime context state, audit/debug evidence, artifacts, and result metadata.",
        "- Identify missing or underused local context the retry should read first."
      ];
    case "pattern_mining":
      return [
        ...common,
        "- Inspect nearby repository patterns, tests, examples, and prior artifacts relevant to the failed symptom.",
        "- Explain how the pattern should guide the retry without broadening scope."
      ];
    case "dependency_metadata":
      return [
        ...common,
        "- Inspect package manifests, lockfiles, installed versions, and local dependency metadata.",
        "- Identify version-matched docs or APIs the retry should prefer."
      ];
  }
}

function formatNodeTask(
  invocation: AgentInvocation,
  options: {
    title: string;
    emptyGoal: string;
    emptyAcceptanceCriteria: string;
    emptyConstraints: string;
  }
): string[] {
  return [
    `## ${options.title}`,
    "",
    invocation.nodeGoal ?? options.emptyGoal,
    "",
    "Acceptance criteria:",
    ...formatBullets(invocation.nodeAcceptanceCriteria, options.emptyAcceptanceCriteria),
    "",
    "Constraints:",
    ...formatBullets(invocation.nodeConstraints, options.emptyConstraints),
    ...(invocation.rubric
      ? [
          "",
          "Rubric:",
          invocation.rubric
        ]
      : [])
  ];
}

export function renderHarnessPrompt(invocation: AgentInvocation): string {
  const graphContext = formatGraphContext(invocation);
  const toolContract = formatToolContract(invocation.tools);
  const skillContract = formatSkillContract(invocation.skills);
  const cliContract = formatCliContract(invocation.cli);

  if (invocation.promptKind === "outcome_verification") {
    if (invocation.sandbox !== "read-only") {
      throw new Error("outcome_verification prompts must run in a read-only sandbox.");
    }
    if (invocation.tools && invocation.tools.length > 0) {
      throw new Error("outcome_verification prompts must not be granted plugin tools.");
    }
    if (typeof invocation.rubric !== "string" || invocation.rubric.length === 0) {
      throw new Error("outcome_verification prompts require the rendered verifier prompt in `rubric`.");
    }

    return invocation.rubric;
  }

  if (invocation.promptKind === "delivery_curator") {
    if (invocation.sandbox !== "read-only") {
      throw new Error("delivery_curator prompts must run in a read-only sandbox.");
    }
    if (invocation.tools && invocation.tools.length > 0) {
      throw new Error("delivery_curator prompts must not be granted plugin tools.");
    }
    if (typeof invocation.rubric !== "string" || invocation.rubric.length === 0) {
      throw new Error("delivery_curator prompts require the rendered curation prompt in `rubric`.");
    }

    return invocation.rubric;
  }

  if (invocation.promptKind === "supervisor_evidence") {
    const evidence = invocation.supervisorEvidence;
    if (!evidence) {
      throw new Error("supervisor_evidence prompts require supervisor evidence context.");
    }

    return [
      "## Role",
      "Agentflow supervisor diagnostic/audit helper.",
      "Gather read-only evidence for a failed node attempt. Do not change graph intent, acceptance criteria, repo authority, sandbox authority, or declared artifacts.",
      "You may inspect audit/debug evidence because this is a diagnostic helper prompt, not normal worker context.",
      "Your output feeds a retry plan, so prefer concrete, source-backed guidance over generic advice.",
      "",
      "## Gather Request",
      `- Kind: \`${evidence.gatherKind}\``,
      `- Case file: \`${evidence.caseFilePath}\``,
      `- Evidence patch output: \`${evidence.evidencePatchPath}\``,
      ...(evidence.outputSchemaPath ? [`- Output schema: \`${evidence.outputSchemaPath}\``] : []),
      "",
      "## Instructions",
      ...formatBullets(evidence.instructions, "Inspect the case file and produce a cited evidence patch."),
      ...formatSupervisorEvidenceInstructions(evidence),
      "",
      "## Output",
      "Return JSON only, with no prose or markdown, matching this shape:",
      "{",
      '  "claims": [string],',
      '  "sources": [{"label": string, "path"?: string, "url"?: string}],',
      '  "confidence": "low" | "medium" | "high",',
      '  "conflicts": [string],',
      '  "retry_guidance": [string],',
      '  "authority_findings": [{"kind": "graph_contract_change" | "sandbox_expansion" | "repo_scope_expansion" | "external_side_effect" | "credential_or_auth_mention" | "operator_input_mention", "summary": string, "evidence"?: [string]}]',
      "}"
    ].join("\n");
  }

  if (invocation.promptKind === "ai_check") {
    const checkTask = formatNodeTask(invocation, {
      title: "Check Task",
      emptyGoal: "Evaluate the graph node against the provided context.",
      emptyAcceptanceCriteria: "No check-level acceptance criteria were authored.",
      emptyConstraints: "No check-level constraints were authored."
    });

    return [
      "## Role",
      "Agentflow is a local graph runner for long-running engineering work.",
      "You are an AI evaluator executing one read-only check node in a wider Agentflow graph.",
      "Evaluate the check task below. Never modify the workspace. Your only output is structured JSON describing your judgment.",
      "",
      ...checkTask,
      "",
      ...graphContext,
      ...(graphContext.length > 0 ? [""] : []),
      ...formatWorkspaceContract(invocation),
      "",
      ...formatContextContract(invocation, "evaluation"),
      ...(skillContract.length > 0 ? ["", ...skillContract] : []),
      ...(cliContract.length > 0 ? ["", ...cliContract] : []),
      "",
      "## Output",
      "Return JSON only with this exact shape:",
      invocation.aiCheckOutputSchema ?? '{"passed":true,"score":0.0,"summary":"short summary","issues":[]}',
      "Do not include any prose outside the JSON object."
    ].join("\n");
  }

  if (invocation.promptKind === "artifact_repair") {
    const repair = invocation.repair;
    if (!repair) {
      throw new Error("artifact_repair prompts require repair context.");
    }
    const agentFacingAttemptEvidence = repair.previousAttemptEvidencePaths.filter((path) =>
      !path.replace(/\\/gu, "/").includes("/human-debug/")
    );

    return [
      "## Role",
      "Agentflow is a local graph runner for long-running engineering work.",
      "You are repairing one previously executed Agentflow node. Do not redo unrelated work.",
      "Your only job is to produce the missing declared artifacts through Agentflow.",
      "",
      ...formatNodeTask(invocation, {
        title: "Repair Task",
        emptyGoal: "Repair the missing declared artifacts for this node.",
        emptyAcceptanceCriteria: "Every missing artifact exists at its expected path.",
        emptyConstraints: "Do not make unrelated source changes."
      }),
      "",
      ...graphContext,
      ...(graphContext.length > 0 ? [""] : []),
      ...formatWorkspaceContract(invocation),
      "",
      "## Missing Artifacts",
      ...repair.missingArtifacts.flatMap((artifact) => [
        `- \`${artifact.name}\``,
        `  - from: \`${artifact.from}\``,
        `  - declared path: \`${artifact.path}\``,
        `  - expected content: ${artifact.description}`
      ]),
      "",
      "## Available Evidence",
      `- Repair brief: ${repair.repairBriefPath}`,
      `- Prior final response artifact, if present: ${repair.priorResponsePath}`,
      ...(agentFacingAttemptEvidence.length > 0
        ? [
            "- Previous attempts for this same node:",
            ...agentFacingAttemptEvidence.map((path) => `  - ${path}`)
          ]
        : []),
      `- Repair attempt: ${repair.repairAttempt} of ${repair.maxAttempts}`,
      "",
      ...formatContextContract(invocation, "repair task"),
      "",
      ...formatRuntimeCliContract(),
      "",
      ...formatArtifactContract(invocation.artifacts, invocation.outputDir, invocation.repoPath, invocation.sandbox),
      ...(skillContract.length > 0 ? ["", ...skillContract] : []),
      ...(cliContract.length > 0 ? ["", ...cliContract] : []),
      ...(toolContract.length > 0 ? ["", ...toolContract] : []),
      "",
      "## Repair Instructions",
      ...(invocation.sandbox === "read-only"
        ? [
            "- Inspect the workspace, context, repair brief, and agent-facing evidence pointers as needed.",
            "- The read-only sandbox cannot produce missing artifacts. Report the concrete blocker without claiming repair success.",
            "- Do not attempt artifact writes, source edits, or mutating shell commands."
          ]
        : [
            "- Run `af orient`, create a repair milestone, inspect only evidence needed to repair the missing artifact, publish each missing artifact with `af artifact write <name>`, complete the milestone with evidence, then run `af complete check`.",
            "- If artifact content exists in prior evidence, use it only after checking it still satisfies the current artifact description.",
            "- Finish only after every missing artifact exists and `af complete check` reports ready."
          ])
    ].join("\n");
  }

  const hasSupervisorRecoveryEnvelope = Boolean(invocation.supervisorRecoveryEnvelope);
  const supervisorRecoveryEnvelope = formatSupervisorRecoveryEnvelope(invocation);
  const attemptMemory = formatAttemptMemory(invocation);
  const nodeTask = formatNodeTask(invocation, {
    title: hasSupervisorRecoveryEnvelope ? "Success Contract (Original Authored Node Task)" : "Success Contract",
    emptyGoal: "Complete the authored node intent goal.",
    emptyAcceptanceCriteria: "No node intent acceptance criteria were authored.",
    emptyConstraints: "No node-level constraints were authored."
  });

  return [
    "## Role",
    "Agentflow is a local graph runner for long-running engineering work.",
    "You are executing one node in a wider Agentflow graph. Complete this node's task; future nodes consume only named artifacts and the final response.",
    hasSupervisorRecoveryEnvelope
      ? "A supervisor recovery case appears before graph context. Use it to recover from prior failure while preserving the unchanged authored contract."
      : "The node task is the controlling objective. Use graph context only to understand why this node exists.",
    "Agentflow is the runner, not the work target. Use the node task and graph context pointers as the contract for this node.",
    "",
    ...nodeTask,
    "",
    ...supervisorRecoveryEnvelope,
    ...(supervisorRecoveryEnvelope.length > 0 ? [""] : []),
    ...attemptMemory,
    ...(attemptMemory.length > 0 ? [""] : []),
    ...formatContractPriority(hasSupervisorRecoveryEnvelope),
    "",
    ...formatWorkspaceContract(invocation),
    "",
    "## Working Loop",
    "Drive the node to completion within its boundary.",
    hasSupervisorRecoveryEnvelope
      ? "This is a retry. Run `af orient`, read the retry orientation and attempt memory, inspect preserved progress, then continue from the selected resume point."
      : "This is a first attempt. Run `af orient` before material work.",
    "1. Run `af orient` before material work.",
    "   Rerun `af orient` whenever the goal, acceptance criteria, context pointers, artifact expectations, retry state, or next action becomes unclear.",
    "   If conversational continuity is lost after compaction, a long pause, or a long-running task drift, rerun `af orient` to re-ground before continuing.",
    "2. Understand the plan before committing to execution milestones: read any relevant plan, research, context pointer, or supervisor recovery brief; check it against the goal, acceptance criteria, and constraints.",
    "3. If no adequate plan exists, do the necessary discovery and planning required to choose a defensible execution path. If that work is substantial, create a planning/research milestone first, log findings and decisions there, complete it, then add execution milestones.",
    "There is no discovery quota or ceiling; do the amount required to act with evidence and satisfy the node contract.",
    "4. Create meaningful execution milestones with `af milestone add`; add more as evidence changes instead of forcing the initial plan to fit.",
    "5. Work milestone by milestone. Attach findings, decisions, and validation evidence with `af milestone log`.",
    "6. Complete each milestone with `af milestone complete --evidence ...`, or block a true external blocker with `af milestone block`.",
    "7. Publish declared artifacts with `af artifact write <name>` using stdin, or `af artifact write <name> --file <path>` when the artifact already exists as a workspace/output file.",
    "   Do not create temporary artifact draft files in the repo workspace; stream final artifact content directly to `af artifact write`.",
    "8. Run `af complete check`; if it reports incomplete, treat that output as repair feedback, fix it, and rerun.",
    "When the node task names an exact command, attempt that command exactly at least once; do not substitute a nearby validation command unless the exact command fails as unavailable and you record that failure before falling back.",
    "When the node task says to write or select a value from a command/tool, the observed command/tool output is the source of truth for that artifact field; do not replace it with a nearby context value.",
    "When the node task asks for a decision, log it with `af milestone log <id> --kind decision`; validation logs are not a substitute for required decision evidence.",
    "When logging validation for a command with arguments, quote the full command as one `--command \"...\"` value so completion checks can match the evidence.",
    "Investigate ambiguity instead of guessing. If the same tactic fails twice with the same symptom, change strategy or surface a concrete blocker.",
    "When `af complete check` reports `ready_for_verification`, stop and respond immediately; do not continue investigating.",
    "Stop early only when a concrete blocker prevents progress; block the active milestone with evidence before the final response.",
    "Outcome verification grades your work against the acceptance criteria after this node finishes; declaring done before the criteria are met will be rejected.",
    "",
    ...graphContext,
    ...(graphContext.length > 0 ? [""] : []),
    ...formatContextContract(invocation, "task"),
    ...(skillContract.length > 0 ? ["", ...skillContract] : []),
    ...(cliContract.length > 0 ? ["", ...cliContract] : []),
    ...(toolContract.length > 0 ? ["", ...toolContract] : []),
    "",
    ...formatRuntimeCliContract(),
    "",
    ...formatArtifactContract(invocation.artifacts, invocation.outputDir, invocation.repoPath, invocation.sandbox),
    ...(hasSupervisorRecoveryEnvelope
      ? [
          "- Prior attempt artifacts are evidence only. This retry must publish every current-attempt declared artifact before finishing."
        ]
      : []),
    "",
    "## Completion Gate",
    "Before the final response: `af orient` has run, every milestone is completed, declared artifacts are published, validation evidence is logged under the relevant milestone, constraints are preserved, and `af complete check` reports `ready_for_verification`.",
    "Your final response is captured as the reserved `agent_response` artifact. Keep it concise: outcome, artifacts, validation, and live blockers/risks."
  ].join("\n");
}
