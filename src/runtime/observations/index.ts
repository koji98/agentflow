import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  evidenceKinds,
  findingKinds,
  type CompletionEvidence,
  type ObservationKind,
  type OperatorObservation
} from "../completion/index.js";

export const operatorObservationsFileName = "observations.jsonl";

export function operatorObservationsPath(runRoot: string): string {
  return join(runRoot, "runtime", operatorObservationsFileName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeEvidence(value: unknown): CompletionEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const kind = stringValue(entry.kind);
    const summary = stringValue(entry.summary);
    if (!kind || !summary || !evidenceKinds.includes(kind as CompletionEvidence["kind"])) {
      return [];
    }
    const status = stringValue(entry.status);
    const ref = stringValue(entry.ref);
    return [{
      kind: kind as CompletionEvidence["kind"],
      ...(ref ? { ref } : {}),
      summary,
      ...(status === "passed" || status === "failed" || status === "blocked" || status === "unknown"
        ? { status }
        : {})
    }];
  });
}

function normalizeObservation(value: unknown): OperatorObservation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const observationId = stringValue(value.observation_id);
  const author = stringValue(value.author);
  const kind = stringValue(value.kind);
  const severity = stringValue(value.severity);
  const message = stringValue(value.message);
  const status = stringValue(value.status);
  const createdAt = stringValue(value.created_at);

  if (
    !observationId ||
    !author ||
    !kind ||
    !findingKinds.includes(kind as ObservationKind) ||
    !severity ||
    !(severity === "info" || severity === "warning" || severity === "error") ||
    !message ||
    !status ||
    !(status === "active" || status === "resolved" || status === "superseded") ||
    !createdAt
  ) {
    return undefined;
  }

  const runId = stringValue(value.run_id);
  const node = stringValue(value.node);
  const attempt = stringValue(value.attempt);
  const blockedOn = stringValue(value.blocked_on);
  const recoverableBy = stringValue(value.recoverable_by);
  const resolutionMessage = stringValue(value.resolution_message);
  const updatedAt = stringValue(value.updated_at);

  return {
    observation_id: observationId,
    ...(runId ? { run_id: runId } : {}),
    author,
    kind: kind as ObservationKind,
    severity,
    message,
    ...(node ? { node } : {}),
    ...(attempt ? { attempt } : {}),
    evidence: normalizeEvidence(value.evidence),
    ...(value.blocking === true ? { blocking: true } : {}),
    ...(blockedOn ? { blocked_on: blockedOn } : {}),
    ...(recoverableBy ? { recoverable_by: recoverableBy } : {}),
    status,
    ...(resolutionMessage ? { resolution_message: resolutionMessage } : {}),
    created_at: createdAt,
    ...(updatedAt ? { updated_at: updatedAt } : {})
  };
}

export async function readOperatorObservationHistory(runRoot: string): Promise<OperatorObservation[]> {
  let raw: string;
  try {
    raw = await readFile(operatorObservationsPath(runRoot), "utf8");
  } catch {
    return [];
  }

  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = normalizeObservation(JSON.parse(line));
        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

export async function readOperatorObservations(runRoot: string): Promise<OperatorObservation[]> {
  const history = await readOperatorObservationHistory(runRoot);
  const latest = new Map<string, OperatorObservation>();
  for (const observation of history) {
    latest.set(observation.observation_id, observation);
  }
  return [...latest.values()].sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export async function appendOperatorObservation(
  runRoot: string,
  observation: OperatorObservation
): Promise<string> {
  const filePath = operatorObservationsPath(runRoot);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(observation)}\n`, "utf8");
  return filePath;
}

export function createOperatorObservation(options: {
  runId?: string;
  author: string;
  kind: ObservationKind;
  severity: OperatorObservation["severity"];
  message: string;
  node?: string;
  attempt?: string;
  evidence?: CompletionEvidence[];
  blocking?: boolean;
  blockedOn?: string;
  recoverableBy?: string;
  now?: Date;
}): OperatorObservation {
  const now = options.now ?? new Date();
  return {
    observation_id: `obs_${now.toISOString().replace(/[-:.TZ]/gu, "")}_${randomUUID().slice(0, 8)}`,
    ...(options.runId ? { run_id: options.runId } : {}),
    author: options.author,
    kind: options.kind,
    severity: options.severity,
    message: options.message,
    ...(options.node ? { node: options.node } : {}),
    ...(options.attempt ? { attempt: options.attempt } : {}),
    evidence: options.evidence ?? [],
    ...(options.blocking ? { blocking: true } : {}),
    ...(options.blockedOn ? { blocked_on: options.blockedOn } : {}),
    ...(options.recoverableBy ? { recoverable_by: options.recoverableBy } : {}),
    status: "active",
    created_at: now.toISOString()
  };
}

export async function resolveOperatorObservation(options: {
  runRoot: string;
  observationId: string;
  status: "resolved" | "superseded";
  message: string;
  now?: Date;
}): Promise<OperatorObservation> {
  const observations = await readOperatorObservations(options.runRoot);
  const existing = observations.find((observation) => observation.observation_id === options.observationId);
  if (!existing) {
    throw new Error(`Observation "${options.observationId}" was not found.`);
  }
  if (existing.status !== "active") {
    throw new Error(`Observation "${options.observationId}" is already ${existing.status}.`);
  }

  const updated: OperatorObservation = {
    ...existing,
    status: options.status,
    resolution_message: options.message,
    updated_at: (options.now ?? new Date()).toISOString()
  };
  await appendOperatorObservation(options.runRoot, updated);
  return updated;
}
