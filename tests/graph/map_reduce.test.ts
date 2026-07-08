import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";

const execFileAsync = promisify(execFile);

const TEST_INTENT = {
  goal: "Audit a bounded set of independent items.",
  acceptance_criteria: ["The map-reduce pattern publishes aggregate evidence."]
};

function buildPatternStep(overrides = {}) {
  return {
    type: "pattern_map_reduce",
    id: "auth_audit",
    runtime: {
      repo: "main",
      profile: "default"
    },
    intent: {
      goal: "Audit route handlers for missing authorization checks.",
      acceptance_criteria: [
        "Every selected route handler is inspected or recorded with concrete skip/blocker evidence.",
        "The aggregate artifact separates pass, finding, skipped, and blocked items with source evidence.",
        "The coverage summary explains what was selected, omitted, and uncertain."
      ],
      constraints: ["Do not edit source files."]
    },
    map_reduce: {
      items: {
        max_items: 80,
        intent: {
          goal: "Find route handlers that should be audited for authorization behavior.",
          acceptance_criteria: [
            "The item list is finite.",
            "Each item has a stable id, input, title, and scope rationale.",
            "The item list records omitted candidates and uncertainty when relevant."
          ],
          constraints: ["Do not include generated files or dependency directories."]
        }
      },
      map: {
        max_concurrency: 6,
        intent: {
          goal: "Inspect one frozen route handler for authorization enforcement.",
          acceptance_criteria: [
            "The item result records passed, finding, skipped, or blocked status.",
            "The item result cites exact source evidence.",
            "Findings include severity, rationale, and evidence."
          ],
          constraints: ["Do not inspect unrelated route handlers except shared middleware needed to judge this item."]
        }
      },
      reduce: {
        intent: {
          goal: "Publish a verified aggregate authorization audit handoff.",
          acceptance_criteria: [
            "Every frozen item has one terminal accepted result.",
            "The aggregate groups findings, passes, skipped items, blockers, and uncertainty.",
            "The aggregate is sufficient for downstream planning without reading item directories first."
          ],
          constraints: ["Do not claim full repository coverage beyond the frozen item set and recorded discovery evidence."]
        }
      }
    },
    ...overrides
  };
}

function buildDocument(steps: unknown[]) {
  return {
    version: "1",
    graph_id: "pattern-map-reduce-test",
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
      },
      supervisor: {
        harness: "codex-cli",
        sandbox: "read-only"
      }
    },
    supervision: {
      profile: "supervisor",
      max_total_interventions: 3
    },
    graph: {
      type: "sequence",
      id: "root",
      steps
    }
  };
}

