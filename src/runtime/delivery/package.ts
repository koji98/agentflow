import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  resolveExecutionHumanDebugHarnessDirectory,
  resolveExecutionRuntimeResultPath,
  resolveRunArtifactPaths
} from "../../artifacts/paths.js";
import type { CompiledGraph } from "../../graph/compiled.js";
import { deliverySections, type DeliverySection } from "../../graph/schema.js";
import type { SupervisorInterventionRecord } from "../../supervisor/types.js";
import type { RuntimeNodeAttempt } from "../attempts.js";
import type { RuntimeEventEnvelope } from "../events.js";
import type { RuntimeStateSnapshot, WorkspaceChangeArtifacts } from "../session.js";
import { operatorObservationsPath } from "../observations/index.js";
import { collectDeliveryEvidence, type DeliveryEvidence } from "./collect.js";
import type { ArtifactPreviewMetadata } from "../../artifacts/metadata.js";
import {
  DeliveryCurationError,
  DeliveryCurationSetupError,
  type DeliveryCurator,
  type DeliveryCurationFinding,
  type DeliveryCurationVerdict,
  type DeliverySourceFailure,
  type DeliverySourcePacket,
  verifyCuratedDelivery
} from "./curation.js";

const sectionFiles: Record<DeliverySection, string> = {
  review_brief: "01-review-brief.md",
  run_learnings: "02-run-learnings.md",
  audit_index: "03-audit-index.md",
  artifact_index: "evidence/artifact-index.json",
  change_map: "evidence/change-map.json",
  validation_ledger: "evidence/validation-ledger.json",
  decision_log: "evidence/decision-log.md",
  intervention_trace: "evidence/intervention-trace.json",
  milestones: "evidence/milestones.json",
  workspace_improvements: "evidence/workspace-improvements.json"
};

const DEFAULT_DELIVERY_CURATION_RETRY_BACKOFF_MS = 60_000;

export interface DeliveryArtifactEntry {
  path: string;
  label: string;
  purpose: string;
  bytes?: number;
  empty?: boolean;
  reason?: string;
}

type AttemptClassification = "final" | "active_failure" | "recovered_issue" | "historical_attempt";
type ArtifactClassification = "final" | "superseded";
type RecommendationPriority = "high" | "medium" | "low";
type RecommendationConfidence = "high" | "medium" | "low";

interface ClassifiedAttempt {
  attempt: RuntimeNodeAttempt;
  classification: AttemptClassification;
  summary: string;
}

interface ArtifactIndexEntry {
  authored_id: string;
  compiled_id: string;
  execution_id: string;
  name: string;
  declared_path: string;
  description: string;
  artifact_path: string;
  content_type: string;
  detected_content_type: string;
  declared_content_type?: string;
  media_kind: string;
  encoding: string;
  size_bytes: number;
  sha256: string;
  preview: ArtifactPreviewMetadata;
  classification: ArtifactClassification;
}

interface WorkspaceImprovementRecommendation {
  area: string;
  recommendation: string;
  evidence: string;
  priority: RecommendationPriority;
  confidence: RecommendationConfidence;
  done_when: string;
}

interface DeliveryModel {
  final_attempts: RuntimeNodeAttempt[];
  classified_attempts: ClassifiedAttempt[];
  active_failures: ClassifiedAttempt[];
  recovered_issues: ClassifiedAttempt[];
  historical_attempts: ClassifiedAttempt[];
  final_artifacts: ArtifactIndexEntry[];
  superseded_artifacts: ArtifactIndexEntry[];
  milestone_validation_logs: Array<{
    execution_id: string;
    milestone_id: string;
    milestone_title: string;
    log_id: string;
    command?: string;
    result?: "pass" | "fail" | "blocked";
    summary: string;
  }>;
  active_blocking_observations: DeliveryEvidence["operator_observations"];
  workspace_recommendations: WorkspaceImprovementRecommendation[];
}

export interface DeliveryPackageManifest {
  run_id: string;
  graph_id: string;
  status: RuntimeStateSnapshot["status"];
  graph_status: RuntimeStateSnapshot["graph_status"];
  delivery_status: RuntimeStateSnapshot["delivery_status"];
  review_ready: boolean;
  evidence_status: RuntimeStateSnapshot["evidence_status"];
  generated_at: string;
  manifest_path: string;
  sections: Record<DeliverySection, string>;
  human_entrypoints: {
    review_brief: string;
    run_learnings: string;
    audit_index: string;
  };
  evidence_files: {
    artifact_index: string;
    change_map: string;
    validation_ledger: string;
    decision_log: string;
    intervention_trace: string;
    milestones: string;
    workspace_improvements: string;
    delivery_source: string;
    delivery_source_markdown: string;
    curation_verdict: string;
    curation_prompt?: string;
    curation_response?: string;
    supervisor_timeline: string;
    runtime_log: string;
    operator_observations: string;
  };
  internal_artifacts: {
    run_record: string;
    state: string;
    events: string;
    interventions: string;
    supervisor_timeline: string;
    runtime_log: string;
    operator_observations: string;
    node_attempts: string;
    workspace_changes: string;
  };
  artifact_taxonomy: {
    human_entrypoints: DeliveryArtifactEntry[];
    declared_artifacts: DeliveryArtifactEntry[];
    resume_required: DeliveryArtifactEntry[];
    audit_trail: DeliveryArtifactEntry[];
    debug_only: DeliveryArtifactEntry[];
    empty_or_noop: DeliveryArtifactEntry[];
  };
  artifact_counts: {
    attempts: number;
    final_attempts: number;
    events: number;
    agent_responses: number;
    final_declared_artifacts: number;
    superseded_declared_artifacts: number;
    tool_invocation_records: number;
    workspace_change_artifacts: number;
    node_workspace_change_artifacts: number;
    operator_observations: number;
    milestones: number;
    milestone_validation_logs: number;
    verifications_passed: number;
    verifications_failed: number;
  };
  intervention_count: number;
  active_failure_count: number;
  recovered_issue_count: number;
  workspace_changed_file_count: number;
  curation: {
    status: "pending" | "passed" | "failed";
    source_path: string;
    source_markdown_path: string;
    verdict_path: string;
    prompt_path?: string;
    response_path?: string;
    failure?: string;
    fallback_reason?: string;
  };
}

