import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import { runAiCheck } from "../../src/runtime/checks/ai.js";
import {
  buildPromptDiagnostics,
  resolvePromptDiagnosticsPath,
  writePromptDiagnostics
} from "../../src/runtime/harness/prompt_diagnostics.js";
import type { AgentInvocation, HarnessAdapter } from "../../src/runtime/harness/types.js";

function baseInvocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    promptKind: "agent",
    runId: "run-1",
    executionId: "exec-1",
    repoAlias: "main",
    repoPath: "/tmp/workspace",
    sandbox: "workspace-write",
    model: "gpt-5-codex",
    reasoningEffort: "medium",
    nodeGoal: "Implement the focused node task.",
    contextPacketPath: "/tmp/run/runtime/context.json",
    contextManifestPath: "/tmp/run/agent/context.md",
    contextManifest: [
      "# Context Manifest",
      "",
      "## Pointers",
      "",
      "| Name | Kind | Pointer | What | Why |",
      "| --- | --- | --- | --- | --- |",
      "| `requirements` | `workspace_file` | `/tmp/requirements.md` | Requirements. | Needed. |",
      "| `prior` | `artifact` | `/tmp/prior.md` | Prior result. | Needed. |"
    ].join("\n"),
    outputDir: "/tmp/run/artifacts",
    artifacts: {
      handoff: {
        from: "output_dir",
        path: "handoff.md",
        description: "Markdown handoff."
      }
    },
    timeoutSec: 30,
    signal: undefined,
    ...overrides
  };
}

function createHarness(run: HarnessAdapter["run"]): HarnessAdapter {
  return {
    kind: "codex-cli",
    capabilities: getHarnessCapabilities("codex-cli")!,
    run,
    async cancel() {
      return;
    }
  };
}

