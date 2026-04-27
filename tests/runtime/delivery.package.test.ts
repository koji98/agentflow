import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CompiledGraph } from "../../src/graph/compiled.js";
import { writeDeliveryPackage } from "../../src/runtime/delivery/package.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { RuntimeEventEnvelope } from "../../src/runtime/events.js";
import type { RuntimeStateSnapshot } from "../../src/runtime/session.js";
import type { SupervisorInterventionRecord } from "../../src/supervisor/types.js";

const graph: CompiledGraph = {
  graph_id: "delivery-test",
  intent: {
    goal: "Ship a trustworthy checkout change.",
    constraints: ["Do not change provider credentials."],
    acceptance_criteria: ["Tests pass.", "Reviewer guide names risk."]
  },
  supervision: {
    actions: {
      retry_with_guidance: { max_uses: 1 },
      repair_artifact: { max_uses: 1 },
      pause_for_human: { max_uses: 1 }
    },
    max_total_interventions: 2,
    policy: {
      pause_on_policy_risk: true,
      pause_on_repeated_recovery: true,
      drift_score_threshold: 0.8
    }
  },
  launch: {
    launch_profile: "default",
    workspace_backend: "inplace"
  },
  entry_node_ids: ["root__implement"],
  nodes: [
    {
      compiled_id: "root__implement",
      authored_id: "implement",
      kind: "agent",
      repo: "main",
      deps: [],
      scope_stack: ["root"],
      effective_policy: {
        profile_name: "default",
        workspace_backend: "inplace",
        harness: "codex-cli",
        sandbox: "workspace-write",
        timeout_sec: 1800,
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
          description: "Human reviewer handoff produced by the implement node."
        }
      },
      goal: "Implement checkout timeout handling.",
      tools: []
    }
  ],
  edges: [],
  scopes: [],
  authored_to_compiled: {
    implement: ["root__implement"]
  },
  prerequisites: { checks: [] }
};

const state: RuntimeStateSnapshot = {
  run_id: "run-1",
  graph_id: "delivery-test",
  snapshot_seq: 1,
  status: "passed",
  evidence_status: "clean",
  workspace_backend: "inplace",
  repo_workspaces: {},
  workspace_change_artifacts: {},
  counts: {
    total: 1,
    pending: 0,
    ready: 0,
    running: 0,
    passed: 1,
    failed: 0,
    blocked: 0,
    canceled: 0,
    skipped: 0
  },
  soft_verification_counts: {
    passed: 0,
    failed: 0
  },
  failed_soft_verifications: [],
  supervisor: {
    status: "healthy",
    intervention_count: 0,
    budget_remaining: {
      max_total_interventions: 2,
      actions: {
        retry_with_guidance: 1,
        repair_artifact: 1,
        pause_for_human: 1
      }
    },
    timeline: [],
    escalations: []
  },
  node_statuses: {},
  active_executions: {},
  latest_execution_by_compiled_id: {},
  repeat_scopes: {},
  started_at: "2026-04-24T00:00:00.000Z",
  ended_at: "2026-04-24T00:00:01.000Z"
};

