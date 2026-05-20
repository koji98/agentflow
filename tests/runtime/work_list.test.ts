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

function plannedWorkListJson(): string {
  return `${JSON.stringify({
    planning_summary: "One runtime-test item is enough to exercise the managed pattern contract.",
    ordering_rationale: "The single item can run immediately after the list is frozen.",
    items: [
      {
        id: "w1",
        title: "Produce evidence",
        goal: "Produce the evidence handoff for the bounded item.",
        acceptance_criteria: ["The item has a completed handoff."],
        constraints: [],
        validation_expectations: ["The runtime finalizer verifies the item result."],
        handoff_focus: ["Downstream nodes need the verified item index."],
        rationale: "This item validates item execution, validation capture, and final ledger aggregation."
      }
    ]
  }, null, 2)}\n`;
}

function plannedTwoItemWorkListJson(): string {
  return `${JSON.stringify({
    planning_summary: "Two ordered runtime-test items exercise sequential item execution and prior handoff context.",
    ordering_rationale: "The second item intentionally depends on the first item's accepted handoff evidence.",
    items: [
      {
        id: "w1",
        title: "Produce first evidence",
        goal: "Produce the first evidence handoff for the bounded item.",
        acceptance_criteria: ["The first item has a completed handoff."],
        constraints: [],
        validation_expectations: ["The runtime finalizer verifies the first item result."],
        handoff_focus: ["Later items need the first accepted handoff."],
        rationale: "The first item creates prior evidence for the following item."
      },
      {
        id: "w2",
        title: "Use prior evidence",
        goal: "Consume the prior item handoff and produce the second evidence handoff.",
        acceptance_criteria: ["The second item uses prior handoff context."],
        constraints: [],
        validation_expectations: ["The runtime finalizer verifies the second item result."],
        handoff_focus: ["Downstream nodes need both verified items."],
        rationale: "The second item proves later workers receive prior completed handoffs."
      }
    ]
  }, null, 2)}\n`;
}

function isWorkListItemInvocation(invocation: AgentInvocation): boolean {
  return Boolean(invocation.artifacts && Object.prototype.hasOwnProperty.call(invocation.artifacts, "item_result"));
}