describe("prompt diagnostics", () => {
  it("summarizes rendered prompts without changing the prompt text", () => {
    const prompt = [
      "## Role",
      "Executing one Agentflow graph node.",
      "",
      "## Success Contract",
      "Implement the focused node task.",
      "",
      "## Context",
      "Open pointers.",
      "",
      "## Operating Brief",
      "Run `af orient` before work and `af complete check` before final response."
    ].join("\n");

    const diagnostics = buildPromptDiagnostics({
      invocation: baseInvocation({
        tools: [
          {
            callable_name: "docs",
            description: "Read docs.",
            source: {
              kind: "plugin",
              alias: "docs-plugin",
              tool: "docs"
            }
          }
        ],
        skills: [
          {
            ref: "team/reviewer",
            source_alias: "team",
            name: "reviewer",
            description: "Review evidence.",
            path: "/skills/reviewer/SKILL.md"
          }
        ],
        cli: [
          {
            cmd: "jq",
            description: "Inspect JSON."
          }
        ]
      }),
      prompt,
      renderer: "renderHarnessPrompt"
    });

    expect(diagnostics).toEqual(expect.objectContaining({
      version: "1",
      prompt_kind: "agent",
      renderer: "renderHarnessPrompt",
      execution_id: "exec-1",
      harness: "codex-cli",
      model: "gpt-5-codex",
      reasoning_effort: "medium",
      sandbox: "workspace-write",
      total_chars: prompt.length,
      context_pointer_count: 2,
      context_pointer_kinds: ["artifact", "workspace_file"],
      tool_count: 1,
      skill_count: 1,
      cli_hint_count: 1,
      declared_artifact_count: 1,
      has_supervisor_recovery: false,
      orient_required_by_prompt: true,
      complete_check_required_by_prompt: true
    }));
    expect(diagnostics.sections.map((section) => section.name)).toEqual([
      "Role",
      "Success Contract",
      "Context",
      "Operating Brief"
    ]);
    expect(diagnostics.warnings).toEqual([]);
    expect(prompt).not.toContain("prompt-diagnostics");
  });

  it("summarizes context priority buckets and glob index shape", () => {
    const diagnostics = buildPromptDiagnostics({
      invocation: baseInvocation({
        contextManifest: [
          "# Context Manifest",
          "",
          "Open read-first pointers before broad search unless the task clearly requires discovery. Use reference sets as search spaces, not as linear reading lists.",
          "",
          "## Read First",
          "",
          "| Name | Kind | Pointer | Why first |",
          "| --- | --- | --- | --- |",
          "| `recovery_case` | `runtime_supervisor_recovery` | `agent/supervisor-recovery.md` | Retry guidance. |",
          "",
          "## Task Context",
          "",
          "| Name | Kind | Pointer | What | Why |",
          "| --- | --- | --- | --- | --- |",
          "| `requirements` | `workspace_file` | `/tmp/requirements.md` | Requirements. | Needed. |",
          "",
          "## Reference Sets",
          "",
          "| Name | Kind | Pointer | Matches | How to use |",
          "| --- | --- | --- | --- | --- |",
          "| `docs` | `workspace_glob` | `runtime/globs/docs.md` | 2 of 5 | Search selectively. |"
        ].join("\n")
      }),
      prompt: "## Role\nExecuting one Agentflow graph node.\n",
      renderer: "renderHarnessPrompt"
    });

    expect(diagnostics).toEqual(expect.objectContaining({
      context_pointer_count: 3,
      context_pointer_kinds: ["runtime_supervisor_recovery", "workspace_file", "workspace_glob"],
      context_priority_bucket_counts: {
        read_first: 1,
        current_work: 0,
        task_context: 1,
        progress_state: 0,
        reference_set: 1
      },
      context_read_first_count: 1,
      context_glob_set_count: 1,
      context_glob_match_count: 5,
      context_glob_included_count: 2,
      context_limited_glob_count: 1,
      context_uses_flat_glob_expansion: false
    }));
  });

  it("flags duplicated operating guidance only on worker prompts", () => {
    const prompt = [
      "## Role",
      "Audit the completed attempt.",
      "",
      "## Completion Packet",
      "- af orient called: true",
      "- af complete check called: true",
      "",
      "## Node Intent",
      "The worker was told to run `af orient` and `af complete check`."
    ].join("\n");

    const workerDiagnostics = buildPromptDiagnostics({
      invocation: baseInvocation({ promptKind: "agent" }),
      prompt,
      renderer: "renderHarnessPrompt"
    });
    expect(workerDiagnostics.warnings).toContain("duplicated_operating_guidance");

    const verifierDiagnostics = buildPromptDiagnostics({
      invocation: baseInvocation({ promptKind: "outcome_verification" }),
      prompt,
      renderer: "renderOutcomeVerificationPrompt"
    });
    expect(verifierDiagnostics.warnings).not.toContain("duplicated_operating_guidance");
  });

  it("derives diagnostics paths under human-debug for agent and verifier prompt files", () => {
    expect(resolvePromptDiagnosticsPath({
      promptKind: "agent",
      promptPath: "/tmp/run/nodes/node/executions/001/agent/prompt.md"
    })).toBe("/tmp/run/nodes/node/executions/001/human-debug/prompt-diagnostics.json");

    expect(resolvePromptDiagnosticsPath({
      promptKind: "outcome_verification",
      promptPath: "/tmp/run/nodes/node/executions/001/human-debug/verifier/prompt.md"
    })).toBe("/tmp/run/nodes/node/executions/001/human-debug/verifier/prompt-diagnostics.json");
  });

  it("writes diagnostics next to the attempt prompt and fails open on write errors", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-prompt-diagnostics-"));
    const promptPath = join(tempRoot, "agent", "prompt.md");
    const prompt = "## Role\nExecuting one Agentflow graph node.\n";

    try {
      await mkdir(join(tempRoot, "agent"), { recursive: true });
      await writeFile(promptPath, prompt, "utf8");

      const diagnosticsPath = await writePromptDiagnostics({
        invocation: baseInvocation({ promptPath }),
        prompt,
        renderer: "renderHarnessPrompt"
      });

      expect(diagnosticsPath).toBe(join(tempRoot, "human-debug", "prompt-diagnostics.json"));
      const diagnostics = JSON.parse(await readFile(diagnosticsPath!, "utf8")) as {
        prompt_kind: string;
        total_chars: number;
      };
      expect(diagnostics.prompt_kind).toBe("agent");
      expect(diagnostics.total_chars).toBe(prompt.length);
      await expect(readFile(promptPath, "utf8")).resolves.toBe(prompt);

      const parentFile = join(tempRoot, "not-a-dir");
      await writeFile(parentFile, "file", "utf8");
      await expect(writePromptDiagnostics({
        invocation: baseInvocation({ promptPath }),
        prompt,
        renderer: "renderHarnessPrompt",
        diagnosticsPath: join(parentFile, "prompt-diagnostics.json")
      })).resolves.toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["agent", "agent/prompt.md", "human-debug/prompt-diagnostics.json"],
    ["ai_check", "agent/prompt.md", "human-debug/prompt-diagnostics.json"],
    ["artifact_repair", "human-debug/interventions/repair/prompt.md", "human-debug/interventions/repair/prompt-diagnostics.json"],
    ["outcome_verification", "human-debug/verifier/prompt.md", "human-debug/verifier/prompt-diagnostics.json"],
    ["supervisor_evidence", "human-debug/interventions/recovery/evidence/local_context/prompt.md", "human-debug/interventions/recovery/evidence/local_context/prompt-diagnostics.json"],
    ["delivery_curator", "delivery/evidence/curation-prompt.md", "delivery/evidence/prompt-diagnostics.json"]
  ] as const)("writes diagnostics for %s prompts", async (promptKind, promptRelativePath, diagnosticsRelativePath) => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-prompt-kind-diagnostics-"));
    const prompt = "## Role\nDiagnostic prompt.\n";

    try {
      const diagnosticsPath = await writePromptDiagnostics({
        invocation: baseInvocation({
          promptKind,
          promptPath: join(tempRoot, promptRelativePath)
        }),
        prompt,
        renderer: "renderHarnessPrompt"
      });

      expect(diagnosticsPath).toBe(join(tempRoot, diagnosticsRelativePath));
      const diagnostics = JSON.parse(await readFile(diagnosticsPath!, "utf8")) as {
        prompt_kind: string;
      };
      expect(diagnostics.prompt_kind).toBe(promptKind);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes AI check prompt diagnostics from the runtime check path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-ai-check-diagnostics-"));
    const promptPath = join(tempRoot, "agent", "prompt.md");
    const harness = createHarness(async () => ({
      status: "passed",
      exitCode: 0,
      stdout: '{"passed":true,"score":1,"summary":"ok","issues":[]}'
    }));

    try {
      await runAiCheck({
        harness,
        run_id: "run-1",
        execution_id: "exec-ai-diagnostics",
        repo_alias: "main",
        repo_path: process.cwd(),
        model: "gpt-5-judge",
        node_goal: "Evaluate the patch.",
        rubric: "Be strict.",
        evaluator_surface: "managed_criterion",
        context_packet_path: join(tempRoot, "runtime", "context.json"),
        context_manifest_path: join(tempRoot, "agent", "context.md"),
        context_manifest: "# Context Manifest\n",
        prompt_path: promptPath,
        output_dir: join(tempRoot, "artifacts"),
        timeout_sec: 30,
        signal: undefined
      });

      const diagnostics = JSON.parse(
        await readFile(join(tempRoot, "human-debug", "prompt-diagnostics.json"), "utf8")
      ) as {
        prompt_kind: string;
        renderer: string;
        ai_evaluator_surface?: string;
        complete_check_required_by_prompt: boolean;
      };
      expect(diagnostics.prompt_kind).toBe("ai_check");
      expect(diagnostics.ai_evaluator_surface).toBe("managed_criterion");
      expect(diagnostics.renderer).toBe("renderHarnessPrompt");
      expect(diagnostics.complete_check_required_by_prompt).toBe(false);
      await expect(readFile(promptPath, "utf8")).resolves.not.toContain("prompt-diagnostics");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
