import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { readRunExecutionAttempts } from "../../src/artifacts/reader.js";
import { runCompiledGraph } from "../../src/runtime/core/engine.js";
import type { AgentInvocation, HarnessAdapter } from "../../src/runtime/harness/types.js";
import { markInvocationRuntimeReady } from "../helpers/agentflow-runtime.js";
import { createPassingDeliveryHarness } from "../helpers/delivery-curation.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";

const execFileAsync = promisify(execFile);

function plannedItemListJson(): string {
  return `${JSON.stringify({
    items: [
      {
        id: "m1",
        title: "GET /api/projects/:id",
        input: { path: "routes.ts", selector: "GET /api/projects/:id" },
        scope_rationale: "This route returns project data and should enforce authorization.",
        evidence_refs: ["routes.ts"]
      },
      {
        id: "m2",
        title: "POST /api/projects",
        input: { path: "routes.ts", selector: "POST /api/projects" },
        scope_rationale: "This route creates project data and should enforce authorization.",
        evidence_refs: ["routes.ts"]
      },
      {
        id: "m3",
        title: "GET /api/health",
        input: { path: "routes.ts", selector: "GET /api/health" },
        scope_rationale: "This route is a plausible candidate that may be intentionally public.",
        evidence_refs: ["routes.ts"]
      }
    ],
    omissions: ["Generated route fixtures were omitted."],
    uncertainty: ["Dynamic route registration may require a follow-up sweep."]
  }, null, 2)}\n`;
}

function isMapReducePlannerInvocation(invocation: AgentInvocation): boolean {
  return Boolean(invocation.artifacts && Object.prototype.hasOwnProperty.call(invocation.artifacts, "item_list_json"));
}

function isMapReduceItemInvocation(invocation: AgentInvocation): boolean {
  return Boolean(
    invocation.artifacts &&
    Object.prototype.hasOwnProperty.call(invocation.artifacts, "item_result") &&
    invocation.managedPrompt?.phase === "map_item"
  );
}

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "seed\n");
  await writeFile(join(repoDir, "routes.ts"), "export const routes = [];\n");
  await execFileAsync("git", ["add", "README.md", "routes.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
}

function compileGraph(document: AuthoredGraphDocument) {
  const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults(document));
  expect(normalized.diagnostics).toEqual([]);
  const launch = resolveLaunchConfig(normalized.document!);
  const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
  expect(compilation.diagnostics).toEqual([]);
  return compilation.compiled_graph!;
}

function buildMapReduceGraph(options: {
  beforeSteps?: unknown[];
  patternSupportContext?: unknown[];
} = {}): AuthoredGraphDocument {
  const patternStep = {
    type: "pattern_map_reduce",
    id: "auth_audit",
    runtime: { repo: "main", profile: "default" },
    intent: {
      goal: "Audit route handlers for authorization behavior.",
      acceptance_criteria: ["The aggregate artifact lists every selected route item."],
      constraints: ["Do not edit source files."]
    },
    ...(options.patternSupportContext
      ? {
          support: {
            context: options.patternSupportContext
          }
        }
      : {}),
    map_reduce: {
      items: {
        max_items: 5,
        intent: {
          goal: "Find route handlers that should be audited.",
          acceptance_criteria: ["The item list is finite and independently inspectable."],
          constraints: ["Do not include generated files."]
        }
      },
      map: {
        max_concurrency: 2,
        intent: {
          goal: "Inspect one route handler for authorization behavior.",
          acceptance_criteria: ["The item result records status and evidence."],
          constraints: ["Do not inspect unrelated routes."]
        }
      },
      reduce: {
        intent: {
          goal: "Publish aggregate authorization audit evidence.",
          acceptance_criteria: ["The aggregate groups counts, findings, blockers, skipped items, evidence, and uncertainty."],
          constraints: ["Do not claim coverage beyond the frozen list."]
        }
      }
    }
  };

  return {
    version: "1",
    graph_id: "runtime-map-reduce",
    intent: {
      goal: "Exercise map-reduce runtime behavior.",
      acceptance_criteria: ["The map-reduce pattern publishes aggregate evidence."]
    },
    repos: { main: { path: "." } },
    defaults: { launch_profile: "default", workspace_backend: "inplace" },
    profiles: {
      default: { harness: "codex-cli", sandbox: "workspace-write" },
      supervisor: { harness: "codex-cli", sandbox: "read-only" }
    },
    supervision: { profile: "supervisor", max_total_interventions: 0 },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        ...(options.beforeSteps ?? []),
        patternStep
      ]
    }
  };
}