function writeJson(filePath: string, payload: unknown): Promise<void> {
  return writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeText(filePath: string, contents: string): Promise<void> {
  return writeFile(filePath, contents.endsWith("\n") ? contents : `${contents}\n`, "utf8");
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetryCuration(verdict: DeliveryCurationVerdict): boolean {
  if (verdict.passed) {
    return false;
  }
  return verdict.findings.some((finding) => finding.retryable !== false);
}

async function fileInfo(filePath: string): Promise<Pick<DeliveryArtifactEntry, "bytes" | "empty">> {
  try {
    const entry = await stat(filePath);
    return {
      bytes: entry.size,
      empty: entry.size === 0
    };
  } catch {
    return {};
  }
}

async function readTrimmed(filePath: string): Promise<string | undefined> {
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch {
    return undefined;
  }
}

async function artifactEntry(options: {
  path: string;
  label: string;
  purpose: string;
  reason?: string;
}): Promise<DeliveryArtifactEntry> {
  const info = await fileInfo(options.path);
  return {
    path: options.path,
    label: options.label,
    purpose: options.purpose,
    ...(info.bytes !== undefined ? { bytes: info.bytes } : {}),
    ...(info.empty !== undefined ? { empty: info.empty } : {}),
    ...(options.reason ? { reason: options.reason } : {})
  };
}

function markdownList(values: string[], emptyText: string): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : [`- ${emptyText}`];
}

function intentList(values: string[] | undefined): string[] {
  return values ?? [];
}

function relativeMarkdownPath(fromDir: string, targetPath: string): string {
  const rel = relative(fromDir, targetPath).split(sep).join("/");
  return rel.length > 0 ? rel : ".";
}

function markdownLink(fromDir: string, label: string, targetPath: string): string {
  return `[${label}](${relativeMarkdownPath(fromDir, targetPath)})`;
}

function formatDuration(startedAt: string, endedAt?: string): string {
  if (!endedAt) {
    return "unknown";
  }
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    return "unknown";
  }
  const ms = ended - started;
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function verificationForAttempt(
  evidence: DeliveryEvidence,
  attempt: RuntimeNodeAttempt
): DeliveryEvidence["outcome_verifications"][number] | undefined {
  return evidence.outcome_verifications.find((entry) => entry.execution_id === attempt.execution_id);
}

function failedCheckForAttempt(
  evidence: DeliveryEvidence,
  attempt: RuntimeNodeAttempt
): DeliveryEvidence["failed_checks"][number] | undefined {
  return evidence.failed_checks.find((entry) => entry.execution_id === attempt.execution_id);
}

function attemptHasFailure(evidence: DeliveryEvidence, attempt: RuntimeNodeAttempt): boolean {
  const verification = verificationForAttempt(evidence, attempt);
  return (
    attempt.status !== "passed"
    || attempt.outcome === "failed"
    || failedCheckForAttempt(evidence, attempt) !== undefined
    || verification?.passed === false
  );
}

function attemptFailureSummary(evidence: DeliveryEvidence, attempt: RuntimeNodeAttempt): string {
  const verification = verificationForAttempt(evidence, attempt);
  const failedCheck = failedCheckForAttempt(evidence, attempt);
  if (verification?.passed === false) {
    return verification.summary;
  }
  if (failedCheck) {
    return failedCheck.summary;
  }
  if (attempt.status !== "passed") {
    return `Attempt ended with status ${attempt.status}.`;
  }
  if (attempt.outcome === "failed") {
    return "Attempt produced a failed graph outcome.";
  }
  return "Attempt completed without active failure evidence.";
}

function buildFinalAttemptIds(evidence: DeliveryEvidence): Set<string> {
  const finalIds = new Set(
    Object.values(evidence.latest_execution_by_compiled_id)
      .map((entry) => entry.execution_id)
      .filter((executionId): executionId is string => typeof executionId === "string")
  );

  const attemptsByCompiled = new Map<string, RuntimeNodeAttempt[]>();
  for (const attempt of evidence.attempts) {
    attemptsByCompiled.set(attempt.compiled_id, [...(attemptsByCompiled.get(attempt.compiled_id) ?? []), attempt]);
  }

  for (const [compiledId, attempts] of attemptsByCompiled) {
    if (attempts.some((attempt) => finalIds.has(attempt.execution_id))) {
      continue;
    }
    const latest = attempts.at(-1);
    if (latest) {
      finalIds.add(latest.execution_id);
    } else if (evidence.latest_execution_by_compiled_id[compiledId]?.execution_id) {
      finalIds.add(evidence.latest_execution_by_compiled_id[compiledId].execution_id);
    }
  }

  return finalIds;
}

function buildMilestoneValidationLogs(evidence: DeliveryEvidence): DeliveryModel["milestone_validation_logs"] {
  return evidence.milestone_states.flatMap((state) =>
    state.milestones.flatMap((milestone) =>
      milestone.logs
        .filter((log) => log.kind === "validation")
        .map((log) => ({
          execution_id: state.execution_id,
          milestone_id: milestone.id,
          milestone_title: milestone.title,
          log_id: log.log_id,
          ...(log.command ? { command: log.command } : {}),
          ...(log.result ? { result: log.result } : {}),
          summary: log.summary
        }))
    )
  );
}

function buildWorkspaceRecommendations(
  evidence: DeliveryEvidence,
  activeFailures: ClassifiedAttempt[],
  recoveredIssues: ClassifiedAttempt[],
  validationLogs: DeliveryModel["milestone_validation_logs"]
): WorkspaceImprovementRecommendation[] {
  const recommendations: WorkspaceImprovementRecommendation[] = [];

  if (activeFailures.length > 0) {
    recommendations.push({
      area: "workflow",
      recommendation: "Resolve active terminal failures before relying on this run's output.",
      evidence: activeFailures.map((entry) => `${entry.attempt.authored_id}:${entry.attempt.execution_dir}`).join(", "),
      priority: "high",
      confidence: "high",
      done_when: "The failing node or blocker has a passing final attempt and no active blocking observation remains."
    });
  }

  if (recoveredIssues.length > 0) {
    recommendations.push({
      area: "graph",
      recommendation: "Review failed-then-recovered attempts for missing context, brittle checks, or oversized node scope.",
      evidence: recoveredIssues.map((entry) => `${entry.attempt.authored_id}:${entry.attempt.execution_dir}`).join(", "),
      priority: "medium",
      confidence: "medium",
      done_when: "The next comparable run completes without the same supervisor recovery or failed first attempt."
    });
  }

  if (evidence.milestone_states.length === 0 && evidence.attempts.some((attempt) => attempt.kind === "agent")) {
    recommendations.push({
      area: "agent evidence",
      recommendation: "Ensure agent nodes create milestone evidence so future reviewers can audit decisions and validation.",
      evidence: "No runtime milestone files were captured.",
      priority: "medium",
      confidence: "high",
      done_when: "Agent runs include completed milestones with finding, decision, and validation logs."
    });
  }

  if (validationLogs.length === 0 && evidence.attempts.some((attempt) => attempt.kind === "agent")) {
    recommendations.push({
      area: "validation",
      recommendation: "Record validation commands in milestone logs when a node changes code or publishes handoff artifacts.",
      evidence: "No milestone validation logs were captured.",
      priority: "medium",
      confidence: "medium",
      done_when: "Review briefs show the commands or checks used to prove the work."
    });
  }

  const activeBlockingObservations = evidence.operator_observations.filter((observation) =>
    observation.status === "active" && (observation.kind === "blocker" || observation.blocking === true)
  );
  if (activeBlockingObservations.length > 0) {
    recommendations.push({
      area: "workspace",
      recommendation: "Clear active human blockers or encode them as graph context/checks before rerunning.",
      evidence: activeBlockingObservations.map((observation) => observation.observation_id).join(", "),
      priority: "high",
      confidence: "high",
      done_when: "The blocker is resolved or represented as an explicit graph gate."
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      area: "none",
      recommendation: "No concrete workspace improvement was inferred from this run.",
      evidence: "Run reached terminal state without active failures, recovered failures, active blockers, or missing milestone validation.",
      priority: "low",
      confidence: "medium",
      done_when: "No action required unless human review identifies missing context, docs, tests, or tooling."
    });
  }

  return recommendations;
}

function buildDeliveryModel(evidence: DeliveryEvidence): DeliveryModel {
  const finalAttemptIds = buildFinalAttemptIds(evidence);
  const finalAttemptByCompiledId = new Map<string, RuntimeNodeAttempt>();
  for (const attempt of evidence.attempts) {
    if (finalAttemptIds.has(attempt.execution_id)) {
      finalAttemptByCompiledId.set(attempt.compiled_id, attempt);
    }
  }
  const classifiedAttempts = evidence.attempts.map((attempt): ClassifiedAttempt => {
    const isFinal = finalAttemptIds.has(attempt.execution_id);
    const hasFailure = attemptHasFailure(evidence, attempt);
    const finalAttempt = finalAttemptByCompiledId.get(attempt.compiled_id);
    const finalRecoveredThisNode = finalAttempt !== undefined && !attemptHasFailure(evidence, finalAttempt);
    const classification: AttemptClassification = isFinal
      ? hasFailure ? "active_failure" : "final"
      : hasFailure && finalRecoveredThisNode ? "recovered_issue" : "historical_attempt";
    return {
      attempt,
      classification,
      summary: attemptFailureSummary(evidence, attempt)
    };
  });
  const finalAttempts = evidence.attempts.filter((attempt) => finalAttemptIds.has(attempt.execution_id));
  const activeFailures = classifiedAttempts.filter((entry) => entry.classification === "active_failure");
  const recoveredIssues = classifiedAttempts.filter((entry) => entry.classification === "recovered_issue");
  const historicalAttempts = classifiedAttempts.filter((entry) => entry.classification === "historical_attempt");
  const finalArtifacts = evidence.declared_artifacts
    .filter((artifact) => finalAttemptIds.has(artifact.execution_id))
    .map((artifact) => ({
      authored_id: artifact.authored_id,
      compiled_id: artifact.compiled_id,
      execution_id: artifact.execution_id,
      name: artifact.name,
      declared_path: artifact.path,
      description: artifact.description,
      artifact_path: artifact.artifact_path,
      content_type: artifact.content_type,
      detected_content_type: artifact.detected_content_type,
      ...(artifact.declared_content_type ? { declared_content_type: artifact.declared_content_type } : {}),
      media_kind: artifact.media_kind,
      encoding: artifact.encoding,
      size_bytes: artifact.size_bytes,
      sha256: artifact.sha256,
      preview: artifact.preview,
      classification: "final" as const
    }));
  const supersededArtifacts = evidence.declared_artifacts
    .filter((artifact) => !finalAttemptIds.has(artifact.execution_id))
    .map((artifact) => ({
      authored_id: artifact.authored_id,
      compiled_id: artifact.compiled_id,
      execution_id: artifact.execution_id,
      name: artifact.name,
      declared_path: artifact.path,
      description: artifact.description,
      artifact_path: artifact.artifact_path,
      content_type: artifact.content_type,
      detected_content_type: artifact.detected_content_type,
      ...(artifact.declared_content_type ? { declared_content_type: artifact.declared_content_type } : {}),
      media_kind: artifact.media_kind,
      encoding: artifact.encoding,
      size_bytes: artifact.size_bytes,
      sha256: artifact.sha256,
      preview: artifact.preview,
      classification: "superseded" as const
    }));
  const milestoneValidationLogs = buildMilestoneValidationLogs(evidence);
  const activeBlockingObservations = evidence.operator_observations.filter((observation) =>
    observation.status === "active" && (observation.kind === "blocker" || observation.blocking === true)
  );

  return {
    final_attempts: finalAttempts,
    classified_attempts: classifiedAttempts,
    active_failures: activeFailures,
    recovered_issues: recoveredIssues,
    historical_attempts: historicalAttempts,
    final_artifacts: finalArtifacts,
    superseded_artifacts: supersededArtifacts,
    milestone_validation_logs: milestoneValidationLogs,
    active_blocking_observations: activeBlockingObservations,
    workspace_recommendations: buildWorkspaceRecommendations(
      evidence,
      activeFailures,
      recoveredIssues,
      milestoneValidationLogs
    )
  };
}

function deliveryEvidencePath(deliveryDir: string, fileName: string): string {
  return join(deliveryDir, "evidence", fileName);
}

function sourceArtifactEntry(
  artifact: ArtifactIndexEntry,
  deliveryDir: string
): DeliverySourcePacket["final_declared_artifacts"][number] {
  return {
    id: `${artifact.authored_id}.${artifact.name}`,
    node: artifact.authored_id,
    name: artifact.name,
    description: artifact.description,
    declared_path: artifact.declared_path,
    absolute_path: artifact.artifact_path,
    relative_path: relativeMarkdownPath(deliveryDir, artifact.artifact_path),
    content_type: artifact.content_type,
    detected_content_type: artifact.detected_content_type,
    ...(artifact.declared_content_type ? { declared_content_type: artifact.declared_content_type } : {}),
    media_kind: artifact.media_kind,
    encoding: artifact.encoding,
    size_bytes: artifact.size_bytes,
    sha256: artifact.sha256,
    preview: artifact.preview
  };
}

function sourceFailure(
  entry: ClassifiedAttempt,
  deliveryDir: string
): DeliverySourcePacket["failures"]["active"][number] {
  return {
    node: entry.attempt.authored_id,
    execution_id: entry.attempt.execution_id,
    attempt_path: entry.attempt.execution_dir,
    attempt_relative_path: relativeMarkdownPath(deliveryDir, entry.attempt.execution_dir),
    status: `${entry.attempt.status}${entry.attempt.outcome ? `/${entry.attempt.outcome}` : ""}`,
    summary: sanitizeDeliveryEvidenceText(entry.summary)
  };
}

function attemptPathForExecution(
  evidence: DeliveryEvidence,
  deliveryDir: string,
  executionId: string
): { attempt_path?: string; attempt_relative_path?: string } {
  const attempt = evidence.attempts.find((candidate) => candidate.execution_id === executionId);
  return attempt
    ? {
        attempt_path: attempt.execution_dir,
        attempt_relative_path: relativeMarkdownPath(deliveryDir, attempt.execution_dir)
      }
    : {};
}

function sanitizeDeliveryEvidenceText(value: string): string {
  return value
    .replace(/\bhuman-debug\b/giu, "debug/audit evidence")
    .replace(/\.(?:task-runtime|agentflow)\/runs\/[^\s)]+/giu, "run audit evidence")
    .replace(/\/private\/tmp\/[^\s)]+/giu, "temporary run path");
}

