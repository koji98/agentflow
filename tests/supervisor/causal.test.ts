import { describe, expect, it } from "vitest";
import type { CompiledAgentNode, CompiledCheckNode, CompiledGraph } from "../../src/graph/compiled.js";
import { createAttemptRegistry, type RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import { buildSchedulerTopology } from "../../src/runtime/core/scheduler.js";
import { buildSupervisorCausalContext } from "../../src/supervisor/causal.js";
import type { FailureClassification } from "../../src/supervisor/classifier.js";
const policy = {
    profile_name: "default",
    sandbox: "workspace-write" as const,
    timeout_sec: 60,
    artifact_repair: { max_attempts: 1 }
};
const implementNode: CompiledAgentNode = {
    compiled_id: "implement",
    authored_id: "implement",
    kind: "agent",
    intent: {
        goal: "Implement checkout behavior.",
        acceptance_criteria: ["The implementation satisfies the downstream validation gate."],
        constraints: []
    },
    repo: "main",
    deps: [],
    scope_stack: ["root"],
    effective_policy: policy,
    context: [],
    declared_artifacts: {
        summary: {
            from: "output_dir",
            path: "summary.md",
            description: "Implementation summary."
        }
    },
    tools: []
};
const validateNode: CompiledCheckNode = {
    compiled_id: "validate",
    authored_id: "validate",
    kind: "check",
    check_kind: "deterministic",
    intent: {
        goal: "Validate checkout behavior.",
        acceptance_criteria: ["The focused validation command exits successfully."],
        constraints: []
    },
    repo: "main",
    deps: ["implement"],
    scope_stack: ["root"],
    effective_policy: policy,
    context: [
        {
            name: "implementation summary",
            ref: "implement.summary",
            node: "implement",
            artifact: "summary"
        }
    ],
    declared_artifacts: {},
    on_failure: "fail",
    command: "npm",
    args: ["test"]
};
const shipNode: CompiledAgentNode = {
    compiled_id: "ship",
    authored_id: "ship",
    kind: "agent",
    intent: {
        goal: "Ship the UI artifacts.",
        acceptance_criteria: ["The UI artifact validation passes with evidence."],
        constraints: []
    },
    repo: "main",
    deps: ["implement"],
    scope_stack: ["root"],
    effective_policy: policy,
    context: [
        {
            name: "implementation summary",
            ref: "implement.summary",
            node: "implement",
            artifact: "summary"
        }
    ],
    declared_artifacts: {
        handoff: {
            from: "output_dir",
            path: "handoff.md",
            description: "Shipping handoff."
        }
    },
    tools: []
};
const graph: CompiledGraph = {
    graph_id: "causal-test",
    intent: {
        goal: "Ship checkout behavior.",
        acceptance_criteria: ["The workflow validates the implementation."]
    },
    supervision: {
        max_total_interventions: 3
    },
    launch: {
        launch_profile: "default",
        workspace_backend: "inplace"
    },
    entry_node_ids: ["implement"],
    nodes: [implementNode, validateNode, shipNode],
    edges: [
        {
            edge_id: "implement__validate",
            from: "implement",
            to: "validate",
            on: "passed",
            kind: "flow"
        },
        {
            edge_id: "implement__ship",
            from: "implement",
            to: "ship",
            on: "passed",
            kind: "flow"
        }
    ],
    scopes: [],
    authored_to_compiled: {
        implement: ["implement"],
        validate: ["validate"],
        ship: ["ship"]
    }
};
const failedCheckAttempt: RuntimeNodeAttempt = {
    execution_id: "exec__validate__attempt_1",
    compiled_id: "validate",
    authored_id: "validate",
    kind: "check",
    repo_alias: "main",
    execution_dir: "/tmp/validate",
    attempt_index: 1,
    status: "failed",
    outcome: "failed",
    started_at: "2026-05-01T00:00:00.000Z",
    ended_at: "2026-05-01T00:00:01.000Z",
    artifacts: {},
    metadata: {}
};
const failedShipAttempt: RuntimeNodeAttempt = {
    execution_id: "exec__ship__attempt_1",
    compiled_id: "ship",
    authored_id: "ship",
    kind: "agent",
    repo_alias: "main",
    execution_dir: "/tmp/ship",
    attempt_index: 1,
    status: "failed",
    outcome: "failed",
    started_at: "2026-05-01T00:00:00.000Z",
    ended_at: "2026-05-01T00:00:01.000Z",
    artifacts: {},
    metadata: {}
};
const classification: FailureClassification = {
    class: "diagnostic_needed",
    summary: "Focused validation failed.",
    retryable: true,
    recommended_action: "run_diagnostic",
    gather_plan: {
        max_parallel: 1,
        gathers: []
    },
    evidence: {
        deterministic_check_failed: true
    }
};
const semanticClassification: FailureClassification = {
    class: "semantic_misalignment",
    summary: "Outcome verification rejected the shipping node because validation evidence was incomplete.",
    retryable: true,
    recommended_action: "semantic_evaluation",
    gather_plan: {
        max_parallel: 1,
        gathers: []
    },
    evidence: {}
};
const completionClassification: FailureClassification = {
    class: "completion_contract_failure",
    summary: "Missing expected artifact: handoff",
    retryable: true,
    recommended_action: "retry_with_guidance",
    gather_plan: {
        max_parallel: 1,
        gathers: []
    },
    evidence: {
        completion: {
            completion_status: "incomplete",
            blocking_reasons: ["Missing expected artifact: handoff"],
            packet_path: "/tmp/ship/completion-packet.json"
        }
    }
};
describe("supervisor causal context", () => {
    it("treats a failed check as a symptom and targets the nearest upstream worker", () => {
        const attempts = createAttemptRegistry();
        attempts.by_compiled_id.set("validate", [failedCheckAttempt]);
        const topology = buildSchedulerTopology(graph);
        const context = buildSupervisorCausalContext({
            graph,
            topology,
            attempts,
            nodeStatuses: new Map([
                ["implement", "passed"],
                ["validate", "failed"]
            ]),
            symptomNode: validateNode,
            symptomAttempt: failedCheckAttempt,
            classification,
            repeatedFingerprintCount: 1
        });
        expect(context.selected_target).toEqual(expect.objectContaining({
            operation: "repair_upstream_node",
            target_compiled_id: "implement",
            symptom_compiled_id: "validate",
            confidence: "high"
        }));
        expect(context.upstream_cone).toEqual([
            expect.objectContaining({
                compiled_id: "implement",
                distance: 1,
                status: "passed"
            })
        ]);
    });
    it("marks repeated fingerprints as requiring causal investigation", () => {
        const attempts = createAttemptRegistry();
        attempts.by_compiled_id.set("validate", [failedCheckAttempt]);
        const topology = buildSchedulerTopology(graph);
        const context = buildSupervisorCausalContext({
            graph,
            topology,
            attempts,
            nodeStatuses: new Map(),
            symptomNode: validateNode,
            symptomAttempt: failedCheckAttempt,
            classification,
            repeatedFingerprintCount: 2
        });
        expect(context.selected_target.requires_investigation).toBe(true);
        expect(context.selected_target.evidence.join(" ")).toContain("Repeated fingerprint");
    });
    it("keeps failed agent outcome verification on the symptom node unless upstream artifact evidence is implicated", () => {
        const attempts = createAttemptRegistry();
        attempts.by_compiled_id.set("ship", [failedShipAttempt]);
        const topology = buildSchedulerTopology(graph);
        const context = buildSupervisorCausalContext({
            graph,
            topology,
            attempts,
            nodeStatuses: new Map([
                ["implement", "passed"],
                ["ship", "failed"]
            ]),
            symptomNode: shipNode,
            symptomAttempt: failedShipAttempt,
            classification: semanticClassification,
            repeatedFingerprintCount: 1
        });
        expect(context.selected_target).toEqual(expect.objectContaining({
            operation: "repair_current_node",
            target_compiled_id: "ship",
            symptom_compiled_id: "ship"
        }));
    });
    it("keeps failed agent completion checks on the symptom node instead of repairing upstream artifacts", () => {
        const attempts = createAttemptRegistry();
        attempts.by_compiled_id.set("ship", [failedShipAttempt]);
        const topology = buildSchedulerTopology(graph);
        const context = buildSupervisorCausalContext({
            graph,
            topology,
            attempts,
            nodeStatuses: new Map([
                ["implement", "passed"],
                ["ship", "failed"]
            ]),
            symptomNode: shipNode,
            symptomAttempt: failedShipAttempt,
            classification: completionClassification,
            repeatedFingerprintCount: 1
        });
        expect(context.selected_target).toEqual(expect.objectContaining({
            operation: "repair_current_node",
            target_compiled_id: "ship",
            symptom_compiled_id: "ship"
        }));
        expect(context.target_candidates).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                operation: "repair_artifact",
                target_compiled_id: "implement"
            })
        ]));
    });
});
