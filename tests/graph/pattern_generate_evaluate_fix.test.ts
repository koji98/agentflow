import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";

const TEST_INTENT = {
  goal: "Generate, evaluate, and fix an accountable implementation slice.",
  acceptance_criteria: ["The managed pattern emits implementation, evaluation, and repair evidence."]
};

function buildPatternSpecDesignStep() {
  return {
    type: "pattern_spec_design",
    id: "managed_nodes_spec",
    brief: {
      problem: "Managed patterns need a stable authored contract.",
      goal: "Design the implementation-ready managed pattern surface."
    },
    context_policy: {
      repo_first: true,
      allow_web_fallback: false
    },
    approval_policy: {
      require_direction_approval: false
    },
    strategy: {
      alternatives: 2,
      critique_profiles: ["architecture"],
      max_revision_cycles: 2
    },
    delivery: {
      sections: ["problem", "recommendation", "implementation_readiness"]
    }
  };
}

function buildPatternStep(stepOverrides = {}) {
  return {
    type: "pattern_generate_evaluate_fix",
    id: "implement_managed_nodes",
    repo: "main",
    profile: "default",
    brief: {
      objective: "Implement the managed pattern model described by the upstream design packet.",
      scope: {
        paths: ["src/**", "docs/**", "tests/**"],
        areas: ["graph", "managed patterns"]
      }
    },
    task_source: {
      kind: "managed_node",
      node: "managed_nodes_spec"
    },
    context_policy: {
      allow_official_docs_fallback: true,
      allow_domains: ["developers.openai.com"]
    },
    strategy: {
      max_fix_cycles: 3
    },
    evaluation: {
      commands: ["npm run typecheck", "npm test"],
      required: true
    },
    ...stepOverrides
  };
}

function buildDocument(steps) {
  return {
    version: "1",
    graph_id: "pattern-generate-evaluate-fix-test",
    intent: TEST_INTENT,
    repos: {
      main: {
        path: "."
      }
    },
    defaults: {
      launch_profile: "default"
    },
    profiles: {
      default: {
        harness: "codex-cli",
        sandbox: "read-only"
      }
    },
    graph: {
      type: "sequence",
      id: "root",
      steps
    }
  };
}