function sanitizeDeliveryCommand(value: string): string {
  const parts = value.trim().split(/\s+/u);
  const prefixOffset = parts[0] === "env" ? 1 : 0;
  const commandStart = parts.findIndex((part, index) => index >= prefixOffset && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(part));
  return commandStart >= prefixOffset && commandStart >= 0 ? parts.slice(commandStart).join(" ") : value;
}

function sanitizeDeliveryInterventionReason(intervention: SupervisorInterventionRecord): string {
  const reason = sanitizeDeliveryEvidenceText(intervention.reason).trim();
  if (
    reason.length > 500
    || /^OpenAI Codex\b/u.test(reason)
    || reason.includes("\n--------\n")
    || reason.includes("\nuser\n## Role")
  ) {
    return `${intervention.action} intervention details are available in the intervention trace.`;
  }
  return reason;
}

function buildDeliverySourcePacket(options: {
  manifest: DeliveryPackageManifest;
  evidence: DeliveryEvidence;
  model: DeliveryModel;
  deliveryDir: string;
}): DeliverySourcePacket {
  const { manifest, evidence, model, deliveryDir } = options;
  return {
    version: "1",
    run: {
      run_id: evidence.run_id,
      graph_id: evidence.graph_id,
      status: evidence.status,
      evidence_status: evidence.evidence_status,
      duration: formatDuration(evidence.started_at, evidence.ended_at)
    },
    intent: {
      goal: evidence.intent.goal,
      acceptance_criteria: intentList(evidence.intent.acceptance_criteria),
      constraints: intentList(evidence.intent.constraints)
    },
    counts: {
      final_attempts: model.final_attempts.length,
      active_failures: model.active_failures.length + model.active_blocking_observations.length,
      recovered_issues: model.recovered_issues.length,
      supervisor_interventions: evidence.interventions.length,
      changed_files: manifest.workspace_changed_file_count
    },
    final_declared_artifacts: model.final_artifacts.map((artifact) => sourceArtifactEntry(artifact, deliveryDir)),
    superseded_declared_artifacts: model.superseded_artifacts.map((artifact) => sourceArtifactEntry(artifact, deliveryDir)),
    changed_files: evidence.workspace_changes.map((change) => ({
      repo: change.repo_alias,
      workspace_path: change.workspace_path,
      files: change.changed_files
    })),
    node_changed_files: evidence.node_workspace_changes.map((entry) => ({
      node: entry.authored_id,
      execution_id: entry.execution_id,
      ...attemptPathForExecution(evidence, deliveryDir, entry.execution_id),
      diff_path: relativeMarkdownPath(deliveryDir, entry.artifacts.diff_patch_path),
      changed_files_path: relativeMarkdownPath(deliveryDir, entry.artifacts.changed_files_path),
      files: entry.changed_files
    })),
    validation: {
      milestone_validation_logs: model.milestone_validation_logs.map((log) => ({
        execution_id: log.execution_id,
        ...attemptPathForExecution(evidence, deliveryDir, log.execution_id),
        milestone_id: log.milestone_id,
        ...(log.command ? { command: sanitizeDeliveryCommand(log.command) } : {}),
        ...(log.result ? { result: log.result } : {}),
        summary: sanitizeDeliveryEvidenceText(log.summary)
      })),
      outcome_verifications: evidence.outcome_verifications.map((entry) => ({
        node: entry.authored_id,
        execution_id: entry.execution_id,
        ...attemptPathForExecution(evidence, deliveryDir, entry.execution_id),
        passed: entry.passed,
        summary: sanitizeDeliveryEvidenceText(entry.summary),
        findings_count: entry.findings_count,
        blockers_count: entry.blockers_count,
        evidence_path: relativeMarkdownPath(deliveryDir, manifest.evidence_files.validation_ledger),
        verifier_evidence_path: relativeMarkdownPath(deliveryDir, entry.verify_outcome_markdown_path)
      }))
    },
    failures: {
      active: [
        ...model.active_failures.map((entry) => sourceFailure(entry, deliveryDir)),
        ...model.active_blocking_observations.map((observation) => ({
          node: observation.observation_id,
          execution_id: observation.observation_id,
          status: observation.status,
          summary: sanitizeDeliveryEvidenceText(observation.message)
        }))
      ],
      recovered: model.recovered_issues.map((entry) => sourceFailure(entry, deliveryDir)),
      historical: model.historical_attempts.map((entry) => sourceFailure(entry, deliveryDir))
    },
    interventions: evidence.interventions.map((intervention) => ({
      action: intervention.action,
      ...(intervention.target_compiled_id ? { target: intervention.target_compiled_id } : {}),
      reason: sanitizeDeliveryInterventionReason(intervention)
    })),
    workspace_improvements: model.workspace_recommendations,
    evidence_links: {
      artifact_index: relativeMarkdownPath(deliveryDir, manifest.evidence_files.artifact_index),
      change_map: relativeMarkdownPath(deliveryDir, manifest.evidence_files.change_map),
      validation_ledger: relativeMarkdownPath(deliveryDir, manifest.evidence_files.validation_ledger),
      decision_log: relativeMarkdownPath(deliveryDir, manifest.evidence_files.decision_log),
      intervention_trace: relativeMarkdownPath(deliveryDir, manifest.evidence_files.intervention_trace),
      milestones: relativeMarkdownPath(deliveryDir, manifest.evidence_files.milestones),
      workspace_improvements: relativeMarkdownPath(deliveryDir, manifest.evidence_files.workspace_improvements),
      audit_index: relativeMarkdownPath(deliveryDir, manifest.human_entrypoints.audit_index)
    }
  };
}

function renderDeliverySourceMarkdown(source: DeliverySourcePacket): string {
  const lines = [
    "# Delivery Source",
    "",
    "This runtime-authored packet is the evidence source for the AI-curated human delivery files.",
    "",
    "## Run",
    "",
    `- Run: \`${source.run.run_id}\``,
    `- Graph: \`${source.run.graph_id}\``,
    `- Status: \`${source.run.status}\``,
    `- Evidence status: \`${source.run.evidence_status}\``,
    `- Duration: \`${source.run.duration}\``,
    "",
    "## Success Contract",
    "",
    source.intent.goal,
    "",
    "Acceptance criteria:",
    ...markdownList(source.intent.acceptance_criteria, "No explicit acceptance criteria were authored."),
    "",
    "Constraints:",
    ...markdownList(source.intent.constraints, "No explicit constraints were authored."),
    "",
    "## Final Declared Artifacts",
    "",
    ...(source.final_declared_artifacts.length > 0
      ? [
          "| Artifact | Description | Type | Path |",
          "| --- | --- | --- | --- |",
          ...source.final_declared_artifacts.map((artifact) =>
            `| \`${artifact.id}\` | ${artifact.description} | \`${artifact.content_type}\` | [${artifact.declared_path}](${artifact.relative_path}) |`
          )
        ]
      : ["- No final declared artifacts were captured."]),
    "",
    "## Changed Files",
    "",
    ...(source.changed_files.length > 0
      ? source.changed_files.flatMap((change) => [
          `### ${change.repo}`,
          "",
          ...markdownList(change.files.map((file) => `\`${file}\``), "No changed files were captured."),
          ""
        ])
      : ["- No workspace change captures were recorded."]),
    "",
    "### Node Change Evidence",
    "",
    ...(source.node_changed_files.length > 0
      ? source.node_changed_files.flatMap((change) => [
          `- \`${change.node}\` (${change.execution_id}): ${change.files.length} changed file(s). Diff: [patch](${change.diff_path}); files: [json](${change.changed_files_path}).`,
          ...change.files.map((file) => `  - \`${file.path}\` (${file.change_kind})`)
        ])
      : ["- No per-node change snapshots were recorded."]),
    "",
    "## Validation",
    "",
    ...(source.validation.milestone_validation_logs.length > 0
      ? [
          "| Source | Attempt | Result | Command | Summary |",
          "| --- | --- | --- | --- | --- |",
          ...source.validation.milestone_validation_logs.map((log) =>
            `| \`${log.milestone_id}\` | ${log.attempt_relative_path ? `[attempt](${log.attempt_relative_path})` : "not recorded"} | \`${log.result ?? "recorded"}\` | ${log.command ? `\`${log.command}\`` : "not specified"} | ${log.summary} |`
          )
        ]
      : ["- No milestone validation logs were captured."]),
    "",
    ...(source.validation.outcome_verifications.length > 0
      ? [
          "| Node | Attempt | Result | Evidence | Summary |",
          "| --- | --- | --- | --- | --- |",
          ...source.validation.outcome_verifications.map((entry) =>
            `| \`${entry.node}\` | ${entry.attempt_relative_path ? `[attempt](${entry.attempt_relative_path})` : "not recorded"} | \`${entry.passed ? "pass" : "fail"}\` | [validation ledger](${entry.evidence_path}) | ${entry.summary} |`
          )
        ]
      : ["- No outcome verifications were captured."]),
    "",
    "## Active Failures",
    "",
    ...markdownList(source.failures.active.map((failure) => `${sourceFailureLabel(failure)}: ${failure.summary}`), "No active failures remain."),
    "",
    "## Recovered Issues",
    "",
    ...markdownList(source.failures.recovered.map((failure) => `${sourceFailureLabel(failure)}: ${failure.summary}`), "No recovered issues were recorded."),
    "",
    "## Historical Attempts",
    "",
    ...markdownList(source.failures.historical.map((failure) => `${sourceFailureLabel(failure)}: ${failure.summary}`), "No historical attempts require reviewer action."),
    "",
    "## Interventions",
    "",
    ...markdownList(source.interventions.map((intervention) => `\`${intervention.action}\`: ${intervention.reason}`), "No supervisor or human interventions were recorded."),
    "",
    "## Workspace Improvements",
    "",
    "| Area | Recommendation | Evidence | Priority | Confidence | Done When |",
    "| --- | --- | --- | --- | --- | --- |",
    ...source.workspace_improvements.map((entry) =>
      `| ${entry.area} | ${entry.recommendation} | ${entry.evidence} | ${entry.priority} | ${entry.confidence} | ${entry.done_when} |`
    ),
    "",
    "## Evidence Links",
    "",
    ...Object.entries(source.evidence_links).map(([label, path]) => `- [${label.replace(/_/gu, " ")}](${path})`)
  ];
  return lines.join("\n");
}

