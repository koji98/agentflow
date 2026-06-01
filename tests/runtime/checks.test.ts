import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import { runAiCheck } from "../../src/runtime/checks/ai.js";
import { runDeterministicCheck, runLocalProcess } from "../../src/runtime/checks/deterministic.js";
import { renderHarnessPrompt, type HarnessAdapter } from "../../src/runtime/harness/types.js";

function createHarness(
  kind: HarnessAdapter["kind"],
  run: HarnessAdapter["run"]
): HarnessAdapter {
  return {
    kind,
    capabilities: getHarnessCapabilities(kind)!,
    run,
    async cancel() {
      return;
    }
  };
}

describe("runtime checks", () => {
  it("fails AI checks closed on malformed evaluator output", async () => {
    let capturedInvocation: Parameters<HarnessAdapter["run"]>[0] | undefined;
    const harness = createHarness("codex-cli", async (invocation) => {
      capturedInvocation = invocation;
      return {
        status: "passed",
        exitCode: 0,
        stdout: "not valid json"
      };
    });

    const result = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-1",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      node_goal: "Evaluate the patch.",
      rubric: "Be strict.",
      context_packet_path: "/tmp/runtime/context.json",
      context_manifest_path: "/tmp/agent/context.md",
      output_dir: "/tmp",
      skills: [
        {
          ref: "team/evaluator",
          source_alias: "team",
          name: "evaluator",
          description: "Evaluate evidence strictly.",
          path: "/tmp/.agentflow/skills/team/sha/evaluator/SKILL.md"
        }
      ],
      cli: [
        {
          cmd: "jq",
          description: "Inspect structured JSON evidence."
        }
      ],
      timeout_sec: 30,
      signal: undefined
    });

    expect(capturedInvocation).toEqual(
      expect.objectContaining({
        promptKind: "ai_check",
        contextPacketPath: "/tmp/runtime/context.json",
        contextManifestPath: "/tmp/agent/context.md",
        outputDir: "/tmp",
        artifacts: {},
        skills: expect.arrayContaining([
          expect.objectContaining({
            ref: "team/evaluator"
          })
        ]),
        cli: expect.arrayContaining([
          expect.objectContaining({
            cmd: "jq"
          })
        ])
      })
    );
    const renderedPrompt = renderHarnessPrompt(capturedInvocation!);
    expect(renderedPrompt).toContain("Evaluate the patch.");
    expect(renderedPrompt).toContain("Be strict.");
    expect(renderedPrompt).toContain("## Optional Skills");
    expect(renderedPrompt).toContain("| evaluator | Evaluate evidence strictly. | `/tmp/.agentflow/skills/team/sha/evaluator/SKILL.md` |");
    expect(renderedPrompt).toContain("## Ambient CLI Hints");
    expect(renderedPrompt).toContain("| `jq` | Inspect structured JSON evidence. |");
    expect(result.evaluation).toEqual(
      expect.objectContaining({
        passed: false,
        summary: expect.stringContaining("structured JSON")
      })
    );
  });

  it("renders the AI check harness prompt with role, JSON output spec, and inlined manifest", () => {
    const rendered = renderHarnessPrompt({
      promptKind: "ai_check",
      runId: "run-render",
      executionId: "exec-render",
      repoAlias: "main",
      repoPath: "/tmp/workspace",
      sandbox: "read-only",
      model: "gpt-5-judge",
      nodeGoal: "Evaluate the change.",
      contextPacketPath: "/tmp/runtime/context.json",
      contextManifestPath: "/tmp/agent/context.md",
      contextManifest: "# Context Manifest\n\n## Pointers\n\n| Name | Kind | Pointer | What | Why |\n| --- | --- | --- | --- | --- |\n| `requirements` | `workspace_file` | `/tmp/requirements.md` | Requirements. | Needed for this check. |\n| `handoff` | `artifact` | `/tmp/handoff.md` | Handoff. | Needed for this check. |\n",
      outputDir: "/tmp",
      artifacts: {},
      timeoutSec: 30,
      signal: undefined
    });

    expect(rendered).toContain("## Role");
    expect(rendered).toContain("You are an AI evaluator executing one read-only check node");
    expect(rendered).toContain("Sandbox: read-only");
    expect(rendered).toContain("## Pointers");
    expect(rendered).not.toContain("Context packet:");
    expect(rendered).not.toContain("Context provenance:");
    expect(rendered).toContain("## Output");
    expect(rendered).toContain("Return JSON only with this exact shape:");
    expect(rendered).toContain('{"passed":true,"score":0.0,"summary":"short summary","issues":[]}');
    expect((rendered.match(/## Context/g) ?? []).length).toBe(1);
  });

  it("lets eval judges override the AI check output schema without losing raw JSON", async () => {
    let capturedInvocation: Parameters<HarnessAdapter["run"]>[0] | undefined;
    const harness = createHarness("codex-cli", async (invocation) => {
      capturedInvocation = invocation;
      return {
        status: "passed",
        exitCode: 0,
        stdout: '{"passed_quality_bar":true,"score":4,"dimension_scores":{"artifact_quality":4},"blockers":[],"rationale":"ok","prompt_feedback":{"helpful_sections":[],"noisy_sections":[],"missing_guidance":[]}}'
      };
    });

    const outputSchema = '{"passed_quality_bar":true,"score":4}';
    const result = await runAiCheck({
      harness,
      run_id: "run-judge",
      execution_id: "exec-judge",
      repo_alias: "eval",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      node_goal: "Judge the trial.",
      rubric: "Use the eval judge schema.",
      output_schema: outputSchema,
      context_packet_path: "/tmp/runtime/context.json",
      context_manifest_path: "/tmp/agent/context.md",
      output_dir: "/tmp",
      timeout_sec: 30,
      signal: undefined
    });

    expect(renderHarnessPrompt(capturedInvocation!)).toContain(outputSchema);
    expect(result.evaluation.passed).toBe(false);
    expect(result.evaluation.summary).toContain("boolean passed");
    expect(result.evaluation.raw).toEqual(
      expect.objectContaining({
        passed_quality_bar: true,
        score: 4
      })
    );
  });

  it("writes AI check prompts to the provided prompt path for audit parity with agent nodes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-ai-check-prompt-"));
    const promptPath = join(tempRoot, "agent", "prompt.md");
    const harness = createHarness("codex-cli", async () => {
      return {
        status: "passed",
        exitCode: 0,
        stdout: '{"passed":true,"score":1,"summary":"ok"}'
      };
    });

    try {
      const result = await runAiCheck({
        harness,
        run_id: "run-1",
        execution_id: "exec-ai-prompt",
        repo_alias: "main",
        repo_path: process.cwd(),
        model: "gpt-5-judge",
        node_goal: "Evaluate the patch.",
        rubric: "Be strict.",
        context_packet_path: join(tempRoot, "runtime", "context.json"),
        context_manifest_path: join(tempRoot, "agent", "context.md"),
        context_manifest: "# Context Manifest\n",
        prompt_path: promptPath,
        output_dir: join(tempRoot, "artifacts"),
        timeout_sec: 30,
        signal: undefined
      });

      expect(result.prompt_sha256).toMatch(/^[a-f0-9]{64}$/u);
      await expect(readFile(promptPath, "utf8")).resolves.toContain("You are an AI evaluator executing one read-only check node");
      await expect(readFile(promptPath, "utf8")).resolves.toContain("Evaluate the patch.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs Cursor AI checks when the harness provides the strict read-only contract", async () => {
    const harness = createHarness("cursor-cli", async () => {
      return {
        status: "passed",
        exitCode: 0,
        transcript: {
          last_message: '{"passed":true,"score":1,"summary":"ok"}'
        },
        outputJson: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: '{"passed":true,"score":1,"summary":"ok"}'
        }
      };
    });

    const result = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-cursor-readonly",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      node_goal: "Evaluate the patch.",
      rubric: "Be strict.",
      context_packet_path: "/tmp/runtime/context.json",
      context_manifest_path: "/tmp/agent/context.md",
      output_dir: "/tmp",
      timeout_sec: 30,
      signal: undefined
    });

    expect(result.harness_result.status).toBe("passed");
    expect(result.evaluation).toEqual(
      expect.objectContaining({
        passed: true,
        score: 1,
        summary: "ok"
      })
    );
  });

  it("fails AI checks closed on harness launch errors", async () => {
    const harness = createHarness("codex-cli", async () => {
      throw new Error("spawnSync codex ETIMEDOUT");
    });

    const result = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-timeout",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      node_goal: "Evaluate the patch.",
      rubric: "Be strict.",
      context_packet_path: "/tmp/runtime/context.json",
      context_manifest_path: "/tmp/agent/context.md",
      output_dir: "/tmp",
      timeout_sec: 30,
      signal: undefined
    });

    expect(result.harness_result).toEqual(
      expect.objectContaining({
        status: "failed",
        stderr: expect.stringContaining("ETIMEDOUT"),
        metadata: expect.objectContaining({
          failure_code: "verification_substrate_failure"
        })
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
    const harness = createHarness("codex-cli", async () => {
      return {
        status: "failed",
        exitCode: 1,
        stdout: '{"passed":true,"score":1,"summary":"ok"}',
        stderr: "spawnSync codex ETIMEDOUT"
      };
    });

    const result = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-timeout-json",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      node_goal: "Evaluate the patch.",
      rubric: "Be strict.",
      context_packet_path: "/tmp/runtime/context.json",
      context_manifest_path: "/tmp/agent/context.md",
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
    const harness = createHarness("codex-cli", async () => {
      return {
        status: "failed",
        exitCode: 1,
        stdout: '{"passed":true,"score":1,"summary":"ok"}',
        metadata: {
          timed_out: true,
          force_killed: true
        }
      };
    });

    const result = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-timeout-metadata",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      node_goal: "Evaluate the patch.",
      rubric: "Be strict.",
      context_packet_path: "/tmp/runtime/context.json",
      context_manifest_path: "/tmp/agent/context.md",
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

  it("parses fenced AI evaluator JSON and deterministic verification artifacts without throwing", async () => {
    const harness = createHarness("codex-cli", async () => {
      return {
        status: "passed",
        exitCode: 0,
        stdout: '```json\n{"passed":true,"score":0.9,"summary":"ok"}\n```'
      };
    });

    const aiResult = await runAiCheck({
      harness,
      run_id: "run-1",
      execution_id: "exec-2",
      repo_alias: "main",
      repo_path: process.cwd(),
      model: "gpt-5-judge",
      node_goal: "Evaluate the patch.",
      rubric: undefined,
      context_packet_path: "/tmp/runtime/context.json",
      context_manifest_path: "/tmp/agent/context.md",
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

    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-deterministic-verification-"));

    try {
      const deterministicResult = await runDeterministicCheck({
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const outputDir = process.env.AGENTFLOW_OUTPUT_DIR;",
            "fs.writeFileSync(path.join(outputDir, 'verification.json'), JSON.stringify({ passed: true, summary: 'ok' }));",
            "process.stdout.write('not json');"
          ].join(" ")
        ],
        cwd: process.cwd(),
        env: undefined,
        runtime_env: {
          AGENTFLOW_OUTPUT_DIR: tempRoot
        },
        timeout_sec: 30,
        pass_if: {
          json_path: "$.passed",
          equals: true
        },
        signal: undefined
      });

      expect(deterministicResult.passed).toBe(true);
      expect(deterministicResult.summary).toBe("ok");
      expect(deterministicResult.stdout).toBe("not json");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails deterministic verification artifact checks when verification.json is missing", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-deterministic-missing-verification-"));

    try {
      const deterministicResult = await runDeterministicCheck({
        command: process.execPath,
        args: ["-e", "process.stdout.write('not json')"],
        cwd: process.cwd(),
        env: undefined,
        runtime_env: {
          AGENTFLOW_OUTPUT_DIR: tempRoot
        },
        timeout_sec: 30,
        pass_if: {
          json_path: "$.passed",
          equals: true
        },
        signal: undefined
      });

      expect(deterministicResult.passed).toBe(false);
      expect(deterministicResult.summary).toContain("verification.json");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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

  it("does not inherit undeclared shell env vars in local process execution", async () => {
    const previous = process.env.AGENTFLOW_UNDECLARED_ENV;
    process.env.AGENTFLOW_UNDECLARED_ENV = "hidden-value";

    try {
      const result = await runLocalProcess({
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.AGENTFLOW_UNDECLARED_ENV ?? '')"],
        cwd: process.cwd(),
        env: undefined,
        timeout_sec: 30,
        signal: undefined
      });

      expect(result.exit_code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      if (previous === undefined) {
        delete process.env.AGENTFLOW_UNDECLARED_ENV;
      } else {
        process.env.AGENTFLOW_UNDECLARED_ENV = previous;
      }
    }
  });

  it("exposes explicit env overrides in local process execution", async () => {
    const result = await runLocalProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.AGENTFLOW_LOCAL_ENV ?? '')"],
      cwd: process.cwd(),
      env: {
        AGENTFLOW_LOCAL_ENV: "visible"
      },
      timeout_sec: 30,
      signal: undefined
    });

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("visible");
  });

  it("loads declared env files before explicit local process env overrides", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-env-files-"));
    const envFile = join(tempRoot, ".env.development");

    try {
      await writeFile(
        envFile,
        [
          "# comments are ignored",
          "AGENTFLOW_ENV_FILE_VALUE=from-file",
          "AGENTFLOW_ENV_FILE_OVERRIDE=from-file",
          "export AGENTFLOW_EXPORTED_ENV_FILE_VALUE='from exported file'"
        ].join("\n")
      );

      const result = await runLocalProcess({
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdout.write(JSON.stringify({",
            "value: process.env.AGENTFLOW_ENV_FILE_VALUE,",
            "override: process.env.AGENTFLOW_ENV_FILE_OVERRIDE,",
            "exported: process.env.AGENTFLOW_EXPORTED_ENV_FILE_VALUE",
            "}));"
          ].join("")
        ],
        cwd: tempRoot,
        env_files: [envFile],
        env: {
          AGENTFLOW_ENV_FILE_OVERRIDE: "from-inline-env"
        },
        timeout_sec: 30,
        signal: undefined
      });

      expect(result.exit_code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        value: "from-file",
        override: "from-inline-env",
        exported: "from exported file"
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats missing declared env files as launch errors", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-missing-env-file-"));

    try {
      await expect(
        runLocalProcess({
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: tempRoot,
          env_files: ["missing.env"],
          env: undefined,
          timeout_sec: 30,
          signal: undefined
        })
      ).rejects.toThrow("missing.env");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
