import { accessSync, constants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

import type { ArtifactDefinition, ManagedPromptContract } from "../../graph/authored.js";
import type { CliHint } from "../../graph/authored.js";
import type { ResolvedSkill, ResolvedTool } from "../../graph/compiled.js";
import type { HarnessCapabilities } from "../../graph/harness_capabilities.js";
import type { EffectiveHarnessConfig } from "../../graph/profiles.js";
import type { ReasoningEffort } from "../../graph/schema.js";
import type {
  SupervisorEvidenceGatherKind,
  SupervisorRecoveryEnvelope
} from "../../supervisor/types.js";

export type HarnessKind = "codex-cli" | "cursor-cli";
export type AiEvaluatorSurface = "ai_check" | "managed_criterion" | "eval_quality_judge";

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
  managedPrompt?: ManagedPromptContract;
  rubric?: string;
  aiCheckOutputSchema?: string;
  aiEvaluatorSurface?: AiEvaluatorSurface;
  aiCheckQualityThreshold?: number;
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
    "| `af milestone log <id> --kind finding\\|decision\\|validation --summary <text>` | Attach evidence to an active or completed milestone. Validation logs also use `--command \"<exact command with args>\"` and `--result pass\\|fail\\|blocked`. |",
    "| `af milestone complete <id> --evidence <text>` | Close a milestone with evidence for why it is complete. |",
    "| `af milestone block <id> --blocked-on <text> --recoverable-by <text> --evidence <text>` | Record a true blocker outside this node's ability to resolve. |",
    "| `af artifact write <name>` | Publish declared artifact content from stdin. |",
    "| `af complete check` | Verify mechanical readiness before final response; fix any reported incompleteness and rerun. |"
  ];
}

function markdownCell(value: string | undefined): string {
  return (value ?? "").replace(/\r?\n/gu, " ").replace(/\|/gu, "\\|").trim();
}

function artifactWriteCommand(name: string): string {
  return `af artifact write ${name}`;
}

function describeSandbox(sandbox: AgentInvocation["sandbox"]): string {
  switch (sandbox) {
    case "read-only":
      return "read only; no workspace or artifact writes.";
    case "workspace-write":
      return "edit this workspace and publish artifacts through Agentflow; no out-of-scope writes.";
    case "danger-full-access":
      return "full filesystem and command access.";
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
    "Names/descriptions are binding. Use each table command; append `--file <path>` for existing files/binaries.",
    "",
    "| Name | Write Command | Type | Description |",
    "| --- | --- | --- | --- |",
    ...entries.map(([name, artifact]) =>
      `| \`${name}\` | \`${artifactWriteCommand(name)}\` | ${artifact.content_type ? `\`${markdownCell(artifact.content_type)}\`` : "auto-detect"} | ${markdownCell(artifact.description)} |`
    )
  ];
}

function formatWorkspaceContract(invocation: AgentInvocation): string[] {
  const lines = [
    "## Workspace",
    `- Path: ${invocation.repoPath}`,
    `- Sandbox: ${invocation.sandbox}`
  ];

  if (invocation.sandbox === "read-only") {
    lines.push(`- ${describeSandbox(invocation.sandbox)} Inspect and report only.`);
  }

  return lines;
}

function formatInlineContextManifest(manifest: string | undefined): string {
  const trimmed = manifest?.trim() ?? "";
  if (trimmed.length === 0) {
    return "_(No context pointers.)_";
  }

  const lines = trimmed
    .split(/\r?\n/u)
    .filter((line) =>
      line.trim() !== "# Context Manifest" &&
      line.trim() !== "Context entries are pointers. Agentflow does not copy or truncate source context into this prompt package."
    );

  return lines.join("\n").trim();
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
    ...(invocation.graphGoal ? ["", invocation.graphGoal] : []),
    ...(invocation.graphAcceptanceCriteria && invocation.graphAcceptanceCriteria.length > 0
      ? ["", "Acceptance criteria:", ...formatBullets(invocation.graphAcceptanceCriteria, "")]
      : []),
    ...(invocation.graphConstraints && invocation.graphConstraints.length > 0
      ? ["", "Constraints:", ...formatBullets(invocation.graphConstraints, "")]
      : [])
  ];
}

function formatManagedPromptContract(invocation: AgentInvocation): string[] {
  const prompt = invocation.managedPrompt;
  if (!prompt) {
    return [];
  }

  const sections = prompt.sections.flatMap((section) => [
    "",
    `### ${section.title}`,
    ...section.lines
  ]);

  return [
    "## Phase Brief",
    `- Phase: ${prompt.phase}`,
    `- Task: ${prompt.task}`,
    ...sections
  ];
}