function sourceFailureLabel(failure: DeliverySourceFailure): string {
  return failure.attempt_relative_path
    ? `\`${failure.node}\` ([attempt](${failure.attempt_relative_path}))`
    : `\`${failure.node}\``;
}

function renderAttemptTable(
  attempts: ClassifiedAttempt[],
  emptyText: string,
  deliveryDir: string
): string[] {
  if (attempts.length === 0) {
    return [`- ${emptyText}`];
  }

  return [
    "| Node | Attempt | Execution ID | Status | Summary |",
    "| --- | --- | --- | --- | --- |",
    ...attempts.map((entry) =>
      `| \`${entry.attempt.authored_id}\` | ${markdownLink(deliveryDir, "attempt", entry.attempt.execution_dir)} | \`${entry.attempt.execution_id}\` | \`${entry.attempt.status}${entry.attempt.outcome ? `/${entry.attempt.outcome}` : ""}\` | ${entry.summary} |`
    )
  ];
}

function renderAuditIndex(
  manifest: DeliveryPackageManifest,
  evidence: DeliveryEvidence,
  model: DeliveryModel,
  deliveryDir: string
): string {
  const attemptByExecutionId = new Map(evidence.attempts.map((attempt) => [attempt.execution_id, attempt]));
  const contextRows = evidence.attempts.flatMap((attempt) =>
    attempt.context_packet_path
      ? [`| \`${attempt.authored_id}\` | ${markdownLink(deliveryDir, "attempt", attempt.execution_dir)} | \`${attempt.execution_id}\` | ${markdownLink(deliveryDir, "runtime context", attempt.context_packet_path)} |`]
      : []
  );
  const toolRows = evidence.tool_invocations.map((entry) => {
    const attempt = attemptByExecutionId.get(entry.execution_id);
    return `| \`${entry.authored_id}\` | ${attempt ? markdownLink(deliveryDir, "attempt", attempt.execution_dir) : "not recorded"} | \`${entry.execution_id}\` | ${entry.records.length} | ${markdownLink(deliveryDir, "ledger", entry.invocation_path)} |`;
  });
  const milestoneRows = evidence.milestone_states.map((entry) => {
    const attempt = attemptByExecutionId.get(entry.execution_id);
    return `| ${attempt ? markdownLink(deliveryDir, "attempt", attempt.execution_dir) : "not recorded"} | \`${entry.execution_id}\` | ${entry.milestones.length} | ${markdownLink(deliveryDir, "milestone file", entry.path)} |`;
  });

  return [
    "# Audit Index",
    "",
    "This file maps raw evidence. Use it when debugging, auditing recovery behavior, or inspecting a specific node attempt.",
    "",
    "## Human Entry Points",
    "",
    `1. ${markdownLink(deliveryDir, "Review brief", manifest.human_entrypoints.review_brief)}`,
    `2. ${markdownLink(deliveryDir, "Run learnings", manifest.human_entrypoints.run_learnings)}`,
    `3. ${markdownLink(deliveryDir, "Audit index", manifest.human_entrypoints.audit_index)}`,
    "",
    "## Final Attempts",
    "",
    ...renderAttemptTable(
      model.classified_attempts.filter((entry) => entry.classification === "final" || entry.classification === "active_failure"),
      "No final attempts were recorded.",
      deliveryDir
    ),
    "",
    "## Superseded Attempts",
    "",
    ...renderAttemptTable(
      [...model.recovered_issues, ...model.historical_attempts],
      "No superseded attempts were recorded.",
      deliveryDir
    ),
    "",
    "## Context Runtime State",
    "",
    ...(contextRows.length > 0
      ? ["| Node | Attempt | Execution ID | Runtime Context |", "| --- | --- | --- | --- |", ...contextRows]
      : ["- No runtime context files were referenced by attempts."]),
    "",
    "## Managed Tool Ledgers",
    "",
    ...(toolRows.length > 0
      ? ["| Node | Attempt | Execution ID | Records | Ledger |", "| --- | --- | --- | --- | --- |", ...toolRows]
      : ["- No managed tool invocation ledgers were recorded."]),
    "",
    "## Milestones",
    "",
    ...(milestoneRows.length > 0
      ? ["| Attempt | Execution ID | Milestones | File |", "| --- | --- | --- | --- |", ...milestoneRows]
      : ["- No milestone files were recorded."]),
    "",
    "## Raw Ledgers",
    "",
    `- ${markdownLink(deliveryDir, "Events", manifest.internal_artifacts.events)}`,
    `- ${markdownLink(deliveryDir, "Runtime state", manifest.internal_artifacts.state)}`,
    `- ${markdownLink(deliveryDir, "Supervisor timeline", manifest.evidence_files.supervisor_timeline)}`,
    `- ${markdownLink(deliveryDir, "Runtime log", manifest.evidence_files.runtime_log)}`,
    `- ${markdownLink(deliveryDir, "Human observations", manifest.evidence_files.operator_observations)}`,
    `- ${markdownLink(deliveryDir, "Interventions", manifest.internal_artifacts.interventions)}`,
    `- ${markdownLink(deliveryDir, "Node attempts", manifest.internal_artifacts.node_attempts)}`,
    `- ${markdownLink(deliveryDir, "Workspace changes", manifest.internal_artifacts.workspace_changes)}`,
    "",
    "## Evidence Files",
    "",
    `- ${markdownLink(deliveryDir, "Artifact index", manifest.evidence_files.artifact_index)}`,
    `- ${markdownLink(deliveryDir, "Change map", manifest.evidence_files.change_map)}`,
    `- ${markdownLink(deliveryDir, "Validation ledger", manifest.evidence_files.validation_ledger)}`,
    `- ${markdownLink(deliveryDir, "Decision log", manifest.evidence_files.decision_log)}`,
    `- ${markdownLink(deliveryDir, "Intervention trace", manifest.evidence_files.intervention_trace)}`,
    `- ${markdownLink(deliveryDir, "Milestones", manifest.evidence_files.milestones)}`,
    `- ${markdownLink(deliveryDir, "Workspace improvements", manifest.evidence_files.workspace_improvements)}`
  ].join("\n");
}