function buildHarness(
  state: { activeItems: number; maxActiveItems: number; itemOrder: string[] },
  options: { findingsOnPassedItem?: boolean } = {}
): HarnessAdapter {
  const deliveryHarness = createPassingDeliveryHarness("codex-cli");
  return {
    kind: "codex-cli",
    capabilities: getHarnessCapabilities("codex-cli")!,
    async run(invocation: AgentInvocation) {
      if (invocation.promptKind === "delivery_curator") {
        return deliveryHarness.run(invocation);
      }

      if (invocation.promptKind === "outcome_verification") {
        return {
          status: "passed",
          exitCode: 0,
          transcript: {
            last_message: [
              "```json",
              JSON.stringify({ passed: true, summary: "Map-reduce item verifier accepted the artifact.", findings: [] }),
              "```"
            ].join("\n")
          }
        };
      }

      if (isMapReducePlannerInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "item-list.json"), plannedItemListJson(), "utf8");
      } else if (isMapReduceItemInvocation(invocation)) {
        const itemId = /`(m\d+)`/u.exec(invocation.nodeGoal ?? "")?.[1] ?? "m1";
        state.itemOrder.push(itemId);
        state.activeItems += 1;
        state.maxActiveItems = Math.max(state.maxActiveItems, state.activeItems);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const finding = itemId === "m2";
        const skipped = itemId === "m3";
        const nonFindingFindings = options.findingsOnPassedItem && itemId === "m1";
        await writeFile(join(invocation.outputDir, "item-result.json"), `${JSON.stringify({
          id: itemId,
          status: finding ? "finding" : skipped ? "skipped" : "passed",
          summary: finding
            ? "Authorization evidence is missing for the project creation route."
            : skipped
              ? "Health route is intentionally public and out of auth-audit scope."
              : "Authorization is enforced before project data is returned.",
          evidence: [
            {
              ref: "routes.ts",
              summary: `Inspected ${itemId} route evidence.`
            }
          ],
          findings: finding
            ? [{ severity: "high", rationale: "Missing authorization check.", evidence: "routes.ts" }]
            : nonFindingFindings
              ? [{ severity: "low", rationale: "Contradictory finding on a passed item.", evidence: "routes.ts" }]
            : [],
          ...(skipped ? { skip_rationale: "Health route is intentionally public." } : {})
        }, null, 2)}\n`, "utf8");
        state.activeItems -= 1;
      }

      const result = {
        status: "passed" as const,
        exitCode: 0,
        transcript: { last_message: "done" }
      };
      await markInvocationRuntimeReady(invocation, result);
      return result;
    },
    async cancel() {
      return;
    }
  };
}

