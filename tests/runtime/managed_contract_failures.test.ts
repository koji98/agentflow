import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  deepWorkCriterionContractFindings,
  missingDeepWorkScorecardFinding,
  writeManagedContractFailurePacket
} from "../../src/runtime/managed/contract_failures.js";

describe("managed contract failures", () => {
  it("converts missing and unreadable deep-work criterion results into structured findings", () => {
    const findings = deepWorkCriterionContractFindings({
      phase: "completion_gate",
      scorecard: {
        path: "/run/scorecard.json",
        criteria: [
          {
            id: "missing_pointer",
            summary: "Criterion result pointer was not available."
          },
          {
            id: "unreadable_json",
            summary: "Criterion result could not be read: Unexpected token",
            evidence_path: "/run/criteria/unreadable/verification.json",
            issues: ["criterion_result_unreadable"]
          },
          {
            id: "ordinary_failure",
            summary: "The criterion failed semantically.",
            evidence_path: "/run/criteria/ordinary/verification.json",
            issues: ["semantic_failure"]
          }
        ]
      }
    });

    expect(findings).toEqual([
      expect.objectContaining({
        managed_kind: "pattern_deep_work",
        phase: "completion_gate",
        artifact_name: "criterion_result:missing_pointer",
        failure_kind: "missing_artifact",
        retry_boundary: "verification"
      }),
      expect.objectContaining({
        managed_kind: "pattern_deep_work",
        phase: "completion_gate",
        artifact_name: "criterion_result:unreadable_json",
        artifact_path: "/run/criteria/unreadable/verification.json",
        failure_kind: "unreadable_artifact",
        retry_boundary: "verification"
      })
    ]);
  });

  it("writes JSON source of truth and compact agent-facing Markdown", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-managed-contract-failure-"));
    const executionDir = join(tempRoot, "execution");
    await mkdir(executionDir, { recursive: true });

    const written = await writeManagedContractFailurePacket({
      executionDir,
      findings: missingDeepWorkScorecardFinding({ phase: "completion_gate" }),
      now: () => new Date("2026-06-02T12:00:00.000Z")
    });

    const packet = JSON.parse(await readFile(written.jsonPath, "utf8")) as {
      schema_version: number;
      status: string;
      created_at: string;
      findings: Array<{ managed_kind: string; artifact_name?: string; failure_kind: string }>;
    };
    expect(packet).toEqual(expect.objectContaining({
      schema_version: 1,
      status: "active",
      created_at: "2026-06-02T12:00:00.000Z"
    }));
    expect(packet.findings).toEqual([
      expect.objectContaining({
        managed_kind: "pattern_deep_work",
        artifact_name: "completion_scorecard",
        failure_kind: "missing_artifact"
      })
    ]);
    const markdown = await readFile(written.markdownPath, "utf8");
    expect(markdown).toContain("# Managed Contract Failure");
    expect(markdown).toContain("completion_scorecard");
    expect(markdown).not.toContain("human-debug");

    await rm(tempRoot, { recursive: true, force: true });
  });
});