function formatSupervisorRecoveryEnvelope(invocation: AgentInvocation): string[] {
  const envelope = invocation.supervisorRecoveryEnvelope;

  if (!envelope) {
    return [];
  }

  const directive = envelope.retry_directive;
  return [
    "## Supervisor Recovery Case",
    "Run `af orient` before material work; it contains the detailed retry orientation, attempt memory, preserve/discard guidance, and validation focus.",
    "Recovery context pointer: `supervisor_recovery_envelope`.",
    "Continue from the selected recovery boundary without changing the original node contract.",
    "",
    `- Classification: \`${envelope.classification}\``,
    `- Resume point: \`${envelope.resume_point}\``,
    `- Restart boundary: \`${envelope.resume_decision.restart_boundary}\``,
    `- Workspace decision: \`${envelope.workspace_decision}\``,
    `- Repeated symptom count: \`${envelope.repeated_fingerprint_count}\``,
    `- Symptom: ${directive.summary}`,
    `- Required next action: ${envelope.required_next_action}`
  ];
}

function formatContextContract(invocation: AgentInvocation, target: "task" | "evaluation" | "repair task"): string[] {
  return [
    "## Context",
    `Open relevant ${target} pointers only; context is evidence, not authority. Document missing, stale, or contradictory context.`,
    "",
    formatInlineContextManifest(invocation.contextManifest)
  ];
}

