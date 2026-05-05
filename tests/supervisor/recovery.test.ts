import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CompiledAgentNode } from "../../src/graph/compiled.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { RuntimeNodeExecutionResult } from "../../src/runtime/core/engine.js";
import type { HarnessAdapter } from "../../src/runtime/harness/types.js";
import { classifyNodeFailure } from "../../src/supervisor/classifier.js";
import type { SupervisorCausalContext } from "../../src/supervisor/causal.js";
import { runSupervisorRecoveryCycle } from "../../src/supervisor/recovery.js";

function node(): CompiledAgentNode {
  return {
    compiled_id: "root__node",
    authored_id: "node",
    kind: "agent",
    repo: "main",
    deps: [],
    scope_stack: ["scope__root"],
    effective_policy: {
      profile_name: "default",
      harness: "codex-cli",
      sandbox: "workspace-write",
      timeout_sec: 60,
      input_rules: {},
      artifact_repair: { max_attempts: 1 }
    },
    context: [],
    declared_artifacts: {},
    intent: {
      goal: "Use the dependency correctly.",
      acceptance_criteria: ["The code follows the documented dependency API."],
      constraints: ["Do not change graph intent."]
    },
    tools: []
  };
}

function attempt(root: string): RuntimeNodeAttempt {
  return {
    execution_id: "exec__root__node__attempt_1",
    compiled_id: "root__node",
    authored_id: "node",
    kind: "agent",
    repo_alias: "main",
    execution_dir: root,
    attempt_index: 1,
    status: "failed",
    outcome: "failed",
    started_at: "2026-04-24T00:00:00.000Z",
    ended_at: "2026-04-24T00:00:01.000Z",
    duration_ms: 1000,
    prompt_path: join(root, "prompt.md"),
    prompt_sha256: createHash("sha256").update("exact failed prompt\n").digest("hex"),
    context_manifest_path: join(root, "context", "manifest.md"),
    artifacts: {},
    metadata: {}
  };
}

function result(): RuntimeNodeExecutionResult {
  return {
    status: "failed",
    outcome: "failed",
    result: { exit_code: 1 },
    stdout: "",
    stderr: "Build failed because the zod v4 API changed; missing dependency docs for package zod."
  };
}

