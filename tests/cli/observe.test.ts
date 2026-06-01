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

  it("adds, lists, and resolves live observations with message-first syntax", async () => {
    const added = await executeCli([
      "observe",
      "--run",
      "run-123",
      "Routed export worker is unavailable",
      "--node",
      "ship_artifacts_ui",
      "--blocking",
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
      observation: { observation_id: string; status: string; kind: string; blocking: boolean; message: string };
      observations_path: string;
    };
    expect(addPayload.observation).toEqual(expect.objectContaining({
      status: "active",
      kind: "blocker",
      blocking: true,
      message: "Routed export worker is unavailable"
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
      addPayload.observation.observation_id,
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

  it("joins multiple positional message words for quick observations", async () => {
    const added = await executeCli([
      "observe",
      "--run",
      runRoot,
      "Use",
      "generated",
      "types"
    ], tempRoot);

    expect(added.exitCode).toBe(0);
    const payload = JSON.parse(added.stdout) as {
      observation: { kind: string; severity: string; message: string };
    };
    expect(payload.observation).toEqual(expect.objectContaining({
      kind: "observation",
      severity: "info",
      message: "Use generated types"
    }));
  });

  it("rejects old add, summary, and body observe surfaces", async () => {
    const addResult = await executeCli([
      "observe",
      "add",
      "--run",
      runRoot,
      "Old add syntax"
    ], tempRoot);

    expect(addResult.exitCode).toBe(2);
    expect(addResult.stdout).toContain("Unexpected observe subcommand");

    const summaryResult = await executeCli([
      "observe",
      "--run",
      runRoot,
      "--summary",
      "Old summary syntax"
    ], tempRoot);

    expect(summaryResult.exitCode).toBe(2);
    expect(summaryResult.stdout).toContain("Unexpected option(s): --summary");

    const bodyResult = await executeCli([
      "observe",
      "--run",
      runRoot,
      "--body",
      "Old body syntax",
      "Message"
    ], tempRoot);

    expect(bodyResult.exitCode).toBe(2);
    expect(bodyResult.stdout).toContain("Unexpected option(s): --body");
  });

  it("rejects unknown observation kinds before writing evidence", async () => {
    const result = await executeCli([
      "observe",
      "--run",
      runRoot,
      "--kind",
      "contract_change",
      "Change the graph goal"
    ], tempRoot);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("--kind must be one of: observation, issue, risk, blocker");
  });
});
