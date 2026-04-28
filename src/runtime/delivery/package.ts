import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

export interface DeliveryArtifactEntry {
  path: string;
  label: string;
  purpose: string;
  bytes?: number;
  empty?: boolean;
  reason?: string;
}

export interface DeliveryPackageManifest {
  run_id: string;
  graph_id: string;
  status: RuntimeStateSnapshot["status"];
  generated_at: string;
  manifest_path: string;
  run_map: string;
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
    supervisor_timeline: string;
    runtime_log: string;
  };
  internal_artifacts: {
    run_record: string;
    state: string;
    events: string;
    interventions: string;
    supervisor_timeline: string;
    runtime_log: string;
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
    events: number;
    agent_responses: number;
    declared_artifacts: number;
    tool_invocation_records: number;
    workspace_change_artifacts: number;
    node_workspace_change_artifacts: number;
    verifications_passed: number;
    verifications_failed: number;
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

  const verificationsPassed = evidence.outcome_verifications.filter((entry) => entry.passed).length;
  const verificationsFailed = evidence.outcome_verifications.filter((entry) => !entry.passed).length;
  const verificationLines = evidence.outcome_verifications.flatMap((entry) => [
    `### ${entry.authored_id} (attempt ${entry.attempt_index}${
      entry.iteration_index !== undefined ? `, iteration ${entry.iteration_index}` : ""
    })`,
    "",
    `- Verdict: \`${entry.passed ? "passed" : "failed"}\``,
    `- Findings: \`${entry.findings_count}\` (blockers: \`${entry.blockers_count}\`)`,
    `- Verify report (markdown): \`${entry.verify_outcome_markdown_path}\``,
    `- Verify report (json): \`${entry.verify_outcome_json_path}\``,
    "",
    entry.summary,
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
    `- Tool invocation records: \`${evidence.tool_invocations.reduce((sum, entry) => sum + entry.records.length, 0)}\``,
    `- Outcome verifications: passed=\`${verificationsPassed}\` failed=\`${verificationsFailed}\``,
    "",
    "## Agent Responses",
    "",
    ...(responseLines.length > 0 ? responseLines : ["No agent responses were captured.", ""]),
    "## Declared Handoff Artifacts",
    "",
    ...(declaredArtifactLines.length > 0
      ? declaredArtifactLines
      : ["No declared handoff artifacts were captured.", ""]),
    "## Outcome Verification",
    "",
    ...(verificationLines.length > 0
      ? verificationLines
      : ["No outcome verifications were recorded.", ""])
  ].join("\n");
}

function renderDecisionLog(evidence: DeliveryEvidence): string {
  const lines = [
    "# Decision Log",
    "",
    "## Run",
    "",
    `- Goal: ${evidence.intent.goal}`,
    `- Final status: \`${evidence.status}\``,
    `- Attempts recorded: \`${evidence.attempts.length}\``,
    `- Supervisor interventions: \`${evidence.interventions.length}\``,
    ""
  ];

  if (evidence.attempts.length === 0) {
    lines.push("## Nodes", "", "- No node executions were recorded.");
  } else {
    lines.push("## Nodes", "");
    for (const attempt of evidence.attempts) {
      const declaredArtifacts = evidence.declared_artifacts
        .filter((artifact) => artifact.execution_id === attempt.execution_id)
        .map((artifact) => artifact.name)
        .sort();
      const toolInvocationCount = evidence.tool_invocations
        .filter((entry) => entry.execution_id === attempt.execution_id)
        .reduce((sum, entry) => sum + entry.records.length, 0);
      const failedCheck = evidence.failed_checks.find((check) => check.execution_id === attempt.execution_id);

      lines.push(`### ${attempt.authored_id}`, "");
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
      if (failedCheck) {
        lines.push(`- Check evidence: ${failedCheck.summary}`);
      }
      lines.push("");
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

  if (evidence.interventions.length > 0) {
    lines.push("## Supervisor Interventions", "");
    for (const intervention of evidence.interventions) {
      lines.push(`- \`${intervention.action}\` on \`${intervention.target_compiled_id ?? "run"}\`: ${intervention.reason}`);
    }
    lines.push("");
  }

  lines.push("## Delivery", "", "- Delivery package generated from run state, attempts, events, interventions, artifacts, tool invocations, and workspace change captures.");
  return lines.join("\n");
}

function renderReviewerGuide(manifest: DeliveryPackageManifest, evidence: DeliveryEvidence): string {
  return [
    "# Reviewer Guide",
    "",
    "## Review Order",
    "",
    `1. Start with \`${manifest.human_entrypoints.task_brief}\`.`,
    `2. Read \`${manifest.human_entrypoints.implementation_summary}\` and the declared artifacts it references.`,
    `3. Check \`${manifest.human_entrypoints.risk_notes}\` and \`${manifest.human_entrypoints.follow_up_items}\`.`,
    `4. Use \`${manifest.run_map}\` if you need to understand the run directory layout.`,
    `5. Use evidence files for audit details: \`${manifest.evidence_files.grouped_change_map}\`, \`${manifest.evidence_files.evaluation_ledger}\`, \`${manifest.evidence_files.supervisor_timeline}\`, \`${manifest.evidence_files.runtime_log}\`, and \`${manifest.evidence_files.intervention_trace}\`.`,
    "",
    "## What To Ignore Unless Debugging",
    "",
    "- `nodes/` contains per-node audit/debug details: raw logs, context packets, tool ledgers, and harness result JSON.",
    "- `runtime/` contains worker `af log` evidence, helper sessions, and structured human resume input.",
    "- Empty/no-op files are called out in the manifest so they do not look like missing review work.",
    "",
    "## Internal Runtime Artifacts",
    "",
    "These files support resume, inspection, and debugging. They are not the primary human handoff.",
    `- State: \`${manifest.internal_artifacts.state}\``,
    `- Events: \`${manifest.internal_artifacts.events}\``,
    `- Supervisor timeline: \`${manifest.internal_artifacts.supervisor_timeline}\``,
    `- Runtime log: \`${manifest.internal_artifacts.runtime_log}\``,
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

function renderRunMap(manifest: DeliveryPackageManifest): string {
  return [
    "# Run Map",
    "",
    "This file explains the run directory without making every internal artifact look equally important.",
    "",
    "## Human Review",
    "",
    ...manifest.artifact_taxonomy.human_entrypoints.map((entry) => `- \`${entry.path}\` - ${entry.purpose}`),
    "",
    "## Declared Artifacts",
    "",
    ...(manifest.artifact_taxonomy.declared_artifacts.length > 0
      ? manifest.artifact_taxonomy.declared_artifacts.map((entry) => `- \`${entry.label}\`: \`${entry.path}\` - ${entry.purpose}`)
      : ["- No declared artifacts were captured."]),
    "",
    "## Resume Required",
    "",
    "Agentflow keeps these files stable for resume, inspect, and replay compatibility.",
    "",
    ...manifest.artifact_taxonomy.resume_required.map((entry) => `- \`${entry.path}\` - ${entry.purpose}`),
    "",
    "## Audit Trail",
    "",
    ...manifest.artifact_taxonomy.audit_trail.map((entry) => `- \`${entry.path}\` - ${entry.purpose}`),
    "",
    "## Debug Only",
    "",
    "Open these only when investigating a failure, auditing a specific node, or debugging context/tool behavior.",
    "",
    ...manifest.artifact_taxonomy.debug_only.map((entry) => `- \`${entry.path}\` - ${entry.purpose}`),
    "",
    "## Empty Or No-Op",
    "",
    ...(manifest.artifact_taxonomy.empty_or_noop.length > 0
      ? manifest.artifact_taxonomy.empty_or_noop.map((entry) => `- \`${entry.path}\` - ${entry.purpose}${entry.reason ? ` (${entry.reason})` : ""}`)
      : ["- No empty or no-op artifacts were detected."])
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

async function buildArtifactTaxonomy(options: {
  evidence: DeliveryEvidence;
  runRoot: string;
  sections: Record<DeliverySection, string>;
  runMapPath: string;
}): Promise<DeliveryPackageManifest["artifact_taxonomy"]> {
  const { evidence, runRoot, sections } = options;
  const runPaths = resolveRunArtifactPaths(runRoot);
  const humanEntryPoints = await Promise.all([
    artifactEntry({
      path: sections.reviewer_guide,
      label: "Reviewer guide",
      purpose: "Start here for review order, risks, follow-ups, and links into supporting evidence."
    }),
    artifactEntry({
      path: sections.task_brief,
      label: "Task brief",
      purpose: "Human-readable summary of the graph goal, constraints, and acceptance criteria."
    }),
    artifactEntry({
      path: sections.implementation_summary,
      label: "Implementation summary",
      purpose: "Captured agent responses and declared handoff artifacts."
    }),
    artifactEntry({
      path: sections.risk_notes,
      label: "Risk notes",
      purpose: "Failed checks, supervisor interventions, changed-file counts, and authored constraints."
    }),
    artifactEntry({
      path: sections.follow_up_items,
      label: "Follow-up items",
      purpose: "Residual work or failures that need human attention."
    }),
    artifactEntry({
      path: options.runMapPath,
      label: "Run map",
      purpose: "Plain-English guide to the run directory layout."
    })
  ]);
  const declaredArtifacts = await Promise.all(
    evidence.declared_artifacts.map((artifact) =>
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
      purpose: "Resolved executable graph contract used by runtime and resume compatibility checks."
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
      purpose: "Structured `af log` evidence recorded by workers during node execution."
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
    artifactEntry({
      path: sections.grouped_change_map,
      label: "Grouped change map",
      purpose: "Delivery summary of changed files and workspace change artifact paths."
    }),
    artifactEntry({
      path: sections.evaluation_ledger,
      label: "Evaluation ledger",
      purpose: "Delivery summary of failed checks, declared artifacts, and tool invocation ledgers."
    }),
    ...outcomeVerificationEntries,
    ...nodeWorkspaceChangeEntries,
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
            purpose: "Exact materialized context contract provided to the node."
          }]
        : []),
      ...(attempt.context_manifest_path
        ? [{
            path: attempt.context_manifest_path,
            label: `${attempt.authored_id} context manifest`,
            purpose: "Prompt-facing index of materialized context."
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
      purpose: "Worker log evidence, helper sessions, and structured human resume input for live/debug workflows."
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
      purpose: "No worker `af log` entries were recorded.",
      reason: "empty_ledger"
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

async function buildManifest(evidence: DeliveryEvidence, runRoot: string, deliveryDir: string): Promise<DeliveryPackageManifest> {
  const sections = Object.fromEntries(
    deliverySections.map((section) => [section, join(deliveryDir, sectionFiles[section])])
  ) as Record<DeliverySection, string>;
  const runPaths = resolveRunArtifactPaths(runRoot);
  const runMapPath = join(deliveryDir, "run-map.md");
  const artifactTaxonomy = await buildArtifactTaxonomy({
    evidence,
    runRoot,
    sections,
    runMapPath
  });

  return {
    run_id: evidence.run_id,
    graph_id: evidence.graph_id,
    status: evidence.status,
    generated_at: new Date().toISOString(),
    manifest_path: join(deliveryDir, "manifest.json"),
    run_map: runMapPath,
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
      intervention_trace: sections.intervention_trace,
      supervisor_timeline: runPaths.supervisor_timeline_file,
      runtime_log: runPaths.runtime_log_file
    },
    internal_artifacts: {
      run_record: runPaths.run_file,
      state: runPaths.state_file,
      events: runPaths.events_file,
      supervisor_timeline: runPaths.supervisor_timeline_file,
      runtime_log: runPaths.runtime_log_file,
      interventions: runPaths.interventions_file,
      node_attempts: runPaths.nodes_dir,
      workspace_changes: runPaths.workspace_changes_dir
    },
    artifact_taxonomy: artifactTaxonomy,
    artifact_counts: {
      attempts: evidence.attempts.length,
      events: evidence.events.length,
      agent_responses: evidence.agent_responses.length,
      declared_artifacts: evidence.declared_artifacts.length,
      tool_invocation_records: evidence.tool_invocations.reduce((sum, entry) => sum + entry.records.length, 0),
      workspace_change_artifacts: evidence.workspace_changes.length,
      node_workspace_change_artifacts: evidence.node_workspace_changes.length,
      verifications_passed: evidence.outcome_verifications.filter((entry) => entry.passed).length,
      verifications_failed: evidence.outcome_verifications.filter((entry) => !entry.passed).length
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
  const manifest = await buildManifest(evidence, options.run_root, deliveryDir);

  await Promise.all([
    writeText(manifest.sections.task_brief, renderTaskBrief(evidence)),
    writeText(manifest.sections.implementation_summary, renderImplementationSummary(evidence)),
    writeText(manifest.run_map, renderRunMap(manifest)),
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
      })),
      tool_invocations: evidence.tool_invocations.map((entry) => ({
        authored_id: entry.authored_id,
        compiled_id: entry.compiled_id,
        execution_id: entry.execution_id,
        invocation_path: entry.invocation_path,
        count: entry.records.length,
        tools: [...new Set(entry.records.map((record) => String(record.tool ?? record.kind ?? "unknown")))].sort()
      })),
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
      node_workspace_changes: evidence.node_workspace_changes.map((entry) => ({
        authored_id: entry.authored_id,
        compiled_id: entry.compiled_id,
        execution_id: entry.execution_id,
        attempt_index: entry.attempt_index,
        ...(entry.iteration_index !== undefined ? { iteration_index: entry.iteration_index } : {}),
        artifacts: entry.artifacts
      }))
    }),
    writeText(manifest.sections.reviewer_guide, renderReviewerGuide(manifest, evidence)),
    writeText(manifest.sections.risk_notes, renderRiskNotes(evidence)),
    writeText(manifest.sections.follow_up_items, renderFollowUpItems(evidence)),
    writeJson(manifest.sections.intervention_trace, {
      graph_id: evidence.graph_id,
      run_id: evidence.run_id,
      supervisor_timeline: evidence.supervisor_timeline,
      runtime_logs: evidence.runtime_logs,
      interventions: evidence.interventions,
      final_assessments: Object.fromEntries(
        evidence.attempts.map((attempt) => [
          attempt.compiled_id,
          {
            authored_id: attempt.authored_id,
            execution_id: attempt.execution_id,
            status: attempt.status,
            outcome: attempt.outcome ?? "none"
          }
        ])
      )
    })
  ]);

  await writeJson(manifest.manifest_path, manifest);
  return manifest;
}
