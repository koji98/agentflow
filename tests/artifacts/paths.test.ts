import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
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
});