function renderDecisionLog(evidence: DeliveryEvidence, model: DeliveryModel): string {
  const lines = [
    "# Decision Log",
    "",
    "## Run",
    "",
    `- Goal: ${evidence.intent.goal}`,
    `- Final status: \`${evidence.status}\``,
    `- Evidence status: \`${evidence.evidence_status}\``,
    `- Attempts recorded: \`${evidence.attempts.length}\``,
    `- Supervisor interventions: \`${evidence.interventions.length}\``,
    ""
  ];

  lines.push("## Attempts", "");
  if (model.classified_attempts.length === 0) {
    lines.push("- No node executions were recorded.", "");
  } else {
    for (const entry of model.classified_attempts) {
      const attempt = entry.attempt;
      const declaredArtifacts = evidence.declared_artifacts
        .filter((artifact) => artifact.execution_id === attempt.execution_id)
        .map((artifact) => artifact.name)
        .sort();
      const toolInvocationCount = evidence.tool_invocations
        .filter((toolEntry) => toolEntry.execution_id === attempt.execution_id)
        .reduce((sum, toolEntry) => sum + toolEntry.records.length, 0);

      lines.push(`### ${attempt.authored_id}`, "");
      lines.push(`- Attempt path: \`${attempt.execution_dir}\``);
      lines.push(`- Execution ID: \`${attempt.execution_id}\``);
      lines.push(`- Classification: \`${entry.classification}\``);
      lines.push(`- Kind: \`${attempt.kind}\``);
      lines.push(`- Status: \`${attempt.status}\`${attempt.outcome ? `, outcome: \`${attempt.outcome}\`` : ""}`);
      if (attempt.duration_ms !== undefined) {
        lines.push(`- Duration: \`${attempt.duration_ms}ms\``);
      }
      if (declaredArtifacts.length > 0) {
        lines.push(`- Published declared artifacts: ${declaredArtifacts.map((name) => `\`${name}\``).join(", ")}.`);
      }
      if (toolInvocationCount > 0) {
        lines.push(`- Runtime-provided tool invocations recorded: \`${toolInvocationCount}\`.`);
      }
      lines.push(`- Summary: ${entry.summary}`, "");
    }
  }

  if (evidence.supervisor_timeline.length > 0) {
    lines.push("## Supervisor Timeline", "");
    for (const decision of evidence.supervisor_timeline) {
      lines.push(`- \`${decision.action ?? decision.kind}\` on \`${decision.target_compiled_id ?? "run"}\`: ${decision.reason}`);
    }
    lines.push("");
  }

  if (evidence.runtime_logs.length > 0) {
    lines.push("## Worker Runtime Logs", "");
    for (const entry of evidence.runtime_logs) {
      lines.push(`- \`${String(entry.type ?? "progress")}\`: ${String(entry.summary ?? "")}`);
    }
    lines.push("");
  }

  if (evidence.operator_observations.length > 0) {
    lines.push("## Human Observations", "");
    for (const observation of evidence.operator_observations) {
      lines.push(`- \`${observation.status}\` \`${observation.kind}\` by \`${observation.author}\`: ${observation.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildChangeMap(workspaceChanges: WorkspaceChangeArtifacts[]): Array<{
  repo_alias: string;
  workspace_path: string;
  changed_files: string[];
  artifacts: {
    status_file: string;
    diff_file: string;
    changed_files_file: string;
    capture_error_file?: string;
  };
}> {
  return workspaceChanges.map((artifact) => ({
    repo_alias: artifact.repo_alias,
    workspace_path: artifact.workspace_path,
    changed_files: artifact.changed_files,
    artifacts: {
      status_file: artifact.status_file,
      diff_file: artifact.diff_file,
      changed_files_file: artifact.changed_files_file,
      ...(artifact.capture_error_file ? { capture_error_file: artifact.capture_error_file } : {})
    }
  }));
}

async function buildArtifactTaxonomy(options: {
  evidence: DeliveryEvidence;
  model: DeliveryModel;
  runRoot: string;
  sections: Record<DeliverySection, string>;
}): Promise<DeliveryPackageManifest["artifact_taxonomy"]> {
  const { evidence, model, runRoot, sections } = options;
  const runPaths = resolveRunArtifactPaths(runRoot);
  const deliveryDir = join(runRoot, "delivery");
  const humanEntryPoints = await Promise.all([
    artifactEntry({
      path: sections.review_brief,
      label: "Review brief",
      purpose: "Start here for outcome, changed files, final artifacts, validation, risks, and recovered issues."
    }),
    artifactEntry({
      path: sections.run_learnings,
      label: "Run learnings",
      purpose: "Future-run lessons, workspace improvement candidates, and eval/plugin/skill extraction hints."
    }),
    artifactEntry({
      path: sections.audit_index,
      label: "Audit index",
      purpose: "Map to raw run evidence for debugging, trace inspection, and recovery audits."
    })
  ]);
  const declaredArtifacts = await Promise.all(
    model.final_artifacts.map((artifact) =>
      artifactEntry({
        path: artifact.artifact_path,
        label: `${artifact.authored_id}.${artifact.name}`,
        purpose: artifact.description
      })
    )
  );
  const resumeRequired = await Promise.all([
    artifactEntry({
      path: runPaths.run_file,
      label: "Run record",
      purpose: "Stable run identity, launch profile, workspace backend, and terminal status used by inspect/resume."
    }),
    artifactEntry({
      path: runPaths.authored_graph_file,
      label: "Authored graph snapshot",
      purpose: "Exact authored graph contract captured at launch."
    }),
    artifactEntry({
      path: runPaths.compiled_graph_file,
      label: "Compiled graph snapshot",
      purpose: "Resolved executable graph contract used by runtime and resume checks."
    }),
    artifactEntry({
      path: runPaths.execution_manifest_file,
      label: "Execution manifest",
      purpose: "Resolved repo workspaces, node policies, and launch metadata."
    }),
    artifactEntry({
      path: runPaths.state_file,
      label: "Runtime state",
      purpose: "Latest scheduler state and node statuses required for resume."
    })
  ]);
  const toolInvocationEntries = await Promise.all(
    evidence.tool_invocations.map((entry) =>
      artifactEntry({
        path: entry.invocation_path,
        label: `${entry.authored_id} tool invocation ledger`,
        purpose: "Canonical JSONL ledger of runtime-provided `af` and plugin tool calls for this execution."
      })
    )
  );
  const outcomeVerificationEntries = await Promise.all(
    evidence.outcome_verifications.flatMap((entry) => [
      artifactEntry({
        path: entry.verify_outcome_markdown_path,
        label: `${entry.authored_id} outcome verification (${entry.passed ? "passed" : "failed"})`,
        purpose: "Outcome verifier verdict, summary, and findings rendered for review."
      }),
      artifactEntry({
        path: entry.verify_outcome_json_path,
        label: `${entry.authored_id} outcome verification JSON`,
        purpose: "Outcome verifier verdict, findings, and verifier metadata in machine-readable form."
      })
    ])
  );
  const nodeWorkspaceChangeEntries = await Promise.all(
    evidence.node_workspace_changes.map((entry) =>
      artifactEntry({
        path: entry.artifacts.diff_patch_path,
        label: `${entry.authored_id} node workspace diff (attempt ${entry.attempt_index})`,
        purpose: "Per-attempt workspace diff captured against the pre-execution baseline."
      })
    )
  );
  const interventionArtifactEntries = await Promise.all(
    evidence.interventions.flatMap((intervention) =>
      Object.entries(intervention.artifact_paths)
        .filter(([key]) => key !== "intervention_dir")
        .map(([key, path]) =>
          artifactEntry({
            path,
            label: `${intervention.action} ${key}`,
            purpose: `Supervisor intervention artifact for ${intervention.target_compiled_id ?? "unknown node"} (${intervention.intervention_id}).`
          })
        )
    )
  );
  const auditTrail = await Promise.all([
    artifactEntry({
      path: runPaths.events_file,
      label: "Runtime event ledger",
      purpose: "Append-only lifecycle event stream for replay, audit, and debugging."
    }),
    artifactEntry({
      path: runPaths.supervisor_timeline_file,
      label: "Supervisor timeline",
      purpose: "Append-only supervisor health and decision records."
    }),
    artifactEntry({
      path: runPaths.runtime_log_file,
      label: "Worker runtime log",
      purpose: "Worker milestone evidence recorded during node execution."
    }),
    artifactEntry({
      path: operatorObservationsPath(runRoot),
      label: "Human observation ledger",
      purpose: "Append-only live human observation records that can influence completion without pausing the run."
    }),
    artifactEntry({
      path: runPaths.interventions_file,
      label: "Supervisor intervention ledger",
      purpose: "Append-only supervisor intervention records."
    }),
    artifactEntry({
      path: runPaths.nodes_dir,
      label: "Node attempt tree",
      purpose: "Per-node execution metadata, artifacts, logs, context, and tool invocation ledgers."
    }),
    artifactEntry({
      path: runPaths.workspace_changes_dir,
      label: "Workspace change captures",
      purpose: "Git status, diffs, and changed-file lists used for review/apply workflows."
    }),
    ...deliverySections
      .filter((section) => !["review_brief", "run_learnings", "audit_index"].includes(section))
      .map((section) =>
        artifactEntry({
          path: sections[section],
          label: section.replace(/_/gu, " "),
          purpose: "Delivery evidence file referenced by the manifest and audit index."
        })
      ),
    artifactEntry({
      path: deliveryEvidencePath(deliveryDir, "delivery-source.json"),
      label: "delivery source",
      purpose: "Runtime-authored source packet used by the delivery curator and verifier."
    }),
    artifactEntry({
      path: deliveryEvidencePath(deliveryDir, "delivery-source.md"),
      label: "delivery source markdown",
      purpose: "Human-readable source packet used by the delivery curator."
    }),
    artifactEntry({
      path: deliveryEvidencePath(deliveryDir, "curation-verdict.json"),
      label: "curation verdict",
      purpose: "Deterministic verification result for the curated delivery files."
    }),
    ...outcomeVerificationEntries,
    ...nodeWorkspaceChangeEntries,
    ...interventionArtifactEntries,
    ...toolInvocationEntries
  ]);
  const debugPaths = [
    ...evidence.attempts.flatMap((attempt) => [
      {
        path: attempt.stdout_log_path ?? `${resolveExecutionHumanDebugHarnessDirectory(attempt.execution_dir)}/stdout.log`,
        label: `${attempt.authored_id} stdout log`,
        purpose: "Raw harness stdout for this execution."
      },
      {
        path: attempt.stderr_log_path ?? `${resolveExecutionHumanDebugHarnessDirectory(attempt.execution_dir)}/stderr.log`,
        label: `${attempt.authored_id} stderr log`,
        purpose: "Raw harness stderr for this execution."
      },
      {
        path: attempt.result_path ?? resolveExecutionRuntimeResultPath(attempt.execution_dir),
        label: `${attempt.authored_id} harness result`,
        purpose: "Raw harness result metadata for this execution."
      },
      ...(attempt.context_packet_path
        ? [{
            path: attempt.context_packet_path,
            label: `${attempt.authored_id} runtime context`,
            purpose: "Exact pointer-only context contract provided to the node."
          }]
        : []),
      ...(attempt.context_manifest_path
        ? [{
            path: attempt.context_manifest_path,
            label: `${attempt.authored_id} agent context brief`,
            purpose: "Prompt-facing index of context pointers and provenance."
          }]
        : []),
      ...(attempt.context_provenance_path
        ? [{
            path: attempt.context_provenance_path,
            label: `${attempt.authored_id} context provenance`,
            purpose: "Digests and source metadata for context debugging."
          }]
        : [])
    ]),
    ...evidence.tool_invocations.flatMap((entry) =>
      entry.records.flatMap((record) => [
        ...(typeof record.input_path === "string"
          ? [{
              path: record.input_path,
              label: `${entry.authored_id} ${String(record.tool ?? record.kind ?? "tool")} input`,
              purpose: "Raw invocation input for a single runtime-provided tool invocation."
            }]
          : []),
        ...(typeof record.output_path === "string"
          ? [{
              path: record.output_path,
              label: `${entry.authored_id} ${String(record.tool ?? record.kind ?? "tool")} output`,
              purpose: "Raw invocation output for a single runtime-provided tool invocation."
            }]
          : [])
      ])
    ),
    {
      path: `${runRoot}/runtime`,
      label: "Runtime coordination state",
      purpose: "Milestone evidence, helper sessions, and structured human resume input for live/debug workflows."
    }
  ];
  const debugOnly = await Promise.all(debugPaths.map((entry) => artifactEntry(entry)));
  const emptyOrNoop: DeliveryArtifactEntry[] = [];

  if ((await readTrimmed(runPaths.interventions_file)) === "") {
    emptyOrNoop.push(await artifactEntry({
      path: runPaths.interventions_file,
      label: "Supervisor intervention ledger",
      purpose: "No supervisor interventions were recorded.",
      reason: "empty_ledger"
    }));
  }

  if ((await readTrimmed(runPaths.supervisor_timeline_file)) === "") {
    emptyOrNoop.push(await artifactEntry({
      path: runPaths.supervisor_timeline_file,
      label: "Supervisor timeline",
      purpose: "No supervisor decisions were recorded.",
      reason: "empty_ledger"
    }));
  }

  if ((await readTrimmed(runPaths.runtime_log_file)) === "") {
    emptyOrNoop.push(await artifactEntry({
      path: runPaths.runtime_log_file,
      label: "Worker runtime log",
      purpose: "No worker milestone evidence was recorded.",
      reason: "empty_ledger"
    }));
  }

  if ((await readTrimmed(operatorObservationsPath(runRoot))) === undefined) {
    emptyOrNoop.push(await artifactEntry({
      path: operatorObservationsPath(runRoot),
      label: "Human observation ledger",
      purpose: "No live human observations were recorded.",
      reason: "missing_ledger"
    }));
  }

  const compileDiagnostics = await readTrimmed(runPaths.compile_diagnostics_file);
  if (compileDiagnostics === "[]" || compileDiagnostics === "") {
    emptyOrNoop.push(await artifactEntry({
      path: runPaths.compile_diagnostics_file,
      label: "Compile diagnostics",
      purpose: "Compilation produced no diagnostics.",
      reason: "no_diagnostics"
    }));
  }

  for (const attempt of evidence.attempts) {
    const stderrPath = attempt.stderr_log_path ?? `${resolveExecutionHumanDebugHarnessDirectory(attempt.execution_dir)}/stderr.log`;
    if ((await readTrimmed(stderrPath)) === "") {
      emptyOrNoop.push(await artifactEntry({
        path: stderrPath,
        label: `${attempt.authored_id} stderr log`,
        purpose: "Execution produced no stderr output.",
        reason: "empty_stderr"
      }));
    }
  }

  for (const entry of evidence.tool_invocations) {
    for (const record of entry.records) {
      const outputPath = record.output_path;
      if (typeof outputPath === "string" && (await readTrimmed(outputPath)) === "") {
        emptyOrNoop.push(await artifactEntry({
          path: outputPath,
          label: `${entry.authored_id} ${String(record.tool ?? record.kind ?? "tool")} output`,
          purpose: "Tool invocation produced no captured output payload.",
          reason: "empty_tool_output"
        }));
      }
    }
  }

  for (const workspaceChange of evidence.workspace_changes) {
    if (workspaceChange.changed_files.length === 0) {
      emptyOrNoop.push(await artifactEntry({
        path: workspaceChange.changed_files_file,
        label: `${workspaceChange.repo_alias} workspace changes`,
        purpose: "Workspace change capture found no changed files.",
        reason: "no_workspace_changes"
      }));
    }
  }

  return {
    human_entrypoints: humanEntryPoints,
    declared_artifacts: declaredArtifacts,
    resume_required: resumeRequired,
    audit_trail: auditTrail,
    debug_only: debugOnly,
    empty_or_noop: emptyOrNoop
  };
}

async function buildManifest(
  evidence: DeliveryEvidence,
  model: DeliveryModel,
  runRoot: string,
  deliveryDir: string
): Promise<DeliveryPackageManifest> {
  const sections = Object.fromEntries(
    deliverySections.map((section) => [section, join(deliveryDir, sectionFiles[section])])
  ) as Record<DeliverySection, string>;
  const runPaths = resolveRunArtifactPaths(runRoot);
  const observationsPath = operatorObservationsPath(runRoot);
  const deliverySourcePath = deliveryEvidencePath(deliveryDir, "delivery-source.json");
  const deliverySourceMarkdownPath = deliveryEvidencePath(deliveryDir, "delivery-source.md");
  const curationVerdictPath = deliveryEvidencePath(deliveryDir, "curation-verdict.json");
  const curationPromptPath = deliveryEvidencePath(deliveryDir, "curation-prompt.md");
  const curationResponsePath = deliveryEvidencePath(deliveryDir, "curation-response.md");
  const artifactTaxonomy = await buildArtifactTaxonomy({
    evidence,
    model,
    runRoot,
    sections
  });
  const milestoneCount = evidence.milestone_states.reduce((sum, entry) => sum + entry.milestones.length, 0);

  return {
    run_id: evidence.run_id,
    graph_id: evidence.graph_id,
    status: evidence.status,
    graph_status: evidence.status,
    delivery_status: "pending",
    review_ready: false,
    evidence_status: evidence.evidence_status,
    generated_at: new Date().toISOString(),
    manifest_path: join(deliveryDir, "manifest.json"),
    sections,
    human_entrypoints: {
      review_brief: sections.review_brief,
      run_learnings: sections.run_learnings,
      audit_index: sections.audit_index
    },
    evidence_files: {
      artifact_index: sections.artifact_index,
      change_map: sections.change_map,
      validation_ledger: sections.validation_ledger,
      decision_log: sections.decision_log,
      intervention_trace: sections.intervention_trace,
      milestones: sections.milestones,
      workspace_improvements: sections.workspace_improvements,
      delivery_source: deliverySourcePath,
      delivery_source_markdown: deliverySourceMarkdownPath,
      curation_verdict: curationVerdictPath,
      curation_prompt: curationPromptPath,
      curation_response: curationResponsePath,
      supervisor_timeline: runPaths.supervisor_timeline_file,
      runtime_log: runPaths.runtime_log_file,
      operator_observations: observationsPath
    },
    internal_artifacts: {
      run_record: runPaths.run_file,
      state: runPaths.state_file,
      events: runPaths.events_file,
      supervisor_timeline: runPaths.supervisor_timeline_file,
      runtime_log: runPaths.runtime_log_file,
      operator_observations: observationsPath,
      interventions: runPaths.interventions_file,
      node_attempts: runPaths.nodes_dir,
      workspace_changes: runPaths.workspace_changes_dir
    },
    artifact_taxonomy: artifactTaxonomy,
    artifact_counts: {
      attempts: evidence.attempts.length,
      final_attempts: model.final_attempts.length,
      events: evidence.events.length,
      agent_responses: evidence.agent_responses.length,
      final_declared_artifacts: model.final_artifacts.length,
      superseded_declared_artifacts: model.superseded_artifacts.length,
      tool_invocation_records: evidence.tool_invocations.reduce((sum, entry) => sum + entry.records.length, 0),
      workspace_change_artifacts: evidence.workspace_changes.length,
      node_workspace_change_artifacts: evidence.node_workspace_changes.length,
      operator_observations: evidence.operator_observations.length,
      milestones: milestoneCount,
      milestone_validation_logs: model.milestone_validation_logs.length,
      verifications_passed: evidence.outcome_verifications.filter((entry) => entry.passed).length,
      verifications_failed: evidence.outcome_verifications.filter((entry) => !entry.passed).length
    },
    intervention_count: evidence.interventions.length,
    active_failure_count: model.active_failures.length + model.active_blocking_observations.length,
    recovered_issue_count: model.recovered_issues.length,
    workspace_changed_file_count: evidence.workspace_changes.reduce(
      (sum, artifact) => sum + artifact.changed_files.length,
      0
    ),
    curation: {
      status: "pending",
      source_path: deliverySourcePath,
      source_markdown_path: deliverySourceMarkdownPath,
      verdict_path: curationVerdictPath,
      prompt_path: curationPromptPath,
      response_path: curationResponsePath
    }
  };
}

function buildValidationLedger(evidence: DeliveryEvidence, model: DeliveryModel): Record<string, unknown> {
  return {
    graph_id: evidence.graph_id,
    run_id: evidence.run_id,
    status: evidence.status,
    active_failures: model.active_failures.map((entry) => ({
      authored_id: entry.attempt.authored_id,
      compiled_id: entry.attempt.compiled_id,
      execution_id: entry.attempt.execution_id,
      status: entry.attempt.status,
      outcome: entry.attempt.outcome ?? "none",
      summary: entry.summary
    })),
    recovered_issues: model.recovered_issues.map((entry) => ({
      authored_id: entry.attempt.authored_id,
      compiled_id: entry.attempt.compiled_id,
      execution_id: entry.attempt.execution_id,
      status: entry.attempt.status,
      outcome: entry.attempt.outcome ?? "none",
      summary: entry.summary
    })),
    historical_attempts: model.historical_attempts.map((entry) => ({
      authored_id: entry.attempt.authored_id,
      compiled_id: entry.attempt.compiled_id,
      execution_id: entry.attempt.execution_id,
      status: entry.attempt.status,
      outcome: entry.attempt.outcome ?? "none",
      summary: entry.summary
    })),
    milestone_validation_logs: model.milestone_validation_logs,
    outcome_verifications: evidence.outcome_verifications.map((entry) => ({
      authored_id: entry.authored_id,
      compiled_id: entry.compiled_id,
      execution_id: entry.execution_id,
      attempt_index: entry.attempt_index,
      ...(entry.iteration_index !== undefined ? { iteration_index: entry.iteration_index } : {}),
      passed: entry.passed,
      summary: entry.summary,
      findings_count: entry.findings_count,
      blockers_count: entry.blockers_count,
      verify_outcome_json_path: entry.verify_outcome_json_path,
      verify_outcome_markdown_path: entry.verify_outcome_markdown_path,
      verifier_metadata: entry.verifier_metadata
    })),
    tool_invocations: evidence.tool_invocations.map((entry) => ({
      authored_id: entry.authored_id,
      compiled_id: entry.compiled_id,
      execution_id: entry.execution_id,
      invocation_path: entry.invocation_path,
      count: entry.records.length,
      tools: [...new Set(entry.records.map((record) => String(record.tool ?? record.kind ?? "unknown")))].sort()
    })),
    node_workspace_changes: evidence.node_workspace_changes.map((entry) => ({
      authored_id: entry.authored_id,
      compiled_id: entry.compiled_id,
      execution_id: entry.execution_id,
      attempt_index: entry.attempt_index,
      ...(entry.iteration_index !== undefined ? { iteration_index: entry.iteration_index } : {}),
      artifacts: entry.artifacts
    })),
    operator_observations: evidence.operator_observations
  };
}

function renderDeliveryFailureReviewBrief(options: {
  manifest: DeliveryPackageManifest;
  source: DeliverySourcePacket;
  verdict: DeliveryCurationVerdict;
}): string {
  const { manifest, source, verdict } = options;
  return [
    "# Review Brief",
    "",
    "## Outcome",
    "",
    `Graph status: \`${manifest.graph_status}\`. Delivery status: \`failed\`. Review ready: \`false\`.`,
    "The graph reached terminal state but delivery could not verify the curated human handoff.",
    "",
    "## Reviewer Decision",
    "",
    "Do not treat this run as review-ready from the front-door delivery files. Use the audit evidence below to inspect the terminal graph state and curation failure.",
    "",
    "## What To Inspect First",
    "",
    `- [Curation verdict](${relativeMarkdownPath(dirname(manifest.manifest_path), manifest.evidence_files.curation_verdict)})`,
    `- [Audit index](${relativeMarkdownPath(dirname(manifest.manifest_path), manifest.sections.audit_index)})`,
    `- [Delivery source](${relativeMarkdownPath(dirname(manifest.manifest_path), manifest.evidence_files.delivery_source_markdown)})`,
    "",
    "## Success Contract",
    "",
    `- Goal: ${source.intent.goal}`,
    ...markdownList(source.intent.acceptance_criteria.map((item) => `Acceptance: ${item}`), "No graph acceptance criteria were recorded."),
    ...markdownList(source.intent.constraints.map((item) => `Constraint: ${item}`), "No graph constraints were recorded."),
    "",
    "## Changed Files",
    "",
    source.changed_files.length > 0 || source.node_changed_files.length > 0
      ? [
          ...source.changed_files.map((entry) => `- \`${entry.repo}\`: ${entry.files.length} workspace changed file(s).`),
          ...source.node_changed_files.map((entry) => `- \`${entry.node}\`: ${entry.files.length} node changed file(s). Evidence: [node diff](${entry.diff_path})`)
        ].join("\n")
      : "- No workspace change evidence was recorded.",
    "",
    "## Final Declared Artifacts",
    "",
    ...markdownList(
      source.final_declared_artifacts.map((artifact) => `\`${artifact.id}\` at ${artifact.relative_path}`),
      "No final declared artifacts were recorded."
    ),
    "",
    "## Validation Evidence",
    "",
    `- Outcome verifications: ${source.validation.outcome_verifications.length}`,
    `- Milestone validation logs: ${source.validation.milestone_validation_logs.length}`,
    "",
    "## Active Failures And Risks",
    "",
    ...markdownList(
      source.failures.active.map((failure) => `\`${failure.node}\`: ${failure.summary}`),
      "No active graph failures were recorded."
    ),
    "- Delivery curation failed verification, so the run is not review-ready.",
    "",
    "## Recovered Issues",
    "",
    ...markdownList(
      source.failures.recovered.map((failure) => `\`${failure.node}\`: ${failure.summary}`),
      "No recovered issues were recorded."
    ),
    "",
    "## Historical Attempts",
    "",
    ...markdownList(
      source.failures.historical.map((failure) => `\`${failure.node}\`: ${failure.summary}`),
      "No historical failed attempts were recorded."
    ),
    "",
    "## Supervisor And Human Interventions",
    "",
    ...markdownList(
      source.interventions.map((intervention) => `\`${intervention.action}\`: ${intervention.reason}`),
      "No supervisor or human interventions were recorded."
    ),
    "",
    "## Supporting Evidence",
    "",
    ...verdict.findings.map((finding) => `- \`${finding.kind}\`: ${finding.message}`),
    `- [Manifest](${relativeMarkdownPath(dirname(manifest.manifest_path), manifest.manifest_path)})`
  ].join("\n");
}

function renderDeliveryFailureLearnings(options: {
  manifest: DeliveryPackageManifest;
  verdict: DeliveryCurationVerdict;
}): string {
  return [
    "# Run Learnings",
    "",
    "## Where Agents Struggled",
    "",
    "- Delivery curation did not produce a verifier-accepted human handoff.",
    "",
    "## Workspace Improvements",
    "",
    "| Area | Recommendation | Evidence | Priority | Confidence | Done When |",
    "| --- | --- | --- | --- | --- | --- |",
    `| delivery | Inspect the curation verdict and source packet before rerunning delivery curation. | ${options.verdict.findings.map((finding) => finding.kind).join(", ") || "curation_failed"} | high | high | Delivery curation passes and \`review_ready\` is true. |`,
    "",
    "## Graph Prompt And Support Improvements",
    "",
    "- None inferred beyond the delivery curation failure.",
    "",
    "## Plugin Skill And Eval Opportunities",
    "",
    "- Add or update a delivery-curation eval if this failure shape was not already covered.",
    "",
    "## What Worked",
    "",
    "- Deterministic delivery evidence was still written for audit and debugging.",
    "",
    "## Evidence Links",
    "",
    `- [Curation verdict](${relativeMarkdownPath(dirname(options.manifest.manifest_path), options.manifest.evidence_files.curation_verdict)})`,
    `- [Audit index](${relativeMarkdownPath(dirname(options.manifest.manifest_path), options.manifest.sections.audit_index)})`
  ].join("\n");
}

function tableCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ").trim();
}

