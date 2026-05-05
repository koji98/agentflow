import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveSubpathWithinRoot } from "../../path_rules.js";
import { resolveExecutionArtifactsDirectory } from "../../artifacts/paths.js";
import type { ArtifactDefinition } from "../../graph/authored.js";
import type { RuntimeNodeAttempt } from "../attempts.js";
import {
  evidenceKinds,
  findingKinds,
  runtimeLogTypes,
  type BuildCompletionPacketOptions,
  type CompletionArtifactFinding,
  type CompletionDeclaredArtifact,
  type CompletionHelperSummary,
  type CompletionManagedSummary,
  type CompletionPacket,
  type CompletionStatus,
  type CompletionValidationEvidence,
  type HelperPurpose,
  type OperatorObservation,
  type RuntimeLogEntry
} from "./types.js";

interface ArtifactInspection {
  artifact: CompletionDeclaredArtifact;
  findings: CompletionArtifactFinding[];
}

interface ForbiddenArtifactContent {
  term: string;
  source: string;
}

interface RequiredArtifactContent {
  term: string;
  source: string;
}

interface HelperSessionSnapshot {
  agent_id: string;
  parent_agent_id: string;
  status: "starting" | "running" | "completed" | "failed" | "canceled";
  purpose: HelperPurpose;
  brief?: string;
  artifacts: Record<string, string>;
  evidence_ref: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnString(value: Record<string, unknown>, key: string): string | undefined {
  const nested = value[key];
  return typeof nested === "string" && nested.trim().length > 0 ? nested : undefined;
}

function hasHelperStatus(value: string | undefined): HelperSessionSnapshot["status"] | undefined {
  return value === "starting" || value === "running" || value === "completed" || value === "failed" || value === "canceled"
    ? value
    : undefined;
}

function hasHelperPurpose(value: string | undefined): HelperPurpose | undefined {
  return value === "investigation" || value === "implementation" || value === "verification" || value === "repair"
    ? value
    : undefined;
}

function expectedArtifactPath(options: {
  definition: ArtifactDefinition;
  executionDir: string;
  outputDir?: string;
  workspacePath: string;
  name: string;
}): string {
  const root = options.definition.from === "output_dir"
    ? (options.outputDir ?? resolveExecutionArtifactsDirectory(options.executionDir))
    : options.workspacePath;
  return resolveSubpathWithinRoot(root, options.definition.path, `Artifact "${options.name}" path`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const placeholderPatterns = [
  /\bTODO\b/iu,
  /\bTBD\b/iu,
  /lorem ipsum/iu,
  /\bplaceholder\s+(?:text|content|value|section|here)\b/iu,
  /\[\s*placeholder[^\]]*\]/iu,
  /\b(?:run|execute|validation|command)\s*:?[\s`]*\\\s+(?:from|in|with|as)\b/iu,
  /\bready\b[^\n.]{0,80}\bonce\b[^\n.]{0,80}\b(?:validation|check|recorded)\b/iu,
  /\b(?:remains|still needs|yet)\s+to\s+be\s+(?:run|recorded|verified|completed)\b/iu,
  /fill this in/iu,
  /to be filled/iu,
  /not implemented/iu,
  /\{\{[^}]+\}\}/u,
  /<\s*todo\s*>/iu
];

function containsPlaceholder(content: string): boolean {
  return placeholderPatterns.some((pattern) => pattern.test(content));
}

const forbiddenSentencePattern = /\b((?:do not|don't|must not|should not|never)[^.!?\n]*(?:contain|include|use|summarize|cite|rely on|copy|mention|write)[^.!?\n]*)/giu;
const forbiddenRequirementSignalPattern = /\b(?:do not|don't|must not|should not|never)\b/iu;
const backtickedTermPattern = /`([^`\n]+)`/gu;
const requiredArtifactTermContextPattern = /\b(?:includes?|including|contains?|copy|say|with|literal labels?|exact phrases?|discovered risk that|risk that|finding that)\b/iu;
const forbiddenBeforeTermPattern = /\b(?:do not|don't|must not|should not|never)\b[^`\n]*$/iu;

function extractForbiddenArtifactContent(texts: string[]): ForbiddenArtifactContent[] {
  const terms = new Map<string, ForbiddenArtifactContent>();
  for (const text of texts) {
    for (const sentence of text.matchAll(forbiddenSentencePattern)) {
      const source = sentence[1]?.trim();
      if (!source) {
        continue;
      }
      for (const match of source.matchAll(backtickedTermPattern)) {
        const term = match[1]?.trim();
        if (!term || terms.has(term)) {
          continue;
        }
        terms.set(term, { term, source });
      }
    }
  }
  return [...terms.values()];
}

function extractRequiredArtifactContent(texts: string[]): RequiredArtifactContent[] {
  const terms = new Map<string, RequiredArtifactContent>();
  for (const text of texts) {
    for (const match of text.matchAll(backtickedTermPattern)) {
      const term = match[1]?.trim();
      if (!term || terms.has(term) || match.index === undefined) {
        continue;
      }
      const before = text.slice(Math.max(0, match.index - 140), match.index);
      const after = text.slice(match.index + match[0].length, Math.min(text.length, match.index + match[0].length + 140));
      if (forbiddenBeforeTermPattern.test(before)) {
        continue;
      }
      const source = `${before}${match[0]}${after}`.trim();
      if (!requiredArtifactTermContextPattern.test(before) && !requiredArtifactTermContextPattern.test(after)) {
        continue;
      }
      if (forbiddenRequirementSignalPattern.test(after) && !requiredArtifactTermContextPattern.test(before)) {
        continue;
      }
      terms.set(term, { term, source });
    }
  }
  return [...terms.values()];
}

async function inspectArtifact(options: {
  name: string;
  definition: ArtifactDefinition;
  expectedPath: string;
  currentAttemptPath: string | undefined;
  priorAttempts: RuntimeNodeAttempt[];
  sandbox: BuildCompletionPacketOptions["sandbox"];
  forbiddenContent: ForbiddenArtifactContent[];
  requiredContent: RequiredArtifactContent[];
  declaredArtifactIdentifiers: string[];
}): Promise<ArtifactInspection> {
  const findings: CompletionArtifactFinding[] = [];
  const currentAttempt = options.currentAttemptPath === options.expectedPath || await fileExists(options.expectedPath);

  if (options.sandbox === "read-only") {
    findings.push({
      artifact: options.name,
      kind: "blocked",
      summary: `Declared artifact "${options.name}" cannot be written in read-only sandbox.`,
      evidence_ref: options.expectedPath
    });
    return {
      artifact: {
        name: options.name,
        required: true,
        from: options.definition.from,
        path: options.definition.path,
        expected_path: options.expectedPath,
        description: options.definition.description,
        status: "blocked",
        current_attempt: false
      },
      findings
    };
  }

  if (!currentAttempt) {
    findings.push({
      artifact: options.name,
      kind: "missing",
      summary: `Missing expected artifact: ${options.name}`,
      evidence_ref: options.expectedPath
    });
    const prior = [...options.priorAttempts]
      .reverse()
      .find((attempt) => typeof attempt.artifacts[options.name] === "string");
    const priorPath = prior?.artifacts[options.name];
    if (priorPath) {
      findings.push({
        artifact: options.name,
        kind: "stale_prior_attempt",
        summary: `Artifact "${options.name}" exists only on prior attempt ${prior.execution_id}.`,
        evidence_ref: priorPath
      });
    }
    return {
      artifact: {
        name: options.name,
        required: true,
        from: options.definition.from,
        path: options.definition.path,
        expected_path: options.expectedPath,
        description: options.definition.description,
        status: "missing",
        current_attempt: false
      },
      findings
    };
  }

  let sizeBytes = 0;
  let content = "";
  try {
    const [stats, raw] = await Promise.all([
      stat(options.expectedPath),
      readFile(options.expectedPath, "utf8")
    ]);
    sizeBytes = stats.size;
    content = raw;
  } catch {
    findings.push({
      artifact: options.name,
      kind: "missing",
      summary: `Expected artifact "${options.name}" could not be read.`,
      evidence_ref: options.expectedPath
    });
    return {
      artifact: {
        name: options.name,
        required: true,
        from: options.definition.from,
        path: options.definition.path,
        expected_path: options.expectedPath,
        description: options.definition.description,
        status: "missing",
        current_attempt: false
      },
      findings
    };
  }

  if (content.trim().length === 0) {
    findings.push({
      artifact: options.name,
      kind: "empty",
      summary: `Declared artifact "${options.name}" is empty.`,
      evidence_ref: options.expectedPath
    });
    return {
      artifact: {
        name: options.name,
        required: true,
        from: options.definition.from,
        path: options.definition.path,
        expected_path: options.expectedPath,
        description: options.definition.description,
        status: "empty",
        current_attempt: true,
        size_bytes: sizeBytes
      },
      findings
    };
  }

  if (containsPlaceholder(content)) {
    findings.push({
      artifact: options.name,
      kind: "placeholder",
      summary: `Declared artifact "${options.name}" contains placeholder content.`,
      evidence_ref: options.expectedPath
    });
    return {
      artifact: {
        name: options.name,
        required: true,
        from: options.definition.from,
        path: options.definition.path,
        expected_path: options.expectedPath,
        description: options.definition.description,
        status: "placeholder",
        current_attempt: true,
        size_bytes: sizeBytes
      },
      findings
    };
  }

  if (options.definition.path.toLocaleLowerCase().endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      findings.push({
        artifact: options.name,
        kind: "invalid_json",
        summary: `Declared JSON artifact "${options.name}" does not parse: ${message}`,
        evidence_ref: options.expectedPath
      });
      return {
        artifact: {
          name: options.name,
          required: true,
          from: options.definition.from,
          path: options.definition.path,
          expected_path: options.expectedPath,
          description: options.definition.description,
          status: "invalid_json",
          current_attempt: true,
          size_bytes: sizeBytes
        },
        findings
      };
    }
  }

  const forbidden = options.forbiddenContent.find((rule) => content.includes(rule.term));
  if (forbidden) {
    findings.push({
      artifact: options.name,
      kind: "forbidden_content",
      summary: `Declared artifact "${options.name}" contains contract-forbidden content: ${forbidden.term}.`,
      evidence_ref: options.expectedPath
    });
    return {
      artifact: {
        name: options.name,
        required: true,
        from: options.definition.from,
        path: options.definition.path,
        expected_path: options.expectedPath,
        description: options.definition.description,
        status: "forbidden_content",
        current_attempt: true,
        size_bytes: sizeBytes
      },
      findings
    };
  }

  const missingRequired = options.requiredContent.find((rule) => {
    if (
      rule.term === options.name ||
      rule.term === options.definition.path ||
      options.declaredArtifactIdentifiers.includes(rule.term)
    ) {
      return false;
    }
    return !content.includes(rule.term);
  });
  if (missingRequired) {
    findings.push({
      artifact: options.name,
      kind: "missing_required_content",
      summary: `Declared artifact "${options.name}" is missing required exact content: ${missingRequired.term}.`,
      evidence_ref: options.expectedPath
    });
    return {
      artifact: {
        name: options.name,
        required: true,
        from: options.definition.from,
        path: options.definition.path,
        expected_path: options.expectedPath,
        description: options.definition.description,
        status: "missing_required_content",
        current_attempt: true,
        size_bytes: sizeBytes
      },
      findings
    };
  }

  return {
    artifact: {
      name: options.name,
      required: true,
      from: options.definition.from,
      path: options.definition.path,
      expected_path: options.expectedPath,
      description: options.definition.description,
      status: "present",
      current_attempt: true,
      size_bytes: sizeBytes
    },
    findings
  };
}

function completionPacketPath(executionDir: string): string {
  return join(executionDir, "completion-packet.json");
}

function runtimeLogPath(runRoot: string): string {
  return join(runRoot, "runtime", "log.jsonl");
}

function helpersRootPath(options: BuildCompletionPacketOptions): string {
  return join(options.runtimeDir ?? join(options.runRoot, "runtime"), "helpers");
}

function normalizeEvidence(value: unknown): RuntimeLogEntry["evidence"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const evidence = value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim().length > 0) {
      return [{
        kind: "runtime_event" as const,
        summary: entry
      }];
    }
    if (!isRecord(entry)) {
      return [];
    }
    const kind = hasOwnString(entry, "kind");
    const summary = hasOwnString(entry, "summary");
    if (!kind || !summary || !evidenceKinds.includes(kind as (typeof evidenceKinds)[number])) {
      return [];
    }
    const ref = hasOwnString(entry, "ref");
    const status = hasOwnString(entry, "status");
    const data = isRecord(entry.data) ? entry.data : undefined;
    return [{
      kind: kind as (typeof evidenceKinds)[number],
      ...(ref ? { ref } : {}),
      summary,
      ...(status ? { status: status as "passed" | "failed" | "blocked" | "unknown" } : {}),
      ...(data ? { data } : {})
    }];
  });

  return evidence.length > 0 ? evidence : undefined;
}

function parseRuntimeLogLine(line: string): RuntimeLogEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const type = hasOwnString(parsed, "type");
  const summary = hasOwnString(parsed, "summary");
  const executionId = hasOwnString(parsed, "execution_id");
  if (!type || !summary || !executionId || !runtimeLogTypes.includes(type as (typeof runtimeLogTypes)[number])) {
    return undefined;
  }

  const findingKind = hasOwnString(parsed, "finding_kind");
  const severity = hasOwnString(parsed, "severity");
  const runId = hasOwnString(parsed, "run_id");
  const graphId = hasOwnString(parsed, "graph_id");
  const agentId = hasOwnString(parsed, "agent_id");
  const nodeId = hasOwnString(parsed, "node_id");
  const compiledId = hasOwnString(parsed, "compiled_id");
  const body = hasOwnString(parsed, "body");
  const blockedOn = hasOwnString(parsed, "blocked_on");
  const recoverableBy = hasOwnString(parsed, "recoverable_by");
  const decision = hasOwnString(parsed, "decision");
  const rationale = hasOwnString(parsed, "rationale");
  const contractImplication = hasOwnString(parsed, "contract_implication");
  const evidence = normalizeEvidence(parsed.evidence);
  return {
    log_id: hasOwnString(parsed, "log_id") ?? `log-${Date.now()}`,
    ...(runId ? { run_id: runId } : {}),
    ...(graphId ? { graph_id: graphId } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    execution_id: executionId,
    ...(nodeId ? { node_id: nodeId } : {}),
    ...(compiledId ? { compiled_id: compiledId } : {}),
    type: type as RuntimeLogEntry["type"],
    summary,
    ...(body ? { body } : {}),
    ...(findingKind && findingKinds.includes(findingKind as (typeof findingKinds)[number])
      ? { finding_kind: findingKind as (typeof findingKinds)[number] }
      : {}),
    ...(severity === "info" || severity === "warning" || severity === "error" ? { severity } : {}),
    ...(parsed.blocking === true ? { blocking: true } : {}),
    ...(blockedOn ? { blocked_on: blockedOn } : {}),
    ...(recoverableBy ? { recoverable_by: recoverableBy } : {}),
    ...(decision ? { decision } : {}),
    ...(rationale ? { rationale } : {}),
    ...(contractImplication ? { contract_implication: contractImplication } : {}),
    ...(evidence ? { evidence } : {}),
    ...(Array.isArray(parsed.artifact_refs)
      ? { artifact_refs: parsed.artifact_refs.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    created_at: hasOwnString(parsed, "created_at") ?? new Date().toISOString()
  };
}

async function readRuntimeLogs(runRoot: string, executionId: string): Promise<RuntimeLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(runtimeLogPath(runRoot), "utf8");
  } catch {
    return [];
  }

  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = parseRuntimeLogLine(line);
      return parsed && parsed.execution_id === executionId ? [parsed] : [];
    });
}

async function readHelperSessions(options: BuildCompletionPacketOptions): Promise<HelperSessionSnapshot[]> {
  let entries: string[];
  const helpersRoot = helpersRootPath(options);
  try {
    entries = await readdir(helpersRoot);
  } catch {
    return [];
  }

  const sessions = await Promise.all(entries.map(async (entry) => {
    const evidenceRef = join(helpersRoot, entry, "session.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(evidenceRef, "utf8")) as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) {
      return undefined;
    }
    const agentId = hasOwnString(parsed, "agent_id");
    const parentAgentId = hasOwnString(parsed, "parent_agent_id");
    const status = hasHelperStatus(hasOwnString(parsed, "status"));
    const purpose = hasHelperPurpose(hasOwnString(parsed, "purpose"));
    if (!agentId || !parentAgentId || parentAgentId !== options.attempt.execution_id || !status || !purpose) {
      return undefined;
    }
    const brief = hasOwnString(parsed, "brief");
    const artifacts = isRecord(parsed.artifacts)
      ? Object.fromEntries(Object.entries(parsed.artifacts).filter((artifact): artifact is [string, string] =>
          typeof artifact[0] === "string" &&
          artifact[0].trim().length > 0 &&
          typeof artifact[1] === "string" &&
          artifact[1].trim().length > 0
        ))
      : {};
    return {
      agent_id: agentId,
      parent_agent_id: parentAgentId,
      status,
      purpose,
      ...(brief ? { brief } : {}),
      artifacts,
      evidence_ref: evidenceRef
    } satisfies HelperSessionSnapshot;
  }));

  return sessions.filter((session): session is HelperSessionSnapshot => Boolean(session));
}

async function summarizeHelpers(options: BuildCompletionPacketOptions): Promise<CompletionHelperSummary> {
  const sessions = await readHelperSessions(options);
  const artifactState = await Promise.all(sessions.map(async (session) => {
    const present: string[] = [];
    const missing: string[] = [];
    for (const [name, path] of Object.entries(session.artifacts)) {
      if (await fileExists(path)) {
        present.push(path);
      } else {
        missing.push(`${session.agent_id}:${name}`);
      }
    }
    return { session, present, missing };
  }));

  return {
    active: sessions.length,
    completed: sessions.filter((session) => session.status === "completed").length,
    pending: sessions.filter((session) => session.status === "starting" || session.status === "running").length,
    failed: sessions.filter((session) => session.status === "failed" || session.status === "canceled").length,
    missing_artifacts: artifactState.flatMap((entry) => entry.missing),
    latest: artifactState.slice(-5).map((entry) => ({
      agent_id: entry.session.agent_id,
      purpose: entry.session.purpose,
      status: entry.session.status,
      summary: entry.session.brief ?? `${entry.session.purpose} helper ${entry.session.status}`,
      artifact_refs: entry.present,
      evidence_ref: entry.session.evidence_ref
    }))
  };
}

function runtimeLogSummary(logs: RuntimeLogEntry[]) {
  return {
    progress: logs.filter((log) => log.type === "progress").length,
    finding: logs.filter((log) => log.type === "finding").length,
    decision: logs.filter((log) => log.type === "decision").length,
    blocking_findings: logs.filter((log) => log.type === "finding" && log.blocking === true).length
  };
}

function extractLiteralCommands(criteria: string[]): string[] {
  const commands = new Set<string>();
  const backtickedCommandPattern = /\b(?:npm|pnpm|yarn|bun|node|pytest|cargo|go)\s+[a-zA-Z0-9:_./=-]+(?:\s+[a-zA-Z0-9:_./=-]+)*/u;
  const plainValidationPattern = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build)\b(?:\s+[a-zA-Z0-9:_./=-]+)*|\bgo\s+test\b(?:\s+[a-zA-Z0-9:_./=-]+)*|\bcargo\s+test\b(?:\s+[a-zA-Z0-9:_./=-]+)*|\bpytest\b(?:\s+[a-zA-Z0-9:_./=-]+)*/gu;

