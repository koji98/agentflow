import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeCli } from "../../src/cli/index.js";

describe("agentflow observe", () => {
  let tempRoot: string;
  let runRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentflow-observe-"));
    runRoot = join(tempRoot, ".agentflow", "runs", "run-123");
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "run.json"), `${JSON.stringify({
      owner: "test",
      run_id: "run-123",
      graph_id: "observe-test",
      launch_profile: "default",
      workspace_backend: "inplace",
      status: "running",
      started_at: "2026-05-03T12:00:00.000Z"
    }, null, 2)}\n`, "utf8");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("adds, lists, and resolves live observations without pausing the run", async () => {
    const added = await executeCli([
      "observe",
      "add",
      "--run",
      "run-123",
      "--kind",
      "blocker",
      "--summary",
      "Routed export worker is unavailable",
      "--node",
      "ship_artifacts_ui",
      "--blocked-on",
      "operator_managed_backend_worker",
      "--recoverable-by",
      "operator",
      "--evidence",
      JSON.stringify({
        kind: "external_state",
        summary: "Worker process is stopped.",
        status: "blocked"
      })
    ], tempRoot);

    expect(added.exitCode).toBe(0);
    const addPayload = JSON.parse(added.stdout) as {
      observation: { observation_id: string; status: string; kind: string; blocking: boolean };
      observations_path: string;
    };
    expect(addPayload.observation).toEqual(expect.objectContaining({
      status: "active",
      kind: "blocker",
      blocking: true
    }));

    const listed = await executeCli(["observe", "list", "--run", runRoot, "--active"], tempRoot);
    expect(listed.exitCode).toBe(0);
    const listPayload = JSON.parse(listed.stdout) as { observations: Array<{ observation_id: string }> };
    expect(listPayload.observations.map((entry) => entry.observation_id)).toEqual([
      addPayload.observation.observation_id
    ]);

    const resolved = await executeCli([
      "observe",
      "resolve",
      "--run",
      runRoot,
      "--observation",
      addPayload.observation.observation_id,
      "--resolution",
      "resolved",
      "--summary",
      "Worker restarted"
    ], tempRoot);
    expect(resolved.exitCode).toBe(0);

    const activeAfterResolve = await executeCli(["observe", "list", "--run", runRoot, "--active"], tempRoot);
    expect(JSON.parse(activeAfterResolve.stdout).observations).toEqual([]);

    const ledgerLines = (await readFile(addPayload.observations_path, "utf8"))
      .trim()
      .split(/\r?\n/u);
    expect(ledgerLines).toHaveLength(2);
  });

  it("rejects unknown observation kinds before writing evidence", async () => {
    const result = await executeCli([
      "observe",
      "add",
      "--run",
      runRoot,
      "--kind",
      "contract_change",
      "--summary",
      "Change the graph goal"
    ], tempRoot);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("--kind must be one of: observation, issue, risk, blocker");
  });
});

