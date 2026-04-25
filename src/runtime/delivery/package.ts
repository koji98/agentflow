import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveRunArtifactPaths } from "../../artifacts/paths.js";
import type { CompiledGraph } from "../../graph/compiled.js";
import { deliverySections, type DeliverySection } from "../../graph/schema.js";
import type { SupervisorInterventionRecord } from "../../supervisor/types.js";
import type { RuntimeNodeAttempt } from "../attempts.js";
import type { RuntimeEventEnvelope } from "../events.js";
import type { RuntimeStateSnapshot, WorkspaceChangeArtifacts } from "../session.js";
import { collectDeliveryEvidence, type DeliveryEvidence } from "./collect.js";

const sectionFiles: Record<DeliverySection, string> = {
  task_brief: "task-brief.md",
  implementation_summary: "implementation-summary.md",
  grouped_change_map: "grouped-change-map.json",
  decision_log: "decision-log.md",
  evaluation_ledger: "evaluation-ledger.json",
  reviewer_guide: "reviewer-guide.md",
  risk_notes: "risk-notes.md",
  follow_up_items: "follow-up-items.md",
  intervention_trace: "intervention-trace.json"
};

export interface DeliveryPackageManifest {
  run_id: string;
  graph_id: string;
  status: RuntimeStateSnapshot["status"];
  generated_at: string;
  manifest_path: string;
  sections: Record<DeliverySection, string>;
  human_entrypoints: {
    reviewer_guide: string;
    task_brief: string;
    implementation_summary: string;
    risk_notes: string;
    follow_up_items: string;
  };
  evidence_files: {
    grouped_change_map: string;
    decision_log: string;
    evaluation_ledger: string;
    intervention_trace: string;
  };
  internal_artifacts: {
    run_record: string;
    state: string;
    events: string;
    interventions: string;
    node_attempts: string;
    workspace_changes: string;
  };
  artifact_counts: {
    attempts: number;
    events: number;
    agent_responses: number;
    declared_artifacts: number;
    workspace_change_artifacts: number;
  };
  intervention_count: number;
  failed_check_count: number;
  workspace_changed_file_count: number;
}