function renderDeterministicReviewBrief(options: {
  manifest: DeliveryPackageManifest;
  source: DeliverySourcePacket;
  failedVerdict: DeliveryCurationVerdict;
}): string {
  const { manifest, source, failedVerdict } = options;
  const deliveryDir = dirname(manifest.manifest_path);
  const validationLines = [
    ...source.validation.milestone_validation_logs.map((log) => {
      const command = log.command ? ` Command: \`${log.command}\`.` : "";
      const result = log.result ? ` Result: \`${log.result}\`.` : "";
      return `\`${log.execution_id}\` milestone \`${log.milestone_id}\`: ${log.summary}${command}${result}`;
    }),
    ...source.validation.outcome_verifications.map((verification) =>
      `\`${verification.node}\` outcome verification: ${verification.summary} Result: \`${verification.passed ? "pass" : "fail"}\`. Evidence: [validation ledger](${verification.evidence_path})`
    )
  ];
  const changedLines = source.changed_files.flatMap((entry) =>
    entry.files.length > 0
      ? entry.files.map((file) => `\`${entry.repo}/${file}\``)
      : [`\`${entry.repo}\`: no changed files recorded.`]
  );
  const nodeChangedLines = source.node_changed_files.flatMap((entry) =>
    entry.files.length > 0
      ? entry.files.map((file) => `\`${file.path}\` (${entry.node}; ${file.change_kind})`)
      : [`\`${entry.node}\`: no per-node changed files recorded.`]
  );

  return [
    "# Review Brief",
    "",
    "## Outcome",
    "",
    `Graph status: \`${manifest.graph_status}\`. Delivery status: \`passed\`. Review ready: \`true\`.`,
    "Deterministic delivery fallback was used because AI curation did not produce a verifier-accepted handoff.",
    "",
    "## Reviewer Decision",
    "",
    source.failures.active.length > 0
      ? "Do not approve the graph result until active failures are addressed. The delivery package itself is review-ready."
      : "Review the changed files, final artifacts, validation evidence, and risks before approving the graph result.",
    "",
    "## What To Inspect First",
    "",
    `- ${markdownLink(deliveryDir, "Validation ledger", manifest.evidence_files.validation_ledger)}`,
    `- ${markdownLink(deliveryDir, "Change map", manifest.evidence_files.change_map)}`,
    `- ${markdownLink(deliveryDir, "Audit index", manifest.sections.audit_index)}`,
    "",
    "## Success Contract",
    "",
    `- Goal: ${source.intent.goal}`,
    ...markdownList(source.intent.acceptance_criteria.map((item) => `Acceptance: ${item}`), "No graph acceptance criteria were recorded."),
    ...markdownList(source.intent.constraints.map((item) => `Constraint: ${item}`), "No graph constraints were recorded."),
    "",
    "## Changed Files",
    "",
    ...markdownList([...changedLines, ...nodeChangedLines], "No workspace or node change evidence was recorded."),
    "",
    "## Final Declared Artifacts",
    "",
    ...markdownList(
      source.final_declared_artifacts.map((artifact) =>
        `\`${artifact.id}\` at \`${artifact.relative_path}\`: ${artifact.description}`
      ),
      "No final declared artifacts were recorded."
    ),
    "",
    "## Validation Evidence",
    "",
    ...markdownList(validationLines, "No validation evidence was recorded."),
    "",
    "## Active Failures And Risks",
    "",
    ...markdownList(
      [
        ...source.failures.active.map((failure) => `\`${failure.node}\`: ${failure.summary}`),
        ...source.workspace_improvements.map((item) => `Risk/improvement candidate \`${item.area}\`: ${item.recommendation}`)
      ],
      "No active failures remain."
    ),
    "",
    "## Recovered Issues",
    "",
    ...markdownList(
      source.failures.recovered.map((failure) => `\`${failure.node}\`: ${failure.summary}`),
      "No recovered issues were recorded."
    ),
    "",
    "## Historical Attempts",
    "",
    ...markdownList(
      source.failures.historical.map((failure) => `\`${failure.node}\`: ${failure.summary}`),
      "No historical failed attempts were recorded."
    ),
    "",
    "## Supervisor And Human Interventions",
    "",
    ...markdownList(
      source.interventions.map((intervention) => `\`${intervention.action}\`: ${intervention.reason}`),
      "No supervisor or human interventions were recorded."
    ),
    "",
    "## Supporting Evidence",
    "",
    `- ${markdownLink(deliveryDir, "Run learnings", manifest.sections.run_learnings)}`,
    `- ${markdownLink(deliveryDir, "Delivery source", manifest.evidence_files.delivery_source_markdown)}`,
    `- ${markdownLink(deliveryDir, "Curation verdict", manifest.evidence_files.curation_verdict)}`,
    ...failedVerdict.findings.map((finding) => `- Prior curation finding \`${finding.kind}\`: ${finding.message}`)
  ].join("\n");
}

