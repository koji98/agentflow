import { describe, expect, it } from "vitest";

import { renderCliStdout } from "../../src/cli/index.js";

describe("CLI stdout rendering", () => {
  it("renders a compact interactive summary for successful runs", () => {
    const rendered = renderCliStdout(
      {
        exitCode: 0,
        stdout: "{\"command\":\"run\",\"status\":\"passed\"}",
        output: {
          command: "run",
          status: "passed",
          duration_ms: 2100,
          run_root: "/tmp/run-123",
          artifacts: {
            summary_file: "/tmp/run-123/summary.md"
          }
        }
      },
      { isTty: true }
    );

    expect(rendered).toBe(
      [
        "Run succeeded in 2s.",
        "Run root: /tmp/run-123",
        "Summary: /tmp/run-123/summary.md"
      ].join("\n")
    );
  });

  it("shows the primary error in the interactive summary for failed resumes", () => {
    const rendered = renderCliStdout(
      {
        exitCode: 1,
        stdout: "{\"command\":\"resume\",\"status\":\"failed\"}",
        output: {
          command: "resume",
          status: "failed",
          duration_ms: 2400,
          message: "Run resumed and failed again.",
          terminal_error: "verify_marker: Deterministic check failed.",
          run_root: "/tmp/run-456",
          artifacts: {
            summary_file: "/tmp/run-456/summary.md"
          }
        }
      },
      { isTty: true }
    );

    expect(rendered).toBe(
      [
        "Resume failed in 2s.",
        "Error: verify_marker: Deterministic check failed.",
        "Run root: /tmp/run-456",
        "Summary: /tmp/run-456/summary.md"
      ].join("\n")
    );
  });

  it("shows a warning line for passed runs with soft verification warnings", () => {
    const rendered = renderCliStdout(
      {
        exitCode: 0,
        stdout: "{\"command\":\"run\",\"status\":\"passed\"}",
        output: {
          command: "run",
          status: "passed",
          duration_ms: 1800,
          evidence_status: "warnings",
          terminal_warning: "verify: Deterministic check failed.",
          run_root: "/tmp/run-soft-warning",
          artifacts: {
            summary_file: "/tmp/run-soft-warning/summary.md"
          }
        }
      },
      { isTty: true }
    );

    expect(rendered).toBe(
      [
        "Run succeeded in 2s.",
        "Warning: verify: Deterministic check failed.",
        "Run root: /tmp/run-soft-warning",
        "Summary: /tmp/run-soft-warning/summary.md"
      ].join("\n")
    );
  });

  it("keeps structured stdout for non-interactive output", () => {
    const stdout = "{\"command\":\"run\",\"status\":\"passed\"}";
    const rendered = renderCliStdout(
      {
        exitCode: 0,
        stdout,
        output: {
          command: "run",
          status: "passed",
          duration_ms: 2100
        }
      },
      { isTty: false }
    );

    expect(rendered).toBe(stdout);
  });
});
