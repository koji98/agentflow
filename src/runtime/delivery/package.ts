import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { resolveRunArtifactPaths } from "../../artifacts/paths.js";
import type { CompiledGraph } from "../../graph/compiled.js";
import { deliverySections, type DeliverySection } from "../../graph/schema.js";
import type { SupervisorInterventionRecord } from "../../supervisor/types.js";
import type { RuntimeNodeAttempt } from "../attempts.js";
import type { RuntimeEventEnvelope } from "../events.js";
import type { RuntimeStateSnapshot, WorkspaceChangeArtifacts } from "../session.js";
import { operatorObservationsPath } from "../observations/index.js";
import { collectDeliveryEvidence, type DeliveryEvidence } from "./collect.js";

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
}

function writeJson(filePath: string, payload: unknown): Promise<void> {
  return writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeText(filePath: string, contents: string): Promise<void> {
  return writeFile(filePath, contents.endsWith("\n") ? contents : `${contents}\n`, "utf8");
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
      evidence: activeFailures.map((entry) => `${entry.attempt.authored_id}:${entry.attempt.execution_id}`).join(", "),
      priority: "high",
      confidence: "high",
      done_when: "The failing node or blocker has a passing final attempt and no active blocking observation remains."
    });
  }

  if (recoveredIssues.length > 0) {
    recommendations.push({
      area: "graph",
      recommendation: "Review failed-then-recovered attempts for missing context, brittle checks, or oversized node scope.",
      evidence: recoveredIssues.map((entry) => `${entry.attempt.authored_id}:${entry.attempt.execution_id}`).join(", "),
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
  const classifiedAttempts = evidence.attempts.map((attempt): ClassifiedAttempt => {
    const isFinal = finalAttemptIds.has(attempt.execution_id);
    const hasFailure = attemptHasFailure(evidence, attempt);
    const classification: AttemptClassification = isFinal
      ? hasFailure ? "active_failure" : "final"
      : hasFailure ? "recovered_issue" : "historical_attempt";
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

function renderChangedFiles(evidence: DeliveryEvidence): string[] {
  if (evidence.workspace_changes.length === 0) {
    return ["- No workspace change captures were recorded."];
  }

  return evidence.workspace_changes.flatMap((change) => [
    `### ${change.repo_alias}`,
    "",
    change.changed_files.length > 0
      ? change.changed_files.map((file) => `- \`${file}\``).join("\n")
      : "- No changed files were captured.",
    ""
  ]);
}

function renderFinalArtifacts(
  model: DeliveryModel,
  deliveryDir: string
): string[] {
  if (model.final_artifacts.length === 0) {
    return ["- No final declared artifacts were captured."];
  }

  return [
    "| Artifact | Expected Content | Authoritative Path |",
    "| --- | --- | --- |",
    ...model.final_artifacts.map((artifact) =>
      `| \`${artifact.authored_id}.${artifact.name}\` | ${artifact.description} | ${markdownLink(deliveryDir, artifact.declared_path, artifact.artifact_path)} |`
    )
  ];
}

function renderValidationRows(
  evidence: DeliveryEvidence,
  model: DeliveryModel,
  deliveryDir: string
): string[] {
  const rows: string[] = [];

  for (const log of model.milestone_validation_logs) {
    rows.push(
      `| milestone \`${log.milestone_id}\` | \`${log.result ?? "recorded"}\` | ${log.command ? `\`${log.command}\`` : "not specified"} | ${log.summary} |`
    );
  }

  for (const verification of evidence.outcome_verifications) {
    rows.push(
      `| outcome verifier \`${verification.authored_id}\` | \`${verification.passed ? "pass" : "fail"}\` | ${markdownLink(deliveryDir, "markdown", verification.verify_outcome_markdown_path)} / ${markdownLink(deliveryDir, "json", verification.verify_outcome_json_path)} | ${verification.summary} |`
    );
  }

  if (rows.length === 0) {
    return ["- No validation evidence was captured."];
  }

  return [
    "| Source | Result | Command Or Evidence | Summary |",
    "| --- | --- | --- | --- |",
    ...rows
  ];
}

function renderAttemptTable(
  attempts: ClassifiedAttempt[],
  emptyText: string
): string[] {
  if (attempts.length === 0) {
    return [`- ${emptyText}`];
  }

  return [
    "| Node | Execution | Status | Summary |",
    "| --- | --- | --- | --- |",
    ...attempts.map((entry) =>
      `| \`${entry.attempt.authored_id}\` | \`${entry.attempt.execution_id}\` | \`${entry.attempt.status}${entry.attempt.outcome ? `/${entry.attempt.outcome}` : ""}\` | ${entry.summary} |`
    )
  ];
}

function renderObservationRows(
  observations: DeliveryEvidence["operator_observations"],
  emptyText: string
): string[] {
  if (observations.length === 0) {
    return [`- ${emptyText}`];
  }

  return [
    "| Observation | Kind | Status | Summary |",
    "| --- | --- | --- | --- |",
    ...observations.map((observation) =>
      `| \`${observation.observation_id}\` | \`${observation.kind}\` | \`${observation.status}\` | ${observation.summary} |`
    )
  ];
}

function renderReviewBrief(
  manifest: DeliveryPackageManifest,
  evidence: DeliveryEvidence,
  model: DeliveryModel,
  deliveryDir: string
): string {
  return [
    "# Review Brief",
    "",
    "## Outcome",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Run | \`${evidence.run_id}\` |`,
    `| Graph | \`${evidence.graph_id}\` |`,
    `| Status | \`${evidence.status}\` |`,
    `| Evidence status | \`${evidence.evidence_status}\` |`,
    `| Duration | \`${formatDuration(evidence.started_at, evidence.ended_at)}\` |`,
    `| Final attempts | \`${model.final_attempts.length}\` |`,
    `| Active failures | \`${model.active_failures.length + model.active_blocking_observations.length}\` |`,
    `| Recovered issues | \`${model.recovered_issues.length}\` |`,
    `| Supervisor interventions | \`${evidence.interventions.length}\` |`,
    "",
    "## Success Contract",
    "",
    "### Goal",
    "",
    evidence.intent.goal,
    "",
    "### Acceptance Criteria",
    "",
    ...markdownList(intentList(evidence.intent.acceptance_criteria), "No explicit acceptance criteria were authored."),
    "",
    "### Constraints",
    "",
    ...markdownList(intentList(evidence.intent.constraints), "No explicit constraints were authored."),
    "",
    "## Reviewer Checklist",
    "",
    `1. Review changed files in this brief and, if needed, open ${markdownLink(deliveryDir, "change-map", manifest.evidence_files.change_map)}.`,
    "2. Open final declared artifacts listed below; ignore superseded artifacts unless auditing recovery behavior.",
    "3. Check validation rows for commands, verifier outcomes, and blocked results.",
    "4. Resolve active risks and follow-ups before trusting the run output.",
    `5. Use ${markdownLink(deliveryDir, "audit index", manifest.human_entrypoints.audit_index)} only when debugging or auditing raw trace evidence.`,
    "",
    "## Changed Files",
    "",
    ...renderChangedFiles(evidence),
    "## Final Declared Artifacts",
    "",
    ...renderFinalArtifacts(model, deliveryDir),
    "",
    "## Validation Evidence",
    "",
    ...renderValidationRows(evidence, model, deliveryDir),
    "",
    "## Active Risks And Follow-ups",
    "",
    ...renderAttemptTable(model.active_failures, "No active failed node attempts remain."),
    "",
    ...renderObservationRows(model.active_blocking_observations, "No active blocking observations remain."),
    "",
    "## Recovered Issues",
    "",
    ...renderAttemptTable(model.recovered_issues, "No failed-then-recovered attempts were recorded."),
    "",
    "## Supervisor And Human Interventions",
    "",
    evidence.interventions.length > 0
      ? evidence.interventions.map((intervention) =>
          `- \`${intervention.action}\` on \`${intervention.target_compiled_id ?? "run"}\`: ${intervention.reason}`
        ).join("\n")
      : "- No supervisor interventions were recorded.",
    "",
    evidence.operator_observations.length > 0
      ? renderObservationRows(evidence.operator_observations, "No human observations were recorded.").join("\n")
      : "- No human observations were recorded.",
    "",
    "## Supporting Files",
    "",
    `- ${markdownLink(deliveryDir, "Run learnings", manifest.human_entrypoints.run_learnings)}`,
    `- ${markdownLink(deliveryDir, "Audit index", manifest.human_entrypoints.audit_index)}`,
    `- ${markdownLink(deliveryDir, "Artifact index", manifest.evidence_files.artifact_index)}`,
    `- ${markdownLink(deliveryDir, "Validation ledger", manifest.evidence_files.validation_ledger)}`,
    `- ${markdownLink(deliveryDir, "Workspace improvements", manifest.evidence_files.workspace_improvements)}`
  ].join("\n");
}

function renderRunLearnings(
  manifest: DeliveryPackageManifest,
  evidence: DeliveryEvidence,
  model: DeliveryModel,
  deliveryDir: string
): string {
  const struggles = [
    ...model.active_failures.map((entry) => ({
      area: "active failure",
      evidence: `${entry.attempt.authored_id}:${entry.attempt.execution_id}`,
      lesson: entry.summary
    })),
    ...model.recovered_issues.map((entry) => ({
      area: "recovered issue",
      evidence: `${entry.attempt.authored_id}:${entry.attempt.execution_id}`,
      lesson: entry.summary
    })),
    ...model.active_blocking_observations.map((observation) => ({
      area: "human blocker",
      evidence: observation.observation_id,
      lesson: observation.summary
    }))
  ];
  const worked = [
    ...(model.final_attempts.length > 0 ? [`${model.final_attempts.length} final node attempt(s) reached the terminal review surface.`] : []),
    ...(model.milestone_validation_logs.length > 0 ? [`${model.milestone_validation_logs.length} milestone validation log(s) were captured.`] : []),
    ...(evidence.outcome_verifications.filter((entry) => entry.passed).length > 0
      ? [`${evidence.outcome_verifications.filter((entry) => entry.passed).length} outcome verifier result(s) passed.`]
      : []),
    ...(evidence.interventions.length > 0 ? [`${evidence.interventions.length} supervisor intervention(s) produced auditable recovery evidence.`] : [])
  ];

  return [
    "# Run Learnings",
    "",
    "## Agent Friction",
    "",
    ...(struggles.length > 0
      ? [
          "| Area | Evidence | Lesson |",
          "| --- | --- | --- |",
          ...struggles.map((entry) => `| ${entry.area} | \`${entry.evidence}\` | ${entry.lesson} |`)
        ]
      : ["- No concrete agent friction was inferred from this run."]),
    "",
    "## Workspace And Workflow Improvements",
    "",
    "| Area | Recommendation | Evidence | Priority | Confidence | Done When |",
    "| --- | --- | --- | --- | --- | --- |",
    ...model.workspace_recommendations.map((entry) =>
      `| ${entry.area} | ${entry.recommendation} | ${entry.evidence} | \`${entry.priority}\` | \`${entry.confidence}\` | ${entry.done_when} |`
    ),
    "",
    "## What Worked",
    "",
    ...markdownList(worked, "No positive run signals were inferred automatically."),
    "",
    "## Extraction Candidates",
    "",
    "- Plugin candidates: only create a plugin when the same command sequence needs reuse, credentials, policy, or auditability.",
    "- Skill candidates: update a skill when repeated run evidence shows the same authoring or execution mistake.",
    "- Eval candidates: add or strengthen evals for any recovered issue that should not regress.",
    "",
    "## Evidence Links",
    "",
    `- ${markdownLink(deliveryDir, "Review brief", manifest.human_entrypoints.review_brief)}`,
    `- ${markdownLink(deliveryDir, "Validation ledger", manifest.evidence_files.validation_ledger)}`,
    `- ${markdownLink(deliveryDir, "Milestone evidence", manifest.evidence_files.milestones)}`,
    `- ${markdownLink(deliveryDir, "Intervention trace", manifest.evidence_files.intervention_trace)}`
  ].join("\n");
}

function renderAuditIndex(
  manifest: DeliveryPackageManifest,
  evidence: DeliveryEvidence,
  model: DeliveryModel,
  deliveryDir: string
): string {
  const contextPacketRows = evidence.attempts.flatMap((attempt) =>
    attempt.context_packet_path
      ? [`| \`${attempt.authored_id}\` | \`${attempt.execution_id}\` | ${markdownLink(deliveryDir, "context packet", attempt.context_packet_path)} |`]
      : []
  );
  const toolRows = evidence.tool_invocations.map((entry) =>
    `| \`${entry.authored_id}\` | \`${entry.execution_id}\` | ${entry.records.length} | ${markdownLink(deliveryDir, "ledger", entry.invocation_path)} |`
  );
  const milestoneRows = evidence.milestone_states.map((entry) =>
    `| \`${entry.execution_id}\` | ${entry.milestones.length} | ${markdownLink(deliveryDir, "milestone file", entry.path)} |`
  );

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
      "No final attempts were recorded."
    ),
    "",
    "## Superseded Attempts",
    "",
    ...renderAttemptTable(
      [...model.recovered_issues, ...model.historical_attempts],
      "No superseded attempts were recorded."
    ),
    "",
    "## Context Packets",
    "",
    ...(contextPacketRows.length > 0
      ? ["| Node | Execution | Packet |", "| --- | --- | --- |", ...contextPacketRows]
      : ["- No context packets were referenced by attempts."]),
    "",
    "## Managed Tool Ledgers",
    "",
    ...(toolRows.length > 0
      ? ["| Node | Execution | Records | Ledger |", "| --- | --- | --- | --- |", ...toolRows]
      : ["- No managed tool invocation ledgers were recorded."]),
    "",
    "## Milestones",
    "",
    ...(milestoneRows.length > 0
      ? ["| Execution | Milestones | File |", "| --- | --- | --- |", ...milestoneRows]
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
      lines.push(`- Execution: \`${attempt.execution_id}\``);
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
        lines.push(`- Agentflow-provided tool invocations recorded: \`${toolInvocationCount}\`.`);
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
      lines.push(`- \`${observation.status}\` \`${observation.kind}\` by \`${observation.author}\`: ${observation.summary}`);
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
        purpose: "Canonical JSONL ledger of Agentflow-provided `af` and plugin tool calls for this execution."
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
    ...outcomeVerificationEntries,
    ...nodeWorkspaceChangeEntries,
    ...interventionArtifactEntries,
    ...toolInvocationEntries
  ]);
  const debugPaths = [
    ...evidence.attempts.flatMap((attempt) => [
      {
        path: attempt.stdout_log_path ?? `${attempt.execution_dir}/logs/stdout.log`,
        label: `${attempt.authored_id} stdout log`,
        purpose: "Raw harness stdout for this execution."
      },
      {
        path: attempt.stderr_log_path ?? `${attempt.execution_dir}/logs/stderr.log`,
        label: `${attempt.authored_id} stderr log`,
        purpose: "Raw harness stderr for this execution."
      },
      {
        path: attempt.result_path ?? `${attempt.execution_dir}/result.json`,
        label: `${attempt.authored_id} harness result`,
        purpose: "Raw harness result metadata for this execution."
      },
      ...(attempt.context_packet_path
        ? [{
            path: attempt.context_packet_path,
            label: `${attempt.authored_id} context packet`,
            purpose: "Exact pointer-only context contract provided to the node."
          }]
        : []),
      ...(attempt.context_manifest_path
        ? [{
            path: attempt.context_manifest_path,
            label: `${attempt.authored_id} context manifest`,
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
        ...(typeof record.stdout_path === "string"
          ? [{
              path: record.stdout_path,
              label: `${entry.authored_id} ${String(record.tool ?? record.kind ?? "tool")} stdout`,
              purpose: "Raw stdout sidecar for a single Agentflow-provided tool invocation."
            }]
          : []),
        ...(typeof record.stderr_path === "string"
          ? [{
              path: record.stderr_path,
              label: `${entry.authored_id} ${String(record.tool ?? record.kind ?? "tool")} stderr`,
              purpose: "Raw stderr sidecar for a single Agentflow-provided tool invocation."
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
    const stderrPath = attempt.stderr_log_path ?? `${attempt.execution_dir}/logs/stderr.log`;
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
      for (const stream of ["stdout_path", "stderr_path"] as const) {
        const path = record[stream];
        if (typeof path === "string" && (await readTrimmed(path)) === "") {
          emptyOrNoop.push(await artifactEntry({
            path,
            label: `${entry.authored_id} ${String(record.tool ?? record.kind ?? "tool")} ${stream === "stdout_path" ? "stdout" : "stderr"}`,
            purpose: `Tool invocation produced no ${stream === "stdout_path" ? "stdout" : "stderr"} output.`,
            reason: stream === "stdout_path" ? "empty_tool_stdout" : "empty_tool_stderr"
          }));
        }
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
    )
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

export async function writeDeliveryPackage(options: {
  run_root: string;
  graph: CompiledGraph;
  state: RuntimeStateSnapshot;
  attempts: RuntimeNodeAttempt[];
  events: RuntimeEventEnvelope[];
  interventions: SupervisorInterventionRecord[];
}): Promise<DeliveryPackageManifest> {
  const deliveryDir = join(options.run_root, "delivery");
  await mkdir(join(deliveryDir, "evidence"), { recursive: true });

  const evidence = await collectDeliveryEvidence(options);
  const model = buildDeliveryModel(evidence);
  const manifest = await buildManifest(evidence, model, options.run_root, deliveryDir);

  await Promise.all([
    writeText(manifest.sections.review_brief, renderReviewBrief(manifest, evidence, model, deliveryDir)),
    writeText(manifest.sections.run_learnings, renderRunLearnings(manifest, evidence, model, deliveryDir)),
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
    })
  ]);

  await writeJson(manifest.manifest_path, manifest);
  return manifest;
}