function renderDeterministicRunLearnings(options: {
  manifest: DeliveryPackageManifest;
  source: DeliverySourcePacket;
  failedVerdict: DeliveryCurationVerdict;
}): string {
  const { manifest, source, failedVerdict } = options;
  const deliveryDir = dirname(manifest.manifest_path);
  const improvementRows = source.workspace_improvements.length > 0
    ? source.workspace_improvements.map((entry) =>
      `| ${tableCell(entry.area)} | ${tableCell(entry.recommendation)} | ${tableCell(entry.evidence)} | ${entry.priority} | ${entry.confidence} | ${tableCell(entry.done_when)} |`
    )
    : ["| none | No workspace improvement was inferred from deterministic evidence. | none | low | high | No action required. |"];
  const curationFindingRows = failedVerdict.findings.length > 0
    ? failedVerdict.findings.map((finding) =>
      `| delivery | Keep deterministic fallback available when AI curation misses the contract. | ${tableCell(finding.kind)} | medium | high | Deterministic delivery verifies successfully. |`
    )
    : [];

  return [
    "# Run Learnings",
    "",
    "## Where Agents Struggled",
    "",
    ...markdownList(
      [
        ...source.failures.active.map((failure) => `Active failure \`${failure.node}\`: ${failure.summary}`),
        ...source.failures.recovered.map((failure) => `Recovered issue \`${failure.node}\`: ${failure.summary}`),
        ...failedVerdict.findings.map((finding) => `Delivery curation finding \`${finding.kind}\`: ${finding.message}`)
      ],
      "No concrete agent struggle was inferred from deterministic evidence."
    ),
    "",
    "## Workspace Improvements",
    "",
    "| Area | Recommendation | Evidence | Priority | Confidence | Done When |",
    "| --- | --- | --- | --- | --- | --- |",
    ...improvementRows,
    ...curationFindingRows,
    "",
    "## Graph Prompt And Support Improvements",
    "",
    "- Use explicit artifact and validation contracts so deterministic delivery can build a complete handoff even when AI curation fails.",
    "",
    "## Plugin Skill And Eval Opportunities",
    "",
    "- Add or update delivery-curation eval coverage for any prior curation finding that recurs.",
    "",
    "## What Worked",
    "",
    "- Deterministic delivery source evidence was sufficient to produce a verifier-accepted fallback handoff.",
    "",
    "## Evidence Links",
    "",
    `- ${markdownLink(deliveryDir, "Validation ledger", manifest.evidence_files.validation_ledger)}`,
    `- ${markdownLink(deliveryDir, "Curation verdict", manifest.evidence_files.curation_verdict)}`,
    `- ${markdownLink(deliveryDir, "Audit index", manifest.sections.audit_index)}`
  ].join("\n");
}