describe("pattern map reduce", () => {
  it("lowers into item planning, freeze, map fanout, and deterministic reduce phases", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([buildPatternStep()])));
    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.lowered_managed_nodes).toEqual([
      {
        authored_id: "auth_audit",
        managed_kind: "pattern_map_reduce",
        lowered_to: "sequence"
      }
    ]);

    const root = normalized.document?.graph;
    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }
    const workflow = root.steps[0];
    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_map_reduce to lower into a sequence workflow.");
    }

    expect(workflow.steps.map((step) => step.id)).toEqual([
      "auth_audit__managed__pattern_map_reduce__plan_items",
      "auth_audit__managed__pattern_map_reduce__freeze",
      "auth_audit__managed__pattern_map_reduce__map_items",
      "auth_audit"
    ]);

    const planNode = workflow.steps[0];
    const freezeNode = workflow.steps[1];
    const mapNode = workflow.steps[2];
    const reduceNode = workflow.steps[3];
    const planPrompt = JSON.stringify(planNode);
    const mapPrompt = JSON.stringify(mapNode);

    expect(planNode).toEqual(expect.objectContaining({
      type: "agent",
      id: "auth_audit__managed__pattern_map_reduce__plan_items",
      managed_runtime: expect.objectContaining({
        kind: "pattern_map_reduce",
        root_id: "auth_audit",
        phase: "plan_items"
      }),
      artifacts: expect.objectContaining({
        item_list_json: expect.objectContaining({ path: "item-list.json" })
      })
    }));
    expect(planPrompt).toContain("Discover the finite independent item set");
    expect(planPrompt).toContain("Maximum items: 80");
    expect(planPrompt).toContain("Do not decide item passed/finding/skipped/blocked status during discovery.");
    expect(planPrompt).toContain("Do not edit source files.");
    expect(planPrompt).not.toContain("managed pattern");
    expect(planPrompt).not.toContain("public artifact");
    expect(planPrompt).not.toContain("private artifact");
    expect(planPrompt).not.toContain("runtime coordinator");

    expect(freezeNode).toEqual(expect.objectContaining({
      type: "exec",
      command: "node",
      artifacts: expect.objectContaining({
        frozen_items: expect.objectContaining({ path: "items-frozen.json" })
      })
    }));
    expect(JSON.stringify(freezeNode)).toContain("Maximum item count is 80.");

    expect(mapNode).toEqual(expect.objectContaining({
      type: "agent",
      id: "auth_audit__managed__pattern_map_reduce__map_items",
      managed_runtime: expect.objectContaining({
        kind: "pattern_map_reduce",
        root_id: "auth_audit",
        phase: "map_items",
        config: expect.objectContaining({
          parent_intent: expect.objectContaining({
            goal: "Audit route handlers for missing authorization checks."
          }),
          map_intent: expect.objectContaining({
            goal: "Inspect one frozen route handler for authorization enforcement."
          }),
          max_concurrency: 6
        })
      }),
      artifacts: expect.objectContaining({
        item_results: expect.objectContaining({ path: "item-results.json" })
      })
    }));
    expect(mapPrompt).toContain("Inspect/process one frozen item at a time.");
    expect(mapPrompt).toContain("Do not add, remove, split, merge, or reorder items.");
    expect(mapPrompt).toContain("passed, finding, skipped, or blocked");
    expect(mapPrompt).toContain("Do not rediscover the item list.");
    expect(mapPrompt).toContain("Write only the current item result.");
    expect(mapPrompt).toContain("Do not make whole-list coverage claims.");
    expect(mapPrompt).not.toContain("aggregate counts");
    expect(mapPrompt).not.toContain("final summary");
    expect(mapPrompt).not.toContain("managed pattern");
    expect(mapPrompt).not.toContain("public artifact");
    expect(mapPrompt).not.toContain("private artifact");

    expect(reduceNode).toEqual(expect.objectContaining({
      id: "auth_audit",
      type: "exec",
      command: "node",
      intent: expect.objectContaining({
        goal: expect.stringContaining("Publish a verified aggregate authorization audit handoff.")
      }),
      artifacts: expect.objectContaining({
        aggregate: expect.objectContaining({ path: "aggregate.json" })
      })
    }));
    expect(JSON.stringify(reduceNode)).toContain("Do not claim coverage beyond the frozen list");
  });

  it("rejects first-pass knobs that are not part of the small authoring contract", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep({
        runtime: {
          repo: "main",
          profile: "default",
          max_concurrency: 4
        },
        map_reduce: {
          items: {
            kind: "glob",
            intent: {
              goal: "Find route handlers."
            }
          },
          map: {
            item_worker: {
              kind: "deep_work"
            },
            intent: {
              goal: "Inspect one route."
            }
          },
          reduce: {
            mode: "llm",
            intent: {
              goal: "Aggregate results."
            }
          }
        }
      })
    ])));
    expect(normalized.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "$.graph.steps[0].map_reduce.items.kind",
        message: "Unknown field \"kind\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].map_reduce.map.item_worker",
        message: "Unknown field \"item_worker\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].map_reduce.reduce.mode",
        message: "Unknown field \"mode\" is not part of the graph contract."
      }),
      expect.objectContaining({
        path: "$.graph.steps[0].runtime.max_concurrency",
        message: "Unknown field \"max_concurrency\" is not part of the graph contract."
      })
    ]));
  });

  it("rejects duplicate item result ids during deterministic reduction", async () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([buildPatternStep()])));
    expect(normalized.diagnostics).toEqual([]);
    const root = normalized.document?.graph;
    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }
    const workflow = root.steps[0];
    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_map_reduce to lower into a sequence workflow.");
    }
    const reduceNode = workflow.steps[3];
    if (!reduceNode || reduceNode.type !== "exec" || reduceNode.command !== "node") {
      throw new Error("Expected lowered reducer to be a node exec.");
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-map-reduce-reducer-"));
    try {
      const outputDir = join(tempRoot, "out");
      const frozenPath = join(tempRoot, "items-frozen.json");
      const resultsPath = join(tempRoot, "item-results.json");
      await mkdir(outputDir, { recursive: true });
      await writeFile(frozenPath, `${JSON.stringify({
        schema_version: 1,
        status: "frozen",
        items: [
          { id: "m1", title: "One", input: { path: "one.md" }, scope_rationale: "First item is in scope." },
          { id: "m2", title: "Two", input: { path: "two.md" }, scope_rationale: "Second item is in scope." }
        ],
        omissions: [],
        uncertainty: []
      }, null, 2)}\n`, "utf8");
      await writeFile(resultsPath, `${JSON.stringify({
        schema_version: 1,
        status: "completed",
        items: [
          {
            id: "m1",
            status: "passed",
            summary: "First item passed.",
            evidence: [{ ref: "one.md", summary: "Reviewed one." }],
            findings: []
          },
          {
            id: "m1",
            status: "passed",
            summary: "Duplicate first item passed.",
            evidence: [{ ref: "one.md", summary: "Reviewed one again." }],
            findings: []
          }
        ]
      }, null, 2)}\n`, "utf8");

      let stderr = "";
      try {
        await execFileAsync("node", ["-e", reduceNode.args[1] ?? ""], {
          env: {
            ...process.env,
            AGENTFLOW_CONTEXT_FROZEN_ITEMS: frozenPath,
            AGENTFLOW_CONTEXT_ITEM_RESULTS: resultsPath,
            AGENTFLOW_OUTPUT_DIR: outputDir
          }
        });
      } catch (error) {
        stderr = String((error as { stderr?: unknown }).stderr ?? error);
      }
      expect(stderr).toContain("duplicate result id m1");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects reducer input that is not a completed item-results packet", async () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep()
    ])));
    expect(normalized.diagnostics).toEqual([]);
    const root = normalized.document?.graph;
    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }
    const workflow = root.steps[0];
    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_map_reduce to lower into a sequence workflow.");
    }
    const reduceNode = workflow.steps[3];
    if (!reduceNode || reduceNode.type !== "exec" || reduceNode.command !== "node") {
      throw new Error("Expected lowered reducer to be a node exec.");
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-map-reduce-reducer-"));
    try {
      const outputDir = join(tempRoot, "out");
      const frozenPath = join(tempRoot, "items-frozen.json");
      const resultsPath = join(tempRoot, "item-results.json");
      await mkdir(outputDir, { recursive: true });
      await writeFile(frozenPath, `${JSON.stringify({
        schema_version: 1,
        status: "frozen",
        items: [
          { id: "m1", title: "One", input: { path: "one.md" }, scope_rationale: "First item is in scope." }
        ],
        omissions: [],
        uncertainty: []
      }, null, 2)}\n`, "utf8");
      await writeFile(resultsPath, `${JSON.stringify({
        schema_version: 1,
        status: "failed",
        items: [
          {
            id: "m1",
            status: "passed",
            summary: "First item passed.",
            evidence: [{ ref: "one.md", summary: "Reviewed one." }],
            findings: []
          }
        ]
      }, null, 2)}\n`, "utf8");

      let stderr = "";
      try {
        await execFileAsync("node", ["-e", reduceNode.args[1] ?? ""], {
          env: {
            ...process.env,
            AGENTFLOW_CONTEXT_FROZEN_ITEMS: frozenPath,
            AGENTFLOW_CONTEXT_ITEM_RESULTS: resultsPath,
            AGENTFLOW_OUTPUT_DIR: outputDir
          }
        });
      } catch (error) {
        stderr = String((error as { stderr?: unknown }).stderr ?? error);
      }
      expect(stderr).toContain('item-results.json status must be "completed"');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-finding reducer results that include findings", async () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep()
    ])));
    expect(normalized.diagnostics).toEqual([]);
    const root = normalized.document?.graph;
    if (!root || root.type !== "sequence") {
      throw new Error("Expected normalized graph root to be a sequence.");
    }
    const workflow = root.steps[0];
    if (!workflow || workflow.type !== "sequence") {
      throw new Error("Expected pattern_map_reduce to lower into a sequence workflow.");
    }
    const reduceNode = workflow.steps[3];
    if (!reduceNode || reduceNode.type !== "exec" || reduceNode.command !== "node") {
      throw new Error("Expected lowered reducer to be a node exec.");
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-map-reduce-reducer-"));
    try {
      const outputDir = join(tempRoot, "out");
      const frozenPath = join(tempRoot, "items-frozen.json");
      const resultsPath = join(tempRoot, "item-results.json");
      await mkdir(outputDir, { recursive: true });
      await writeFile(frozenPath, `${JSON.stringify({
        schema_version: 1,
        status: "frozen",
        items: [
          { id: "m1", title: "One", input: { path: "one.md" }, scope_rationale: "First item is in scope." }
        ],
        omissions: [],
        uncertainty: []
      }, null, 2)}\n`, "utf8");
      await writeFile(resultsPath, `${JSON.stringify({
        schema_version: 1,
        status: "completed",
        items: [
          {
            id: "m1",
            status: "passed",
            summary: "First item passed.",
            evidence: [{ ref: "one.md", summary: "Reviewed one." }],
            findings: [{ severity: "low", rationale: "Contradictory finding.", evidence: "one.md" }]
          }
        ]
      }, null, 2)}\n`, "utf8");

      let stderr = "";
      try {
        await execFileAsync("node", ["-e", reduceNode.args[1] ?? ""], {
          env: {
            ...process.env,
            AGENTFLOW_CONTEXT_FROZEN_ITEMS: frozenPath,
            AGENTFLOW_CONTEXT_ITEM_RESULTS: resultsPath,
            AGENTFLOW_OUTPUT_DIR: outputDir
          }
        });
      } catch (error) {
        stderr = String((error as { stderr?: unknown }).stderr ?? error);
      }
      expect(stderr).toContain("Item m1 with status passed must not include findings.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("compiles downstream refs against the stable aggregate artifact only", () => {
    const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(buildDocument([
      buildPatternStep(),
      {
        type: "agent",
        id: "handoff",
        intent: {
          goal: "Summarize the authorization audit.",
          acceptance_criteria: ["The handoff uses the stable aggregate artifact."],
          constraints: []
        },
        support: {
          context: [
            {
              kind: "artifact",
              ref: "auth_audit.aggregate",
              name: "aggregate",
              what: "Stable aggregate evidence from the managed map-reduce node.",
              why: "The handoff must cite aggregate coverage, findings, and blockers."
            }
          ]
        }
      }
    ])));
    expect(normalized.diagnostics).toEqual([]);
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
    expect(compilation.diagnostics).toEqual([]);
    const compiledGraph = compilation.compiled_graph!;
    expect(compiledGraph.authored_to_compiled.auth_audit).toEqual([
      "root__auth_audit__managed__pattern_map_reduce__workflow__auth_audit"
    ]);
    expect(compiledGraph.nodes.find((node) => node.authored_id === "auth_audit")).toEqual(expect.objectContaining({
      lowered_from: "pattern_map_reduce",
      declared_artifacts: expect.objectContaining({
        aggregate: expect.objectContaining({ path: "aggregate.json" })
      })
    }));
    expect(compiledGraph.nodes.find((node) => node.authored_id === "handoff")).toEqual(expect.objectContaining({
      deps: ["root__auth_audit__managed__pattern_map_reduce__workflow__auth_audit"]
    }));
  });
});
