import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

import type { EffectiveSupervisorPolicy } from "../../graph/profiles.js";
import type { HarnessAdapter, HarnessResult } from "../harness/types.js";

export type DeliveryCurationStatus = "passed" | "failed";

export interface DeliverySourceFailure {
  node: string;
  execution_id: string;
  status: string;
  summary: string;
}

export interface DeliverySourcePacket {
  version: "1";
  run: {
    run_id: string;
    graph_id: string;
    status: string;
    evidence_status: string;
    duration: string;
  };
  intent: {
    goal: string;
    acceptance_criteria: string[];
    constraints: string[];
  };
  counts: {
    final_attempts: number;
    active_failures: number;
    recovered_issues: number;
    supervisor_interventions: number;
    changed_files: number;
  };
  final_declared_artifacts: Array<{
    id: string;
    node: string;
    name: string;
    description: string;
    declared_path: string;
    absolute_path: string;
    relative_path: string;
  }>;
  superseded_declared_artifacts: Array<{
    id: string;
    node: string;
    name: string;
    description: string;
    declared_path: string;
    absolute_path: string;
    relative_path: string;
  }>;
  changed_files: Array<{
    repo: string;
    workspace_path: string;
    files: string[];
  }>;
  validation: {
    milestone_validation_logs: Array<{
      execution_id: string;
      milestone_id: string;
      command?: string;
      result?: string;
      summary: string;
    }>;
    outcome_verifications: Array<{
      node: string;
      execution_id: string;
      passed: boolean;
      summary: string;
      findings_count: number;
      blockers_count: number;
      evidence_path: string;
    }>;
  };
  failures: {
    active: DeliverySourceFailure[];
    recovered: DeliverySourceFailure[];
    historical: DeliverySourceFailure[];
  };
  interventions: Array<{
    action: string;
    target?: string;
    reason: string;
  }>;
  workspace_improvements: Array<{
    area: string;
    recommendation: string;
    evidence: string;
    priority: string;
    confidence: string;
    done_when: string;
  }>;
  evidence_links: Record<string, string>;
}

export interface DeliveryCurationInput {
  source: DeliverySourcePacket;
  source_markdown: string;
  source_json_path: string;
  source_markdown_path: string;
  review_brief_path: string;
  run_learnings_path: string;
  delivery_dir: string;
}

export interface DeliveryCurationOutput {
  review_brief_markdown: string;
  run_learnings_markdown: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryCurator {
  curate(input: DeliveryCurationInput): Promise<DeliveryCurationOutput>;
}

export interface DeliveryCurationFinding {
  severity: "blocker" | "warning";
  kind: string;
  message: string;
  evidence?: string;
}

export interface DeliveryCurationVerdict {
  passed: boolean;
  generated_at: string;
  findings: DeliveryCurationFinding[];
  curator_metadata?: Record<string, unknown>;
}

export class DeliveryCurationError extends Error {
  constructor(
    message: string,
    readonly verdict_path: string,
    readonly findings: DeliveryCurationFinding[]
  ) {
    super(message);
    this.name = "DeliveryCurationError";
  }
}

function markdownLinks(markdown: string): Array<{ label: string; target: string }> {
  const links: Array<{ label: string; target: string }> = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/gu;
  for (const match of markdown.matchAll(pattern)) {
    links.push({ label: match[1] ?? "", target: match[2] ?? "" });
  }
  return links;
}

function hasHeading(markdown: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^#{1,3}\\s+${escaped}\\s*$`, "imu").test(markdown);
}

function sectionBody(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "imu");
  return pattern.exec(markdown)?.[1] ?? "";
}