async function initGitRepo(repoDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "seed\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
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

function buildHarness(): HarnessAdapter {
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
              JSON.stringify({ passed: true, summary: "Work-list runtime test verifier accepted the artifacts.", findings: [] }),
              "```"
            ].join("\n")
          }
        };
      }

      if (invocation.nodeGoal?.includes("work_list_json")) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "item-handoff.md"), "# Item Handoff\n\nCompleted with evidence.\n", "utf8");
        await writeFile(join(invocation.outputDir, "item-result.json"), `${JSON.stringify({
          id: "w1",
          status: "completed",
          summary: "Produced the evidence handoff.",
          validation: [{ summary: "Runtime finalizer can verify this result.", result: "pass" }],
          risks: [],
          downstream_implications: ["Downstream nodes can consume work_items."]
        }, null, 2)}\n`, "utf8");
        await writeFile(join(invocation.outputDir, "item-validation.md"), "Validation: runtime finalizer verifies item-result.json.\n", "utf8");
      } else if (invocation.nodeGoal?.includes("final public artifacts")) {
        await writeFile(join(invocation.outputDir, "summary.md"), "Completed one frozen work-list item.\n", "utf8");
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

function buildDeepWorkHarness(state: { runItemsCalls: number }): HarnessAdapter {
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
              JSON.stringify({ passed: true, summary: "Work-list deep-work verifier accepted the artifacts.", findings: [] }),
              "```"
            ].join("\n")
          }
        };
      }

      if (invocation.nodeGoal?.includes("work_list_json")) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemInvocation(invocation)) {
        state.runItemsCalls += 1;
        const completed = state.runItemsCalls > 1;
        await writeFile(
          join(invocation.outputDir, "item-handoff.md"),
          completed
            ? "# Item Handoff\n\nCompleted with evidence after retry.\n"
            : "# Item Handoff\n\nBlocked pending retry evidence.\n",
          "utf8"
        );
        await writeFile(join(invocation.outputDir, "item-result.json"), `${JSON.stringify({
          id: "w1",
          status: completed ? "completed" : "blocked",
          summary: completed ? "Produced the evidence handoff." : "First cycle intentionally lacks completion evidence.",
          validation: [{ summary: completed ? "Runtime gate can verify this result." : "Runtime gate should reject this cycle.", result: completed ? "pass" : "blocked" }],
          risks: [],
          downstream_implications: ["Downstream nodes can consume work_items after completion."]
        }, null, 2)}\n`, "utf8");
        await writeFile(join(invocation.outputDir, "item-validation.md"), "Validation: runtime gate checks item-result.json.\n", "utf8");
      } else if (invocation.nodeGoal?.includes("final public artifacts")) {
        await writeFile(join(invocation.outputDir, "summary.md"), "Completed one frozen work-list item after retry.\n", "utf8");
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

function buildTwoItemHarness(state: { itemOrder: string[]; secondSawPriorHandoff: boolean }): HarnessAdapter {
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
              JSON.stringify({ passed: true, summary: "Two-item work-list verifier accepted the artifacts.", findings: [] }),
              "```"
            ].join("\n")
          }
        };
      }

      if (invocation.nodeGoal?.includes("work_list_json")) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedTwoItemWorkListJson(), "utf8");
      } else if (isWorkListItemInvocation(invocation)) {
        const itemId = invocation.nodeGoal?.includes("`w2`") ? "w2" : "w1";
        state.itemOrder.push(itemId);
        if (itemId === "w2" && invocation.contextManifest?.includes("prior_completed_item_handoffs")) {
          state.secondSawPriorHandoff = true;
        }
        await writeFile(join(invocation.outputDir, "item-handoff.md"), `# Item Handoff\n\n${itemId} completed with evidence.\n`, "utf8");
        await writeFile(join(invocation.outputDir, "item-result.json"), `${JSON.stringify({
          id: itemId,
          status: "completed",
          summary: `${itemId} produced the evidence handoff.`,
          validation: [{ summary: "Runtime finalizer can verify this result.", result: "pass" }],
          risks: [],
          downstream_implications: ["Downstream nodes can consume work_items."]
        }, null, 2)}\n`, "utf8");
        await writeFile(join(invocation.outputDir, "item-validation.md"), `Validation: ${itemId} item result is present.\n`, "utf8");
      } else if (invocation.nodeGoal?.includes("final public artifacts")) {
        await writeFile(join(invocation.outputDir, "summary.md"), "Completed two frozen work-list items.\n", "utf8");
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

function buildTwoItemParentRetryHarness(state: { itemOrder: string[]; w2Attempts: number }): HarnessAdapter {
  const deliveryHarness = createPassingDeliveryHarness("codex-cli");
  return {
    kind: "codex-cli",
    capabilities: getHarnessCapabilities("codex-cli")!,
    async run(invocation: AgentInvocation) {
      if (invocation.promptKind === "delivery_curator") {
        return deliveryHarness.run(invocation);
      }

      if (invocation.promptKind === "supervisor_evidence") {
        return {
          status: "passed",
          exitCode: 0,
          outputJson: {
            claims: ["The failed work-list item can be retried while preserving prior completed items."],
            retry_guidance: ["Retry only the failed current item and keep earlier accepted item evidence."],
            conflicts: [],
            confidence: "high"
          }
        };
      }

      if (invocation.promptKind === "outcome_verification") {
        return {
          status: "passed",
          exitCode: 0,
          transcript: {
            last_message: [
              "```json",
              JSON.stringify({ passed: true, summary: "Two-item retry verifier accepted the artifacts.", findings: [] }),
              "```"
            ].join("\n")
          }
        };
      }

      if (invocation.nodeGoal?.includes("work_list_json")) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedTwoItemWorkListJson(), "utf8");
      } else if (isWorkListItemInvocation(invocation)) {
        const itemId = invocation.nodeGoal?.includes("`w2`") ? "w2" : "w1";
        state.itemOrder.push(itemId);
        if (itemId === "w2") {
          state.w2Attempts += 1;
        }
        const shouldComplete = itemId !== "w2" || state.w2Attempts > 1;
        await writeFile(join(invocation.outputDir, "item-handoff.md"), `# Item Handoff\n\n${itemId} ${shouldComplete ? "completed" : "blocked"} with evidence.\n`, "utf8");
        await writeFile(join(invocation.outputDir, "item-result.json"), `${JSON.stringify({
          id: itemId,
          status: shouldComplete ? "completed" : "blocked",
          summary: shouldComplete
            ? `${itemId} produced the evidence handoff.`
            : `${itemId} intentionally failed before retry.`,
          validation: [{ summary: shouldComplete ? "Runtime finalizer can verify this result." : "Runtime should reject this result.", result: shouldComplete ? "pass" : "blocked" }],
          risks: [],
          downstream_implications: ["Downstream nodes can consume work_items."]
        }, null, 2)}\n`, "utf8");
        await writeFile(join(invocation.outputDir, "item-validation.md"), `Validation: ${itemId} item result is ${shouldComplete ? "complete" : "blocked"}.\n`, "utf8");
      } else if (invocation.nodeGoal?.includes("final public artifacts")) {
        await writeFile(join(invocation.outputDir, "summary.md"), "Completed two frozen work-list items after preserving prior progress.\n", "utf8");
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

function buildDeepWorkOutcomeRetryHarness(state: { runItemsCalls: number; rejectedRunItems?: boolean }): HarnessAdapter {
  const deliveryHarness = createPassingDeliveryHarness("codex-cli");
  return {
    kind: "codex-cli",
    capabilities: getHarnessCapabilities("codex-cli")!,
    async run(invocation: AgentInvocation) {
      if (invocation.promptKind === "delivery_curator") {
        return deliveryHarness.run(invocation);
      }

      if (invocation.promptKind === "outcome_verification") {
        const shouldRejectRunItems = state.runItemsCalls === 1 && state.rejectedRunItems !== true;
        if (shouldRejectRunItems) {
          state.rejectedRunItems = true;
        }
        return {
          status: "passed",
          exitCode: 0,
          transcript: {
            last_message: [
              "```json",
              JSON.stringify(shouldRejectRunItems
                ? {
                    passed: false,
                    summary: "The item evidence omits a required semantic result.",
                    findings: [
                      {
                        severity: "blocker",
                        category: "incorrect_output",
                        evidence: "w1 is marked complete but lacks the required evidence.",
                        recommendation: "Retry the current work-list item and repair only the failed item evidence."
                      }
                    ]
                  }
                : {
                    passed: true,
                    summary: "Verifier accepted the repaired item evidence.",
                    findings: []
                  }),
              "```"
            ].join("\n")
          }
        };
      }

      if (invocation.nodeGoal?.includes("work_list_json")) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemInvocation(invocation)) {
        state.runItemsCalls += 1;
        await writeFile(
          join(invocation.outputDir, "item-handoff.md"),
          `# Item Handoff\n\nCompleted with ${state.runItemsCalls > 1 ? "repaired" : "initial"} semantic evidence.\n`,
          "utf8"
        );
        await writeFile(join(invocation.outputDir, "item-result.json"), `${JSON.stringify({
          id: "w1",
          status: "completed",
          summary: state.runItemsCalls > 1
            ? "Produced the repaired evidence handoff."
            : "Produced an initial handoff that verifier will reject.",
          validation: [{ summary: "Outcome verifier checks semantic evidence.", result: "pass" }],
          risks: [],
          downstream_implications: ["Downstream nodes can consume work_items after verification."]
        }, null, 2)}\n`, "utf8");
        await writeFile(join(invocation.outputDir, "item-validation.md"), "Validation: outcome verifier checks semantic evidence.\n", "utf8");
      } else if (invocation.nodeGoal?.includes("final public artifacts")) {
        await writeFile(join(invocation.outputDir, "summary.md"), "Completed one frozen work-list item after verifier retry.\n", "utf8");
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

describe("runtime pattern_work_list", () => {
  it("freezes planner output, verifies item results, and publishes stable work_items", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-work-list-runtime-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-work-list",
      intent: {
        goal: "Exercise work-list runtime behavior.",
        acceptance_criteria: ["The work-list pattern publishes verified work items."]
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
          {
            type: "pattern_work_list",
            id: "deliver",
            runtime: { repo: "main", profile: "default" },
            intent: {
              goal: "Deliver a bounded runtime-test work list.",
              acceptance_criteria: ["The work_items artifact lists completed items."],
              constraints: []
            },
            work_list: {
              planning_goal: "Discover the ordered runtime-test items.",
              item_guidance: {
                what_counts_as_one_item: "One coherent runtime-test unit.",
                done_when: ["The item has evidence and validation."]
              },
              item_worker: { kind: "agent" }
            }
          }
        ]
      }
    });

    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildHarness()
      }
    });

    expect(run.outcome).toBe("passed");
    const attempts = await readRunExecutionAttempts(runRoot);
    const publishAttempt = attempts.find((attempt) => attempt.authored_id === "deliver");
    expect(publishAttempt?.artifacts.work_items).toBeDefined();
    const workItems = JSON.parse(await readFile(publishAttempt!.artifacts.work_items, "utf8")) as {
      status: string;
      item_count: number;
      items: Array<{ id: string; status: string }>;
    };
    expect(workItems).toEqual(expect.objectContaining({
      status: "completed",
      item_count: 1
    }));
    expect(workItems.items).toEqual([
      expect.objectContaining({ id: "w1", status: "completed" })
    ]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("runs one managed agent execution per item and passes prior handoffs forward", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-work-list-sequential-runtime-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-work-list-sequential",
      intent: {
        goal: "Exercise sequential work-list item behavior.",
        acceptance_criteria: ["The work-list pattern passes prior item handoffs to later items."]
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
          {
            type: "pattern_work_list",
            id: "deliver",
            runtime: { repo: "main", profile: "default" },
            intent: {
              goal: "Deliver a two-item runtime-test work list.",
              acceptance_criteria: ["The work_items artifact lists both completed items."],
              constraints: []
            },
            work_list: {
              planning_goal: "Discover the ordered runtime-test items.",
              item_guidance: {
                what_counts_as_one_item: "One coherent runtime-test unit.",
                done_when: ["The item has evidence and validation."]
              },
              item_worker: { kind: "agent" }
            }
          }
        ]
      }
    });

    const state = { itemOrder: [] as string[], secondSawPriorHandoff: false };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildTwoItemHarness(state)
      }
    });

    expect(run.outcome).toBe("passed");
    expect(state.itemOrder).toEqual(["w1", "w2"]);
    expect(state.secondSawPriorHandoff).toBe(true);
    const attempts = await readRunExecutionAttempts(runRoot);
    const itemAttempts = attempts
      .filter((attempt) => attempt.authored_id.startsWith("deliver__managed__pattern_work_list__run_items__item_"))
      .map((attempt) => attempt.authored_id);
    expect(itemAttempts).toEqual([
      "deliver__managed__pattern_work_list__run_items__item_w1",
      "deliver__managed__pattern_work_list__run_items__item_w2"
    ]);
    const firstItemAttempt = attempts.find((attempt) => attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1");
    const firstItemPrompt = await readFile(firstItemAttempt!.prompt_path!, "utf8");
    expect(firstItemPrompt).toContain("Parent work-list goal: Deliver a two-item runtime-test work list.");
    expect(firstItemPrompt).not.toContain("You are the runtime coordinator for a managed work-list pattern.");
    const publishAttempt = attempts.find((attempt) => attempt.authored_id === "deliver");
    const workItems = JSON.parse(await readFile(publishAttempt!.artifacts.work_items, "utf8")) as {
      item_count: number;
      items: Array<{ id: string; status: string }>;
    };
    expect(workItems.item_count).toBe(2);
    expect(workItems.items.map((item) => item.id)).toEqual(["w1", "w2"]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("preserves prior completed items when the parent work-list item phase is retried", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-work-list-parent-retry-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-work-list-parent-retry",
      intent: {
        goal: "Exercise parent work-list retry locality.",
        acceptance_criteria: ["The work-list pattern preserves accepted prior items across a parent retry."]
      },
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: {
        default: { harness: "codex-cli", sandbox: "workspace-write" },
        supervisor: { harness: "codex-cli", sandbox: "read-only" }
      },
      supervision: { profile: "supervisor", max_total_interventions: 1 },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "pattern_work_list",
            id: "deliver",
            runtime: { repo: "main", profile: "default" },
            intent: {
              goal: "Deliver a two-item runtime-test work list with parent retry.",
              acceptance_criteria: ["The work_items artifact lists both completed items."],
              constraints: []
            },
            work_list: {
              planning_goal: "Discover the ordered runtime-test items.",
              item_guidance: {
                what_counts_as_one_item: "One coherent runtime-test unit.",
                done_when: ["The item has evidence and validation."]
              },
              item_worker: { kind: "agent" }
            }
          }
        ]
      }
    });

    const state = { itemOrder: [] as string[], w2Attempts: 0 };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildTwoItemParentRetryHarness(state)
      }
    });

    expect(run.outcome).toBe("passed");
    expect(state.itemOrder).toEqual(["w1", "w2", "w2"]);
    const attempts = await readRunExecutionAttempts(runRoot);
    const runItemAttempts = attempts.filter((attempt) => attempt.authored_id === "deliver__managed__pattern_work_list__run_items");
    expect(runItemAttempts.map((attempt) => attempt.outcome)).toEqual(["failed", "passed"]);
    const w1Attempts = attempts.filter((attempt) => attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1");
    const w2Attempts = attempts.filter((attempt) => attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w2");
    expect(w1Attempts).toHaveLength(1);
    expect(w2Attempts).toHaveLength(2);

    const publishAttempt = attempts.find((attempt) => attempt.authored_id === "deliver");
    const workItems = JSON.parse(await readFile(publishAttempt!.artifacts.work_items!, "utf8")) as {
      item_count: number;
      items: Array<{ id: string; status: string }>;
    };
    expect(workItems.item_count).toBe(2);
    expect(workItems.items.map((item) => [item.id, item.status])).toEqual([
      ["w1", "completed"],
      ["w2", "completed"]
    ]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("retries deep_work item execution until the item gate passes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-work-list-deep-runtime-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-work-list-deep",
      intent: {
        goal: "Exercise work-list deep-work retry behavior.",
        acceptance_criteria: ["The work-list pattern retries failed item completion evidence."]
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
          {
            type: "pattern_work_list",
            id: "deliver",
            runtime: { repo: "main", profile: "default" },
            intent: {
              goal: "Deliver a bounded runtime-test work list with retry.",
              acceptance_criteria: ["The work_items artifact lists completed items."],
              constraints: []
            },
            work_list: {
              planning_goal: "Discover the ordered runtime-test items.",
              item_guidance: {
                what_counts_as_one_item: "One coherent runtime-test unit.",
                done_when: ["The item has evidence and validation."]
              },
              item_worker: {
                kind: "deep_work",
                completion: {
                  max_cycles: 2,
                  pass_threshold: 1,
                  criteria: [
                    {
                      id: "command_ok",
                      kind: "command",
                      command: "true",
                      weight: 1,
                      required: true
                    }
                  ]
                }
              }
            }
          }
        ]
      }
    });

    const state = { runItemsCalls: 0 };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildDeepWorkHarness(state)
      }
    });

    expect(run.outcome).toBe("passed");
    expect(state.runItemsCalls).toBe(2);
    const attempts = await readRunExecutionAttempts(runRoot);
    const itemAttempts = attempts.filter((attempt) => attempt.authored_id === "deliver__managed__pattern_work_list__run_items");
    expect(itemAttempts).toHaveLength(1);
    const publishAttempt = attempts.find((attempt) => attempt.authored_id === "deliver");
    expect(publishAttempt?.artifacts.work_items).toBeDefined();
    const workItems = JSON.parse(await readFile(publishAttempt!.artifacts.work_items, "utf8")) as {
      status: string;
      item_count: number;
      items: Array<{ id: string; status: string; summary: string }>;
    };
    expect(workItems.status).toBe("completed");
    expect(workItems.items).toEqual([
      expect.objectContaining({ id: "w1", status: "completed", summary: "Produced the evidence handoff." })
    ]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("retries the current item when item outcome verification rejects it", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-work-list-verifier-retry-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-work-list-verifier-retry",
      intent: {
        goal: "Exercise work-list verifier retry behavior.",
        acceptance_criteria: ["The work-list pattern retries semantic item failures before blocking downstream nodes."]
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
          {
            type: "pattern_work_list",
            id: "deliver",
            runtime: { repo: "main", profile: "default" },
            intent: {
              goal: "Deliver a bounded runtime-test work list with verifier retry.",
              acceptance_criteria: ["The work_items artifact lists verified completed items."],
              constraints: []
            },
            work_list: {
              planning_goal: "Discover the ordered runtime-test items.",
              item_guidance: {
                what_counts_as_one_item: "One coherent runtime-test unit.",
                done_when: ["The item has semantic evidence and validation."]
              },
              item_worker: {
                kind: "deep_work",
                completion: {
                  max_cycles: 2,
                  pass_threshold: 1,
                  criteria: [
                    {
                      id: "command_ok",
                      kind: "command",
                      command: "true",
                      weight: 1,
                      required: true
                    }
                  ]
                }
              }
            }
          }
        ]
      }
    });

    const state = { runItemsCalls: 0 };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildDeepWorkOutcomeRetryHarness(state)
      }
    });

    expect(run.outcome).toBe("passed");
    expect(state.runItemsCalls).toBe(2);
    const attempts = await readRunExecutionAttempts(runRoot);
    const managedItemAttempts = attempts.filter((attempt) => attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1");
    expect(managedItemAttempts.map((attempt) => attempt.outcome)).toEqual(["passed", "passed"]);
    const runItemAttempts = attempts.filter((attempt) => attempt.authored_id === "deliver__managed__pattern_work_list__run_items");
    expect(runItemAttempts.map((attempt) => attempt.outcome)).toEqual(["passed"]);

    await rm(tempRoot, { recursive: true, force: true });
  });
});
