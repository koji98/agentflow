import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompiledCheckNode } from "../../src/graph/compiled.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import {
  buildRequirementEvidenceMap,
  selectEvidenceMapDelta
} from "../../src/supervisor/evidence_map.js";

const policy = {
  profile_name: "default",
  sandbox: "workspace-write" as const,
  timeout_sec: 60,
  artifact_repair: { max_attempts: 1 }
};

function aiCheckNode(): CompiledCheckNode {
  return {
    compiled_id: "validate",
    authored_id: "validate",
    kind: "check",
    check_kind: "ai",
    intent: {
      goal: "Validate ship readiness.",
      acceptance_criteria: ["The handoff cites exact validation commands and changed files."],
      constraints: ["Do not accept unevidenced claims."]
    },
    repo: "main",
    deps: ["worker"],
    scope_stack: ["root"],
    effective_policy: policy,
    context: [],
    declared_artifacts: {},
    on_failure: "fail",
    rubric: "The handoff must cite exact validation commands and changed files."
  };
}

describe("supervisor requirement evidence maps", () => {
  it("maps failed AI-check requirements to available and missing evidence", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-evidence-map-"));
    const resultPath = join(tempRoot, "result.json");
    const stderrPath = join(tempRoot, "stderr.log");
    await writeFile(resultPath, JSON.stringify({ passed: false }), "utf8");
    await writeFile(stderrPath, "missing validation command evidence\n", "utf8");
    const attempt: RuntimeNodeAttempt = {
      execution_id: "exec__validate__attempt_1",
      compiled_id: "validate",
      authored_id: "validate",
      kind: "check",
      repo_alias: "main",
      execution_dir: tempRoot,
      attempt_index: 1,
      status: "failed",
      outcome: "failed",
      started_at: "2026-05-01T00:00:00.000Z",
      ended_at: "2026-05-01T00:00:01.000Z",
      result_path: resultPath,
      stderr_log_path: stderrPath,
      artifacts: {},
      metadata: {}
    };
    const map = buildRequirementEvidenceMap({
      node: aiCheckNode(),
      attempt,
      rawResult: {
        passed: false,
        summary: "The handoff is missing exact validation command evidence.",
        issues: ["No changed-file list is cited."]
      },
      generatedAt: "2026-05-01T00:00:02.000Z"
    });
    expect(map.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requirement: "The handoff cites exact validation commands and changed files.",
        status: "missing",
        evidence_refs: expect.arrayContaining([
          expect.objectContaining({ path: resultPath }),
          expect.objectContaining({ path: stderrPath })
        ])
      })
    ]));
    expect(map.missing_evidence.length).toBeGreaterThan(0);
    expect(selectEvidenceMapDelta(map).delta).toEqual(expect.objectContaining({
      kind: "requirement_evidence_mapped"
    }));
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("blocks retry when no evidence can prove the requirement", () => {
    const map = buildRequirementEvidenceMap({
      node: aiCheckNode(),
      rawResult: {
        passed: false,
        summary: "The handoff is missing exact validation command evidence."
      },
      generatedAt: "2026-05-01T00:00:02.000Z"
    });
    expect(selectEvidenceMapDelta(map)).toEqual(expect.objectContaining({
      blockedReason: expect.stringContaining("No available run evidence")
    }));
  });
});
