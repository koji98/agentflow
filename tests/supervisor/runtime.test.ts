import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRunArtifactPaths } from "../../src/artifacts/paths.js";
import { readSupervisorInterventions } from "../../src/artifacts/reader.js";
import { ArtifactWriter } from "../../src/artifacts/writer.js";
import type { SupervisorInterventionRecord } from "../../src/supervisor/types.js";

describe("supervisor runtime ledger", () => {
  it("appends intervention records to the durable run ledger", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "agentflow-supervisor-ledger-"));
    const writer = new ArtifactWriter(runRoot);
    await writer.initializeSupervisorLedger();

    const record: SupervisorInterventionRecord = {
      intervention_id: "int_1",
      decision_id: "decision_1",
      action: "repair_artifact",
      status: "passed",
      target_compiled_id: "root__implement",
      target_execution_id: "exec__root__implement__attempt_1",
      started_at: "2026-04-24T00:00:00.000Z",
      ended_at: "2026-04-24T00:00:01.000Z",
      reason: "Declared artifact was missing after agent success.",
      evidence: {
        missing_artifacts: ["change_summary"]
      },
      artifact_paths: {
        repair_log: "/tmp/repair.log"
      }
    };

    await writer.appendSupervisorIntervention(record);

    expect(resolveRunArtifactPaths(runRoot).interventions_file).toBe(
      join(runRoot, "interventions.jsonl")
    );
    await expect(readSupervisorInterventions(runRoot)).resolves.toEqual([record]);
  });

  it("returns an empty intervention list when no ledger exists", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "agentflow-supervisor-empty-"));

    await expect(readSupervisorInterventions(runRoot)).resolves.toEqual([]);
  });
});
