import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveExecutionArtifactsDirectory } from "../../src/artifacts/paths.js";
import type { CompiledAgentNode } from "../../src/graph/compiled.js";
import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import { runRepairArtifactIntervention } from "../../src/supervisor/actions.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { HarnessAdapter } from "../../src/runtime/harness/types.js";
import type { RuntimeSession } from "../../src/runtime/session.js";

describe("supervisor actions", () => {
  it("runs artifact repair in a durable intervention directory", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "agentflow-supervisor-action-"));
    const executionDir = join(runRoot, "nodes", "001-write", "executions", "001-exec");
    const artifactsRoot = resolveExecutionArtifactsDirectory(executionDir);
    await mkdir(artifactsRoot, { recursive: true });

    const node: CompiledAgentNode = {
      compiled_id: "root__write",
      authored_id: "write",
      kind: "agent",
      repo: "main",
      deps: [],
      scope_stack: ["root"],
      effective_policy: {
        profile_name: "default",
        harness: "codex-cli",
        workspace_backend: "inplace",
        timeout_sec: 60,
        input_rules: {
          max_total_tokens: 128000,
          max_tokens_per_item: 32000
        },
        artifact_repair: {
          max_attempts: 1
        }
      },
      context: [],
      declared_artifacts: {
        handoff: {
          from: "output_dir",
          path: "handoff.md",
          description: "Markdown handoff."
        }
      },
      prompt: "Write a handoff.",
      tools: []
    };
    const attempt: RuntimeNodeAttempt = {
      execution_id: "exec-1",
      compiled_id: node.compiled_id,
      authored_id: node.authored_id,
      kind: "agent",
      repo_alias: "main",
      execution_dir: executionDir,
      attempt_index: 1,
      status: "running",
      started_at: "2026-04-24T00:00:00.000Z",
      artifacts: {},
      metadata: {}
    };
    const harness: HarnessAdapter = {
      kind: "codex-cli",
      capabilities: getHarnessCapabilities("codex-cli")!,
      async run(invocation) {
        await writeFile(join(invocation.outputDir, "handoff.md"), "repaired\n", "utf8");
        return {
          status: "passed",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          transcript: {
            last_message: "repaired"
          }
        };
      },
      async cancel() {
        return;
      }
    };

    const record = await runRepairArtifactIntervention({
      node,
      attempt,
      missing_artifacts: [{
        name: "handoff",
        from: "output_dir",
        path: "handoff.md",
        description: "Markdown handoff.",
        expected_path: join(artifactsRoot, "handoff.md")
      }],
      session: { run_id: "run-1" } as RuntimeSession,
      workspace_path: runRoot,
      context_packet_path: join(executionDir, "context", "packet.json"),
      context_manifest_path: join(executionDir, "context", "manifest.md"),
      harnesses: {
        "codex-cli": harness
      },
      decision_id: "decision-1",
      intervention_id: "intervention-1",
      repair_attempt: 1,
      max_attempts: 1
    });

    expect(record).toEqual(
      expect.objectContaining({
        intervention_id: "intervention-1",
        decision_id: "decision-1",
        action: "repair_artifact",
        status: "passed",
        target_compiled_id: "root__write",
        target_execution_id: "exec-1"
      })
    );
    expect(record.artifact_paths.intervention_dir).toBe(join(executionDir, "interventions", "intervention-1"));
    await expect(readFile(join(executionDir, "interventions", "intervention-1", "prompt.md"), "utf8"))
      .resolves.toContain("## Agentflow Artifact Repair");
    await expect(readFile(join(executionDir, "interventions", "intervention-1", "result.json"), "utf8"))
      .resolves.toContain('"missing_artifacts_after": []');
    await expect(readFile(join(artifactsRoot, "handoff.md"), "utf8")).resolves.toBe("repaired\n");
  });
});
