import { createHash } from "node:crypto";

import type { CompiledExecutableNode } from "../graph/compiled.js";
import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import type { RuntimeNodeExecutionResult } from "../runtime/core/engine.js";
import type {
  SupervisorEvidenceReference,
  SupervisorMaterialDelta,
  SupervisorRequirementEvidence,
  SupervisorRequirementEvidenceMap,
  SupervisorRequirementEvidenceStatus
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableId(parts: string[]): string {
  return createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 10);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, output);
    }
    return output;
  }

  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("summary") ||
        lowerKey.includes("issue") ||
        lowerKey.includes("finding") ||
        lowerKey.includes("blocker") ||
        lowerKey.includes("evidence") ||
        lowerKey.includes("recommendation") ||
        lowerKey.includes("error") ||
        lowerKey.includes("stderr") ||
        lowerKey.includes("stdout")
      ) {
        collectStrings(nested, output);
      }
    }
  }

  return output;
}

function readResultPayload(options: {
  result?: RuntimeNodeExecutionResult;
  rawResult?: unknown;
}): unknown {
  if (options.result) {
    return {
      outcome: options.result.outcome,
      status: options.result.status,
      result: options.result.result,
      stdout: options.result.stdout,
      stderr: options.result.stderr,
      metadata: options.result.metadata,
      check: options.result.check,
      verification: options.result.verification,
      verification_artifact: options.result.verification_artifact,
      agent_response: options.result.agent_response
    };
  }
  return options.rawResult;
}

function issueTexts(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }

  const nested = isRecord(payload.result) ? payload.result : payload;
  const candidates: unknown[] = [];
  if (Array.isArray(nested.issues)) {
    candidates.push(...nested.issues);
  }
  if (Array.isArray(nested.findings)) {
    candidates.push(...nested.findings);
  }
  if (Array.isArray(nested.blockers)) {
    candidates.push(...nested.blockers);
  }
  if (isRecord(nested.outcome_verification)) {
    if (Array.isArray(nested.outcome_verification.findings)) {
      candidates.push(...nested.outcome_verification.findings);
    }
    if (Array.isArray(nested.outcome_verification.blockers)) {
      candidates.push(...nested.outcome_verification.blockers);
    }
    candidates.push(nested.outcome_verification.summary);
  }
  candidates.push(nested.summary, nested.error, payload.stderr, payload.stdout);

  return uniqueStrings(candidates.flatMap((candidate) => collectStrings(candidate)));
}

function requirementsForNode(node: CompiledExecutableNode, payload: unknown): SupervisorRequirementEvidence[] {
  const entries: Array<Pick<SupervisorRequirementEvidence, "requirement" | "source">> = [];
  if (node.intent.goal.trim().length > 0) {
    entries.push({
      source: "goal",
      requirement: node.intent.goal.trim()
    });
  }
  for (const item of node.intent.acceptance_criteria ?? []) {
    if (item.trim().length > 0) {
      entries.push({
        source: "acceptance_criteria",
        requirement: item.trim()
      });
    }
  }
  for (const item of node.intent.constraints ?? []) {
    if (item.trim().length > 0) {
      entries.push({
        source: "constraint",
        requirement: item.trim()
      });
    }
  }
  if (node.kind === "check" && node.check_kind === "ai" && typeof node.rubric === "string" && node.rubric.trim().length > 0) {
    entries.push({
      source: "check_rubric",
      requirement: node.rubric.trim()
    });
  }
  for (const issue of issueTexts(payload).slice(0, 8)) {
    entries.push({
      source: "failure_issue",
      requirement: issue
    });
  }

  const deduped = new Map<string, Pick<SupervisorRequirementEvidence, "requirement" | "source">>();
  for (const entry of entries) {
    const key = `${entry.source}:${entry.requirement}`;
    deduped.set(key, entry);
  }

  return [...deduped.values()].map((entry, index) => ({
    id: `r${index + 1}_${stableId([entry.source, entry.requirement])}`,
    requirement: entry.requirement,
    source: entry.source,
    status: "unknown",
    evidence_refs: []
  }));
}