describe("runtime pattern_map_reduce", () => {
  it("freezes planner output, maps items with bounded concurrency, and publishes aggregate", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-map-reduce-runtime-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const state = { activeItems: 0, maxActiveItems: 0, itemOrder: [] as string[] };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: compileGraph(buildMapReduceGraph()),
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildHarness(state)
      }
    });

    expect(run.outcome).toBe("passed");
    expect(state.itemOrder.sort()).toEqual(["m1", "m2", "m3"]);
    expect(state.maxActiveItems).toBe(2);
    const attempts = await readRunExecutionAttempts(runRoot);
    expect(attempts
      .filter((attempt) => attempt.authored_id.startsWith("auth_audit__managed__pattern_map_reduce__map_items__item_"))
      .map((attempt) => attempt.authored_id)
      .sort()).toEqual([
      "auth_audit__managed__pattern_map_reduce__map_items__item_m1",
      "auth_audit__managed__pattern_map_reduce__map_items__item_m2",
      "auth_audit__managed__pattern_map_reduce__map_items__item_m3"
    ]);
    const firstItemAttempt = attempts.find((attempt) => attempt.authored_id === "auth_audit__managed__pattern_map_reduce__map_items__item_m1");
    const itemPrompt = await readFile(firstItemAttempt!.prompt_path!, "utf8");
    expect(itemPrompt).toContain("Write only the current item result.");
    expect(itemPrompt).toContain("Do not make whole-list coverage claims.");
    expect(itemPrompt).not.toContain("aggregate counts");
    expect(itemPrompt).not.toContain("final summary");
    const publishAttempt = attempts.find((attempt) => attempt.authored_id === "auth_audit");
    expect(publishAttempt?.artifacts.aggregate).toBeDefined();
    const aggregate = JSON.parse(await readFile(publishAttempt!.artifacts.aggregate, "utf8")) as {
      item_count: number;
      counts: Record<string, number>;
      coverage: { omissions: string[]; uncertainty: string[] };
      findings: unknown[];
      skipped: unknown[];
    };
    expect(aggregate.item_count).toBe(3);
    expect(aggregate.counts).toEqual({ passed: 1, finding: 1, skipped: 1, blocked: 0 });
    expect(aggregate.coverage.omissions).toEqual(["Generated route fixtures were omitted."]);
    expect(aggregate.coverage.uncertainty).toEqual(["Dynamic route registration may require a follow-up sweep."]);
    expect(aggregate.findings).toHaveLength(1);
    expect(aggregate.skipped).toHaveLength(1);
    expect(run.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "managed.progress",
        payload: expect.objectContaining({
          managed_kind: "pattern_map_reduce",
          managed_authored_id: "auth_audit",
          phase: "map_item",
          status: "item_started",
          item_id: "m1"
        })
      }),
      expect.objectContaining({
        type: "managed.progress",
        payload: expect.objectContaining({
          managed_kind: "pattern_map_reduce",
          managed_authored_id: "auth_audit",
          phase: "map_item",
          status: "item_completed",
          item_id: "m2"
        })
      })
    ]));

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("passes materialized parent context to each map item without duplicate frozen item refs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-map-reduce-context-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const state = { activeItems: 0, maxActiveItems: 0, itemOrder: [] as string[] };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: compileGraph(buildMapReduceGraph({
        beforeSteps: [
          {
            type: "exec",
            id: "prepare_context",
            command: "node",
            args: [
              "-e",
              "const fs=require('node:fs');const path=require('node:path');fs.mkdirSync(process.env.AGENTFLOW_OUTPUT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'audit-seed.json'),JSON.stringify({scope:'routes'},null,2)+'\\n');"
            ],
            artifacts: {
              audit_seed: {
                from: "output_dir",
                path: "audit-seed.json",
                description: "Prepared audit seed."
              }
            },
            intent: {
              goal: "Prepare audit seed context.",
              acceptance_criteria: ["The audit seed artifact is written."],
              constraints: []
            }
          }
        ],
        patternSupportContext: [
          {
            kind: "artifact",
            ref: "prepare_context.audit_seed",
            name: "audit_seed",
            what: "Prepared audit seed artifact.",
            why: "Map workers need the prepared audit scope."
          },
          {
            kind: "workspace_glob",
            name: "route_sources",
            path: "*.ts",
            max_files: 5,
            what: "Route source files.",
            why: "Map workers use this as a selective source index."
          }
        ]
      })),
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildHarness(state)
      }
    });

    expect(run.outcome).toBe("passed");
    const attempts = await readRunExecutionAttempts(runRoot);
    const firstItemAttempt = attempts.find((attempt) => attempt.authored_id === "auth_audit__managed__pattern_map_reduce__map_items__item_m1");
    const packet = JSON.parse(await readFile(firstItemAttempt!.context_packet_path!, "utf8")) as {
      materials: Array<{ key: string; pointer_path: string }>;
    };
    expect(packet.materials.filter((item) => item.key === "frozen_items")).toHaveLength(1);
    expect(packet.materials.find((item) => item.key === "audit_seed")?.pointer_path).toMatch(/audit-seed\.json$/u);
    expect(packet.materials.find((item) => item.key === "audit_seed")?.pointer_path).not.toBe("prepare_context.audit_seed");
    expect(packet.materials.find((item) => item.key === "route_sources")?.pointer_path).toMatch(/context[/\\]runtime[/\\]globs/u);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects non-finding map item results that include findings", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-map-reduce-findings-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const state = { activeItems: 0, maxActiveItems: 0, itemOrder: [] as string[] };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: compileGraph(buildMapReduceGraph()),
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildHarness(state, { findingsOnPassedItem: true })
      }
    });

    expect(run.outcome).toBe("failed");
    expect(run.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "managed.progress",
        payload: expect.objectContaining({
          managed_kind: "pattern_map_reduce",
          managed_authored_id: "auth_audit",
          phase: "map_item",
          status: "item_failed",
          item_id: "m1"
        })
      })
    ]));

    await rm(tempRoot, { recursive: true, force: true });
  });
});
