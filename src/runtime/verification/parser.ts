import {
  outcomeVerificationFindingSeverities,
  type OutcomeVerificationFinding,
  type OutcomeVerificationFindingSeverity
} from "./types.js";

export interface ParsedOutcomeVerification {
  passed: boolean;
  summary: string;
  findings: OutcomeVerificationFinding[];
  blockers: OutcomeVerificationFinding[];
}

export type OutcomeVerificationParseResult =
  | {
      ok: true;
      mode: "ok" | "recovered";
      data: ParsedOutcomeVerification;
    }
  | {
      ok: false;
      error: string;
      raw_excerpt: string;
    };

const fencedJsonPattern = /```(?:json)?\s*([\s\S]+?)\s*```/iu;
const maxRawExcerpt = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeverity(value: unknown): value is OutcomeVerificationFindingSeverity {
  return typeof value === "string"
    && (outcomeVerificationFindingSeverities as readonly string[]).includes(value);
}

function trim(value: string): string {
  return value.trim();
}

function parseFinding(raw: unknown, index: number): OutcomeVerificationFinding {
  if (!isRecord(raw)) {
    throw new Error(`findings[${index}] must be an object.`);
  }

  if (!isSeverity(raw.severity)) {
    throw new Error(`findings[${index}].severity must be one of ${outcomeVerificationFindingSeverities.join(", ")}.`);
  }
  if (typeof raw.category !== "string" || raw.category.trim().length === 0) {
    throw new Error(`findings[${index}].category must be a non-empty string.`);
  }
  if (typeof raw.evidence !== "string" || raw.evidence.trim().length === 0) {
    throw new Error(`findings[${index}].evidence must be a non-empty string.`);
  }
  if (typeof raw.recommendation !== "string" || raw.recommendation.trim().length === 0) {
    throw new Error(`findings[${index}].recommendation must be a non-empty string.`);
  }

  let references: string[] | undefined;
  if (raw.references !== undefined) {
    if (!Array.isArray(raw.references) || !raw.references.every((entry) => typeof entry === "string")) {
      throw new Error(`findings[${index}].references must be an array of strings if provided.`);
    }
    references = raw.references.map(trim).filter((entry) => entry.length > 0);
    if (references.length === 0) {
      references = undefined;
    }
  }

  return {
    severity: raw.severity,
    category: raw.category.trim(),
    evidence: raw.evidence.trim(),
    recommendation: raw.recommendation.trim(),
    ...(references ? { references } : {})
  };
}

function buildRawExcerpt(raw: string): string {
  if (raw.length <= maxRawExcerpt) {
    return raw;
  }
  return `${raw.slice(0, maxRawExcerpt)}\n... [excerpt truncated at ${maxRawExcerpt} chars] ...`;
}

function extractJsonCandidate(raw: string): { candidate: string; mode: "ok" | "recovered" } | undefined {
  const fenced = raw.match(fencedJsonPattern);
  if (fenced && fenced[1]) {
    return { candidate: fenced[1].trim(), mode: "ok" };
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return { candidate: trimmed, mode: "recovered" };
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return { candidate: trimmed.slice(firstBrace, lastBrace + 1), mode: "recovered" };
  }

  return undefined;
}

export function parseOutcomeVerificationResponse(rawResponse: string): OutcomeVerificationParseResult {
  if (typeof rawResponse !== "string" || rawResponse.trim().length === 0) {
    return {
      ok: false,
      error: "Verifier response was empty.",
      raw_excerpt: ""
    };
  }

  const candidate = extractJsonCandidate(rawResponse);
  if (!candidate) {
    return {
      ok: false,
      error: "Verifier response did not contain a JSON object.",
      raw_excerpt: buildRawExcerpt(rawResponse)
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.candidate);
  } catch (error) {
    return {
      ok: false,
      error: `Verifier JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      raw_excerpt: buildRawExcerpt(rawResponse)
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: "Verifier JSON must be an object at the top level.",
      raw_excerpt: buildRawExcerpt(rawResponse)
    };
  }

  if (typeof parsed.passed !== "boolean") {
    return {
      ok: false,
      error: "Verifier JSON missing required boolean field `passed`.",
      raw_excerpt: buildRawExcerpt(rawResponse)
    };
  }

  if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0) {
    return {
      ok: false,
      error: "Verifier JSON missing required non-empty string field `summary`.",
      raw_excerpt: buildRawExcerpt(rawResponse)
    };
  }

  const rawFindings = parsed.findings;
  if (!Array.isArray(rawFindings)) {
    return {
      ok: false,
      error: "Verifier JSON missing required array field `findings`.",
      raw_excerpt: buildRawExcerpt(rawResponse)
    };
  }

  let findings: OutcomeVerificationFinding[];
  try {
    findings = rawFindings.map((entry, index) => parseFinding(entry, index));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      raw_excerpt: buildRawExcerpt(rawResponse)
    };
  }

  const blockers = findings.filter((finding) => finding.severity === "blocker");

  if (parsed.passed === true && blockers.length > 0) {
    return {
      ok: false,
      error: "Verifier marked passed=true but reported blocker findings.",
      raw_excerpt: buildRawExcerpt(rawResponse)
    };
  }

  return {
    ok: true,
    mode: candidate.mode,
    data: {
      passed: parsed.passed,
      summary: parsed.summary.trim(),
      findings,
      blockers
    }
  };
}