function attemptEvidenceRefs(attempt: RuntimeNodeAttempt | undefined): SupervisorEvidenceReference[] {
  if (!attempt) {
    return [];
  }

  const refs: Array<SupervisorEvidenceReference | undefined> = [
    attempt.prompt_path ? { label: "failed prompt", path: attempt.prompt_path, kind: "prompt" } : undefined,
    attempt.result_path ? { label: "attempt result", path: attempt.result_path, kind: "result" } : undefined,
    attempt.stdout_log_path ? { label: "stdout log", path: attempt.stdout_log_path, kind: "stdout" } : undefined,
    attempt.stderr_log_path ? { label: "stderr log", path: attempt.stderr_log_path, kind: "stderr" } : undefined,
    attempt.context_packet_path ? { label: "context packet", path: attempt.context_packet_path, kind: "context_packet" } : undefined,
    attempt.context_manifest_path ? { label: "context manifest", path: attempt.context_manifest_path, kind: "context_manifest" } : undefined,
    attempt.context_provenance_path ? { label: "context provenance", path: attempt.context_provenance_path, kind: "context_provenance" } : undefined,
    ...Object.entries(attempt.artifacts).map(([name, path]) => ({
      label: `artifact:${name}`,
      path,
      kind: "artifact"
    }))
  ];
  return refs.filter((item): item is SupervisorEvidenceReference => Boolean(item));
}

function textSuggestsAuthorityGap(text: string): boolean {
  return /\b(credential|permission|approval|authority|auth|login|token|remote side effect|scope)\b/iu.test(text);
}

function textSuggestsMissingEvidence(text: string): boolean {
  return /\b(missing|absent|not provided|not cited|no evidence|without evidence|unproven|cannot verify|not shown|not demonstrated|lacks)\b/iu.test(text);
}

function textSuggestsConflict(text: string): boolean {
  return /\b(conflict|contradict|inconsistent|stale|mismatch)\b/iu.test(text);
}

function classifyRequirementStatus(options: {
  requirement: SupervisorRequirementEvidence;
  failureTexts: string[];
  availableRefs: SupervisorEvidenceReference[];
}): {
  status: SupervisorRequirementEvidenceStatus;
  missing_reason?: string;
} {
  const haystack = options.failureTexts.join("\n").toLowerCase();
  const requirement = options.requirement.requirement.toLowerCase();
  const words = requirement
    .split(/[^a-z0-9_/-]+/u)
    .filter((word) => word.length >= 5)
    .slice(0, 8);
  const related = words.length === 0 || words.some((word) => haystack.includes(word));

  if (related && textSuggestsAuthorityGap(haystack)) {
    return {
      status: "outside_authority",
      missing_reason: "The failure text indicates the requirement crosses a credential, permission, scope, or remote-side-effect boundary."
    };
  }
  if (related && textSuggestsConflict(haystack)) {
    return {
      status: "conflicting",
      missing_reason: "The failure text indicates available evidence conflicts or is stale."
    };
  }
  if (related && textSuggestsMissingEvidence(haystack)) {
    return {
      status: "missing",
      missing_reason: "The failure text says the run did not provide enough evidence for this requirement."
    };
  }
  if (options.availableRefs.length > 0 && options.requirement.source !== "failure_issue") {
    return { status: "available" };
  }
  return {
    status: "missing",
    missing_reason: "No deterministic evidence in the current run proves this requirement."
  };
}

