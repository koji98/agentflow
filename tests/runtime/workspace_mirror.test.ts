import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHarnessWorkspaceWriteMirror } from "../../src/runtime/harness/workspace_mirror.js";

describe("harness workspace-write mirror", () => {
  it("keeps long managed execution ids in distinct mirror directories", () => {
    const commonPrefix = [
      "exec",
      "root",
      "lodash_research",
      "managed",
      "pattern_deep_research",
      "workflow",
      "lodash_research",
      "managed",
      "pattern_deep_research",
      "angle_fanout",
      "lodash_research",
      "managed",
      "pattern_deep_research"
    ].join("__");

    const first = createHarnessWorkspaceWriteMirror({
      harness: "codex-cli",
      sandbox: "workspace-write",
      workspace_path: "/workspace",
      run_id: "run-1",
      execution_id: `${commonPrefix}__angle_01__attempt_1`,
      execution_dir: "/run/nodes/001/executions/001-exec",
      output_dir: "/run/nodes/001/executions/001-exec/artifacts",
      runtime_dir: "/run/nodes/001/executions/001-exec/runtime"
    });
    const second = createHarnessWorkspaceWriteMirror({
      harness: "codex-cli",
      sandbox: "workspace-write",
      workspace_path: "/workspace",
      run_id: "run-1",
      execution_id: `${commonPrefix}__angle_02__attempt_1`,
      execution_dir: "/run/nodes/002/executions/001-exec",
      output_dir: "/run/nodes/002/executions/001-exec/artifacts",
      runtime_dir: "/run/nodes/002/executions/001-exec/runtime"
    });

    expect(first?.root_dir).toContain(join("/workspace", ".agentflow-runtime", "run-1"));
    expect(second?.root_dir).toContain(join("/workspace", ".agentflow-runtime", "run-1"));
    expect(first?.root_dir).not.toBe(second?.root_dir);
    expect(first?.output_dir).not.toBe(second?.output_dir);
  });
});
