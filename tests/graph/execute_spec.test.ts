import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";

function buildSpecDesignStep() {
  return {
    type: "spec_design",
    id: "managed_nodes_spec",
    brief: {
      problem: "Managed workflows need a stable authored contract.",
      goal: "Design the implementation-ready managed workflow surface."
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

function buildExecuteStep(stepOverrides = {}) {
  return {
    type: "execute_spec",
    id: "implement_managed_nodes",
    repo: "main",
    profile: "default",
    brief: {
      objective: "Implement the managed workflow model described by the spec.",
      scope: {
        paths: ["src/**", "docs/**", "tests/**"],
        areas: ["graph", "managed workflows"]
      }
    },
    spec_source: {
      kind: "managed_node",
      node: "managed_nodes_spec"
    },
    context_policy: {
      allow_official_docs_fallback: true,
      allow_domains: ["developers.openai.com"]
    },
    approval_policy: {
      require_execution_plan_approval: false
    },
    strategy: {
      single_writer: true,
      allow_readonly_recon: true,
      max_repair_cycles: 3
    },
    validation: {
      commands: ["npm run typecheck", "npm test"],
      required: true
    },
    delivery: {
      write_handoff: true,
      write_validation_ledger: true,
      write_repair_log: true
    },
    ...stepOverrides
  };
}

function buildDocument(steps) {
  return {
    version: "1",
    graph_id: "execute-spec-test",
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

describe("execute spec managed workflow", () => {
  it("lowers to the v2 single-writer execution workflow with optional plan approval and a bounded repair loop", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument([
        buildExecuteStep({
          approval_policy: {
            require_execution_plan_approval: true
          },
          strategy: {
            single_writer: true,
            allow_readonly_recon: true,
            max_repair_cycles: 3
          }
        })
      ])
    );

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "implement_managed_nodes",
        managed_kind: "execute_spec",
        lowered_to: "sequence"
      }
    ]);

    const root = normalized.document?.graph;

    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }

    const workflow = root.steps[0];

    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected execute_spec to lower into a sequence workflow.");
    }

    expect(workflow.steps.map((step) => step.id)).toEqual([
      "implement_managed_nodes__managed__execute_spec__ingest_spec",
      "implement_managed_nodes__managed__execute_spec__assess_spec_readiness",
      "implement_managed_nodes__managed__execute_spec__read_only_recon",
      "implement_managed_nodes__managed__execute_spec__plan_approval_loop",
      "implement_managed_nodes__managed__execute_spec__implement_spec",
      "implement_managed_nodes__managed__execute_spec__repair_loop",
      "implement_managed_nodes"
    ]);

    const readinessGate = workflow.steps[1];
    const planLoop = workflow.steps[3];
    const implementNode = workflow.steps[4];
    const repairLoop = workflow.steps[5];
    const finalNode = workflow.steps[6];

    expect(readinessGate).toEqual(
      expect.objectContaining({
        type: "check",
        check_kind: "ai",
        id: "implement_managed_nodes__managed__execute_spec__assess_spec_readiness"
      })
    );

    if (!planLoop || planLoop.type !== "repeat") {
      throw new Error("Expected execution plan approval to compile as a repeat loop.");
    }

    if (!repairLoop || repairLoop.type !== "repeat") {
      throw new Error("Expected repair loop to be repeat-based.");
    }

    expect(planLoop.until.node).toBe("implement_managed_nodes__managed__execute_spec__approve_execution_plan");
    expect(repairLoop.max_attempts).toBe(3);
    expect(repairLoop.until.node).toBe("implement_managed_nodes__managed__execute_spec__validation_gate");
    expect(implementNode).toEqual(
      expect.objectContaining({
        type: "agent",
        sandbox: "workspace-write",
        id: "implement_managed_nodes__managed__execute_spec__implement_spec"
      })
    );
    expect(finalNode).toEqual(
      expect.objectContaining({
        id: "implement_managed_nodes",
        type: "agent",
        outputs: expect.arrayContaining([
          expect.objectContaining({ name: "handoff", path: "handoff.md" }),
          expect.objectContaining({ name: "validation_ledger", path: "validation-ledger.json" }),
          expect.objectContaining({ name: "repair_log", path: "repair-log.md" }),
          expect.objectContaining({ name: "execution_plan", path: "execution-plan.md" }),
          expect.objectContaining({ name: "file_plan", path: "file-plan.md" }),
          expect.objectContaining({ name: "mutation_boundary", path: "mutation-boundary.md" }),
          expect.objectContaining({ name: "validation_plan", path: "validation-plan.md" }),
          expect.objectContaining({ name: "workflow_status", path: "workflow-status.json" }),
          expect.objectContaining({ name: "workflow_events", path: "workflow-events.jsonl" })
        ])
      })
    );
  });

  it("maps artifact_bundle spec sources into ingest inputs and managed-output context", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument([
        {
          type: "agent",
          id: "upstream_plan",
          prompt: "Write a decision log artifact.",
          outputs: [
            {
              name: "decision_log",
              from: "attempt",
              path: "decision-log.md",
              required: true
            }
          ]
        },
        buildExecuteStep({
          id: "implement_from_bundle",
          spec_source: {
            kind: "artifact_bundle",
            design_spec: {
              kind: "file",
              path: "docs/spec.md"
            },
            tradeoff_matrix: {
              kind: "file",
              path: "docs/tradeoff-matrix.md"
            },
            decision_log: {
              kind: "managed_output",
              node: "upstream_plan",
              output: "decision_log"
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
      throw new Error("Expected execute_spec to lower into a sequence workflow.");
    }

    const ingestNode = workflow.steps[0];

    expect(ingestNode).toEqual(
      expect.objectContaining({
        type: "agent",
        id: "implement_from_bundle__managed__execute_spec__ingest_spec",
        inputs: expect.arrayContaining([
          expect.objectContaining({ kind: "file", path: "docs/spec.md" }),
          expect.objectContaining({ kind: "file", path: "docs/tradeoff-matrix.md" })
        ]),
        context_from: expect.arrayContaining([
          expect.objectContaining({
            node: "upstream_plan",
            include: "output",
            output: "decision_log",
            optional: true
          })
        ])
      })
    );
  });

  it("compiles execute_spec so downstream nodes depend on the final published handoff", () => {
    const normalized = normalizeAuthoredGraphDocument(
      buildDocument([
        buildSpecDesignStep(),
        buildExecuteStep(),
        {
          type: "agent",
          id: "handoff",
          prompt: "Summarize the implementation result for an operator.",
          context_from: [
            {
              node: "implement_managed_nodes",
              include: "summary"
            },
            {
              node: "implement_managed_nodes",
              include: "output",
              output: "handoff"
            },
            {
              node: "implement_managed_nodes",
              include: "output",
              output: "validation_ledger"
            }
          ]
        }
      ])
    );

    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(
      normalized.document!,
      launch,
      normalized.lowered_managed_nodes
    );

    expect(compilation.diagnostics).toEqual([]);
    expect(compilation.compiled_graph).toBeDefined();

    const compiledGraph = compilation.compiled_graph!;
    const finalExecuteNode = compiledGraph.nodes.find((node) => node.authored_id === "implement_managed_nodes");
    const implementNode = compiledGraph.nodes.find(
      (node) => node.authored_id === "implement_managed_nodes__managed__execute_spec__implement_spec"
    );
    const repairScope = compiledGraph.scopes.find(
      (scope) => scope.authored_id === "implement_managed_nodes__managed__execute_spec__repair_loop"
    );
    const handoffNode = compiledGraph.nodes.find((node) => node.authored_id === "handoff");

    expect(compiledGraph.authored_to_compiled.implement_managed_nodes).toEqual([
      "root__implement_managed_nodes__managed__execute_spec__workflow__implement_managed_nodes"
    ]);
    expect(finalExecuteNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        lowered_from: "execute_spec",
        compiled_id: "root__implement_managed_nodes__managed__execute_spec__workflow__implement_managed_nodes"
      })
    );
    expect(implementNode).toEqual(
      expect.objectContaining({
        kind: "agent",
        effective_policy: expect.objectContaining({
          sandbox: "workspace-write"
        })
      })
    );
    expect(repairScope).toEqual(
      expect.objectContaining({
        kind: "repeat"
      })
    );
    expect(handoffNode).toEqual(
      expect.objectContaining({
        deps: ["root__implement_managed_nodes__managed__execute_spec__workflow__implement_managed_nodes"]
      })
    );
  });
});