function writeJson(filePath: string, payload: unknown): Promise<void> {
  return writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeText(filePath: string, contents: string): Promise<void> {
  return writeFile(filePath, contents.endsWith("\n") ? contents : `${contents}\n`, "utf8");
}

function markdownList(values: string[], emptyText: string): string[] {
  if (values.length === 0) {
    return [`- ${emptyText}`];
  }

  return values.map((value) => `- ${value}`);
}

function intentList(values: string[] | undefined): string[] {
  return values ?? [];
}

function formatAttempt(attempt: RuntimeNodeAttempt): string {
  return [
    `- \`${attempt.authored_id}\``,
    `  - compiled: \`${attempt.compiled_id}\``,
    `  - execution: \`${attempt.execution_id}\``,
    `  - kind: \`${attempt.kind}\``,
    `  - status: \`${attempt.status}\``,
    `  - outcome: \`${attempt.outcome ?? "none"}\``
  ].join("\n");
}

function renderTaskBrief(evidence: DeliveryEvidence): string {
  return [
    "# Task Brief",
    "",
    `## Goal`,
    "",
    evidence.intent.goal,
    "",
    "## Constraints",
    "",
    ...markdownList(intentList(evidence.intent.constraints), "No explicit constraints were authored."),
    "",
    "## Acceptance Criteria",
    "",
    ...markdownList(
      intentList(evidence.intent.acceptance_criteria),
      "No explicit acceptance criteria were authored."
    )
  ].join("\n");
}

function renderImplementationSummary(evidence: DeliveryEvidence): string {
  const responseLines = evidence.agent_responses.flatMap((response) => [
    `## ${response.authored_id}`,
    "",
    response.content.trim().length > 0 ? response.content.trim() : "No captured response.",
    ""
  ]);
  const declaredArtifactLines = evidence.declared_artifacts.flatMap((artifact) => [
    `### ${artifact.authored_id}.${artifact.name}`,
    "",
    `- Execution: \`${artifact.execution_id}\``,
    `- Declared path: \`${artifact.path}\``,
    `- Captured artifact: \`${artifact.artifact_path}\``,
    `- Expected content: ${artifact.description}`,
    "",
    artifact.content && artifact.content.trim().length > 0
      ? artifact.content.trim()
      : "Artifact was captured, but Agentflow could not read text content for the delivery summary.",
    ""
  ]);

  return [
    "# Implementation Summary",
    "",
    `- Run: \`${evidence.run_id}\``,
    `- Status: \`${evidence.status}\``,
    `- Attempts: \`${evidence.attempts.length}\``,
    `- Failed checks: \`${evidence.failed_checks.length}\``,
    `- Declared artifacts captured: \`${evidence.declared_artifacts.length}\``,
    "",
    "## Agent Responses",
    "",
    ...(responseLines.length > 0 ? responseLines : ["No agent responses were captured.", ""]),
    "## Declared Handoff Artifacts",
    "",
    ...(declaredArtifactLines.length > 0
      ? declaredArtifactLines
      : ["No declared handoff artifacts were captured.", ""])
  ].join("\n");
}

function renderDecisionLog(evidence: DeliveryEvidence): string {
  const decisionEvents = evidence.events.filter((event) =>
    [
      "graph.compiled",
      "run.started",
      "node.completed",
      "check.evaluated",
      "verification.recorded",
      "supervisor.decision",
      "supervisor.escalated",
      "run.completed",
      "run.canceled"
    ].includes(event.type)
  );

  return [
    "# Decision Log",
    "",
    ...(decisionEvents.length === 0
      ? ["- No decision events were recorded."]
      : decisionEvents.map((event) => {
          const target = event.compiled_id ? ` \`${event.compiled_id}\`` : "";
          return `- ${event.ts} \`${event.type}\`${target}`;
        }))
  ].join("\n");
}

function renderReviewerGuide(manifest: DeliveryPackageManifest, evidence: DeliveryEvidence): string {
  return [
    "# Reviewer Guide",
    "",
    "## Human Review Surface",
    "",
    `- Start with \`${manifest.human_entrypoints.task_brief}\` and \`${manifest.human_entrypoints.implementation_summary}\`.`,
    `- Review risk and follow-up notes in \`${manifest.human_entrypoints.risk_notes}\` and \`${manifest.human_entrypoints.follow_up_items}\`.`,
    `- Use evidence files for audit details: \`${manifest.evidence_files.grouped_change_map}\`, \`${manifest.evidence_files.evaluation_ledger}\`, and \`${manifest.evidence_files.intervention_trace}\`.`,
    "",
    "## Internal Runtime Artifacts",
    "",
    "These files support resume, inspection, and debugging. They are not the primary human handoff.",
    `- State: \`${manifest.internal_artifacts.state}\``,
    `- Events: \`${manifest.internal_artifacts.events}\``,
    `- Interventions ledger: \`${manifest.internal_artifacts.interventions}\``,
    `- Node attempts: \`${manifest.internal_artifacts.node_attempts}\``,
    "",
    "## Review Focus",
    "",
    ...markdownList(intentList(evidence.intent.acceptance_criteria), "Confirm the authored goal was satisfied."),
    "",
    "## Latest Attempts",
    "",
    ...(evidence.attempts.length === 0
      ? ["No node executions were recorded."]
      : evidence.attempts.map(formatAttempt))
  ].join("\n");
}

function renderRiskNotes(evidence: DeliveryEvidence): string {
  const lines = [
    "# Risk Notes",
    "",
    `- Failed checks: \`${evidence.failed_checks.length}\``,
    `- Supervisor interventions: \`${evidence.interventions.length}\``,
    `- Changed files: \`${evidence.workspace_changes.reduce((sum, artifact) => sum + artifact.changed_files.length, 0)}\``,
    ""
  ];

  if (evidence.failed_checks.length > 0) {
    lines.push("## Failed Checks", "");
    for (const check of evidence.failed_checks) {
      lines.push(`- \`${check.authored_id}\`: ${check.summary}`);
    }
    lines.push("");
  }

  lines.push(
    "## Scope Constraints",
    "",
    ...markdownList(intentList(evidence.intent.constraints), "No explicit constraints were authored.")
  );
  return lines.join("\n");
}

function renderFollowUpItems(evidence: DeliveryEvidence): string {
  const failedChecks = evidence.failed_checks.map((check) => `Resolve failed check \`${check.authored_id}\`: ${check.summary}`);
  const nonPassingAttempts = evidence.attempts
    .filter((attempt) => attempt.status !== "passed")
    .map((attempt) => `Inspect \`${attempt.authored_id}\` execution \`${attempt.execution_id}\` with status \`${attempt.status}\`.`);
  const items = [...failedChecks, ...nonPassingAttempts];

  return [
    "# Follow Up Items",
    "",
    ...markdownList(items, "No follow-up items were produced by this run.")
  ].join("\n");
}

function buildGroupedChangeMap(workspaceChanges: WorkspaceChangeArtifacts[]): Array<{
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

function buildManifest(evidence: DeliveryEvidence, runRoot: string, deliveryDir: string): DeliveryPackageManifest {
  const sections = Object.fromEntries(
    deliverySections.map((section) => [section, join(deliveryDir, sectionFiles[section])])
  ) as Record<DeliverySection, string>;
  const runPaths = resolveRunArtifactPaths(runRoot);

  return {
    run_id: evidence.run_id,
    graph_id: evidence.graph_id,
    status: evidence.status,
    generated_at: new Date().toISOString(),
    manifest_path: join(deliveryDir, "manifest.json"),
    sections,
    human_entrypoints: {
      reviewer_guide: sections.reviewer_guide,
      task_brief: sections.task_brief,
      implementation_summary: sections.implementation_summary,
      risk_notes: sections.risk_notes,
      follow_up_items: sections.follow_up_items
    },
    evidence_files: {
      grouped_change_map: sections.grouped_change_map,
      decision_log: sections.decision_log,
      evaluation_ledger: sections.evaluation_ledger,
      intervention_trace: sections.intervention_trace
    },
    internal_artifacts: {
      run_record: runPaths.run_file,
      state: runPaths.state_file,
      events: runPaths.events_file,
      interventions: runPaths.interventions_file,
      node_attempts: runPaths.nodes_dir,
      workspace_changes: runPaths.workspace_changes_dir
    },
    artifact_counts: {
      attempts: evidence.attempts.length,
      events: evidence.events.length,
      agent_responses: evidence.agent_responses.length,
      declared_artifacts: evidence.declared_artifacts.length,
      workspace_change_artifacts: evidence.workspace_changes.length
    },
    intervention_count: evidence.interventions.length,
    failed_check_count: evidence.failed_checks.length,
    workspace_changed_file_count: evidence.workspace_changes.reduce(
      (sum, artifact) => sum + artifact.changed_files.length,
      0
    )
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
  await mkdir(deliveryDir, { recursive: true });

  const evidence = await collectDeliveryEvidence(options);
  const manifest = buildManifest(evidence, options.run_root, deliveryDir);

  await Promise.all([
    writeText(manifest.sections.task_brief, renderTaskBrief(evidence)),
    writeText(manifest.sections.implementation_summary, renderImplementationSummary(evidence)),
    writeJson(manifest.sections.grouped_change_map, {
      graph_id: evidence.graph_id,
      run_id: evidence.run_id,
      repos: buildGroupedChangeMap(evidence.workspace_changes)
    }),
    writeText(manifest.sections.decision_log, renderDecisionLog(evidence)),
    writeJson(manifest.sections.evaluation_ledger, {
      graph_id: evidence.graph_id,
      run_id: evidence.run_id,
      status: evidence.status,
      failed_checks: evidence.failed_checks,
      declared_artifacts: evidence.declared_artifacts.map((artifact) => ({
        authored_id: artifact.authored_id,
        compiled_id: artifact.compiled_id,
        execution_id: artifact.execution_id,
        name: artifact.name,
        path: artifact.path,
        description: artifact.description,
        artifact_path: artifact.artifact_path
      }))
    }),
    writeText(manifest.sections.reviewer_guide, renderReviewerGuide(manifest, evidence)),
    writeText(manifest.sections.risk_notes, renderRiskNotes(evidence)),
    writeText(manifest.sections.follow_up_items, renderFollowUpItems(evidence)),
    writeJson(manifest.sections.intervention_trace, {
      graph_id: evidence.graph_id,
      run_id: evidence.run_id,
      interventions: evidence.interventions
    })
  ]);

  await writeJson(manifest.manifest_path, manifest);
  return manifest;
}