export function buildRequirementEvidenceMap(options: {
  node: CompiledExecutableNode;
  attempt?: RuntimeNodeAttempt;
  result?: RuntimeNodeExecutionResult;
  rawResult?: unknown;
  generatedAt?: string;
}): SupervisorRequirementEvidenceMap {
  const payload = readResultPayload({
    ...(options.result ? { result: options.result } : {}),
    ...(options.rawResult !== undefined ? { rawResult: options.rawResult } : {})
  });
  const availableEvidence = attemptEvidenceRefs(options.attempt);
  const failureTexts = issueTexts(payload);
  const requirements = requirementsForNode(options.node, payload).map((requirement) => {
    const classification = classifyRequirementStatus({
      requirement,
      failureTexts,
      availableRefs: availableEvidence
    });
    const evidenceRefs =
      classification.status === "available"
        ? availableEvidence
        : availableEvidence.filter((ref) => ref.kind !== "prompt");
    return {
      ...requirement,
      status: classification.status,
      evidence_refs: evidenceRefs,
      ...(classification.missing_reason ? { missing_reason: classification.missing_reason } : {})
    };
  });
  const missingEvidence = requirements.filter((requirement) =>
    requirement.status === "missing" ||
    requirement.status === "unknown" ||
    requirement.status === "outside_authority" ||
    requirement.status === "conflicting"
  );

  return {
    map_id: `evidence_map_${stableId([
      options.node.compiled_id,
      options.attempt?.execution_id ?? "no-attempt",
      JSON.stringify(requirements.map((requirement) => [requirement.id, requirement.status]))
    ])}`,
    node_compiled_id: options.node.compiled_id,
    node_authored_id: options.node.authored_id,
    ...(options.attempt?.execution_id ? { attempt_execution_id: options.attempt.execution_id } : {}),
    generated_at: options.generatedAt ?? nowIso(),
    requirements,
    available_evidence: availableEvidence,
    missing_evidence: missingEvidence
  };
}

export function evidenceMapHasActionableEvidence(map: SupervisorRequirementEvidenceMap): boolean {
  const actionableKinds = new Set(["artifact", "result", "stdout", "stderr", "context_manifest", "context_packet", "context_provenance"]);
  return map.requirements.some((requirement) =>
    requirement.evidence_refs.some((ref) => ref.kind ? actionableKinds.has(ref.kind) : Boolean(ref.path || ref.url))
  );
}

export function evidenceMapRequiresAuthority(map: SupervisorRequirementEvidenceMap): boolean {
  return map.requirements.some((requirement) => requirement.status === "outside_authority");
}

export function evidenceMapHasUnprovableRequirements(map: SupervisorRequirementEvidenceMap): boolean {
  return map.requirements.some((requirement) =>
    requirement.status === "missing" || requirement.status === "unknown" || requirement.status === "conflicting"
  );
}

export function selectEvidenceMapDelta(map: SupervisorRequirementEvidenceMap): {
  delta?: SupervisorMaterialDelta;
  blockedReason?: string;
} {
  if (evidenceMapRequiresAuthority(map)) {
    return {
      blockedReason: "A failed requirement needs authority, credentials, scope, or remote-side-effect approval the supervisor cannot infer."
    };
  }

  if (evidenceMapHasActionableEvidence(map)) {
    return {
      delta: {
        kind: "requirement_evidence_mapped",
        summary: "Mapped failed requirements to current run evidence so the retry has a concrete evidence target.",
        artifact_paths: Object.fromEntries(
          map.available_evidence
            .filter((ref) => typeof ref.path === "string")
            .slice(0, 12)
            .map((ref, index) => [`evidence_${index + 1}`, ref.path!])
        )
      }
    };
  }

  if (evidenceMapHasUnprovableRequirements(map)) {
    return {
      blockedReason: "No available run evidence can prove the failed requirement under the current graph contract."
    };
  }

  return {
    blockedReason: "No material recovery delta was available."
  };
}

export function renderRequirementEvidenceMapMarkdown(map: SupervisorRequirementEvidenceMap): string {
  const lines = [
    "# Requirement Evidence Map",
    "",
    `- Map: \`${map.map_id}\``,
    `- Node: \`${map.node_authored_id}\` (\`${map.node_compiled_id}\`)`,
    ...(map.attempt_execution_id ? [`- Attempt: \`${map.attempt_execution_id}\``] : []),
    "",
    "| ID | Source | Status | Requirement | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...map.requirements.map((requirement) => {
      const evidence = requirement.evidence_refs.length > 0
        ? requirement.evidence_refs.map((ref) => ref.path ?? ref.url ?? ref.label).join("<br>")
        : requirement.missing_reason ?? "";
      return `| \`${requirement.id}\` | \`${requirement.source}\` | \`${requirement.status}\` | ${requirement.requirement.replace(/\|/gu, "\\|")} | ${evidence.replace(/\|/gu, "\\|")} |`;
    })
  ];
  return `${lines.join("\n")}\n`;
}