function codeSpans(markdown: string): string[] {
  return Array.from(markdown.matchAll(/`([^`\n]+)`/gu), (match) => match[1] ?? "");
}

function looksLikeValidationCommand(value: string): boolean {
  return /^(?:npm|pnpm|yarn|node|npx|git|pytest|python|python3|go|cargo|make|bash|sh|tsx|tsc|vitest)\b/u.test(value);
}

function looksLikeFileReference(value: string): boolean {
  return value.includes("/") || /\.[a-z0-9]{1,8}$/iu.test(value);
}

function lineContainsPassClaim(line: string): boolean {
  const prose = line.replace(/`[^`]*`/gu, "");
  return /\b(?:pass|passed|passing|succeeded|successful|green)\b/iu.test(prose);
}

function lineContainsPassClaimForCommand(line: string, command: string): boolean {
  const commandIndex = line.indexOf(command);
  if (commandIndex < 0) {
    return false;
  }
  const suffix = line.slice(commandIndex + command.length);
  const nextClauseBreaks = [suffix.indexOf(";"), suffix.indexOf("\n")].filter((index) => index >= 0);
  const localSuffix = nextClauseBreaks.length > 0 ? suffix.slice(0, Math.min(...nextClauseBreaks)) : suffix;
  return lineContainsPassClaim(localSuffix);
}

function sectionIncludes(section: string, value: string): boolean {
  return section.toLocaleLowerCase().includes(value.toLocaleLowerCase());
}

function commandAliases(command: string): string[] {
  const aliases = new Set<string>([command]);
  const envStripped = command.replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/u, "").trim();
  if (envStripped.length > 0) {
    aliases.add(envStripped);
  }
  for (const token of envStripped.split(/\s+/u)) {
    if (looksLikeFileReference(token)) {
      aliases.add(token);
      aliases.add(token.split("/").pop() ?? token);
    }
  }
  return [...aliases].filter((alias) => alias.length > 0);
}

