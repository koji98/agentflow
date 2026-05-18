import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactDefinition } from "../graph/authored.js";
import type { CompiledExecutableNode } from "../graph/compiled.js";
import {
  resolveExecutionAgentAttemptMemoryPath,
  resolveExecutionRuntimeAttemptMemoryPath
} from "../artifacts/paths.js";
import type { RuntimeNodeAttempt } from "./attempts.js";
import type {
  RuntimeMilestone,
  RuntimeMilestoneState
} from "./completion/index.js";
import type {
  SupervisorRecoveryEnvelope,
  SupervisorResumePoint,
  SupervisorWorkspaceDecision
} from "../supervisor/types.js";

export interface AttemptMemoryArtifactState {
  name: string;
  status: "present" | "missing";
  path?: string;
  description: string;
}

export interface AttemptMemoryValidationEvidence {
  command?: string;
  result?: "pass" | "fail" | "blocked";
  summary: string;
}

export interface AttemptMemoryWorkspaceChanges {
  decision: SupervisorWorkspaceDecision;
  changed_files: string[];
  preserved_files: string[];
  reset_files: string[];
}

export interface AttemptMemory {
  version: "1";
  prior_execution_id: string;
  prior_outcome: string;
  failure_summary: string;
  resume_point: SupervisorResumePoint;
  workspace_decision: SupervisorWorkspaceDecision;
  required_next_action: string;
  preserve_progress: string[];
  do_not_redo: string[];
  completed_milestones: string[];
  unfinished_work: string[];
  declared_artifact_state: AttemptMemoryArtifactState[];
  validation_evidence: AttemptMemoryValidationEvidence[];
  workspace_changes: AttemptMemoryWorkspaceChanges;
  evidence_to_read: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile<T>(path: string | undefined): Promise<T | undefined> {
  if (!path) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function safeRuntimeStateSegment(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "execution";
  if (sanitized.length <= 120) {
    return sanitized;
  }
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 16);
  const prefix = sanitized.slice(0, 96).replace(/_+$/g, "") || "execution";
  return `${prefix}_${hash}`;
}

async function readPriorMilestones(priorExecutionId: string, runRoot: string): Promise<RuntimeMilestone[]> {
  const milestonePath = join(runRoot, "runtime", "milestones", `${safeRuntimeStateSegment(priorExecutionId)}.json`);
  const state = await readJsonFile<Partial<RuntimeMilestoneState>>(milestonePath);
  return Array.isArray(state?.milestones)
    ? state.milestones.filter((milestone): milestone is RuntimeMilestone => isRecord(milestone))
    : [];
}

function artifactState(
  definitions: Record<string, ArtifactDefinition>,
  priorAttempt: RuntimeNodeAttempt | undefined
): AttemptMemoryArtifactState[] {
  return Object.entries(definitions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => {
      const path = priorAttempt?.artifacts[name];
      return {
        name,
        status: path ? "present" : "missing",
        ...(path ? { path } : {}),
        description: definition.description
      };
    });
}

function milestoneLabels(milestones: RuntimeMilestone[], status: RuntimeMilestone["status"]): string[] {
  return milestones
    .filter((milestone) => milestone.status === status)
    .map((milestone) => `${milestone.id}: ${milestone.title}`);
}

function validationEvidence(milestones: RuntimeMilestone[]): AttemptMemoryValidationEvidence[] {
  return milestones
    .flatMap((milestone) => milestone.logs)
    .filter((log) => log.kind === "validation")
    .map((log) => ({
      ...(log.command ? { command: log.command } : {}),
      ...(log.result ? { result: log.result } : {}),
      summary: log.summary
    }))
    .slice(-12);
}

function changedFilePaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string") {
      return [item];
    }
    if (isRecord(item) && typeof item.path === "string") {
      return [item.path];
    }
    return [];
  });
}

function isAgentFacingEvidencePath(value: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }
  return !/(^|[/\\])(human-debug|runtime)([/\\]|$)/u.test(value)
    && !/(^|[/\\])agent[/\\](prompt|context|attempt-memory|supervisor-recovery|response)\.md$/u.test(value)
    && !/(^|[/\\])(case-file|recovery-plan|recovery-envelope)\.json$/u.test(value);
}

async function workspaceChanges(priorAttempt: RuntimeNodeAttempt | undefined, decision: SupervisorWorkspaceDecision): Promise<AttemptMemoryWorkspaceChanges> {
  const metadata = isRecord(priorAttempt?.metadata) ? priorAttempt.metadata : {};
  const nodeChanges = isRecord(metadata.node_workspace_changes) ? metadata.node_workspace_changes : {};
  const inlineChangedFiles = changedFilePaths(nodeChanges.changed_files);
  const changedFilesPath = typeof nodeChanges.changed_files_path === "string" ? nodeChanges.changed_files_path : undefined;
  const changedFiles = inlineChangedFiles.length > 0
    ? inlineChangedFiles
    : changedFilePaths(await readJsonFile<unknown>(changedFilesPath));
  const resetFiles = decision === "partial_cleanup" || decision === "reset" ? changedFiles : [];
  const preservedFiles = decision === "preserve" ? changedFiles : changedFiles.filter((file) => !resetFiles.includes(file));

  return {
    decision,
    changed_files: changedFiles,
    preserved_files: preservedFiles,
    reset_files: resetFiles
  };
}

