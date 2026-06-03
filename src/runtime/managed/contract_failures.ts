import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveExecutionAgentDirectory, resolveExecutionRuntimeDirectory } from "../../artifacts/paths.js";
import { RuntimeFailureError } from "../failure.js";

export const managedContractFailureKinds = [
  "missing_artifact",
  "invalid_json",
  "schema_mismatch",
  "contract_mismatch",
  "unreadable_artifact",
  "unreadable_context"
] as const;

export type ManagedContractFailureKind = (typeof managedContractFailureKinds)[number];

export interface ManagedContractFinding {
  managed_kind: "pattern_deep_research" | "pattern_deep_work" | "pattern_work_list";
  phase: string;
  item_id?: string;
  artifact_name?: string;
  artifact_path?: string;
  failure_kind: ManagedContractFailureKind;
  message: string;
  expected: string;
  retry_boundary: string;
  required_next_action: string;
  evidence_refs: string[];
}

export interface ManagedContractFailurePacket {
  schema_version: 1;
  status: "active";
  created_at: string;
  findings: ManagedContractFinding[];
}

export class ManagedContractFailureError extends RuntimeFailureError {
  readonly findings: ManagedContractFinding[];

  constructor(findings: ManagedContractFinding | ManagedContractFinding[]) {
    const normalized = Array.isArray(findings) ? findings : [findings];
    const summary = normalized.map((finding) => finding.message).join(" ");
    super("artifact_contract_failure", summary, { managed_contract_findings: normalized });
    this.name = "ManagedContractFailureError";
    this.findings = normalized;
  }
}

export function managedContractFailureJsonPath(executionDir: string): string {
  return join(resolveExecutionRuntimeDirectory(executionDir), "managed-contract-failure.json");
}

export function managedContractFailureMarkdownPath(executionDir: string): string {
  return join(resolveExecutionAgentDirectory(executionDir), "managed-contract-failure.md");
}

export function managedContractFailureSummary(findings: ManagedContractFinding[]): string {
  return findings.map((finding) => {
    const target = [
      finding.item_id ? `item ${finding.item_id}` : undefined,
      finding.artifact_name ? `artifact ${finding.artifact_name}` : undefined
    ].filter(Boolean).join(", ");
    return `${finding.phase}${target ? ` (${target})` : ""}: ${finding.message}`;
  }).join(" ");
}

export function missingDeepWorkScorecardFinding(options: {
  phase: string;
  scorecardPath?: string;
}): ManagedContractFinding {
  return {
    managed_kind: "pattern_deep_work",
    phase: options.phase,
    artifact_name: "completion_scorecard",
    ...(options.scorecardPath ? { artifact_path: options.scorecardPath } : {}),
    failure_kind: options.scorecardPath ? "unreadable_artifact" : "missing_artifact",
    message: options.scorecardPath
      ? `Deep-work completion scorecard could not be read at ${options.scorecardPath}.`
      : "Deep-work completion scorecard was not published.",
    expected: "The completion gate publishes a readable completion_scorecard artifact with criterion results and gate status.",
    retry_boundary: "verification",
    required_next_action: "Rerun or repair the deep-work completion gate so it publishes a readable completion_scorecard.",
    evidence_refs: options.scorecardPath ? [options.scorecardPath] : []
  };
}