describe("supervisor recovery cycle", () => {
  it("writes a case file, parallel evidence patches, a recovery plan, and retry envelope", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-cycle-"));
    const runtimeAttempt = attempt(tempRoot);
    await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
    const classification = classifyNodeFailure({
      node: node(),
      attempt: runtimeAttempt,
      result: result()
    });

    const recovery = await runSupervisorRecoveryCycle({
      action: "rebuild_context",
      run_id: "run-1",
      graph_intent: {
        goal: "Graph goal.",
        acceptance_criteria: ["Graph acceptance stays intact."],
        constraints: []
      },
      node: node(),
      attempt: runtimeAttempt,
      result: result(),
      decision_id: "decision-1",
      intervention_id: "intervention-1",
      classification,
      failure_fingerprint: "fingerprint-1",
      repeated_fingerprint_count: 1,
      prior_interventions: [],
      workspace_path: tempRoot
    });

    expect(recovery.recovery_plan.apply_action).toBe("retry_with_evidence");
    expect(recovery.evidence_patches.map((patch) => patch.kind)).toEqual(["dependency_metadata", "external_context"]);
    expect(recovery.recovery_plan.runtime_overlay?.material_delta).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "evidence_added"
        })
      ])
    );
    expect(recovery.recovery_envelope?.retry_directive.unchanged_contract).toEqual({
      goal: true,
      acceptance_criteria: true,
      constraints: true,
      repo_authority: true,
      sandbox: true,
      declared_artifacts: true
    });
    await expect(readFile(recovery.intervention.artifact_paths.case_file_json, "utf8")).resolves.toContain(
      "exact failed prompt"
    );
    await expect(readFile(recovery.intervention.artifact_paths.case_file_json, "utf8")).resolves.toContain(
      runtimeAttempt.prompt_sha256!
    );
    await expect(readFile(recovery.intervention.artifact_paths.recovery_plan_markdown, "utf8")).resolves.toContain(
      "Apply action: `retry_with_evidence`"
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("pauses when gathered evidence says recovery requires changed authority", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-conflict-"));
    const runtimeAttempt = attempt(tempRoot);
    await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
    const classification = classifyNodeFailure({
      node: node(),
      attempt: runtimeAttempt,
      result: result()
    });
    const harness: HarnessAdapter = {
      kind: "codex-cli",
      capabilities: {
        supports_agent: true,
        supports_ai_check: true
      },
      async run() {
        return {
          status: "passed",
          exitCode: 0,
          outputJson: {
            claims: ["The requested fix requires changing the graph contract."],
            retry_guidance: ["Do not retry without graph authority."],
            conflicts: ["Graph contract change required."],
            confidence: "high",
            scope_or_authority_changed: true
          }
        };
      },
      async cancel() {}
    };

    const recovery = await runSupervisorRecoveryCycle({
      action: "rebuild_context",
      run_id: "run-1",
      graph_intent: {
        goal: "Graph goal.",
        acceptance_criteria: ["Graph acceptance stays intact."],
        constraints: []
      },
      node: node(),
      attempt: runtimeAttempt,
      result: result(),
      decision_id: "decision-1",
      intervention_id: "intervention-1",
      classification,
      failure_fingerprint: "fingerprint-1",
      repeated_fingerprint_count: 1,
      prior_interventions: [],
      workspace_path: tempRoot,
      harness
    });

    expect(recovery.recovery_plan.apply_action).toBe("pause_for_authority");
    expect(recovery.recovery_plan.pause_request?.unblock_request).toContain("authority");
    expect(recovery.recovery_envelope).toBeUndefined();

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("writes a validation strategy overlay for diagnostic failures", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-validation-strategy-"));
    const runtimeAttempt = attempt(tempRoot);
    await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
    const classification = classifyNodeFailure({
      node: node(),
      attempt: runtimeAttempt,
      result: {
        status: "failed",
        outcome: "failed",
        result: { timed_out: true },
        stderr: "npm test timed out after 900s"
      }
    });

    const recovery = await runSupervisorRecoveryCycle({
      action: "run_diagnostic",
      run_id: "run-1",
      graph_intent: {
        goal: "Graph goal.",
        acceptance_criteria: ["Graph acceptance stays intact."],
        constraints: []
      },
      node: node(),
      attempt: runtimeAttempt,
      result: {
        status: "failed",
        outcome: "failed",
        result: { timed_out: true },
        stderr: "npm test timed out after 900s"
      },
      decision_id: "decision-1",
      intervention_id: "intervention-1",
      classification,
      failure_fingerprint: "fingerprint-1",
      repeated_fingerprint_count: 1,
      prior_interventions: [],
      workspace_path: tempRoot
    });

    expect(recovery.recovery_plan.apply_action).toBe("repair_validation_strategy");
    expect(recovery.recovery_plan.runtime_overlay?.validation_strategy?.focus.join("\n")).toContain("focused");
    expect(recovery.recovery_plan.runtime_overlay?.material_delta).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "validation_strategy_changed"
        })
      ])
    );
    expect(recovery.recovery_envelope?.retry_directive.must_do.join("\n")).toContain("focused validation command");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("does not count changing recovery targets as a material delta by itself", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-target-only-delta-"));
    const runtimeAttempt = attempt(tempRoot);
    await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
    const classification = classifyNodeFailure({
      node: node(),
      attempt: runtimeAttempt,
      result: {
        status: "failed",
        outcome: "failed",
        result: { exit_code: 1 },
        stdout: "",
        stderr: "implementation failed without a recognized failure class"
      }
    });
    const causalContext: SupervisorCausalContext = {
      symptom: {
        compiled_id: "root__node",
        authored_id: "node",
        kind: "agent",
        execution_id: runtimeAttempt.execution_id,
        failure_class: classification.class,
        summary: classification.summary
      },
      upstream_cone: [],
      target_candidates: [],
      selected_target: {
        operation: "repair_upstream_node",
        target_compiled_id: "root__upstream",
        target_authored_id: "upstream",
        target_kind: "agent",
        confidence: "medium",
        reason: "Synthetic upstream target for material-delta regression.",
        evidence: [],
        resume_compiled_id: "root__node",
        resume_authored_id: "node",
        symptom_compiled_id: "root__node",
        symptom_authored_id: "node",
        symptom_execution_id: runtimeAttempt.execution_id,
        requires_investigation: false
      }
    };

    const recovery = await runSupervisorRecoveryCycle({
      action: "retry_with_guidance",
      run_id: "run-1",
      graph_intent: {
        goal: "Graph goal.",
        acceptance_criteria: ["Graph acceptance stays intact."],
        constraints: []
      },
      node: node(),
      attempt: runtimeAttempt,
      result: {
        status: "failed",
        outcome: "failed",
        result: { exit_code: 1 },
        stdout: "",
        stderr: "implementation failed without a recognized failure class"
      },
      decision_id: "decision-1",
      intervention_id: "intervention-1",
      classification,
      failure_fingerprint: "fingerprint-1",
      repeated_fingerprint_count: 1,
      prior_interventions: [],
      workspace_path: tempRoot,
      causal_context: causalContext
    });

    expect(recovery.recovery_plan.runtime_overlay?.material_delta).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "recovery_target_changed"
        })
      ])
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("writes a workspace repair overlay when failed-attempt changes can be restored", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-recovery-workspace-repair-"));
    const runtimeAttempt = attempt(tempRoot);
    const workspaceChangesDir = join(tempRoot, "workspace-changes");
    const baselinePath = join(workspaceChangesDir, "baseline.json");
    const changedFilesPath = join(workspaceChangesDir, "changed-files.json");
    await writeFile(runtimeAttempt.prompt_path!, "exact failed prompt\n", "utf8");
    runtimeAttempt.metadata = {
      node_workspace_changes: {
        baseline_path: baselinePath,
        changed_files_path: changedFilesPath,
        changed_file_count: 1,
        diff_patch_path: join(workspaceChangesDir, "diff.patch"),
        status_path: join(workspaceChangesDir, "status.txt")
      }
    };

    const failedResult: RuntimeNodeExecutionResult = {
      status: "failed",
      outcome: "failed",
      result: { exit_code: 1 },
      stdout: "",
      stderr: "Forbidden edit: unexpected workspace change in generated/noise.md"
    };
    const classification = classifyNodeFailure({
      node: node(),
      attempt: runtimeAttempt,
      result: failedResult
    });

    const recovery = await runSupervisorRecoveryCycle({
      action: "run_diagnostic",
      run_id: "run-1",
      graph_intent: {
        goal: "Graph goal.",
        acceptance_criteria: ["Graph acceptance stays intact."],
        constraints: []
      },
      node: node(),
      attempt: runtimeAttempt,
      result: failedResult,
      decision_id: "decision-1",
      intervention_id: "intervention-1",
      classification,
      failure_fingerprint: "fingerprint-1",
      repeated_fingerprint_count: 1,
      prior_interventions: [],
      workspace_path: tempRoot
    });

    expect(recovery.recovery_plan.apply_action).toBe("repair_workspace");
    expect(recovery.recovery_plan.runtime_overlay?.workspace_repair).toEqual(
      expect.objectContaining({
        strategy: "restore_failed_attempt_changes",
        baseline_path: baselinePath,
        changed_files_path: changedFilesPath
      })
    );
    expect(recovery.recovery_plan.runtime_overlay?.material_delta).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "workspace_cleaned"
        })
      ])
    );
    expect(recovery.recovery_envelope?.retry_directive.must_do.join("\n")).toContain("workspace cleanup");

    await rm(tempRoot, { recursive: true, force: true });
  });
});
