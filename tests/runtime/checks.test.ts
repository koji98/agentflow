import { describe, expect, it } from "vitest";

import { runAiCheck } from "../../src/runtime/checks/ai.js";
import { runDeterministicCheck } from "../../src/runtime/checks/deterministic.js";
import type { HarnessAdapter } from "../../src/runtime/harness/types.js";

describe("runtime checks", () => {
  it("fails AI checks closed on malformed evaluator output", async () => {
    const harness: HarnessAdapter = {
      kind: "codex-cli",
      async run() {
        return {
          status: "passed",
          exitCode: 0,
          stdout: "not valid json"
        };
      },
      async cancel() {
        return;
      }
    };

    const result = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-1",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      prompt: "Evaluate the patch.",
      rubric: "Be strict.",
      context_packet_path: "/tmp/context_packet.json",
      output_dir: "/tmp",
      timeout_sec: 30,
      signal: undefined
    });

    expect(result.evaluation).toEqual(
      expect.objectContaining({
        passed: false,
        summary: expect.stringContaining("structured JSON")
      })
    );
  });

  it("fails AI checks closed when cursor-cli cannot guarantee strict read-only evaluation", async () => {
    const harness: HarnessAdapter = {
      kind: "cursor-cli",
      async run() {
        return {
          status: "passed",
          exitCode: 0,
          stdout: '{"passed":true,"score":1,"summary":"ok"}'
        };
      },
      async cancel() {
        return;
      }
    };

    const result = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-cursor-readonly",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      prompt: "Evaluate the patch.",
      rubric: "Be strict.",
      context_packet_path: "/tmp/context_packet.json",
      output_dir: "/tmp",
      timeout_sec: 30,
      signal: undefined
    });

    expect(result.harness_result).toEqual(
      expect.objectContaining({
        status: "failed",
        stderr: expect.stringContaining("cursor-cli does not provide a strict read-only evaluation contract")
      })
    );
    expect(result.evaluation).toEqual(
      expect.objectContaining({
        passed: false,
        summary: expect.stringContaining("Use codex-cli for AI checks")
      })
    );
  });

  it("fails AI checks closed on harness launch errors", async () => {
    const harness: HarnessAdapter = {
      kind: "codex-cli",
      async run() {
        throw new Error("spawnSync codex ETIMEDOUT");
      },
      async cancel() {
        return;
      }
    };

    const result = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-timeout",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      prompt: "Evaluate the patch.",
      rubric: "Be strict.",
      context_packet_path: "/tmp/context_packet.json",
      output_dir: "/tmp",
      timeout_sec: 30,
      signal: undefined
    });

    expect(result.harness_result).toEqual(
      expect.objectContaining({
        status: "failed",
        stderr: expect.stringContaining("ETIMEDOUT")
      })
    );
    expect(result.evaluation).toEqual(
      expect.objectContaining({
        passed: false,
        summary: expect.stringContaining("spawnSync codex ETIMEDOUT")
      })
    );
  });

  it("fails AI checks closed when a failed harness returns misleading structured JSON", async () => {
    const harness: HarnessAdapter = {
      kind: "codex-cli",
      async run() {
        return {
          status: "failed",
          exitCode: 1,
          stdout: '{"passed":true,"score":1,"summary":"ok"}',
          stderr: "spawnSync codex ETIMEDOUT"
        };
      },
      async cancel() {
        return;
      }
    };

    const result = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-timeout-json",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      prompt: "Evaluate the patch.",
      rubric: "Be strict.",
      context_packet_path: "/tmp/context_packet.json",
      output_dir: "/tmp",
      timeout_sec: 30,
      signal: undefined
    });

    expect(result.evaluation).toEqual(
      expect.objectContaining({
        passed: false,
        summary: expect.stringContaining("spawnSync codex ETIMEDOUT")
      })
    );
  });

  it("surfaces timed-out AI harness results instead of JSON parsing errors", async () => {
    const harness: HarnessAdapter = {
      kind: "codex-cli",
      async run() {
        return {
          status: "failed",
          exitCode: 1,
          stdout: '{"passed":true,"score":1,"summary":"ok"}',
          metadata: {
            timed_out: true,
            force_killed: true
          }
        };
      },
      async cancel() {
        return;
      }
    };

    const result = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-timeout-metadata",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      prompt: "Evaluate the patch.",
      rubric: "Be strict.",
      context_packet_path: "/tmp/context_packet.json",
      output_dir: "/tmp",
      timeout_sec: 30,
      signal: undefined
    });

    expect(result.evaluation).toEqual(
      expect.objectContaining({
        passed: false,
        summary: "AI check harness timed out and required a force kill."
      })
    );
  });

  it("parses fenced AI evaluator JSON and deterministic JSON-path checks without throwing", async () => {
    const harness: HarnessAdapter = {
      kind: "codex-cli",
      async run() {
        return {
          status: "passed",
          exitCode: 0,
          stdout: '```json\n{"passed":true,"score":0.9,"summary":"ok"}\n```'
        };
      },
      async cancel() {
        return;
      }
    };

    const aiResult = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-2",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      prompt: "Evaluate the patch.",
      rubric: undefined,
      context_packet_path: "/tmp/context_packet.json",
      output_dir: "/tmp",
      timeout_sec: 30,
      signal: undefined
    });

    expect(aiResult.evaluation).toEqual(
      expect.objectContaining({
        passed: true,
        score: 0.9,
        summary: "ok"
      })
    );

    const deterministicResult = await runDeterministicCheck({
      command: process.execPath,
      args: ["-e", "process.stdout.write('not json')"],
      cwd: process.cwd(),
      env: undefined,
      timeout_sec: 30,
      pass_if: {
        json_path: "$.passed",
        equals: true
      },
      signal: undefined
    });

    expect(deterministicResult.passed).toBe(false);
    expect(deterministicResult.summary).toContain("not valid JSON");
  });

  it("forces timed-out deterministic checks to exit if the child ignores SIGTERM", async () => {
    const started_at = Date.now();
    const result = await runDeterministicCheck({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
      env: undefined,
      timeout_sec: 1,
      pass_if: undefined,
      signal: undefined
    });

    expect(Date.now() - started_at).toBeLessThan(5000);
    expect(result.passed).toBe(false);
    expect(result.timed_out).toBe(true);
    expect(result.force_killed).toBe(true);
    expect(result.summary).toBe("Deterministic check timed out.");
  });

  it("passes inline env through deterministic checks", async () => {
    const result = await runDeterministicCheck({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.AGENTFLOW_CHECK_ENV ?? '')"],
      cwd: process.cwd(),
      env: {
        AGENTFLOW_CHECK_ENV: "expected-value"
      },
      timeout_sec: 30,
      pass_if: {
        exit_code: 0
      },
      signal: undefined
    });

    expect(result.passed).toBe(true);
    expect(result.stdout).toBe("expected-value");
  });
});
