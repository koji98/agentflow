import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CompiledAgentNode, CompiledGraph } from "../../graph/compiled.js";
import type { EffectiveSupervisorPolicy } from "../../graph/profiles.js";
import type { RuntimeNodeAttempt } from "../attempts.js";
import type { AgentInvocation, HarnessAdapter } from "../harness/types.js";
import type { CompletionPacket } from "../completion/index.js";
import type { NodeWorkspaceChangeArtifacts } from "../workspace/types.js";
import {
  parseOutcomeVerificationResponse,
  type OutcomeVerificationParseResult
} from "./parser.js";
import {
  renderOutcomeVerificationPrompt,
  truncateForPrompt,
  type OutcomeVerificationPromptArtifactSnippet,
  type OutcomeVerificationPromptCompletionPacket,
  type OutcomeVerificationPromptDecisionLogEntry,
  type OutcomeVerificationPromptExecutionEvidence
} from "./prompt.js";
import type {
  OutcomeVerificationFinding,
  OutcomeVerificationResult
} from "./types.js";

const verifierExecutionIdSuffix = "__verifier";
const maxArtifactPromptBytes = 24 * 1024;
const maxExecutionEvidencePromptBytes = 14 * 1024;
const verifierMaxAttempts = 2;
const verifierTimeoutSec = 600;
const verifierRetryDelayMs = 250;
const maxDecisionLogEntries = 40;

export interface RunOutcomeVerificationOptions {
  graph: CompiledGraph;
  node: CompiledAgentNode;
  attempt: RuntimeNodeAttempt;
  workspacePath: string;
  outputDir: string;
  contextPacketPath: string;
  contextManifestPath: string;
  contextManifest: string;
  agentResponseArtifactPath?: string;
  declaredArtifactPaths: Record<string, string>;
  completionPacket?: CompletionPacket;
  workspaceChangeArtifacts?: NodeWorkspaceChangeArtifacts;
  harness: HarnessAdapter;
  supervisorPolicy?: EffectiveSupervisorPolicy;
  runId: string;
  baseEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtimeDir?: string;
  now?: () => number;
}

async function readSnippet(path: string | undefined, maxBytes: number): Promise<{
  content?: string;
  truncated?: boolean;
  byte_count?: number;
  read_error?: string;
}> {
  if (!path) {
    return { read_error: "Artifact path was not captured." };
  }

  try {
    const raw = await readFile(path, "utf8");
    const byteCount = Buffer.byteLength(raw, "utf8");
    const { content, truncated } = truncateForPrompt(raw, maxBytes);
    return {
      content,
      truncated,
      byte_count: byteCount
    };
  } catch (error) {
    return {
      read_error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function buildArtifactSnippet(
  name: string,
  path: string | undefined,
  description: string,
  maxBytes: number
): Promise<OutcomeVerificationPromptArtifactSnippet> {
  const snippet = await readSnippet(path, maxBytes);
  return {
    name,
    description,
    path: path ?? "(missing)",
    ...(snippet.content !== undefined ? { content: snippet.content } : {}),
    ...(snippet.truncated !== undefined ? { truncated: snippet.truncated } : {}),
    ...(snippet.byte_count !== undefined ? { byte_count: snippet.byte_count } : {}),
    ...(snippet.read_error ? { read_error: snippet.read_error } : {})
  };
}

async function buildWorkspaceDiffSnippet(
  artifacts: NodeWorkspaceChangeArtifacts | undefined
): Promise<{
  status: "captured" | "degraded" | "absent";
  changed_file_count: number;
  diff_path?: string;
  status_path?: string;
  changed_files_path?: string;
  diff_excerpt?: string;
  diff_truncated?: boolean;
  capture_error?: string;
}> {
  if (!artifacts) {
    return {
      status: "absent",
      changed_file_count: 0
    };
  }

  let captureError: string | undefined;
  if (artifacts.capture_error_path) {
    try {
      captureError = (await readFile(artifacts.capture_error_path, "utf8")).trim();
    } catch {
      captureError = "Capture error file present but could not be read.";
    }
  }

  return {
    status: artifacts.status,
    changed_file_count: artifacts.changed_file_count,
    diff_path: artifacts.diff_patch_path,
    status_path: artifacts.status_path,
    changed_files_path: artifacts.changed_files_path,
    ...(captureError ? { capture_error: captureError } : {})
  };
}

function tailText(value: string, maxBytes: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { content: value, truncated: false };
  }

  const marker = "\n... [earlier log output omitted] ...\n";
  const buffer = Buffer.from(value, "utf8");
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const sliced = buffer.subarray(Math.max(0, buffer.length - Math.max(0, maxBytes - markerBytes)));
  return {
    content: `${marker}${sliced.toString("utf8")}`,
    truncated: true
  };
}

function isTranscriptBoundary(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "thinking"
    || trimmed === "codex"
    || trimmed === "exec"
    || trimmed === "apply_patch"
    || trimmed === "file update:"
    || trimmed.startsWith("apply_patch(");
}

function extractCommandTranscript(raw: string): string {
  const lines = raw.split(/\r?\n/u);
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "exec") {
      continue;
    }

    const block: string[] = [lines[index] ?? "exec"];
    let outputLineCount = 0;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (outputLineCount > 0 && isTranscriptBoundary(line)) {
        break;
      }

      block.push(line);
      outputLineCount += 1;
      if (outputLineCount >= 22) {
        block.push("... [command output truncated] ...");
        break;
      }
    }

    blocks.push(block.join("\n").trimEnd());
  }

  return blocks.slice(-10).join("\n\n");
}

