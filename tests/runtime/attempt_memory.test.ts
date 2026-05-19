import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CompiledExecutableNode } from "../../src/graph/compiled.js";
import { buildAttemptMemory, renderAttemptMemoryMarkdown } from "../../src/runtime/attempt_memory.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { SupervisorRecoveryEnvelope } from "../../src/supervisor/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentflow-attempt-memory-"));
  tempDirs.push(dir);
  return dir;
}

function safeRuntimeStateSegment(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "execution";
  if (sanitized.length <= 120) {
    return sanitized;
  }
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 16);
  const prefix = sanitized.slice(0, 96).replace(/_+$/g, "") || "execution";
  return `${prefix}_${hash}`;
}

function nodeFixture(): CompiledExecutableNode {
  return {
    kind: "agent",
    compiled_id: "root__worker",
    authored_id: "worker",
    repo: "main",
    deps: [],
    scope_stack: ["root"],
    intent: {
      goal: "Finish the feature.",
      acceptance_criteria: ["Validated feature."],
      constraints: ["Preserve prior work."]
    },
    effective_policy: {
      profile: "default",
      model: "gpt-5.5",
      reasoning_effort: "medium",
      sandbox: "workspace-write",
      timeout_sec: 60,
      harness: "codex-cli",
      supervisor: {
        enabled: true
      }
    },
    context: [],
    declared_artifacts: {
      handoff: {
        from: "output_dir",
        path: "handoff.md",
        description: "Retry handoff."
      }
    },
    skills: [],
    cli: [],
    tools: []
  };
}

function recoveryEnvelope(priorExecutionId: string): SupervisorRecoveryEnvelope {
  return {
    envelope_id: "env-1",
    compiled_id: "root__worker",
    authored_id: "worker",
    prior_execution_id: priorExecutionId,
    recovery_plan_path: "/debug/recovery-plan.json",
    case_file_path: "/debug/case-file.json",
    action: "retry_node",
    classification: "semantic_misalignment",
    failure_fingerprint: "semantic:worker",
    repeated_fingerprint_count: 1,
    resume_point: "continue_from_milestone",
    workspace_decision: "preserve",
    resume_decision: {
      resume_point: "continue_from_milestone",
      restart_boundary: "milestone",
      workspace_decision: "preserve",
      reuse: ["Implementation edits from milestone m1 are still valid."],
      discard: ["Incomplete handoff artifact draft."],
      reason_code: "validated_progress",
      confidence: "high",
      evidence: ["m1 validation passed before handoff verification failed."],
      required_next_action: "Repair the handoff artifact and rerun completion checks.",
      validation_gate: ["af complete check must pass."]
    },
    preserve_progress: ["Keep the implementation edits that satisfied milestone m1."],
    do_not_redo: ["Do not restart discovery from scratch."],
    required_next_action: "Repair the handoff artifact and rerun completion checks.",
    retry_directive: {
      summary: "Prior attempt finished implementation but failed handoff verification.",
      must_do: ["Read prior handoff and validation evidence."],
      must_not_do: ["Do not delete implementation files."],
      evidence_to_read: [
        "/run/human-debug/interventions/evidence-patch.md",
        "/run/runtime/context.json",
        "/run/agent/context.md",
        "/run/evidence/prior-handoff.md"
      ],
      validation_focus: ["Handoff cites validation."],
      unchanged_contract: {
        goal: true,
        acceptance_criteria: true,
        constraints: true,
        repo_authority: true,
        sandbox: true,
        declared_artifacts: true
      }
    },
    created_at: "2026-05-18T00:00:00.000Z"
  };
}

