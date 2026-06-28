import { readFile } from "node:fs/promises";

export const runtimeOrientationModes = ["startup_restore", "refresh_full", "recovery_focus"] as const;
export type RuntimeOrientationMode = (typeof runtimeOrientationModes)[number];

export interface RuntimeOrientationSummary {
  orient_called: boolean;
  orient_call_count: number;
  first_orient_at?: string;
  last_orient_at?: string;
  modes_seen: RuntimeOrientationMode[];
  evidence_ref?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeRuntimeOrientationMode(value: unknown): RuntimeOrientationMode | undefined {
  return runtimeOrientationModes.includes(value as RuntimeOrientationMode)
    ? value as RuntimeOrientationMode
    : undefined;
}

export function extractOrientationModeFromStdout(stdout: string | undefined): RuntimeOrientationMode | undefined {
  if (!stdout) {
    return undefined;
  }
  const match = stdout.match(/Orientation mode:\s*`?([a-z_]+)`?/u);
  return normalizeRuntimeOrientationMode(match?.[1]);
}

function appendUniqueMode(modes: RuntimeOrientationMode[], mode: RuntimeOrientationMode | undefined): void {
  if (mode && !modes.includes(mode)) {
    modes.push(mode);
  }
}

export async function summarizeOrientInvocations(options: {
  toolInvocationsPath?: string;
  executionId: string;
}): Promise<RuntimeOrientationSummary> {
  if (!options.toolInvocationsPath) {
    return { orient_called: false, orient_call_count: 0, modes_seen: [] };
  }

  let raw: string;
  try {
    raw = await readFile(options.toolInvocationsPath, "utf8");
  } catch {
    return { orient_called: false, orient_call_count: 0, modes_seen: [] };
  }

  const successful: JsonRecord[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.execution_id !== options.executionId) {
      continue;
    }
    const argv = Array.isArray(parsed.argv) ? parsed.argv : [];
    if (
      parsed.kind === "af" &&
      parsed.exit_code === 0 &&
      argv.length === 1 &&
      argv[0] === "orient"
    ) {
      successful.push(parsed);
    }
  }

  if (successful.length === 0) {
    return { orient_called: false, orient_call_count: 0, modes_seen: [] };
  }

  const modesSeen: RuntimeOrientationMode[] = [];
  for (const record of successful) {
    appendUniqueMode(modesSeen, normalizeRuntimeOrientationMode(record.orientation_mode));
  }

  const first = successful[0]!;
  const last = successful.at(-1)!;
  const firstOrientAt = stringValue(first.ts);
  const lastOrientAt = stringValue(last.ts);
  const evidenceRef = stringValue(last.output_path) ?? stringValue(last.stdout_path);

  return {
    orient_called: true,
    orient_call_count: successful.length,
    ...(firstOrientAt ? { first_orient_at: firstOrientAt } : {}),
    ...(lastOrientAt ? { last_orient_at: lastOrientAt } : {}),
    modes_seen: modesSeen,
    ...(evidenceRef ? { evidence_ref: evidenceRef } : {})
  };
}