describe("delivery package", () => {
  it("writes every required supervised delivery artifact", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "agentflow-delivery-"));
    const executionDir = join(runRoot, "nodes", "001-implement", "executions", "001-exec");
    const artifactDir = join(executionDir, "artifacts");
    const logsDir = join(executionDir, "logs");
    await mkdir(artifactDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    const responsePath = join(artifactDir, "agent-response.md");
    const handoffPath = join(artifactDir, "handoff.md");
    const stdoutPath = join(logsDir, "stdout.log");
    const stderrPath = join(logsDir, "stderr.log");
    await writeFile(responsePath, "Implemented checkout timeout handling.\n", "utf8");
    await writeFile(handoffPath, "Reviewer handoff with validation evidence.\n", "utf8");
    await writeFile(stdoutPath, "agent stdout\n", "utf8");
    await writeFile(stderrPath, "", "utf8");
    await writeFile(join(runRoot, "interventions.jsonl"), "", "utf8");
    await mkdir(join(runRoot, "runtime"), { recursive: true });
    await writeFile(join(runRoot, "supervisor-timeline.jsonl"), "", "utf8");
    await writeFile(join(runRoot, "runtime", "log.jsonl"), "", "utf8");
    await writeFile(join(runRoot, "compile_diagnostics.json"), "[]\n", "utf8");
    const attempts: RuntimeNodeAttempt[] = [
      {
        execution_id: "exec-1",
        compiled_id: "root__implement",
        authored_id: "implement",
        kind: "agent",
        repo_alias: "main",
        execution_dir: executionDir,
        attempt_index: 1,
        status: "passed",
        outcome: "passed",
        started_at: "2026-04-24T00:00:00.000Z",
        ended_at: "2026-04-24T00:00:01.000Z",
        duration_ms: 1000,
        stdout_log_path: stdoutPath,
        stderr_log_path: stderrPath,
        artifacts: {
          agent_response: responsePath,
          handoff: handoffPath
        },
        metadata: {}
      }
    ];
    const events: RuntimeEventEnvelope[] = [];
    const interventions: SupervisorInterventionRecord[] = [];

    const manifest = await writeDeliveryPackage({
      run_root: runRoot,
      graph,
      state,
      attempts,
      events,
      interventions
    });

    expect(Object.keys(manifest.sections).sort()).toEqual([
      "decision_log",
      "evaluation_ledger",
      "follow_up_items",
      "grouped_change_map",
      "implementation_summary",
      "intervention_trace",
      "reviewer_guide",
      "risk_notes",
      "task_brief"
    ]);
    expect(manifest.human_entrypoints).toEqual({
      reviewer_guide: join(runRoot, "delivery", "reviewer-guide.md"),
      task_brief: join(runRoot, "delivery", "task-brief.md"),
      implementation_summary: join(runRoot, "delivery", "implementation-summary.md"),
      risk_notes: join(runRoot, "delivery", "risk-notes.md"),
      follow_up_items: join(runRoot, "delivery", "follow-up-items.md")
    });
    expect(manifest.evidence_files).toEqual({
      grouped_change_map: join(runRoot, "delivery", "grouped-change-map.json"),
      decision_log: join(runRoot, "delivery", "decision-log.md"),
      evaluation_ledger: join(runRoot, "delivery", "evaluation-ledger.json"),
      intervention_trace: join(runRoot, "delivery", "intervention-trace.json"),
      supervisor_timeline: join(runRoot, "supervisor-timeline.jsonl"),
      runtime_log: join(runRoot, "runtime", "log.jsonl")
    });
    expect(manifest.internal_artifacts).toEqual({
      run_record: join(runRoot, "run.json"),
      state: join(runRoot, "state.json"),
      events: join(runRoot, "events.jsonl"),
      supervisor_timeline: join(runRoot, "supervisor-timeline.jsonl"),
      runtime_log: join(runRoot, "runtime", "log.jsonl"),
      interventions: join(runRoot, "interventions.jsonl"),
      node_attempts: join(runRoot, "nodes"),
      workspace_changes: join(runRoot, "workspace-changes")
    });
    await expect(readFile(join(runRoot, "delivery", "manifest.json"), "utf8")).resolves.toContain(
      '"graph_id": "delivery-test"'
    );
    await expect(readFile(join(runRoot, "delivery", "reviewer-guide.md"), "utf8")).resolves.toContain(
      "Reviewer Guide"
    );
    await expect(readFile(join(runRoot, "delivery", "reviewer-guide.md"), "utf8")).resolves.toContain(
      "Review Order"
    );
    await expect(readFile(join(runRoot, "delivery", "run-map.md"), "utf8")).resolves.toContain(
      "Run Map"
    );
    await expect(readFile(join(runRoot, "delivery", "evaluation-ledger.json"), "utf8")).resolves.toContain(
      '"failed_checks": []'
    );
    expect(manifest.artifact_counts.declared_artifacts).toBe(1);
    expect(manifest.run_map).toBe(join(runRoot, "delivery", "run-map.md"));
    expect(manifest.artifact_taxonomy.declared_artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "implement.handoff",
          path: handoffPath
        })
      ])
    );
    expect(manifest.artifact_taxonomy.resume_required.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(["Run record", "Compiled graph snapshot", "Runtime state"])
    );
    expect(manifest.artifact_taxonomy.debug_only).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "implement stdout log",
          path: stdoutPath
        })
      ])
    );
    expect(manifest.artifact_taxonomy.empty_or_noop).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: stderrPath,
          reason: "empty_stderr"
        }),
        expect.objectContaining({
          path: join(runRoot, "interventions.jsonl"),
          reason: "empty_ledger"
        }),
        expect.objectContaining({
          path: join(runRoot, "supervisor-timeline.jsonl"),
          reason: "empty_ledger"
        }),
        expect.objectContaining({
          path: join(runRoot, "runtime", "log.jsonl"),
          reason: "empty_ledger"
        }),
        expect.objectContaining({
          path: join(runRoot, "compile_diagnostics.json"),
          reason: "no_diagnostics"
        })
      ])
    );
    await expect(readFile(join(runRoot, "delivery", "implementation-summary.md"), "utf8")).resolves.toContain(
      "Reviewer handoff with validation evidence."
    );
    await expect(readFile(join(runRoot, "delivery", "evaluation-ledger.json"), "utf8")).resolves.toContain(
      '"name": "handoff"'
    );
  });
});
