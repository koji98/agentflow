import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRunRootPath,
  resolveExecutionArtifactsDirectory,
  resolveNodeExecutionDirectory,
  resolveRunsRoot,
  runsRootEnvironmentVariable
} from "../../src/artifacts/paths.js";

describe("runs root resolution", () => {
  it("defaults to <launch-cwd>/.agentflow/runs when no override is set", () => {
    expect(
      resolveRunsRoot({
        currentWorkingDirectory: "/tmp/agentflow-launch",
        environment: {}
      })
    ).toBe("/tmp/agentflow-launch/.agentflow/runs");
  });

  it("uses an absolute AGENTFLOW_RUNS_ROOT override verbatim", () => {
    const runsRoot = join("/tmp", "agentflow-shared-runs");

    expect(
      resolveRunsRoot({
        currentWorkingDirectory: "/tmp/agentflow-launch",
        environment: {
          [runsRootEnvironmentVariable]: runsRoot
        }
      })
    ).toBe(runsRoot);
  });

  it("rejects a relative AGENTFLOW_RUNS_ROOT override", () => {
    expect(() =>
      resolveRunsRoot({
        currentWorkingDirectory: "/tmp/agentflow-launch",
        environment: {
          [runsRootEnvironmentVariable]: "relative-runs"
        }
      })
    ).toThrowError(
      `${runsRootEnvironmentVariable} must be an absolute path when set. Received: relative-runs`
    );
  });

  it("bounds long run-root segments to filesystem-safe lengths", () => {
    const runRoot = createRunRootPath({
      currentWorkingDirectory: "/tmp/agentflow-launch",
      graphId:
        "mathboard-access-sync-admin-ux-design-with-an-extremely-long-graph-identifier-that-would-otherwise-overflow-the-filesystem-segment-limit-on-macos",
      runLabel:
        "this-is-an-equally-long-label-that-should-be-shortened-with-a-stable-hash-suffix-instead-of-producing-an-enametoolong-runtime-failure"
    });

    const finalSegment = runRoot.split("/").at(-1) ?? "";
    expect(finalSegment.length).toBeLessThanOrEqual(120);
    expect(finalSegment).toMatch(/-[0-9a-f]{12}$/);
  });

  it("bounds long node and execution ids to filesystem-safe directories", () => {
    const executionDir = resolveNodeExecutionDirectory(
      "/tmp/agentflow-launch/.agentflow/runs/demo",
      "root__design_access_sync_program__managed__pattern_spec_design__workflow__design_access_sync_program__managed__pattern_spec_design__revision_loop__design_access_sync_program__managed__pattern_spec_design__revision_body__design_access_sync_program__managed__pattern_spec_design__revise_spec",
      "exec__root__design_access_sync_program__managed__pattern_spec_design__workflow__design_access_sync_program__managed__pattern_spec_design__revision_loop__design_access_sync_program__managed__pattern_spec_design__revision_body__design_access_sync_program__managed__pattern_spec_design__revise_spec__attempt_1__repeat_scope_scope__root__design_access_sync_program__managed__pattern_spec_design__workflow__design_access_sync_program__managed__pattern_spec_design__revision_loop__iter_1"
    );

    const segments = executionDir.split("/").filter(Boolean);
    const nodeSegment = segments.at(-3) ?? "";
    const executionSegment = segments.at(-1) ?? "";

    expect(nodeSegment).toMatch(/^node-[0-9a-f]{16}$/);
    expect(executionSegment).toMatch(/^exec-[0-9a-f]{16}$/);
  });

  it("uses ordered readable node directories when compiled node order is provided", () => {
    const executionDir = resolveNodeExecutionDirectory(
      "/tmp/agentflow-launch/.agentflow/runs/demo",
      "root__repair_loop__repair_body__verify_fix",
      "exec__root__repair_loop__repair_body__verify_fix__attempt_1",
      {
        nodeIndex: 14,
        nodeCount: 331,
        label: "Verify Fix",
        attemptIndex: 1
      }
    );

    const segments = executionDir.split("/").filter(Boolean);
    const nodeSegment = segments.at(-3) ?? "";
    const executionSegment = segments.at(-1) ?? "";

    expect(nodeSegment).toMatch(/^015-verify-fix-[0-9a-f]{12}$/);
    expect(executionSegment).toMatch(/^001-exec-[0-9a-f]{16}$/);
  });

  it("uses ordered execution directories for repeat iterations", () => {
    const executionDir = resolveNodeExecutionDirectory(
      "/tmp/agentflow-launch/.agentflow/runs/demo",
      "root__retry__body__repair",
      "exec__root__retry__body__repair__attempt_12__repeat_scope__root__retry__iter_3",
      {
        nodeIndex: 1,
        nodeCount: 4,
        label: "Repair",
        attemptIndex: 12,
        iterationIndex: 3,
        iterationAttemptIndex: 2
      }
    );

    const segments = executionDir.split("/").filter(Boolean);
    const nodeSegment = segments.at(-3) ?? "";
    const executionSegment = segments.at(-1) ?? "";

    expect(nodeSegment).toMatch(/^002-repair-[0-9a-f]{12}$/);
    expect(executionSegment).toMatch(/^i003-a002-exec-[0-9a-f]{16}$/);
  });

  it("resolves execution artifact directories as a stable execution subdirectory", () => {
    expect(resolveExecutionArtifactsDirectory("/tmp/agentflow/run/node/execution")).toBe(
      "/tmp/agentflow/run/node/execution/artifacts"
    );
  });
});
