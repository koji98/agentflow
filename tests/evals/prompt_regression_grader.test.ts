import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("prompt regression grader diagnostics checks", () => {
  it("requires prompt diagnostics and enforces warning expectations", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-prompt-regression-grader-"));
    const runRoot = join(tempRoot, "run");
    const diagnosticsDir = join(runRoot, "nodes", "node-1", "executions", "001", "human-debug");
    const tracePacketPath = join(tempRoot, "trace-packet.json");
    const outputDir = join(tempRoot, "criteria", "prompt-regression");

    try {
      await mkdir(diagnosticsDir, { recursive: true });
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        join(diagnosticsDir, "prompt-diagnostics.json"),
        `${JSON.stringify({
          version: "1",
          prompt_kind: "agent",
          warnings: []
        }, null, 2)}\n`,
        "utf8"
      );
      await writeFile(
        tracePacketPath,
        `${JSON.stringify({
          artifacts: [
            {
              name: "handoff",
              content: [
                "Scenario: diagnostics-baseline",
                "Evidence: runtime measurement stayed internal",
                "Validation: focused grader fixture",
                "Risks: none",
                "Completion: done"
              ].join("\n")
            }
          ],
          trajectory: [
            { kind: "af_tool_call", command: "orient" },
            { kind: "af_tool_call", command: "complete check" },
            { kind: "completion_packet", ready_for_verification: true }
          ],
          simulation_events: []
        }, null, 2)}\n`,
        "utf8"
      );

      const { stdout } = await execFileAsync(
        process.execPath,
        ["graders/prompt-regression.mjs"],
        {
          cwd: "evals/agentflow-prompt-regression",
          env: {
            ...process.env,
            AGENTFLOW_EVAL_SCENARIO_ID: "prompt-diagnostics-baseline",
            AGENTFLOW_EVAL_TRACE_PACKET_FILE: tracePacketPath,
            AGENTFLOW_EVAL_RUN_ROOT: runRoot,
            AGENTFLOW_EVAL_OUTPUT_DIR: outputDir
          }
        }
      );

      const parsed = JSON.parse(stdout) as {
        passed: boolean;
        assertions: Array<{ id: string; passed: boolean }>;
        metrics: {
          prompt_diagnostics_count: number;
          prompt_warning_tags: string[];
        };
      };
      expect(parsed.passed).toBe(true);
      expect(parsed.assertions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "prompt_diagnostics_present", passed: true }),
        expect.objectContaining({ id: "forbidden_prompt_warning:context_many_pointers", passed: true })
      ]));
      expect(parsed.metrics.prompt_diagnostics_count).toBe(1);
      expect(parsed.metrics.prompt_warning_tags).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
