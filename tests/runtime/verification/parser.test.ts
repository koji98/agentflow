import { describe, expect, it } from "vitest";

import { parseOutcomeVerificationResponse } from "../../../src/runtime/verification/parser.js";

const passingFenced = "```json\n{\"passed\":true,\"summary\":\"Looks correct.\",\"findings\":[]}\n```";
const failingFenced = "```json\n" + JSON.stringify({
  passed: false,
  summary: "Function returns wrong value for negative inputs.",
  findings: [
    {
      severity: "blocker",
      category: "incorrect_output",
      evidence: "agent-response.md says positive but code returns -1.",
      recommendation: "Return 0 for negative inputs."
    }
  ]
}) + "\n```";

describe("parseOutcomeVerificationResponse", () => {
  it("parses a strict fenced JSON pass response", () => {
    const result = parseOutcomeVerificationResponse(passingFenced);
    if (!result.ok) {
      throw new Error(`Expected ok, got error: ${result.error}`);
    }
    expect(result.mode).toBe("ok");
    expect(result.data.passed).toBe(true);
    expect(result.data.findings).toEqual([]);
    expect(result.data.summary).toBe("Looks correct.");
  });

  it("parses a fenced JSON failure with blocker findings", () => {
    const result = parseOutcomeVerificationResponse(failingFenced);
    if (!result.ok) {
      throw new Error(`Expected ok, got error: ${result.error}`);
    }
    expect(result.data.passed).toBe(false);
    expect(result.data.findings).toHaveLength(1);
    expect(result.data.blockers).toHaveLength(1);
    expect(result.data.findings[0]?.category).toBe("incorrect_output");
  });

  it("recovers when the model omits the fence but emits a top-level JSON object", () => {
    const raw = JSON.stringify({
      passed: false,
      summary: "Recovered",
      findings: [
        {
          severity: "high",
          category: "missing_test",
          evidence: "no tests added",
          recommendation: "add a regression test"
        }
      ]
    });
    const result = parseOutcomeVerificationResponse(raw);
    if (!result.ok) {
      throw new Error(`Expected ok, got error: ${result.error}`);
    }
    expect(result.mode).toBe("recovered");
    expect(result.data.passed).toBe(false);
    expect(result.data.findings[0]?.severity).toBe("high");
  });

  it("rejects prose-only responses", () => {
    const result = parseOutcomeVerificationResponse("Looks good to me.");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.error).toContain("did not contain a JSON object");
  });

  it("rejects payload missing passed boolean", () => {
    const raw = "```json\n{\"summary\":\"x\",\"findings\":[]}\n```";
    const result = parseOutcomeVerificationResponse(raw);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.error).toContain("passed");
  });

  it("rejects findings missing required fields", () => {
    const raw = "```json\n" + JSON.stringify({
      passed: false,
      summary: "bad",
      findings: [{ severity: "blocker" }]
    }) + "\n```";
    const result = parseOutcomeVerificationResponse(raw);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.error).toContain("findings[0]");
  });

  it("rejects findings with unknown severity", () => {
    const raw = "```json\n" + JSON.stringify({
      passed: false,
      summary: "bad",
      findings: [{
        severity: "critical",
        category: "x",
        evidence: "y",
        recommendation: "z"
      }]
    }) + "\n```";
    const result = parseOutcomeVerificationResponse(raw);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.error).toContain("severity");
  });

  it("rejects passed=true with a blocker finding", () => {
    const raw = "```json\n" + JSON.stringify({
      passed: true,
      summary: "ok?",
      findings: [{
        severity: "blocker",
        category: "x",
        evidence: "y",
        recommendation: "z"
      }]
    }) + "\n```";
    const result = parseOutcomeVerificationResponse(raw);
    expect(result.ok).toBe(false);
  });

  it("ignores commentary outside the fence", () => {
    const raw = `Here is my verdict.\n${passingFenced}\nThanks.`;
    const result = parseOutcomeVerificationResponse(raw);
    expect(result.ok).toBe(true);
  });
});