export async function buildAttemptMemory(options: {
  runRoot: string;
  node: CompiledExecutableNode;
  priorAttempt?: RuntimeNodeAttempt;
  recoveryEnvelope: SupervisorRecoveryEnvelope;
}): Promise<AttemptMemory> {
  const priorMilestones = await readPriorMilestones(options.recoveryEnvelope.prior_execution_id, options.runRoot);
  const unfinishedMilestones = [
    ...milestoneLabels(priorMilestones, "active"),
    ...milestoneLabels(priorMilestones, "blocked")
  ];
  const evidenceToRead = [
    ...options.recoveryEnvelope.retry_directive.evidence_to_read,
    ...Object.values(options.priorAttempt?.artifacts ?? {})
  ].filter(isAgentFacingEvidencePath);

  return {
    version: "1",
    prior_execution_id: options.recoveryEnvelope.prior_execution_id,
    prior_outcome: options.priorAttempt?.outcome ?? options.priorAttempt?.status ?? "unknown",
    failure_summary: options.recoveryEnvelope.retry_directive.summary,
    resume_point: options.recoveryEnvelope.resume_point,
    workspace_decision: options.recoveryEnvelope.workspace_decision,
    required_next_action: options.recoveryEnvelope.required_next_action,
    preserve_progress: options.recoveryEnvelope.preserve_progress,
    do_not_redo: options.recoveryEnvelope.do_not_redo,
    completed_milestones: milestoneLabels(priorMilestones, "completed"),
    unfinished_work: unfinishedMilestones,
    declared_artifact_state: artifactState(options.node.declared_artifacts, options.priorAttempt),
    validation_evidence: validationEvidence(priorMilestones),
    workspace_changes: await workspaceChanges(options.priorAttempt, options.recoveryEnvelope.workspace_decision),
    evidence_to_read: [...new Set(evidenceToRead)].slice(0, 20)
  };
}

function markdownCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}

function bulletList(values: string[], empty: string): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : [`- ${empty}`];
}

export function renderAttemptMemoryMarkdown(memory: AttemptMemory): string {
  const artifactRows = memory.declared_artifact_state.length > 0
    ? [
        "| Artifact | Status | Description |",
        "| --- | --- | --- |",
        ...memory.declared_artifact_state.map((artifact) =>
          `| \`${artifact.name}\` | \`${artifact.status}\` | ${markdownCell(artifact.description)} |`
        )
      ]
    : ["No declared artifacts were tracked for the prior attempt."];
  const validationRows = memory.validation_evidence.length > 0
    ? [
        "| Command | Result | Summary |",
        "| --- | --- | --- |",
        ...memory.validation_evidence.map((entry) =>
          `| ${entry.command ? `\`${markdownCell(entry.command)}\`` : ""} | ${entry.result ? `\`${entry.result}\`` : ""} | ${markdownCell(entry.summary)} |`
        )
      ]
    : ["No prior validation evidence was recorded."];

  return [
    "# Attempt Memory",
    "",
    "This is runtime-authored retry memory. Use it to continue the prior attempt without redoing completed in-scope work.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Prior execution | \`${memory.prior_execution_id}\` |`,
    `| Prior outcome | \`${memory.prior_outcome}\` |`,
    `| Resume point | \`${memory.resume_point}\` |`,
    `| Workspace decision | \`${memory.workspace_decision}\` |`,
    `| Failure symptom | ${markdownCell(memory.failure_summary)} |`,
    `| Required next action | ${markdownCell(memory.required_next_action)} |`,
    "",
    "## Preserve Progress",
    ...bulletList(memory.preserve_progress, "No preserved prior progress was identified."),
    "",
    "## Do Not Redo",
    ...bulletList(memory.do_not_redo, "Do not restart from scratch unless prior progress is unsafe or irrelevant."),
    "",
    "## Completed Milestones",
    ...bulletList(memory.completed_milestones, "No prior milestones were completed."),
    "",
    "## Unfinished Work",
    ...bulletList(memory.unfinished_work, "No unfinished milestone state was recorded."),
    "",
    "## Declared Artifact State",
    ...artifactRows,
    "",
    "## Validation Evidence",
    ...validationRows,
    "",
    "## Workspace Changes",
    `- Decision: \`${memory.workspace_changes.decision}\``,
    ...bulletList(memory.workspace_changes.changed_files.map((file) => `Changed: ${file}`), "No changed files were recorded."),
    "",
    "## Evidence To Read",
    ...bulletList(memory.evidence_to_read, "Use current context pointers and artifact status.")
  ].join("\n");
}

export async function writeAttemptMemory(options: {
  executionDir: string;
  memory: AttemptMemory;
}): Promise<{ runtime_path: string; markdown_path: string }> {
  const runtimePath = resolveExecutionRuntimeAttemptMemoryPath(options.executionDir);
  const markdownPath = resolveExecutionAgentAttemptMemoryPath(options.executionDir);
  await mkdir(dirname(runtimePath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(runtimePath, `${JSON.stringify(options.memory, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${renderAttemptMemoryMarkdown(options.memory)}\n`, "utf8");
  return {
    runtime_path: runtimePath,
    markdown_path: markdownPath
  };
}