async function buildExecutionEvidenceSnippet(attempt: RuntimeNodeAttempt): Promise<OutcomeVerificationPromptExecutionEvidence | undefined> {
  if (!attempt.stdout_log_path && !attempt.stderr_log_path) {
    return undefined;
  }

  const readErrors: string[] = [];
  let stderr = "";
  let stdout = "";

  if (attempt.stderr_log_path) {
    try {
      stderr = await readFile(attempt.stderr_log_path, "utf8");
    } catch (error) {
      readErrors.push(`stderr: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (attempt.stdout_log_path) {
    try {
      stdout = await readFile(attempt.stdout_log_path, "utf8");
    } catch (error) {
      readErrors.push(`stdout: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const commandTranscript = stderr.length > 0 ? extractCommandTranscript(stderr) : "";
  const fallbackTranscript = commandTranscript.length > 0
    ? commandTranscript
    : [stderr, stdout].filter((entry) => entry.trim().length > 0).join("\n\n");
  const { content, truncated } = tailText(fallbackTranscript, maxExecutionEvidencePromptBytes);

  return {
    ...(attempt.stdout_log_path ? { stdout_path: attempt.stdout_log_path } : {}),
    ...(attempt.stderr_log_path ? { stderr_path: attempt.stderr_log_path } : {}),
    ...(content.trim().length > 0 ? { excerpt: content } : {}),
    ...(truncated ? { truncated } : {}),
    ...(readErrors.length > 0 ? { read_error: readErrors.join("; ") } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEvidenceSummaries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const kind = typeof entry.kind === "string" ? entry.kind : undefined;
    const summary = typeof entry.summary === "string" && entry.summary.trim().length > 0 ? entry.summary : undefined;
    if (!kind || !summary) {
      return [];
    }
    const ref = typeof entry.ref === "string" && entry.ref.trim().length > 0 ? ` (${entry.ref})` : "";
    const status = typeof entry.status === "string" && entry.status.trim().length > 0 ? ` [${entry.status}]` : "";
    return [`${kind}${ref}${status}: ${summary}`];
  });
}

async function readDecisionLogEntries(options: {
  runtimeDir?: string;
  executionId: string;
}): Promise<OutcomeVerificationPromptDecisionLogEntry[]> {
  if (!options.runtimeDir) {
    return [];
  }

  const logPath = join(options.runtimeDir, "log.jsonl");
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return [];
  }

  const entries: OutcomeVerificationPromptDecisionLogEntry[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!isRecord(parsed)) {
      continue;
    }
    if (parsed.execution_id !== options.executionId || parsed.type !== "decision") {
      continue;
    }
    if (typeof parsed.decision !== "string" || typeof parsed.rationale !== "string") {
      continue;
    }
    const evidence = readEvidenceSummaries(parsed.evidence);
    if (evidence.length === 0) {
      continue;
    }

    entries.push({
      decision: parsed.decision,
      rationale: parsed.rationale,
      ...(typeof parsed.contract_implication === "string" ? { contract_implication: parsed.contract_implication } : {}),
      evidence,
      ...(typeof parsed.created_at === "string" ? { created_at: parsed.created_at } : {}),
      ...(typeof parsed.log_id === "string" ? { log_id: parsed.log_id } : {})
    });
  }

  return entries.slice(-maxDecisionLogEntries);
}

function renderResultMarkdown(result: OutcomeVerificationResult, node: CompiledAgentNode): string {
  const lines: string[] = [
    `# Outcome Verification: ${node.authored_id}`,
    "",
    `- Compiled id: \`${node.compiled_id}\``,
    `- Verdict: \`${result.passed ? "passed" : "failed"}\``,
    `- Findings: ${result.findings.length} (blockers: ${result.blockers.length})`,
    `- Verifier harness: \`${result.verifier_metadata.harness}\``,
    ...(result.verifier_metadata.model ? [`- Verifier model: \`${result.verifier_metadata.model}\``] : []),
    `- Duration: \`${result.verifier_metadata.duration_ms}ms\``,
    `- Workspace diff: \`${result.verifier_metadata.workspace_diff_status}\``,
    `- Parse status: \`${result.verifier_metadata.parse_status}\``,
    "",
    "## Summary",
    "",
    result.summary
  ];

  if (result.findings.length === 0) {
    lines.push("", "## Findings", "", "No findings reported.");
    return lines.join("\n");
  }

  lines.push("", "## Findings", "");
  for (const finding of result.findings) {
    lines.push(`- **${finding.severity}** [${finding.category}]: ${finding.evidence}`);
    lines.push(`  - Recommendation: ${finding.recommendation}`);
    if (finding.references && finding.references.length > 0) {
      lines.push(`  - References: ${finding.references.join(", ")}`);
    }
  }

  return lines.join("\n");
}

async function persistResult(options: {
  attempt: RuntimeNodeAttempt;
  result: OutcomeVerificationResult;
  node: CompiledAgentNode;
}): Promise<{ jsonPath: string; markdownPath: string }> {
  const baseDir = options.attempt.execution_dir;
  const jsonPath = join(baseDir, "verify-outcome.json");
  const markdownPath = join(baseDir, "verify-outcome.md");
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(options.result, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${renderResultMarkdown(options.result, options.node)}\n`, "utf8");
  return { jsonPath, markdownPath };
}

function buildPromptPath(attempt: RuntimeNodeAttempt): string {
  return join(attempt.execution_dir, "verify-outcome.prompt.md");
}

function buildResponsePath(attempt: RuntimeNodeAttempt): string {
  return join(attempt.execution_dir, "verify-outcome.raw-response.md");
}

function buildVerifierExecutionId(attempt: RuntimeNodeAttempt): string {
  return `${attempt.execution_id}${verifierExecutionIdSuffix}`;
}

function buildVerifierOutputDir(attempt: RuntimeNodeAttempt): string {
  return join(attempt.execution_dir, "verifier-session");
}

function buildVerifierInvocation(options: {
  prompt: string;
  attempt: RuntimeNodeAttempt;
  node: CompiledAgentNode;
  workspacePath: string;
  contextPacketPath: string;
  contextManifestPath: string;
  contextManifest: string;
  outputDir: string;
  runId: string;
  baseEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtimeDir?: string;
  supervisorPolicy?: EffectiveSupervisorPolicy;
}): AgentInvocation {
  const policy = options.supervisorPolicy;
  return {
    promptKind: "outcome_verification",
    runId: options.runId,
    executionId: buildVerifierExecutionId(options.attempt),
    repoAlias: options.node.repo,
    repoPath: options.workspacePath,
    sandbox: "read-only",
    skipGitRepoCheck: true,
    ...(policy?.harness_config ?? options.node.effective_policy.harness_config
      ? { harnessConfig: policy?.harness_config ?? options.node.effective_policy.harness_config }
      : {}),
    model: policy?.model ?? options.node.effective_policy.model,
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
    ...(policy?.reasoning_effort ?? options.node.effective_policy.reasoning_effort
      ? { reasoningEffort: policy?.reasoning_effort ?? options.node.effective_policy.reasoning_effort }
      : {}),
    ...(options.runtimeDir ? { runtimeDir: options.runtimeDir } : {}),
    nodeGoal: "Audit the just-finished node attempt against the captured prompt.",
    nodeAcceptanceCriteria: [
      "Respond with a single fenced JSON object that follows the schema described in the prompt."
    ],
    nodeConstraints: [
      "Do not edit, write, or move any files.",
      "Do not invoke plugin tools.",
      "Do not produce any prose outside the fenced JSON block."
    ],
    contextPacketPath: options.contextPacketPath,
    contextManifestPath: options.contextManifestPath,
    contextManifest: options.contextManifest,
    outputDir: options.outputDir,
    artifacts: {},
    timeoutSec: Math.min(policy?.timeout_sec ?? verifierTimeoutSec, verifierTimeoutSec),
    signal: options.signal,
    rubric: options.prompt
  };
}

function buildFailureClosedResult(options: {
  parseError: string;
  raw: string;
  attemptCount: number;
  metadataBase: {
    harness: string;
    model?: string;
    duration_ms: number;
    prompt_path: string;
    response_path: string;
    truncated_artifacts: string[];
    workspace_diff_status: "captured" | "degraded" | "absent";
  };
}): OutcomeVerificationResult {
  const finding: OutcomeVerificationFinding = {
    severity: "blocker",
    category: "verifier_unparseable",
    evidence: options.parseError,
    recommendation: "Re-run the node so the verifier can issue a parseable verdict, or inspect the raw verifier response for adapter issues."
  };
  return {
    passed: false,
    summary: `Outcome verifier did not produce a parseable verdict: ${options.parseError}`,
    findings: [finding],
    blockers: [finding],
    verifier_metadata: {
      ...options.metadataBase,
      attempt_count: options.attemptCount,
      parse_status: "unparseable",
      parse_error: options.parseError,
      ...(options.raw.length > 0 ? { raw_response_excerpt: options.raw.slice(0, 1024) } : {})
    }
  };
}

function nowMs(now: (() => number) | undefined): number {
  return (now ?? Date.now)();
}

function selectRawResponse(harnessResult: Awaited<ReturnType<HarnessAdapter["run"]>>): string {
  if (harnessResult.transcript?.last_message && harnessResult.transcript.last_message.length > 0) {
    return harnessResult.transcript.last_message;
  }
  return harnessResult.stdout ?? "";
}

function selectHarnessFailureDetail(harnessResult: Awaited<ReturnType<HarnessAdapter["run"]>>): string | undefined {
  if (typeof harnessResult.stderr === "string" && harnessResult.stderr.trim().length > 0) {
    return harnessResult.stderr.trim();
  }
  if (typeof harnessResult.metadata?.error === "string" && harnessResult.metadata.error.trim().length > 0) {
    return harnessResult.metadata.error.trim();
  }
  return undefined;
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function collectTruncatedArtifactNames(snippets: OutcomeVerificationPromptArtifactSnippet[]): string[] {
  return snippets.filter((snippet) => snippet.truncated === true).map((snippet) => snippet.name);
}

function buildPromptCompletionPacket(packet: CompletionPacket): OutcomeVerificationPromptCompletionPacket {
  return {
    completion_status: packet.completion_status,
    ready_for_verification: packet.ready_for_verification,
    blocking_reasons: packet.blocking_reasons,
    missing_artifacts: packet.missing_artifacts,
    declared_artifacts: packet.declared_artifacts.map((artifact) => ({
      name: artifact.name,
      status: artifact.status,
      current_attempt: artifact.current_attempt,
      ...(artifact.size_bytes !== undefined ? { size_bytes: artifact.size_bytes } : {})
    })),
    artifact_findings: packet.artifact_findings.map((finding) => ({
      artifact: finding.artifact,
      kind: finding.kind,
      summary: finding.summary
    })),
    orientation: {
      orient_called: packet.orientation.orient_called
    },
    milestones: {
      total: packet.milestones.total,
      active: packet.milestones.active,
      completed: packet.milestones.completed,
      blocked: packet.milestones.blocked,
      validation_logs: packet.milestones.validation_logs,
      milestones: packet.milestones.milestones.map((milestone) => ({
        id: milestone.id,
        title: milestone.title,
        status: milestone.status,
        ...(milestone.completion_evidence ? { completion_evidence: milestone.completion_evidence } : {}),
        ...(milestone.blocked_on ? { blocked_on: milestone.blocked_on } : {}),
        logs: milestone.logs.map((log) => ({
          kind: log.kind,
          summary: log.summary,
          ...(log.command ? { command: log.command } : {}),
          ...(log.result ? { result: log.result } : {}),
          ...(log.evidence ? { evidence: log.evidence } : {})
        }))
      }))
    },
    packet_path: packet.packet_path
  };
}

function buildForcedFailureFindings(agentResponseSnippet: OutcomeVerificationPromptArtifactSnippet): OutcomeVerificationFinding[] {
  const response = agentResponseSnippet.content ?? "";
  if (!response.includes("INTENTIONAL_FAILURE_DO_NOT_ACCEPT")) {
    return [];
  }

  return [{
    severity: "blocker",
    category: "intentional_failure_marker",
    evidence: `The final agent response contains INTENTIONAL_FAILURE_DO_NOT_ACCEPT, which marks the attempt as an intentional failed fallback rather than terminal completion. Response excerpt: ${response.slice(0, 500)}`,
    recommendation: "Retry with supervisor recovery evidence and finish only when the authored acceptance criteria are satisfied."
  }];
}

export async function runOutcomeVerification(
  options: RunOutcomeVerificationOptions
): Promise<OutcomeVerificationResult> {
  await mkdir(buildVerifierOutputDir(options.attempt), { recursive: true });

  const agentResponseSnippet = await buildArtifactSnippet(
    "agent_response",
    options.agentResponseArtifactPath,
    "Agent's final captured response.",
    maxArtifactPromptBytes
  );

  const declaredArtifactSnippets: OutcomeVerificationPromptArtifactSnippet[] = [];
  for (const [name, definition] of Object.entries(options.node.declared_artifacts)) {
    if (name === "agent_response") {
      continue;
    }
    const path = options.declaredArtifactPaths[name];
    declaredArtifactSnippets.push(
      await buildArtifactSnippet(name, path, definition.description, maxArtifactPromptBytes)
    );
  }

  const workspaceDiffSnippet = await buildWorkspaceDiffSnippet(options.workspaceChangeArtifacts);
  const executionEvidence = await buildExecutionEvidenceSnippet(options.attempt);
  const decisionLogEntries = await readDecisionLogEntries({
    executionId: options.attempt.execution_id,
    ...(options.runtimeDir ? { runtimeDir: options.runtimeDir } : {})
  });
  const truncatedArtifacts = collectTruncatedArtifactNames([agentResponseSnippet, ...declaredArtifactSnippets]);
  const promptPath = buildPromptPath(options.attempt);
  const responsePath = buildResponsePath(options.attempt);

  const prompt = renderOutcomeVerificationPrompt({
    graph_goal: options.graph.intent.goal ?? "",
    graph_acceptance_criteria: options.graph.intent.acceptance_criteria ?? [],
    graph_constraints: options.graph.intent.constraints ?? [],
    node_authored_id: options.node.authored_id,
    node_compiled_id: options.node.compiled_id,
    node_goal: options.node.intent.goal ?? "",
    node_acceptance_criteria: options.node.intent.acceptance_criteria ?? [],
    node_constraints: options.node.intent.constraints ?? [],
    agent_response_snippet: agentResponseSnippet,
    declared_artifact_snippets: declaredArtifactSnippets,
    decision_log_entries: decisionLogEntries,
    ...(executionEvidence ? { execution_evidence: executionEvidence } : {}),
    ...(options.completionPacket ? { completion_packet: buildPromptCompletionPacket(options.completionPacket) } : {}),
    workspace_diff_snippet: workspaceDiffSnippet,
    workspace_path: options.workspacePath,
    attempt: {
      execution_id: options.attempt.execution_id,
      attempt_index: options.attempt.attempt_index,
      ...(options.attempt.iteration_index !== undefined
        ? { iteration_index: options.attempt.iteration_index }
        : {})
    }
  });

  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, prompt, "utf8");

  const startedAt = nowMs(options.now);
  const metadataBase = {
    harness: options.harness.kind,
    ...(options.supervisorPolicy?.profile_name ? { profile_name: options.supervisorPolicy.profile_name } : {}),
    ...(options.supervisorPolicy?.model ?? options.node.effective_policy.model
      ? { model: options.supervisorPolicy?.model ?? options.node.effective_policy.model }
      : {}),
    duration_ms: 0,
    prompt_path: promptPath,
    response_path: responsePath,
    truncated_artifacts: truncatedArtifacts,
    workspace_diff_status: workspaceDiffSnippet.status,
    decision_log_count: decisionLogEntries.length
  };

  let lastParseError = "Verifier never returned a response.";
  let lastRaw = "";
  let attemptCount = 0;

  for (let attemptIndex = 0; attemptIndex < verifierMaxAttempts; attemptIndex += 1) {
    attemptCount += 1;
    const verifierOutputDir = buildVerifierOutputDir(options.attempt);
    await mkdir(verifierOutputDir, { recursive: true });
    const invocation = buildVerifierInvocation({
      prompt,
      attempt: options.attempt,
      node: options.node,
      workspacePath: options.workspacePath,
      contextPacketPath: options.contextPacketPath,
      contextManifestPath: options.contextManifestPath,
      contextManifest: options.contextManifest,
      outputDir: verifierOutputDir,
      runId: options.runId,
      ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.runtimeDir ? { runtimeDir: options.runtimeDir } : {}),
      ...(options.supervisorPolicy ? { supervisorPolicy: options.supervisorPolicy } : {})
    });

    let harnessResult: Awaited<ReturnType<HarnessAdapter["run"]>>;
    try {
      harnessResult = await options.harness.run(invocation);
    } catch (error) {
      lastParseError = `Verifier harness failed to launch: ${error instanceof Error ? error.message : String(error)}`;
      lastRaw = "";
      continue;
    }

    const raw = selectRawResponse(harnessResult);
    lastRaw = raw;
    await writeFile(responsePath, raw, "utf8");

    if (harnessResult.status !== "passed") {
      const detail = selectHarnessFailureDetail(harnessResult);
      lastParseError = [
        `Verifier harness exited with status "${harnessResult.status}" (exit ${harnessResult.exitCode}).`,
        detail
      ].filter(Boolean).join(" ");
      if (attemptIndex + 1 < verifierMaxAttempts) {
        await delay(verifierRetryDelayMs);
      }
      continue;
    }

    const parsed: OutcomeVerificationParseResult = parseOutcomeVerificationResponse(raw);

    if (parsed.ok) {
      const durationMs = nowMs(options.now) - startedAt;
      const forcedFailureFindings = buildForcedFailureFindings(agentResponseSnippet);
      const findings = [...forcedFailureFindings, ...parsed.data.findings];
      const blockers = [...forcedFailureFindings, ...parsed.data.blockers];
      const result: OutcomeVerificationResult = {
        passed: forcedFailureFindings.length > 0 ? false : parsed.data.passed,
        summary: forcedFailureFindings.length > 0
          ? "Outcome verifier returned passed=true, but the agent response contains an explicit intentional-failure marker."
          : parsed.data.summary,
        findings,
        blockers,
        verifier_metadata: {
          ...metadataBase,
          duration_ms: durationMs,
          attempt_count: attemptCount,
          parse_status: parsed.mode === "ok" ? "ok" : "recovered"
        }
      };
      await persistResult({ attempt: options.attempt, result, node: options.node });
      return result;
    }

    lastParseError = parsed.error;

    if (attemptIndex + 1 < verifierMaxAttempts) {
      await delay(verifierRetryDelayMs);
    }
  }

  const durationMs = nowMs(options.now) - startedAt;
  const result = buildFailureClosedResult({
    parseError: lastParseError,
    raw: lastRaw,
    attemptCount,
    metadataBase: {
      ...metadataBase,
      duration_ms: durationMs
    }
  });
  await persistResult({ attempt: options.attempt, result, node: options.node });
  return result;
}
