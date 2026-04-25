export interface SemanticEvaluation {
  passed: boolean;
  score: number;
  summary: string;
  issues: Array<{
    title: string;
    severity: "low" | "medium" | "high";
    evidence: string;
  }>;
  scope_drift?: {
    score: number;
    summary: string;
    paths?: string[];
  };
  architecture_fit?: {
    score: number;
    summary: string;
  };
  risk?: {
    score: number;
    summary: string;
  };
  requires_intervention?: boolean;
}

export type SemanticEvaluationNormalization =
  | { evaluation: SemanticEvaluation }
  | { diagnostics: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value) && value >= 0 && value <= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIssueSeverity(value: unknown): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function normalizeScoreSummaryRecord(
  value: unknown,
  name: string,
  diagnostics: string[]
): { score: number; summary: string } | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push(`${name} must be an object when provided.`);
    return undefined;
  }

  if (!isScore(value.score)) {
    diagnostics.push(`${name}.score must be a number between 0 and 1.`);
  }

  if (!isNonEmptyString(value.summary)) {
    diagnostics.push(`${name}.summary must be a non-empty string.`);
  }

  if (!isScore(value.score) || !isNonEmptyString(value.summary)) {
    return undefined;
  }

  return {
    score: value.score,
    summary: value.summary
  };
}

export function normalizeSemanticEvaluation(value: unknown): SemanticEvaluationNormalization {
  const diagnostics: string[] = [];

  if (!isRecord(value)) {
    return { diagnostics: ["Semantic evaluation must be a JSON object."] };
  }

  if (typeof value.passed !== "boolean") {
    diagnostics.push("passed must be a boolean.");
  }

  if (!isScore(value.score)) {
    diagnostics.push("score must be a number between 0 and 1.");
  }

  if (!isNonEmptyString(value.summary)) {
    diagnostics.push("summary must be a non-empty string.");
  }

  if (!Array.isArray(value.issues)) {
    diagnostics.push("issues must be an array.");
  }

  const issues = Array.isArray(value.issues)
    ? value.issues.flatMap((issue, index) => {
        if (!isRecord(issue)) {
          diagnostics.push(`issues[${index}] must be an object.`);
          return [];
        }

        if (!isNonEmptyString(issue.title)) {
          diagnostics.push(`issues[${index}].title must be a non-empty string.`);
        }

        if (!isIssueSeverity(issue.severity)) {
          diagnostics.push(`issues[${index}].severity must be one of: low, medium, high.`);
        }

        if (!isNonEmptyString(issue.evidence)) {
          diagnostics.push(`issues[${index}].evidence must be a non-empty string.`);
        }

        if (
          !isNonEmptyString(issue.title) ||
          !isIssueSeverity(issue.severity) ||
          !isNonEmptyString(issue.evidence)
        ) {
          return [];
        }

        return [{
          title: issue.title,
          severity: issue.severity,
          evidence: issue.evidence
        }];
      })
    : [];

  const scopeDriftBase = normalizeScoreSummaryRecord(value.scope_drift, "scope_drift", diagnostics);
  let scope_drift: SemanticEvaluation["scope_drift"] | undefined;
  if (scopeDriftBase && isRecord(value.scope_drift)) {
    const rawPaths = value.scope_drift.paths;
    if (rawPaths !== undefined && (!Array.isArray(rawPaths) || rawPaths.some((item) => !isNonEmptyString(item)))) {
      diagnostics.push("scope_drift.paths must be an array of non-empty strings when provided.");
    }
    scope_drift = {
      ...scopeDriftBase,
      ...(Array.isArray(rawPaths) && rawPaths.every((item) => isNonEmptyString(item))
        ? { paths: rawPaths }
        : {})
    };
  }

  const architecture_fit = normalizeScoreSummaryRecord(value.architecture_fit, "architecture_fit", diagnostics);
  const risk = normalizeScoreSummaryRecord(value.risk, "risk", diagnostics);

  if (value.requires_intervention !== undefined && typeof value.requires_intervention !== "boolean") {
    diagnostics.push("requires_intervention must be a boolean when provided.");
  }

  if (diagnostics.length > 0) {
    return { diagnostics };
  }

  return {
    evaluation: {
      passed: value.passed as boolean,
      score: value.score as number,
      summary: value.summary as string,
      issues,
      ...(scope_drift ? { scope_drift } : {}),
      ...(architecture_fit ? { architecture_fit } : {}),
      ...(risk ? { risk } : {}),
      ...(typeof value.requires_intervention === "boolean"
        ? { requires_intervention: value.requires_intervention }
        : {})
    }
  };
}