export function deepWorkCriterionContractFindings(options: {
  phase: string;
  scorecard: {
    path: string;
    criteria: Array<{
      id: string;
      summary?: string;
      evidence_path?: string;
      issues?: string[];
    }>;
  };
}): ManagedContractFinding[] {
  return options.scorecard.criteria.flatMap((criterion) => {
    const unreadable = criterion.issues?.includes("criterion_result_unreadable") === true;
    const missingPointer = criterion.summary === "Criterion result pointer was not available.";
    if (!unreadable && !missingPointer) {
      return [];
    }

    return [{
      managed_kind: "pattern_deep_work" as const,
      phase: options.phase,
      artifact_name: `criterion_result:${criterion.id}`,
      ...(criterion.evidence_path ? { artifact_path: criterion.evidence_path } : {}),
      failure_kind: missingPointer ? "missing_artifact" as const : "unreadable_artifact" as const,
      message: missingPointer
        ? `Deep-work criterion ${criterion.id} did not provide a result pointer.`
        : `Deep-work criterion ${criterion.id} result could not be read.`,
      expected: "Every deep-work criterion result is readable JSON before scorecard aggregation.",
      retry_boundary: "verification",
      required_next_action: `Rerun or repair criterion ${criterion.id} so it writes readable verification JSON before the scorecard gate.`,
      evidence_refs: [
        options.scorecard.path,
        ...(criterion.evidence_path ? [criterion.evidence_path] : [])
      ]
    }];
  });
}

function renderManagedContractFailureMarkdown(packet: ManagedContractFailurePacket): string {
  const lines = [
    "# Managed Contract Failure",
    "",
    "This runtime-authored packet identifies the exact managed contract issue to repair. Use it as retry input; do not treat it as source code or implementation output.",
    "",
    "| Phase | Item | Artifact | Failure | Required Next Action | Evidence |",
    "| --- | --- | --- | --- | --- | --- |"
  ];

  for (const finding of packet.findings) {
    lines.push([
      finding.phase,
      finding.item_id ?? "",
      finding.artifact_name ?? "",
      finding.message.replace(/\|/gu, "\\|"),
      finding.required_next_action.replace(/\|/gu, "\\|"),
      finding.evidence_refs.join("<br>").replace(/\|/gu, "\\|")
    ].map((entry) => ` ${entry} `).join("|"));
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function writeManagedContractFailurePacket(options: {
  executionDir: string;
  findings: ManagedContractFinding | ManagedContractFinding[];
  now?: () => Date;
}): Promise<{ jsonPath: string; markdownPath: string; packet: ManagedContractFailurePacket }> {
  const findings = Array.isArray(options.findings) ? options.findings : [options.findings];
  const packet: ManagedContractFailurePacket = {
    schema_version: 1,
    status: "active",
    created_at: (options.now ?? (() => new Date()))().toISOString(),
    findings
  };
  const jsonPath = managedContractFailureJsonPath(options.executionDir);
  const markdownPath = managedContractFailureMarkdownPath(options.executionDir);
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderManagedContractFailureMarkdown(packet), "utf8");
  return { jsonPath, markdownPath, packet };
}

export async function readManagedContractFailurePacket(
  executionDir: string
): Promise<ManagedContractFailurePacket | undefined> {
  try {
    const parsed = JSON.parse(await readFile(managedContractFailureJsonPath(executionDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as { schema_version?: unknown; status?: unknown; findings?: unknown };
    if (record.schema_version !== 1 || record.status !== "active" || !Array.isArray(record.findings)) {
      return undefined;
    }
    const findings = record.findings.filter((finding): finding is ManagedContractFinding =>
      Boolean(
        finding &&
        typeof finding === "object" &&
        !Array.isArray(finding) &&
        typeof (finding as ManagedContractFinding).managed_kind === "string" &&
        typeof (finding as ManagedContractFinding).phase === "string" &&
        typeof (finding as ManagedContractFinding).failure_kind === "string" &&
        typeof (finding as ManagedContractFinding).message === "string" &&
        typeof (finding as ManagedContractFinding).expected === "string" &&
        typeof (finding as ManagedContractFinding).retry_boundary === "string" &&
        typeof (finding as ManagedContractFinding).required_next_action === "string" &&
        Array.isArray((finding as ManagedContractFinding).evidence_refs)
      )
    );
    return findings.length > 0
      ? {
          schema_version: 1,
          status: "active",
          created_at: typeof (parsed as { created_at?: unknown }).created_at === "string"
            ? (parsed as { created_at: string }).created_at
            : "",
          findings
        }
      : undefined;
  } catch {
    return undefined;
  }
}