function isForbiddenLinkTarget(target: string): boolean {
  return (
    target.length === 0 ||
    isAbsolute(target) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target) ||
    target.includes("#") && target.split("#")[0]?.length === 0
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function validateRelativeLinks(options: {
  markdown: string;
  file_path: string;
  delivery_dir: string;
  findings: DeliveryCurationFinding[];
}): Promise<void> {
  const fileDir = dirname(options.file_path);
  for (const link of markdownLinks(options.markdown)) {
    const withoutFragment = link.target.split("#")[0] ?? link.target;
    if (isForbiddenLinkTarget(withoutFragment)) {
      options.findings.push({
        severity: "blocker",
        kind: "invalid_link",
        message: `Link "${link.label}" must be a relative local path.`,
        evidence: link.target
      });
      continue;
    }
    const resolved = normalize(join(fileDir, withoutFragment));
    if (!(await pathExists(resolved))) {
      options.findings.push({
        severity: "blocker",
        kind: "broken_link",
        message: `Link "${link.label}" does not resolve.`,
        evidence: link.target
      });
    }
  }
}

function assertNoForbiddenText(markdown: string, fileName: string, findings: DeliveryCurationFinding[]): void {
  const forbidden = [
    "human-debug",
    "task-brief.md",
    "implementation-summary.md",
    "risk-notes.md",
    "follow-up-items.md",
    "run-map.md"
  ];
  for (const value of forbidden) {
    if (markdown.includes(value)) {
      findings.push({
        severity: "blocker",
        kind: "forbidden_text",
        message: `${fileName} contains forbidden raw debug or old delivery wording.`,
        evidence: value
      });
    }
  }
}

function validateRequiredHeadings(markdown: string, fileName: string, headings: string[], findings: DeliveryCurationFinding[]): void {
  for (const heading of headings) {
    if (!hasHeading(markdown, heading)) {
      findings.push({
        severity: "blocker",
        kind: "missing_heading",
        message: `${fileName} is missing required heading "${heading}".`
      });
    }
  }
}

function validateEvidenceClaims(options: {
  source: DeliverySourcePacket;
  reviewBrief: string;
  runLearnings: string;
  findings: DeliveryCurationFinding[];
}): void {
  for (const artifact of options.source.final_declared_artifacts) {
    if (
      !options.reviewBrief.includes(artifact.id)
      && !options.reviewBrief.includes(artifact.declared_path)
      && !options.reviewBrief.includes(artifact.relative_path)
    ) {
      options.findings.push({
        severity: "blocker",
        kind: "missing_final_artifact",
        message: `Review brief does not mention final declared artifact ${artifact.id} or its file path.`,
        evidence: artifact.relative_path
      });
    }
  }

  const activeSection = sectionBody(options.reviewBrief, "Active Failures And Risks");
  const recoveredSection = sectionBody(options.reviewBrief, "Recovered Issues");
  const changedSection = sectionBody(options.reviewBrief, "Changed Files");
  const validationSection = sectionBody(options.reviewBrief, "Validation Evidence");
  const knownChangedFiles = new Set(
    options.source.changed_files.flatMap((entry) => [
      ...entry.files,
      ...entry.files.map((file) => `${entry.repo}/${file}`)
    ])
  );
  for (const reference of codeSpans(changedSection)) {
    if (looksLikeFileReference(reference) && !knownChangedFiles.has(reference)) {
      options.findings.push({
        severity: "blocker",
        kind: "invented_changed_file",
        message: `Review brief mentions changed file "${reference}" that is not in the change map.`
      });
    }
  }

  const validationLogsByCommand = new Map<string, Array<{ result?: string; summary: string }>>();
  const validationLogs = options.source.validation.milestone_validation_logs.map((log) => ({
    ...(log.result !== undefined ? { result: log.result } : {}),
    summary: log.summary,
    ...(log.command !== undefined ? { command: log.command } : {})
  }));
  for (const log of options.source.validation.milestone_validation_logs) {
    if (!log.command) {
      continue;
    }
    validationLogsByCommand.set(log.command, [
      ...(validationLogsByCommand.get(log.command) ?? []),
      {
        ...(log.result !== undefined ? { result: log.result } : {}),
        summary: log.summary
      }
    ]);
  }
  const logsForValidationReference = (reference: string): Array<{ result?: string; summary: string }> => [
    ...(validationLogsByCommand.get(reference) ?? []),
    ...validationLogs.filter((log) => log.summary.includes(reference))
  ];
  const allowedValidationCommands = new Set(validationLogsByCommand.keys());
  for (const verification of options.source.validation.outcome_verifications) {
    for (const reference of codeSpans(verification.summary)) {
      if (looksLikeValidationCommand(reference)) {
        allowedValidationCommands.add(reference);
      }
    }
  }
  for (const reference of codeSpans(validationSection)) {
    if (
      looksLikeValidationCommand(reference)
      && !allowedValidationCommands.has(reference)
      && logsForValidationReference(reference).length === 0
    ) {
      options.findings.push({
        severity: "blocker",
        kind: "invented_validation_command",
        message: `Review brief mentions validation command "${reference}" that is not in the delivery source validation evidence.`
      });
    }
  }
  for (const line of validationSection.split(/\r?\n/u)) {
    const mentionedCommands = [
      ...validationLogsByCommand.keys(),
      ...codeSpans(line).filter((reference) => looksLikeValidationCommand(reference))
    ];
    for (const command of new Set(mentionedCommands)) {
      const commandLogs = logsForValidationReference(command);
      if (
        line.includes(command)
        && lineContainsPassClaimForCommand(line, command)
        && commandLogs.length > 0
        && !commandLogs.some((log) => log.result === "pass")
      ) {
        options.findings.push({
          severity: "blocker",
          kind: "invented_validation_pass",
          message: `Review brief claims validation command "${command}" passed, but the validation ledger does not record a pass result.`
        });
      }
    }
  }
  for (const failure of options.source.failures.active) {
    if (!sectionIncludes(activeSection, failure.node)) {
      options.findings.push({
        severity: "blocker",
        kind: "missing_active_failure",
        message: `Review brief does not list active failure for ${failure.node}.`,
        evidence: failure.summary
      });
    }
  }
  if (options.source.failures.active.length > 0 && /no active failures remain/iu.test(activeSection)) {
    options.findings.push({
      severity: "blocker",
      kind: "hidden_active_failure",
      message: "Review brief claims no active failures even though active failures exist."
    });
  }
  for (const failure of options.source.failures.recovered) {
    if (!sectionIncludes(recoveredSection, failure.node)) {
      options.findings.push({
        severity: "blocker",
        kind: "missing_recovered_issue",
        message: `Review brief does not list recovered issue for ${failure.node}.`,
        evidence: failure.summary
      });
    }
    const activeMentions = activeSection
      .split(/\r?\n/u)
      .filter((line) => sectionIncludes(line, failure.node));
    const marksRecoveredAsActive = activeMentions.some((line) =>
      !/\b(?:no|none|recover|repaired|resolved|historical)\b/iu.test(line)
    );
    if (marksRecoveredAsActive) {
      options.findings.push({
        severity: "blocker",
        kind: "recovered_issue_marked_active",
        message: `Recovered issue ${failure.node} appears in the active failure section.`
      });
    }
  }

  for (const log of options.source.validation.milestone_validation_logs) {
    if (log.command && !commandAliases(log.command).some((alias) => options.reviewBrief.includes(alias))) {
      options.findings.push({
        severity: log.result === "pass" ? "blocker" : "warning",
        kind: "missing_validation_command",
        message: `Review brief omits validation command "${log.command}".`,
        evidence: log.summary
      });
    }
    if (log.result && !options.reviewBrief.includes(log.result)) {
      options.findings.push({
        severity: "blocker",
        kind: "missing_validation_result",
        message: `Review brief omits validation result "${log.result}".`,
        evidence: log.summary
      });
    }
  }

  if (options.source.workspace_improvements.length > 0 && !options.runLearnings.includes("Done When")) {
    options.findings.push({
      severity: "blocker",
      kind: "missing_learning_done_when",
      message: "Run learnings must keep recommendations measurable with a Done When column or section."
    });
  }
}

export async function verifyCuratedDelivery(options: {
  source: DeliverySourcePacket;
  review_brief_markdown: string;
  run_learnings_markdown: string;
  review_brief_path: string;
  run_learnings_path: string;
  delivery_dir: string;
  curator_metadata?: Record<string, unknown>;
}): Promise<DeliveryCurationVerdict> {
  const findings: DeliveryCurationFinding[] = [];

  validateRequiredHeadings(options.review_brief_markdown, "01-review-brief.md", [
    "Review Brief",
    "Outcome",
    "Reviewer Decision",
    "What To Inspect First",
    "Success Contract",
    "Changed Files",
    "Final Declared Artifacts",
    "Validation Evidence",
    "Active Failures And Risks",
    "Recovered Issues",
    "Historical Attempts",
    "Supervisor And Human Interventions",
    "Supporting Evidence"
  ], findings);
  validateRequiredHeadings(options.run_learnings_markdown, "02-run-learnings.md", [
    "Run Learnings",
    "Where Agents Struggled",
    "Workspace Improvements",
    "Graph Prompt And Support Improvements",
    "Plugin Skill And Eval Opportunities",
    "What Worked",
    "Evidence Links"
  ], findings);
  assertNoForbiddenText(options.review_brief_markdown, "01-review-brief.md", findings);
  assertNoForbiddenText(options.run_learnings_markdown, "02-run-learnings.md", findings);
  await validateRelativeLinks({
    markdown: options.review_brief_markdown,
    file_path: options.review_brief_path,
    delivery_dir: options.delivery_dir,
    findings
  });
  await validateRelativeLinks({
    markdown: options.run_learnings_markdown,
    file_path: options.run_learnings_path,
    delivery_dir: options.delivery_dir,
    findings
  });
  validateEvidenceClaims({
    source: options.source,
    reviewBrief: options.review_brief_markdown,
    runLearnings: options.run_learnings_markdown,
    findings
  });

  return {
    passed: findings.every((finding) => finding.severity !== "blocker"),
    generated_at: new Date().toISOString(),
    findings,
    ...(options.curator_metadata ? { curator_metadata: options.curator_metadata } : {})
  };
}

function extractFencedBlock(markdown: string, tag: string): string | undefined {
  const openPattern = new RegExp("```" + tag + "\\s*\\n", "iu");
  const open = openPattern.exec(markdown);
  if (!open || open.index === undefined) {
    return undefined;
  }

  const contentStart = open.index + open[0].length;
  const remainder = markdown.slice(contentStart);
  const closingIndex = remainder.search(/\n```/u);
  const content = closingIndex >= 0 ? remainder.slice(0, closingIndex) : remainder;
  return content.trim();
}

export function parseDeliveryCuratorResponse(raw: string): DeliveryCurationOutput {
  const review = extractFencedBlock(raw, "review-brief");
  const learnings = extractFencedBlock(raw, "run-learnings");
  if (!review || !learnings) {
    throw new Error("Delivery curator response must include fenced `review-brief` and `run-learnings` Markdown blocks.");
  }
  return {
    review_brief_markdown: review,
    run_learnings_markdown: learnings
  };
}

export function renderDeliveryCuratorPrompt(input: DeliveryCurationInput): string {
  return [
    "## Role",
    "You are the Agentflow delivery curator. Synthesize the terminal run evidence into a human review package.",
    "You are read-only. Do not edit source workspaces, run commands, request human input, or change run status.",
    "Your job is to make the handoff useful, concise, and evidence-grounded.",
    "",
    "## Source Of Truth",
    "- The embedded Delivery Source packet below is the source of truth for the curated Markdown.",
    "- Runtime uses machine JSON for verification; do not cite or copy machine JSON paths.",
    "- Use only the facts in the source packet and linked deterministic evidence.",
    "- Use relative Markdown links from the source Markdown. Never copy absolute paths from machine JSON into the curated Markdown.",
    "- Do not invent changed files, commands, passing validation, artifacts, risks, or follow-ups.",
    "- Do not expose chain-of-thought, raw debug paths, or `human-debug` links.",
    "- Do not write the literal string `human-debug`; if debug evidence matters, describe it as audit/debug evidence and link only to the audit index.",
    "",
    "## Review Brief Contract",
    "- Use the exact required heading outline below. Keep every section even when the answer is `None`.",
    "- Start with outcome, reviewer decision, and what to inspect first.",
    "- Explain the goal, acceptance criteria, constraints, status, and whether the run satisfied them.",
    "- Group changed files by repo and reviewer concern when evidence supports grouping.",
    "- Link final declared artifacts and include each artifact id or exact artifact path from the evidence packet.",
    "- Separate active failures, active risks, recovered issues, historical attempts, and follow-ups.",
    "- In `Recovered Issues`, include every recovered issue from the source packet by its exact node id.",
    "- In `Active Failures And Risks`, do not list recovered or historical attempts as active.",
    "- Summarize supervisor/human interventions only when they matter to review.",
    "",
    "Required `review-brief` heading outline:",
    "- `# Review Brief`",
    "- `## Outcome`",
    "- `## Reviewer Decision`",
    "- `## What To Inspect First`",
    "- `## Success Contract`",
    "- `## Changed Files`",
    "- `## Final Declared Artifacts`",
    "- `## Validation Evidence`",
    "- `## Active Failures And Risks`",
    "- `## Recovered Issues`",
    "- `## Historical Attempts`",
    "- `## Supervisor And Human Interventions`",
    "- `## Supporting Evidence`",
    "",
    "## Run Learnings Contract",
    "- Use the exact required heading outline below. Keep every section even when the answer is `None`.",
    "- Provide concrete workspace, graph, prompt, skill, tool, plugin, and eval improvement recommendations when supported by evidence.",
    "- Recommendations must be a Markdown table with columns: `Area`, `Recommendation`, `Evidence`, `Priority`, `Confidence`, `Done When`.",
    "- If no action is needed, still include one no-op row with `Area` = `none` and a concrete `Done When` value.",
    "- Distinguish what worked from what needs action.",
    "",
    "Required `run-learnings` heading outline:",
    "- `# Run Learnings`",
    "- `## Where Agents Struggled`",
    "- `## Workspace Improvements`",
    "- `## Graph Prompt And Support Improvements`",
    "- `## Plugin Skill And Eval Opportunities`",
    "- `## What Worked`",
    "- `## Evidence Links`",
    "",
    "## Evidence Packet",
    "",
    input.source_markdown,
    "",
    "## Output",
    "Return exactly two fenced Markdown blocks and no other prose:",
    "```review-brief",
    "# Review Brief",
    "## Outcome",
    "...",
    "## Reviewer Decision",
    "...",
    "## What To Inspect First",
    "...",
    "## Success Contract",
    "...",
    "## Changed Files",
    "...",
    "## Final Declared Artifacts",
    "...",
    "## Validation Evidence",
    "...",
    "## Active Failures And Risks",
    "...",
    "## Recovered Issues",
    "...",
    "## Historical Attempts",
    "...",
    "## Supervisor And Human Interventions",
    "...",
    "## Supporting Evidence",
    "...",
    "```",
    "```run-learnings",
    "# Run Learnings",
    "## Where Agents Struggled",
    "...",
    "## Workspace Improvements",
    "...",
    "## Graph Prompt And Support Improvements",
    "...",
    "## Plugin Skill And Eval Opportunities",
    "...",
    "## What Worked",
    "...",
    "## Evidence Links",
    "...",
    "```"
  ].join("\n");
}

export function createHarnessDeliveryCurator(options: {
  harness: HarnessAdapter;
  policy: EffectiveSupervisorPolicy;
  run_id: string;
  repo_path: string;
  delivery_dir: string;
  prompt_path: string;
  response_path: string;
  signal?: AbortSignal;
  base_env?: NodeJS.ProcessEnv;
}): DeliveryCurator {
  return {
    async curate(input) {
      const prompt = renderDeliveryCuratorPrompt(input);
      const result: HarnessResult = await options.harness.run({
        promptKind: "delivery_curator",
        runId: options.run_id,
        executionId: `${options.run_id}__delivery_curator`,
        repoAlias: "delivery",
        repoPath: options.repo_path,
        sandbox: "read-only",
        skipGitRepoCheck: true,
        ...(options.policy.harness_config ? { harnessConfig: options.policy.harness_config } : {}),
        model: options.policy.model,
        ...(options.policy.reasoning_effort ? { reasoningEffort: options.policy.reasoning_effort } : {}),
        ...(options.base_env ? { baseEnv: options.base_env } : {}),
        contextPacketPath: input.source_json_path,
        contextManifestPath: input.source_markdown_path,
        contextManifest: input.source_markdown,
        outputDir: join(options.delivery_dir, "evidence", "curator-session"),
        artifacts: {},
        timeoutSec: options.policy.timeout_sec,
        signal: options.signal,
        rubric: prompt,
        promptPath: options.prompt_path
      });
      const raw = result.transcript?.last_message ?? result.stdout ?? "";
      await writeFile(options.response_path, raw, "utf8");
      if (result.status !== "passed") {
        throw new Error(`Delivery curator harness failed with status ${result.status} (exit ${result.exitCode}).`);
      }
      return parseDeliveryCuratorResponse(raw);
    }
  };
}

export async function readCuratedDeliveryFiles(options: {
  review_brief_path: string;
  run_learnings_path: string;
}): Promise<DeliveryCurationOutput> {
  return {
    review_brief_markdown: await readFile(options.review_brief_path, "utf8"),
    run_learnings_markdown: await readFile(options.run_learnings_path, "utf8")
  };
}
