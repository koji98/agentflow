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
    allowed_actions: ["retry_node", "repair_artifact", "escalate"],
    retry_budget: {
      max_total_interventions: 2,
      max_node_retries: 1,
      max_artifact_repairs: 1,
      max_context_rebuilds: 0,
      max_workspace_refreshes: 0,
      max_diagnostic_runs: 0,
      max_semantic_evaluations: 0
    },
    drift_detection: { score_threshold: 0.8 },
    escalation: {
      require_human_on_policy_breach: true,
      require_human_on_scope_drift: true
    }
  },
  delivery: {
    required_sections: [
      "task_brief",
      "implementation_summary",
      "grouped_change_map",
      "decision_log",
      "evaluation_ledger",
      "reviewer_guide",
      "risk_notes",
      "follow_up_items",
      "intervention_trace"
    ]
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
      prompt: "Implement checkout timeout handling.",
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
      max_node_retries: 1,
      max_artifact_repairs: 1,
      max_context_rebuilds: 0,
      max_workspace_refreshes: 0,
      max_diagnostic_runs: 0,
      max_semantic_evaluations: 0
    },
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
    const artifactDir = join(runRoot, "nodes", "001-implement", "executions", "001-exec", "artifacts");
    await mkdir(artifactDir, { recursive: true });
    const responsePath = join(artifactDir, "agent-response.md");
    const handoffPath = join(artifactDir, "handoff.md");
    await writeFile(responsePath, "Implemented checkout timeout handling.\n", "utf8");
    await writeFile(handoffPath, "Reviewer handoff with validation evidence.\n", "utf8");
    const attempts: RuntimeNodeAttempt[] = [
      {
        execution_id: "exec-1",
        compiled_id: "root__implement",
        authored_id: "implement",
        kind: "agent",
        repo_alias: "main",
        execution_dir: join(runRoot, "nodes", "001-implement", "executions", "001-exec"),
        attempt_index: 1,
        status: "passed",
        outcome: "passed",
        started_at: "2026-04-24T00:00:00.000Z",
        ended_at: "2026-04-24T00:00:01.000Z",
        duration_ms: 1000,
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
      intervention_trace: join(runRoot, "delivery", "intervention-trace.json")
    });
    expect(manifest.internal_artifacts).toEqual({
      run_record: join(runRoot, "run.json"),
      state: join(runRoot, "state.json"),
      events: join(runRoot, "events.jsonl"),
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
      "Human Review Surface"
    );
    await expect(readFile(join(runRoot, "delivery", "evaluation-ledger.json"), "utf8")).resolves.toContain(
      '"failed_checks": []'
    );
    expect(manifest.artifact_counts.declared_artifacts).toBe(1);
    await expect(readFile(join(runRoot, "delivery", "implementation-summary.md"), "utf8")).resolves.toContain(
      "Reviewer handoff with validation evidence."
    );
    await expect(readFile(join(runRoot, "delivery", "evaluation-ledger.json"), "utf8")).resolves.toContain(
      '"name": "handoff"'
    );
  });
});