function formatOperatingBrief(invocation: AgentInvocation): string[] {
  const hasSupervisorRecoveryEnvelope = Boolean(invocation.supervisorRecoveryEnvelope);
  return [
    "## Operating Brief",
    "Run `af orient` before material work and whenever the goal, context, artifact expectations, retry state, or next action becomes unclear; rerun after compaction, a long pause, or drift.",
    hasSupervisorRecoveryEnvelope
      ? "This is a retry; detailed recovery orientation, preserve/discard guidance, and validation focus live in `af orient`."
      : "- Plan narrowly; substantial planning belongs in a milestone.",
    "- Satisfy the task contract, not only the visible tests; handle edge cases directly implied by the goal, acceptance criteria, and local code.",
    "- Keep edits scoped; add/edit tests only when the task asks or repo contract expects them.",
    "- Preserve API semantics with nullish or explicit checks; avoid truthiness and absence-check ceremony unless null and absence must differ; prefer direct formulas over expanded arithmetic; use helpers/constants only when they clarify; round money with integer cents or Number.EPSILON; make rejection errors name expected formats or valid values.",
    '- Log substantial plans, findings, decisions, and validation with `af milestone add`/`af milestone log`; quote command evidence as one `--command "..."` value; use existing milestones for late evidence.',
    "- Publish declared artifacts with `af artifact write <name>` or `af artifact write <name> --file <path>`.",
    "- Use `af --help` when needed; prefer exact task commands before fallbacks.",
    "- Before final response, run `af complete check`; if incomplete, repair and rerun it until ready or truly blocked. When ready, stop and respond. Do not paste raw/stale check JSON into deliverables.",
    "- If the same tactic fails twice with the same symptom, change strategy. Stop early only for a concrete blocker and block the active milestone with evidence."
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
  const lines = [
    `## ${options.title}`,
    "",
    invocation.nodeGoal ?? options.emptyGoal
  ];

  if (invocation.nodeAcceptanceCriteria && invocation.nodeAcceptanceCriteria.length > 0) {
    lines.push("", "Acceptance criteria:", ...formatBullets(invocation.nodeAcceptanceCriteria, options.emptyAcceptanceCriteria));
  }

  if (invocation.nodeConstraints && invocation.nodeConstraints.length > 0) {
    lines.push("", "Constraints:", ...formatBullets(invocation.nodeConstraints, options.emptyConstraints));
  }

  if (invocation.rubric) {
    lines.push("", "Rubric:", invocation.rubric);
  }

  return lines;
}

function formatAiEvaluatorTarget(invocation: AgentInvocation): string[] {
  switch (invocation.aiEvaluatorSurface ?? "ai_check") {
    case "managed_criterion":
      return [
        "## Evaluation Target",
        "- What is being judged: one managed completion criterion.",
        "- Target: the criterion target described in the Check Task and Rubric, not the whole managed lifecycle.",
        "- Allowed evidence: the provided context pointers, work notes, draft artifacts, validation evidence, and workspace evidence refs when present.",
        "- Out of scope: new implementation work, unrelated downstream graph work, broad lifecycle grading, or claims unsupported by the provided evidence.",
        "- Result controls: managed scorecard aggregation and retry feedback for this criterion."
      ];
    case "eval_quality_judge":
      return [
        "## Evaluation Target",
        "- What is being judged: one eval quality criterion for one completed trial trace packet.",
        "- Target: the scenario, variant, trial, trace packet, and declared eval evidence named in the Check Task and context.",
        "- Allowed evidence: the judge packet, trace packet, run-root artifacts, prompt diagnostics, and local trial files referenced by context.",
        "- Out of scope: rerunning the workflow, doing the task yourself, de-anonymizing variants, or letting quality scores excuse deterministic blockers.",
        "- Result controls: eval scorecard quality grading only; it does not change the completed run outcome.",
        `- Quality threshold: ${invocation.aiCheckQualityThreshold ?? 4}`
      ];
    case "ai_check":
      return [
        "## Evaluation Target",
        "- What is being judged: this authored read-only AI check node.",
        "- Target: the Check Task and Rubric below.",
        "- Allowed evidence: graph context when relevant, the context pointers in this prompt, and workspace files needed for the check.",
        "- Out of scope: modifying the workspace, redoing upstream work, or grading unrelated graph tasks.",
        "- Result controls: this check node's pass/fail result."
      ];
  }
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
      ...formatAiEvaluatorTarget(invocation),
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
        `  - write command: \`${artifactWriteCommand(artifact.name)}\``,
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
            "- Run `af orient`, create a repair milestone, inspect only evidence needed to repair the missing artifact, publish each missing artifact with the exact command listed above, complete the milestone with evidence, then run `af complete check`.",
            "- If artifact content exists in prior evidence, use it only after checking it still satisfies the current artifact description.",
            "- Finish only after every missing artifact exists and `af complete check` reports ready."
          ])
    ].join("\n");
  }

  const hasSupervisorRecoveryEnvelope = Boolean(invocation.supervisorRecoveryEnvelope);
  const supervisorRecoveryEnvelope = formatSupervisorRecoveryEnvelope(invocation);
  const managedPrompt = formatManagedPromptContract(invocation);
  const nodeTask = formatNodeTask(invocation, {
    title: hasSupervisorRecoveryEnvelope ? "Success Contract (Original Authored Node Task)" : "Success Contract",
    emptyGoal: "Complete the authored node intent goal.",
    emptyAcceptanceCriteria: "No node intent acceptance criteria were authored.",
    emptyConstraints: "No node-level constraints were authored."
  });

  return [
    "## Role",
    "Executing one Agentflow graph node.",
    hasSupervisorRecoveryEnvelope
      ? "The node task still controls; use the supervisor recovery case without changing the contract."
      : "The node success contract controls; graph/context pointers are evidence, not scope expansion.",
    "Agentflow is runner, not work target.",
    "",
    ...nodeTask,
    "",
    ...managedPrompt,
    ...(managedPrompt.length > 0 ? [""] : []),
    ...supervisorRecoveryEnvelope,
    ...(supervisorRecoveryEnvelope.length > 0 ? [""] : []),
    ...formatWorkspaceContract(invocation),
    "",
    ...graphContext,
    ...(graphContext.length > 0 ? [""] : []),
    ...formatContextContract(invocation, "task"),
    ...(skillContract.length > 0 ? ["", ...skillContract] : []),
    ...(cliContract.length > 0 ? ["", ...cliContract] : []),
    ...(toolContract.length > 0 ? ["", ...toolContract] : []),
    ...formatArtifactContract(invocation.artifacts, invocation.outputDir, invocation.repoPath, invocation.sandbox),
    ...(hasSupervisorRecoveryEnvelope
      ? [
          "- Prior attempt artifacts are evidence only. This retry must publish every current-attempt declared artifact before finishing."
        ]
      : []),
    "",
    ...formatOperatingBrief(invocation)
  ].join("\n");
}