async function applyDeterministicDeliveryFallback(options: {
  manifest: DeliveryPackageManifest;
  source: DeliverySourcePacket;
  failedVerdict: DeliveryCurationVerdict;
}): Promise<DeliveryCurationVerdict> {
  const reviewBrief = renderDeterministicReviewBrief(options);
  const runLearnings = renderDeterministicRunLearnings(options);
  await Promise.all([
    writeText(options.manifest.sections.review_brief, reviewBrief),
    writeText(options.manifest.sections.run_learnings, runLearnings)
  ]);
  return verifyCuratedDelivery({
    source: options.source,
    review_brief_markdown: reviewBrief,
    run_learnings_markdown: runLearnings,
    review_brief_path: options.manifest.sections.review_brief,
    run_learnings_path: options.manifest.sections.run_learnings,
    delivery_dir: dirname(options.manifest.manifest_path),
    curator_metadata: {
      deterministic_fallback: true,
      prior_findings: options.failedVerdict.findings.map((finding) => finding.kind)
    }
  });
}

export async function writeDeliveryPackage(options: {
  run_root: string;
  graph: CompiledGraph;
  state: RuntimeStateSnapshot;
  attempts: RuntimeNodeAttempt[];
  events: RuntimeEventEnvelope[];
  interventions: SupervisorInterventionRecord[];
  curator: DeliveryCurator;
  curation_retry_backoff_ms?: number;
}): Promise<DeliveryPackageManifest> {
  const deliveryDir = join(options.run_root, "delivery");
  await mkdir(join(deliveryDir, "evidence"), { recursive: true });

  const evidence = await collectDeliveryEvidence(options);
  const model = buildDeliveryModel(evidence);
  const manifest = await buildManifest(evidence, model, options.run_root, deliveryDir);
  const source = buildDeliverySourcePacket({ manifest, evidence, model, deliveryDir });
  const sourceMarkdown = renderDeliverySourceMarkdown(source);

  await Promise.all([
    writeText(manifest.sections.audit_index, renderAuditIndex(manifest, evidence, model, deliveryDir)),
    writeJson(manifest.sections.artifact_index, {
      graph_id: evidence.graph_id,
      run_id: evidence.run_id,
      policy: "Declared artifacts are indexed in place and are not copied into delivery.",
      final_declared_artifacts: model.final_artifacts,
      superseded_declared_artifacts: model.superseded_artifacts
    }),
    writeJson(manifest.sections.change_map, {
      graph_id: evidence.graph_id,
      run_id: evidence.run_id,
      repos: buildChangeMap(evidence.workspace_changes)
    }),
    writeJson(manifest.sections.validation_ledger, buildValidationLedger(evidence, model)),
    writeText(manifest.sections.decision_log, renderDecisionLog(evidence, model)),
    writeJson(manifest.sections.intervention_trace, {
      graph_id: evidence.graph_id,
      run_id: evidence.run_id,
      supervisor_timeline: evidence.supervisor_timeline,
      runtime_logs: evidence.runtime_logs,
      operator_observations: evidence.operator_observations,
      interventions: evidence.interventions,
      final_assessments: Object.fromEntries(
        model.final_attempts.map((attempt) => [
          attempt.compiled_id,
          {
            authored_id: attempt.authored_id,
            execution_id: attempt.execution_id,
            status: attempt.status,
            outcome: attempt.outcome ?? "none"
          }
        ])
      )
    }),
    writeJson(manifest.sections.milestones, {
      graph_id: evidence.graph_id,
      run_id: evidence.run_id,
      milestone_files: evidence.milestone_states,
      validation_logs: model.milestone_validation_logs
    }),
    writeJson(manifest.sections.workspace_improvements, {
      graph_id: evidence.graph_id,
      run_id: evidence.run_id,
      recommendations: model.workspace_recommendations
    }),
    writeJson(manifest.evidence_files.delivery_source, source),
    writeText(manifest.evidence_files.delivery_source_markdown, sourceMarkdown),
    writeJson(manifest.evidence_files.curation_verdict, {
      passed: false,
      generated_at: new Date().toISOString(),
      findings: [{
        severity: "warning",
        kind: "curation_pending",
        message: "Delivery curation has not completed yet."
      }]
    })
  ]);

  let verdict: DeliveryCurationVerdict | undefined;
  const retryBackoffMs = options.curation_retry_backoff_ms ?? DEFAULT_DELIVERY_CURATION_RETRY_BACKOFF_MS;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const previousVerdict = verdict;
    try {
      const curated = await options.curator.curate({
        source,
        source_markdown: sourceMarkdown,
        source_json_path: manifest.evidence_files.delivery_source,
        source_markdown_path: manifest.evidence_files.delivery_source_markdown,
        review_brief_path: manifest.sections.review_brief,
        run_learnings_path: manifest.sections.run_learnings,
        delivery_dir: deliveryDir,
        curation_attempt: attempt,
        ...(previousVerdict ? { previous_verdict: previousVerdict } : {})
      });
      await Promise.all([
        writeText(manifest.sections.review_brief, curated.review_brief_markdown),
        writeText(manifest.sections.run_learnings, curated.run_learnings_markdown)
      ]);
      verdict = await verifyCuratedDelivery({
        source,
        review_brief_markdown: curated.review_brief_markdown,
        run_learnings_markdown: curated.run_learnings_markdown,
        review_brief_path: manifest.sections.review_brief,
        run_learnings_path: manifest.sections.run_learnings,
        delivery_dir: deliveryDir,
        ...(curated.metadata ? { curator_metadata: curated.metadata } : {})
      });
    } catch (error) {
      const finding: DeliveryCurationFinding = {
        severity: "blocker",
        kind: "curator_failed",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof DeliveryCurationSetupError ? { retryable: false } : {})
      };
      verdict = {
        passed: false,
        generated_at: new Date().toISOString(),
        findings: [finding]
      };
    }

    await writeJson(manifest.evidence_files.curation_verdict, verdict);
    if (verdict.passed || attempt === 2 || !shouldRetryCuration(verdict)) {
      break;
    }
    await sleep(retryBackoffMs);
  }

  if (!verdict) {
    throw new Error("Delivery curation did not produce a verdict.");
  }
  let fallbackReason: string | undefined;
  if (!verdict.passed) {
    const curatorVerdict = verdict;
    const fallbackVerdict = await applyDeterministicDeliveryFallback({
      manifest,
      source,
      failedVerdict: verdict
    });
    if (fallbackVerdict.passed) {
      fallbackReason = verdict.findings.map((finding) => finding.kind).join(", ") || "curation_failed";
    }
    verdict = fallbackVerdict;
  }

  const completedManifest: DeliveryPackageManifest = {
    ...manifest,
    delivery_status: verdict.passed ? "passed" : "failed",
    review_ready: verdict.passed,
    curation: {
      ...manifest.curation,
      status: verdict.passed ? "passed" : "failed",
      ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      ...(verdict.passed ? {} : { failure: verdict.findings.map((finding) => finding.message).join("; ") })
    }
  };
  if (!verdict.passed) {
    await Promise.all([
      writeText(completedManifest.sections.review_brief, renderDeliveryFailureReviewBrief({
        manifest: completedManifest,
        source,
        verdict
      })),
      writeText(completedManifest.sections.run_learnings, renderDeliveryFailureLearnings({
        manifest: completedManifest,
        verdict
      }))
    ]);
  }
  await writeJson(completedManifest.evidence_files.curation_verdict, verdict);
  await writeJson(completedManifest.manifest_path, completedManifest);
  if (!verdict.passed) {
    throw new DeliveryCurationError(
      `curated delivery failed verification; see ${completedManifest.evidence_files.curation_verdict}`,
      completedManifest.evidence_files.curation_verdict,
      verdict.findings
    );
  }
  return completedManifest;
}
