import { describe, expect, it } from "vitest";

import { normalizeSemanticEvaluation } from "../../src/runtime/evaluators/semantic.js";

describe("semantic evaluator normalization", () => {
  it("normalizes rich semantic evaluator JSON", () => {
    const normalized = normalizeSemanticEvaluation({
      passed: false,
      score: 0.62,
      summary: "The change drifts from the approved checkout scope.",
      issues: [
        {
          title: "Touches billing provider setup",
          severity: "high",
          evidence: "Diff includes src/billing/provider.ts"
        }
      ],
      scope_drift: {
        score: 0.45,
        summary: "Billing provider setup is out of scope.",
        paths: ["src/billing/provider.ts"]
      },
      architecture_fit: {
        score: 0.7,
        summary: "Mostly follows existing boundaries."
      },
      risk: {
        score: 0.8,
        summary: "Payment behavior changed."
      },
      requires_intervention: true
    });

    expect(normalized).toEqual({
      evaluation: {
        passed: false,
        score: 0.62,
        summary: "The change drifts from the approved checkout scope.",
        issues: [
          {
            title: "Touches billing provider setup",
            severity: "high",
            evidence: "Diff includes src/billing/provider.ts"
          }
        ],
        scope_drift: {
          score: 0.45,
          summary: "Billing provider setup is out of scope.",
          paths: ["src/billing/provider.ts"]
        },
        architecture_fit: {
          score: 0.7,
          summary: "Mostly follows existing boundaries."
        },
        risk: {
          score: 0.8,
          summary: "Payment behavior changed."
        },
        requires_intervention: true
      }
    });
  });

  it("rejects semantic evaluator output without required evidence fields", () => {
    expect(normalizeSemanticEvaluation({ passed: true })).toEqual({
      diagnostics: [
        "score must be a number between 0 and 1.",
        "summary must be a non-empty string.",
        "issues must be an array."
      ]
    });
  });
});
