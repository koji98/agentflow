import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("validate:real-harness contract", () => {
  it("pins the optional real-harness smoke contract and package script", async () => {
    const scriptModule = await import("../../scripts/validate-real-harness.mjs");
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    ) as {
      scripts: Record<string, string>;
    };

    expect(scriptModule.realHarnessContract).toEqual({
      builtCliRelativePath: "dist/cli/index.js",
      selectionEnvVar: "AGENTFLOW_REAL_HARNESS",
      smokeGraph: {
        workspaceBackend: "inplace",
        nodeKind: "agent",
        timeoutSec: 180
      },
      artifactChecks: [
        "run.json status",
        "state.json status",
        "summary.md status",
        "run.completed event",
        "agent_response artifact"
      ],
      supportedHarnesses: [
        {
          kind: "codex-cli",
          envVar: "AGENTFLOW_CODEX_CLI_BIN",
          defaultBinary: "codex"
        },
        {
          kind: "cursor-cli",
          envVar: "AGENTFLOW_CURSOR_CLI_BIN",
          defaultBinary: "agent"
        }
      ]
    });
    expect(packageJson.scripts["validate:real-harness"]).toBe("node scripts/validate-real-harness.mjs");
  });

  it("parses harness selection from CLI flags and environment with CLI precedence", async () => {
    const scriptModule = await import("../../scripts/validate-real-harness.mjs");

    expect(scriptModule.parseRequestedHarnessKinds(["--harness", "cursor-cli"], {
      AGENTFLOW_REAL_HARNESS: "codex-cli"
    })).toEqual(["cursor-cli"]);
    expect(scriptModule.parseRequestedHarnessKinds([], {
      AGENTFLOW_REAL_HARNESS: "codex-cli,cursor-cli"
    })).toEqual(["codex-cli", "cursor-cli"]);
    expect(scriptModule.parseRequestedHarnessKinds(["--harness=all"], {})).toEqual([
      "codex-cli",
      "cursor-cli"
    ]);
    expect(() => scriptModule.parseRequestedHarnessKinds(["--harness", "unknown-cli"], {})).toThrow(
      'Unsupported harness "unknown-cli". Use codex-cli, cursor-cli, or all.'
    );
  });

  it("detects explicit binary overrides and skips cleanly when no binaries are available", async () => {
    const scriptModule = await import("../../scripts/validate-real-harness.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-real-harness-contract-"));
    const binaryPath = join(tempRoot, "mock-codex.sh");
    const scriptPath = fileURLToPath(new URL("../../scripts/validate-real-harness.mjs", import.meta.url));
    const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
    const nodePath = process.execPath;

    try {
      await writeFile(binaryPath, "#!/bin/sh\nexit 0\n");
      await chmod(binaryPath, 0o755);

      const detection = scriptModule.inspectHarnessBinary(scriptModule.realHarnessSpecs[0], {
        AGENTFLOW_CODEX_CLI_BIN: binaryPath,
        PATH: ""
      });

      expect(detection).toEqual({
        kind: "codex-cli",
        envVar: "AGENTFLOW_CODEX_CLI_BIN",
        binary: binaryPath,
        binarySource: "env-override",
        available: true,
        detectedPath: binaryPath
      });

      const skipped = spawnSync(nodePath, [scriptPath, "--json"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: "",
          AGENTFLOW_REAL_HARNESS: "codex-cli,cursor-cli"
        }
      });

      expect(skipped.status).toBe(0);
      expect(JSON.parse(skipped.stdout)).toEqual({
        status: "skipped",
        attempted_harnesses: 0,
        passed_harnesses: 0,
        skipped_harnesses: 2,
        results: [
          {
            harness: "codex-cli",
            status: "skipped",
            reason:
              'codex-cli binary "codex" is unavailable. Set AGENTFLOW_CODEX_CLI_BIN or install it on PATH. The smoke would have run the built CLI against a one-node real harness graph and verified durable passed artifacts and captured agent response.',
            binary: "codex",
            binary_source: "path-default"
          },
          {
            harness: "cursor-cli",
            status: "skipped",
            reason:
              'cursor-cli binary "agent" is unavailable. Set AGENTFLOW_CURSOR_CLI_BIN or install it on PATH. The smoke would have run the built CLI against a one-node real harness graph and verified durable passed artifacts and captured agent response.',
            binary: "agent",
            binary_source: "path-default"
          }
        ],
        reasons: ["No configured real harness binaries were available, so the optional smoke did not run."]
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("formats harness failures from summary diagnostics instead of raw JSON tails", async () => {
    const scriptModule = await import("../../scripts/validate-real-harness.mjs");
    const summary = [
      "# Run Summary: run-123",
      "",
      "## Diagnostics",
      "",
      "- `real-smoke-agent`: codex auth failed",
      "- `run.completed`: Run failed: terminal_failure",
      "",
      "## Latest Executions"
    ].join("\n");

    expect(scriptModule.extractSummaryDiagnostics(summary)).toEqual([
      "`real-smoke-agent`: codex auth failed",
      "`run.completed`: Run failed: terminal_failure"
    ]);
    expect(
      scriptModule.summarizeHarnessFailure({
        harnessKind: "codex-cli",
        detectedBinaryPath: "/usr/local/bin/codex",
        message: "Run failed.",
        diagnostics: scriptModule.extractSummaryDiagnostics(summary),
        summaryFile: "/tmp/run-123/summary.md",
        runRoot: "/tmp/run-123"
      })
    ).toBe(
      "codex-cli smoke failed against /usr/local/bin/codex: Diagnostics: `real-smoke-agent`: codex auth failed | `run.completed`: Run failed: terminal_failure | summary.md: /tmp/run-123/summary.md | run_root: /tmp/run-123"
    );
  });
});