describe("pattern generate evaluate fix", () => {
  it("lowers hard evaluation into a bounded generate/evaluate/fix loop and fixed published outputs", () => {
    const normalized = normalizeAuthoredGraphDocument(buildDocument([buildPatternStep()]));

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "implement_managed_nodes",
        managed_kind: "pattern_generate_evaluate_fix",
        lowered_to: "sequence"
      }
    ]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_generate_evaluate_fix to lower into a sequence workflow.");
    }

    expect(workflow.steps.map((step) => step.id)).toEqual([
      "implement_managed_nodes__managed__pattern_generate_evaluate_fix__prepare_task_packet",
      "implement_managed_nodes__managed__pattern_generate_evaluate_fix__fix_loop",
      "implement_managed_nodes"
    ]);

    const loop = workflow.steps[1];
    const finalNode = workflow.steps[2];

    if (!loop || loop.type !== "repeat") {
      throw new Error("Expected hard evaluation to lower into a repeat loop.");
    }

    expect(loop.max_attempts).toBe(4);
    expect(loop.until.node).toBe("implement_managed_nodes__managed__pattern_generate_evaluate_fix__evaluation_gate");

    if (loop.body.type !== "sequence") {
      throw new Error("Expected fix loop body to be a sequence.");
    }

    expect(loop.body.steps.map((step) => step.id)).toEqual([
      "implement_managed_nodes__managed__pattern_generate_evaluate_fix__generate_or_fix_change",
      "implement_managed_nodes__managed__pattern_generate_evaluate_fix__evaluator_panel",
      "implement_managed_nodes__managed__pattern_generate_evaluate_fix__aggregate_evaluations",
      "implement_managed_nodes__managed__pattern_generate_evaluate_fix__evaluation_gate"
    ]);

    const generateNode = loop.body.steps[0];
    const evaluatorPanel = loop.body.steps[1];
    const gateNode = loop.body.steps[3];

    expect(generateNode).toEqual(
      expect.objectContaining({
        type: "agent",
        sandbox: "workspace-write",
        id: "implement_managed_nodes__managed__pattern_generate_evaluate_fix__generate_or_fix_change"
      })
    );

    if (!evaluatorPanel || evaluatorPanel.type !== "parallel") {
      throw new Error("Expected evaluator panel to be parallel.");
    }

    expect(evaluatorPanel.max_concurrency).toBe(2);
    expect(evaluatorPanel.steps).toHaveLength(2);
    expect(evaluatorPanel.steps[0]).toEqual(
      expect.objectContaining({
        type: "check",
        check_kind: "deterministic",
        on_failure: "continue",
        id: "implement_managed_nodes__managed__pattern_generate_evaluate_fix__evaluate_01"
      })
    );
    expect(gateNode).toEqual(
      expect.objectContaining({
        type: "check",
        check_kind: "ai",
        id: "implement_managed_nodes__managed__pattern_generate_evaluate_fix__evaluation_gate"
      })
    );
    expect(finalNode).toEqual(
      expect.objectContaining({
        id: "implement_managed_nodes",
        type: "agent",
        artifacts: expect.objectContaining({
          change_summary: expect.objectContaining({ path: "change-summary.md" }),
          change_packet: expect.objectContaining({ path: "change-packet.json" }),
          evaluation_ledger: expect.objectContaining({ path: "evaluation-ledger.json" }),
          fix_log: expect.objectContaining({ path: "fix-log.md" })
        })
      })
    );
  });

  it("maps artifact_bundle task sources into prepare context", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument([
        {
          type: "agent",
          id: "upstream_decisions",
          goal: "Write a decision log artifact.",
          artifacts: {
            decision_log: {
              from: "output_dir",
              path: "decision-log.md",
              description: "Test artifact produced at decision-log.md."
            }
          }
        },
        buildPatternStep({
          id: "implement_from_bundle",
          task_source: {
            kind: "artifact_bundle",
            design_packet: {
              kind: "file",
              path: "artifacts/design-packet.json"
            },
            design_spec: {
              kind: "file",
              path: "docs/design-spec.md"
            },
            decision_log: {
              kind: "artifact",
              node: "upstream_decisions",
              artifact: "decision_log"
            }
          }
        })
      ])
    );

    expect(normalized.diagnostics).toEqual([]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[1];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_generate_evaluate_fix to lower into a sequence workflow.");
    }

    const prepareNode = workflow.steps[0];

    expect(prepareNode).toEqual(
      expect.objectContaining({
        type: "agent",
        id: "implement_from_bundle__managed__pattern_generate_evaluate_fix__prepare_task_packet",
        context: expect.arrayContaining([
          expect.objectContaining({ name: "design_packet", from: "workspace_file", path: "artifacts/design-packet.json" }),
          expect.objectContaining({ name: "design_spec", from: "workspace_file", path: "docs/design-spec.md" }),
          expect.objectContaining({
            ref: "upstream_decisions.decision_log",
            name: "decision_log",
            node: "upstream_decisions",
            artifact: "decision_log",
            if_available: true
          })
        ])
      })
    );
  });

  it("compiles pattern_generate_evaluate_fix so downstream nodes depend on the final published change package", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument([
        buildPatternSpecDesignStep(),
        buildPatternStep(),
        {
          type: "agent",
          id: "handoff",
          goal: "Summarize the final change package for an operator.",
          context: [
            {
              ref: "implement_managed_nodes.agent_response",
              name: "change_agent_response",
              node: "implement_managed_nodes",
              artifact: "agent_response"
            },
            {
              ref: "implement_managed_nodes.change_summary",
              name: "change_summary",
              node: "implement_managed_nodes",
              artifact: "change_summary"
            },
            {
              ref: "implement_managed_nodes.evaluation_ledger",
              name: "evaluation_ledger",
              node: "implement_managed_nodes",
              artifact: "evaluation_ledger"
            }
          ]
        }
      ])
    );

    expect(normalized.diagnostics).toEqual([]);

    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(
      normalized.document!,
      launch,
      normalized.lowered_managed_nodes
    );

    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.compiled_graph).toBeDefined();

    const compiledGraph = compilation.compiled_graph!;
    const finalChangeNode = compiledGraph.nodes.find((node) => node.authored_id === "implement_managed_nodes");
    const handoffNode = compiledGraph.nodes.find((node) => node.authored_id === "handoff");
    const loopScope = compiledGraph.scopes.find(
      (scope) => scope.authored_id === "implement_managed_nodes__managed__pattern_generate_evaluate_fix__fix_loop"
    );

    expect(loopScope).toEqual(
      expect.objectContaining({
        kind: "repeat"
      })
    );
    expect(compiledGraph.authored_to_compiled.implement_managed_nodes).toEqual([
      "root__implement_managed_nodes__managed__pattern_generate_evaluate_fix__workflow__implement_managed_nodes"
    ]);
    expect(finalChangeNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        lowered_from: "pattern_generate_evaluate_fix",
        compiled_id:
          "root__implement_managed_nodes__managed__pattern_generate_evaluate_fix__workflow__implement_managed_nodes"
      })
    );
    expect(handoffNode).toEqual(
      expect.objectContaining({
        deps: ["root__implement_managed_nodes__managed__pattern_generate_evaluate_fix__workflow__implement_managed_nodes"]
      })
    );
  });

  it("lowers evaluation.required = false to one non-blocking evaluation pass with no repair loop", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument([
        buildPatternStep({
          evaluation: {
            commands: ["npm test"],
            required: false
          }
        })
      ])
    );

    expect(normalized.diagnostics).toEqual([]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_generate_evaluate_fix to lower into a sequence workflow.");
    }

    expect(workflow.steps.map((step) => step.id)).toEqual([
      "implement_managed_nodes__managed__pattern_generate_evaluate_fix__prepare_task_packet",
      "implement_managed_nodes__managed__pattern_generate_evaluate_fix__generate_or_fix_change",
      "implement_managed_nodes__managed__pattern_generate_evaluate_fix__evaluator_panel",
      "implement_managed_nodes__managed__pattern_generate_evaluate_fix__aggregate_evaluations",
      "implement_managed_nodes"
    ]);

    expect(workflow.steps.some((step) => step.id?.includes("__evaluation_gate"))).toBe(false);
    expect(workflow.steps.some((step) => step.type === "repeat")).toBe(false);
  });
});
