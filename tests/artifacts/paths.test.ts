import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRunRootPath,
	  resolveExecutionArtifactsDirectory,
	  resolveExecutionAgentArtifactRepairBriefPath,
	  resolveExecutionAgentContextPath,
  resolveExecutionAgentDirectory,
  resolveExecutionAgentPromptPath,
  resolveExecutionAgentRecoveryBriefPath,
  resolveExecutionAgentResponsePath,
  resolveExecutionHumanDebugDirectory,
  resolveExecutionHumanDebugHarnessDirectory,
  resolveExecutionHumanDebugToolDirectory,
  resolveExecutionRuntimeCompletionPacketPath,
  resolveExecutionRuntimeContextPath,
  resolveExecutionRuntimeDirectory,
  resolveExecutionRuntimeResultPath,
  resolveExecutionRuntimeSupervisorDirectory,
  resolveExecutionRuntimeToolDirectory,
  resolveExecutionRuntimeVerifierPath,
  resolveInterventionDirectory,
  resolveNodeExecutionDirectory,
  resolveRunsRoot,
  runsRootEnvironmentVariable
} from "../../src/artifacts/paths.js";

describe("runs root resolution", () => {
  it("defaults to <graph-directory>/.task-runtime/runs when a graph directory is provided", () => {
    expect(
      resolveRunsRoot({
        currentWorkingDirectory: "/tmp/agentflow-launch",
        graphDirectory: "/tmp/agentflow-graphs/demo",
        environment: {}
      })
    ).toBe("/tmp/agentflow-graphs/demo/.task-runtime/runs");
  });

  it("falls back to <launch-cwd>/.task-runtime/runs when no graph directory or override is set", () => {
    expect(
      resolveRunsRoot({
        currentWorkingDirectory: "/tmp/agentflow-launch",
        environment: {}
      })
    ).toBe("/tmp/agentflow-launch/.task-runtime/runs");
  });

  it("prefers an absolute AGENTFLOW_RUNS_ROOT override over the graph directory default", () => {
    const runsRoot = join("/tmp", "agentflow-shared-runs");

    expect(
      resolveRunsRoot({
        currentWorkingDirectory: "/tmp/agentflow-launch",
        graphDirectory: "/tmp/agentflow-graphs/demo",
        environment: {
          [runsRootEnvironmentVariable]: runsRoot
        }
      })
    ).toBe(runsRoot);
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
      "/tmp/agentflow-launch/.task-runtime/runs/demo",
      "root__design_access_sync_program__managed__pattern_deep_work__workflow__design_access_sync_program__managed__pattern_deep_work__work_loop__design_access_sync_program__managed__pattern_deep_work__work_loop_body__design_access_sync_program__managed__pattern_deep_work__generate_validate",
      "exec__root__design_access_sync_program__managed__pattern_deep_work__workflow__design_access_sync_program__managed__pattern_deep_work__work_loop__design_access_sync_program__managed__pattern_deep_work__work_loop_body__design_access_sync_program__managed__pattern_deep_work__generate_validate__attempt_1__repeat_scope_scope__root__design_access_sync_program__managed__pattern_deep_work__workflow__design_access_sync_program__managed__pattern_deep_work__work_loop__iter_1"
    );

    const segments = executionDir.split("/").filter(Boolean);
    const nodeSegment = segments.at(-3) ?? "";
    const executionSegment = segments.at(-1) ?? "";

    expect(nodeSegment).toMatch(/^node-[0-9a-f]{16}$/);
    expect(executionSegment).toMatch(/^exec-[0-9a-f]{16}$/);
  });

  it("uses ordered readable node directories when compiled node order is provided", () => {
    const executionDir = resolveNodeExecutionDirectory(
      "/tmp/agentflow-launch/.task-runtime/runs/demo",
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
      "/tmp/agentflow-launch/.task-runtime/runs/demo",
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

  it("bounds long intervention ids to filesystem-safe directories", () => {
    const executionDir = "/tmp/agentflow/run/node/execution";
    const interventionId =
      "exec__root__research_artifacts_ui_plan__managed__pattern_deep_research__workflow__research_artifacts_ui_plan__managed__pattern_deep_research__angle_fanout__research_artifacts_ui_plan__managed__pattern_deep_research__angle_01__attempt_1__semantic_evaluation";
    const interventionDir = resolveInterventionDirectory(
      executionDir,
      interventionId
    );
    const sameInterventionDir = resolveInterventionDirectory(
      executionDir,
      interventionId
    );
    const differentInterventionDir = resolveInterventionDirectory(
      executionDir,
      `${interventionId}__retry`
    );

    const segments = interventionDir.split("/").filter(Boolean);
    const interventionSegment = segments.at(-1) ?? "";

    expect(interventionDir).toBe(sameInterventionDir);
    expect(interventionDir).not.toBe(differentInterventionDir);
    expect(interventionSegment.length).toBeLessThanOrEqual(120);
    expect(interventionSegment).toMatch(/^intervention-[0-9a-f]{16}$/);
  });

  it("resolves execution artifact directories as a stable execution subdirectory", () => {
    expect(resolveExecutionArtifactsDirectory("/tmp/agentflow/run/node/execution")).toBe(
      "/tmp/agentflow/run/node/execution/artifacts"
    );
  });

  it("preserves the execution directory anchor while segmenting execution internals by audience", () => {
    const executionDir = "/tmp/agentflow/run/nodes/001-work/executions/001-exec";

    expect(resolveExecutionArtifactsDirectory(executionDir)).toBe(`${executionDir}/artifacts`);
    expect(resolveExecutionAgentDirectory(executionDir)).toBe(`${executionDir}/agent`);
    expect(resolveExecutionAgentPromptPath(executionDir)).toBe(`${executionDir}/agent/prompt.md`);
    expect(resolveExecutionAgentContextPath(executionDir)).toBe(`${executionDir}/agent/context.md`);
	    expect(resolveExecutionAgentResponsePath(executionDir)).toBe(`${executionDir}/agent/response.md`);
	    expect(resolveExecutionAgentRecoveryBriefPath(executionDir)).toBe(`${executionDir}/agent/supervisor-recovery.md`);
	    expect(resolveExecutionAgentArtifactRepairBriefPath(executionDir)).toBe(`${executionDir}/agent/artifact-repair.md`);
    expect(resolveExecutionRuntimeDirectory(executionDir)).toBe(`${executionDir}/runtime`);
    expect(resolveExecutionRuntimeResultPath(executionDir)).toBe(`${executionDir}/runtime/result.json`);
    expect(resolveExecutionRuntimeCompletionPacketPath(executionDir)).toBe(`${executionDir}/runtime/completion-packet.json`);
    expect(resolveExecutionRuntimeContextPath(executionDir)).toBe(`${executionDir}/runtime/context.json`);
    expect(resolveExecutionRuntimeVerifierPath(executionDir)).toBe(`${executionDir}/runtime/verifier.json`);
    expect(resolveExecutionRuntimeSupervisorDirectory(executionDir)).toBe(`${executionDir}/runtime/supervisor`);
    expect(resolveExecutionRuntimeToolDirectory(executionDir)).toBe(`${executionDir}/runtime/tools`);
    expect(resolveExecutionHumanDebugDirectory(executionDir)).toBe(`${executionDir}/human-debug`);
    expect(resolveExecutionHumanDebugHarnessDirectory(executionDir)).toBe(`${executionDir}/human-debug/harness`);
    expect(resolveExecutionHumanDebugToolDirectory(executionDir)).toBe(`${executionDir}/human-debug/tools`);
  });
});