  for (const criterion of criteria) {
    const backtickMatches = criterion.match(/`([^`]+)`/gu) ?? [];
    for (const wrapped of backtickMatches) {
      const value = wrapped.slice(1, -1).trim();
      if (backtickedCommandPattern.test(value) || isGenericBacktickedCommand(value)) {
        commands.add(value);
      }
    }

    let match: RegExpExecArray | null;
    plainValidationPattern.lastIndex = 0;
    while ((match = plainValidationPattern.exec(criterion)) !== null) {
      commands.add(match[0].trim().replace(/[.)]+$/u, ""));
    }
  }

  return [...commands];
}

function isGenericBacktickedCommand(value: string): boolean {
  const parts = value.trim().split(/\s+/u);
  if (parts.length < 2) {
    return false;
  }

  const executable = parts[0] ?? "";
  if (!/[./-]/u.test(executable)) {
    return false;
  }

  return parts.slice(1).some((part) =>
    part.startsWith("-") ||
    part.includes("=") ||
    part.includes("/") ||
    part.includes(".")
  );
}

async function readAttemptTranscript(attempt: RuntimeNodeAttempt): Promise<string> {
  const chunks = await Promise.all(
    [attempt.stdout_log_path, attempt.stderr_log_path]
      .filter((path): path is string => typeof path === "string" && path.length > 0)
      .map(async (path) => {
        try {
          return await readFile(path, "utf8");
        } catch {
          return "";
        }
      })
  );
  return chunks.join("\n");
}

type RuntimeEvidence = NonNullable<RuntimeLogEntry["evidence"]>[number];

function evidenceDataStrings(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(evidenceDataStrings);
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap(evidenceDataStrings);
  }
  return [];
}

function commandEvidenceText(evidence: RuntimeEvidence): string[] {
  return [
    evidence.ref,
    evidence.summary,
    ...evidenceDataStrings(evidence.data)
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function logContainsCommandEvidence(logs: RuntimeLogEntry[], command: string): RuntimeLogEntry | undefined {
  return logs.find((log) => {
    const evidence = log.evidence ?? [];
    return evidence.some((item) =>
      (item.kind === "command_output" || item.kind === "tool_output") &&
      commandEvidenceText(item).some((value) => value.includes(command))
    );
  });
}

async function buildValidationEvidence(options: {
  acceptanceCriteria: string[];
  attempt: RuntimeNodeAttempt;
  logs: RuntimeLogEntry[];
}): Promise<CompletionValidationEvidence[]> {
  const commands = extractLiteralCommands(options.acceptanceCriteria);
  if (commands.length === 0) {
    return [];
  }

  const transcript = await readAttemptTranscript(options.attempt);
  return commands.map((command) => {
    const logEvidence = logContainsCommandEvidence(options.logs, command);
    if (logEvidence) {
      return {
        requirement: command,
        status: "present",
        source: "runtime_log",
        evidence_ref: logEvidence.log_id,
        summary: logEvidence.summary
      } satisfies CompletionValidationEvidence;
    }

    const stdoutHit = transcript.includes(command);
    return {
      requirement: command,
      status: stdoutHit ? "present" : "missing_evidence",
      source: stdoutHit ? "captured_transcript" : "acceptance_criteria",
      ...(stdoutHit
        ? {
            evidence_ref: [
              options.attempt.stdout_log_path,
              options.attempt.stderr_log_path
            ].filter(Boolean).join(", ")
          }
        : {})
    } satisfies CompletionValidationEvidence;
  });
}

function observationRelevant(observation: OperatorObservation, options: BuildCompletionPacketOptions): boolean {
  if (observation.status !== "active") {
    return false;
  }
  if (observation.attempt && observation.attempt !== options.attempt.execution_id) {
    return false;
  }
  if (observation.node && observation.node !== options.node.compiled_id && observation.node !== options.node.authored_id) {
    return false;
  }
  return true;
}

function observationSummary(observations: OperatorObservation[], options: BuildCompletionPacketOptions) {
  const active = observations.filter((observation) => observationRelevant(observation, options));
  const latest = active.slice(-5).map((observation) => ({
    observation_id: observation.observation_id,
    kind: observation.kind,
    summary: observation.summary,
    author: observation.author,
    severity: observation.severity,
    status: observation.status,
    ...(observation.node ? { target: observation.node } : {})
  }));
  return {
    active: active.length,
    blocking: active.filter((observation) => observation.kind === "blocker" || observation.blocking === true).length,
    latest
  };
}

function supervisorSummary(options: BuildCompletionPacketOptions) {
  const envelope = options.supervisorRecoveryEnvelope;
  return {
    active: Boolean(envelope),
    ...(options.supervisorRecoveryEnvelopePath ? { envelope_path: options.supervisorRecoveryEnvelopePath } : {}),
    ...(envelope?.retry_directive?.must_do ? { requirements: envelope.retry_directive.must_do } : {}),
    ...(envelope?.retry_directive?.summary ? { summary: envelope.retry_directive.summary } : {})
  };
}

function normalizeManaged(managed: CompletionManagedSummary | undefined): CompletionManagedSummary {
  return managed ?? { active: false };
}

function decideCompletionStatus(options: {
  artifactFindings: CompletionArtifactFinding[];
  validationEvidence: CompletionValidationEvidence[];
  activeBlockers: RuntimeLogEntry[];
  observations: OperatorObservation[];
  managed: CompletionManagedSummary;
  helpers: CompletionHelperSummary;
}): { status: CompletionStatus; reasons: string[] } {
  const reasons: string[] = [];
  let blocked = false;
  let incomplete = false;

  for (const finding of options.artifactFindings) {
    reasons.push(finding.summary);
    if (finding.kind === "blocked") {
      blocked = true;
    } else {
      incomplete = true;
    }
  }

  for (const evidence of options.validationEvidence) {
    if (evidence.status === "missing_evidence") {
      incomplete = true;
      reasons.push(`No evidence found for required validation: ${evidence.requirement}`);
    }
    if (evidence.status === "blocked") {
      blocked = true;
      reasons.push(`Validation blocked: ${evidence.requirement}`);
    }
  }

  for (const blocker of options.activeBlockers) {
    blocked = true;
    reasons.push(blocker.summary);
  }

  for (const observation of options.observations) {
    if (observation.kind === "blocker" || observation.blocking === true) {
      blocked = true;
      reasons.push(observation.summary);
    }
  }

  if (options.managed.active) {
    const managedBlockers = [
      ...(options.managed.failing_required_criteria ?? []),
      ...(options.managed.blocking_criteria ?? [])
    ];
    if (managedBlockers.length > 0 || options.managed.ready_for_publish === false) {
      incomplete = true;
      reasons.push(`Managed completion is not publish-ready: ${managedBlockers.join(", ") || "required criteria unresolved"}.`);
    }
  }

  for (const helper of options.helpers.latest) {
    if (helper.status === "starting" || helper.status === "running") {
      incomplete = true;
      reasons.push(`Helper ${helper.agent_id} is ${helper.status} and has not produced required evidence.`);
    }
    if (helper.status === "failed" || helper.status === "canceled") {
      incomplete = true;
      reasons.push(`Helper ${helper.agent_id} ended with status ${helper.status}.`);
    }
  }
  for (const missing of options.helpers.missing_artifacts) {
    incomplete = true;
    reasons.push(`Helper required artifact is missing: ${missing}`);
  }

  if (blocked) {
    return { status: "blocked", reasons };
  }
  if (incomplete) {
    return { status: "incomplete", reasons };
  }
  return { status: "ready_for_verification", reasons: [] };
}

export async function buildCompletionPacket(options: BuildCompletionPacketOptions): Promise<CompletionPacket> {
  const declaredArtifacts: CompletionDeclaredArtifact[] = [];
  const artifactFindings: CompletionArtifactFinding[] = [];
  const priorAttempts = options.priorAttempts ?? [];
  const forbiddenContent = extractForbiddenArtifactContent([
    options.node.intent.goal,
    ...options.node.intent.acceptance_criteria,
    ...options.node.intent.constraints,
    ...Object.values(options.node.declared_artifacts).map((artifact) => artifact.description)
  ]);
  const requiredContent = extractRequiredArtifactContent([
    options.node.intent.goal,
    ...options.node.intent.acceptance_criteria,
    ...options.node.intent.constraints,
    ...Object.values(options.node.declared_artifacts).map((artifact) => artifact.description)
  ]);
  const declaredArtifactIdentifiers = Object.entries(options.node.declared_artifacts).flatMap(([name, definition]) => [
    name,
    definition.path
  ]);
  for (const [name, definition] of Object.entries(options.node.declared_artifacts)) {
    const expectedPath = expectedArtifactPath({
      definition,
      executionDir: options.attempt.execution_dir,
      ...(options.outputDir ? { outputDir: options.outputDir } : {}),
      workspacePath: options.workspacePath,
      name
    });
    const inspected = await inspectArtifact({
      name,
      definition,
      expectedPath,
      currentAttemptPath: options.attempt.artifacts[name],
      priorAttempts,
      sandbox: options.sandbox,
      forbiddenContent,
      requiredContent,
      declaredArtifactIdentifiers
    });
    declaredArtifacts.push(inspected.artifact);
    artifactFindings.push(...inspected.findings);
  }

  const logs = await readRuntimeLogs(options.runRoot, options.attempt.execution_id);
  const activeBlockers = logs.filter((log) =>
    log.type === "finding" &&
    (log.finding_kind === "blocker" || log.blocking === true)
  );
  const validationEvidence = await buildValidationEvidence({
    acceptanceCriteria: [
      options.node.intent.goal,
      ...options.node.intent.acceptance_criteria,
      ...options.node.intent.constraints
    ],
    attempt: options.attempt,
    logs
  });
  const activeObservations = (options.observations ?? []).filter((observation) =>
    observationRelevant(observation, options)
  );
  const managed = normalizeManaged(options.managed);
  const helpers = await summarizeHelpers(options);
  const supervisor = supervisorSummary(options);
  const status = decideCompletionStatus({
    artifactFindings,
    validationEvidence,
    activeBlockers,
    observations: activeObservations,
    managed,
    helpers
  });

  return {
    version: "1",
    attempt_id: options.attempt.execution_id,
    execution_id: options.attempt.execution_id,
    execution_dir: options.attempt.execution_dir,
    packet_path: completionPacketPath(options.attempt.execution_dir),
    compiled_id: options.node.compiled_id,
    authored_id: options.node.authored_id,
    kind: options.node.kind,
    goal: options.node.intent.goal,
    acceptance_criteria: options.node.intent.acceptance_criteria,
    constraints: options.node.intent.constraints,
    authority: {
      sandbox: options.sandbox,
      repos: [options.node.repo]
    },
    declared_artifacts: declaredArtifacts,
    published_artifacts: declaredArtifacts
      .filter((artifact) => artifact.status === "present")
      .map((artifact) => artifact.name),
    missing_artifacts: declaredArtifacts
      .filter((artifact) => artifact.status === "missing")
      .map((artifact) => artifact.name),
    artifact_findings: artifactFindings,
    validation_evidence: validationEvidence,
    runtime_logs: runtimeLogSummary(logs),
    active_blockers: activeBlockers,
    operator_observations: observationSummary(options.observations ?? [], options),
    supervisor_recovery: supervisor,
    managed,
    helpers,
    completion_status: status.status,
    ready_for_verification: status.status === "ready_for_verification",
    blocking_reasons: [...new Set(status.reasons)]
  };
}

export async function persistCompletionPacket(packet: CompletionPacket): Promise<string> {
  await mkdir(dirname(packet.packet_path), { recursive: true });
  await writeFile(packet.packet_path, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  return packet.packet_path;
}