describe("attempt memory", () => {
  it("reads prior milestones and workspace changes from runtime-owned paths", async () => {
    const runRoot = await makeTempDir();
    const priorExecutionId = `exec__${"very_long_execution_segment_".repeat(12)}__attempt_1`;
    const milestonesDir = join(runRoot, "runtime", "milestones");
    await mkdir(milestonesDir, { recursive: true });
    await writeFile(
      join(runRoot, "events.jsonl"),
      [
        {
          seq: 1,
          ts: "2026-05-18T00:00:00.000Z",
          run_id: "run-1",
          type: "node.started",
          compiled_id: "root__worker",
          execution_id: priorExecutionId,
          attempt_index: 1,
          payload: { kind: "agent", repo_alias: "main", profile_name: "default" }
        },
        {
          seq: 2,
          ts: "2026-05-18T00:02:00.000Z",
          run_id: "run-1",
          type: "verification.completed",
          compiled_id: "root__worker",
          execution_id: priorExecutionId,
          attempt_index: 1,
          payload: { verifier_kind: "outcome", passed: false, summary: "Handoff verification failed." }
        },
        {
          seq: 3,
          ts: "2026-05-18T00:02:10.000Z",
          run_id: "run-1",
          type: "supervisor.retry_scheduled",
          compiled_id: "root__worker",
          execution_id: priorExecutionId,
          attempt_index: 1,
          payload: { action: "retry_with_guidance", target_compiled_id: "root__worker" }
        }
      ].map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8"
    );
    await writeFile(
      join(milestonesDir, `${safeRuntimeStateSegment(priorExecutionId)}.json`),
      `${JSON.stringify({
        version: "1",
        execution_id: priorExecutionId,
        milestones: [
          {
            id: "m1",
            title: "Implement feature",
            goal: "Create the implementation.",
            status: "completed",
            logs: [
              {
                id: "l1",
                ts: "2026-05-18T00:01:00.000Z",
                kind: "validation",
                summary: "Unit tests passed.",
                command: "npm test -- feature",
                result: "pass"
              }
            ],
            completion_evidence: "Implementation and tests are complete."
          },
          {
            id: "m2",
            title: "Repair handoff",
            goal: "Fix the artifact.",
            status: "active",
            logs: []
          }
        ]
      }, null, 2)}\n`,
      "utf8"
    );

    const changedFilesPath = join(runRoot, "changed-files.json");
    await writeFile(
      changedFilesPath,
      `${JSON.stringify([
        { path: "src/feature.ts", change_kind: "tracked" },
        { path: "tests/feature.test.ts", change_kind: "untracked_added" }
      ], null, 2)}\n`,
      "utf8"
    );

    const priorAttempt: RuntimeNodeAttempt = {
      execution_id: priorExecutionId,
      compiled_id: "root__worker",
      authored_id: "worker",
      kind: "agent",
      repo_alias: "main",
      execution_dir: join(runRoot, "nodes", "worker", "executions", "001"),
      attempt_index: 1,
      status: "failed",
      outcome: "failed",
      started_at: "2026-05-18T00:00:00.000Z",
      artifacts: {
        handoff: "/run/artifacts/handoff.md"
      },
      metadata: {
        node_workspace_changes: {
          changed_files_path: changedFilesPath
        }
      }
    };

    const memory = await buildAttemptMemory({
      runRoot,
      node: nodeFixture(),
      priorAttempt,
      recoveryEnvelope: recoveryEnvelope(priorExecutionId)
    });

    expect(memory.completed_milestones).toEqual(["m1: Implement feature"]);
    expect(memory.unfinished_work).toEqual(["m2: Repair handoff"]);
    expect(memory.validation_evidence).toEqual([
      {
        command: "npm test -- feature",
        result: "pass",
        summary: "Unit tests passed."
      }
    ]);
    expect(memory.workspace_changes.changed_files).toEqual([
      "src/feature.ts",
      "tests/feature.test.ts"
    ]);
    expect(memory.workspace_changes.preserved_files).toEqual([
      "src/feature.ts",
      "tests/feature.test.ts"
    ]);
    expect(memory.resume_decision.restart_boundary).toBe("milestone");
    expect(memory.resume_decision.reason_code).toBe("validated_progress");
    expect(memory.resume_decision.reuse).toContain("Implementation edits from milestone m1 are still valid.");
    expect(memory.resume_decision.discard).toContain("Incomplete handoff artifact draft.");
    expect(memory.phase_history).toEqual([
      {
        type: "node.started",
        ts: "2026-05-18T00:00:00.000Z",
        summary: "agent node started in repo main"
      },
      {
        type: "verification.completed",
        ts: "2026-05-18T00:02:00.000Z",
        summary: "outcome verification failed: Handoff verification failed."
      },
      {
        type: "supervisor.retry_scheduled",
        ts: "2026-05-18T00:02:10.000Z",
        summary: "supervisor scheduled retry_with_guidance for root__worker"
      }
    ]);
    expect(memory.evidence_to_read).toContain("/run/artifacts/handoff.md");
    expect(memory.evidence_to_read).toContain("/run/evidence/prior-handoff.md");
    expect(memory.evidence_to_read).not.toContain("/run/human-debug/interventions/evidence-patch.md");
    expect(memory.evidence_to_read).not.toContain("/run/runtime/context.json");
    expect(memory.evidence_to_read).not.toContain("/run/agent/context.md");

    const markdown = renderAttemptMemoryMarkdown(memory);
    expect(markdown).toContain("## Completed Milestones");
    expect(markdown).toContain("## Best Resume Decision");
    expect(markdown).toContain("validated_progress");
    expect(markdown).toContain("Implementation edits from milestone m1 are still valid.");
    expect(markdown).toContain("Incomplete handoff artifact draft.");
    expect(markdown).toContain("## Prior Attempt Timeline");
    expect(markdown).toContain("outcome verification failed: Handoff verification failed.");
    expect(markdown).toContain("m1: Implement feature");
    expect(markdown).toContain("Changed: src/feature.ts");
    expect(markdown).not.toContain("recovery-plan.json");
    expect(markdown).not.toContain("case-file.json");
    expect(markdown).not.toContain("human-debug");
    expect(markdown).not.toContain("runtime/context.json");
    expect(markdown).not.toContain("agent/context.md");
  });
});
