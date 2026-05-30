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
import { readRunEvents, readRunExecutionAttempts } from "../../src/artifacts/reader.js";
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

function isWorkListItemPlanInvocation(invocation: AgentInvocation): boolean {
  return invocation.nodeGoal?.includes("Plan frozen work-list item") === true;
}

function isWorkListItemExecuteInvocation(invocation: AgentInvocation): boolean {
  return invocation.nodeGoal?.includes("Execute frozen work-list item") === true;
}

async function writeItemCyclePlan(invocation: AgentInvocation): Promise<void> {
  await writeFile(join(invocation.outputDir, "item-cycle-plan.md"), "# Item Cycle Plan\n\nPlan the current item.\n", "utf8");
}

async function writeDraftItemArtifacts(invocation: AgentInvocation, options: {
  itemId?: string;
  completed?: boolean;
  summary?: string;
  validationMessage?: string;
} = {}): Promise<void> {
  const itemId = options.itemId ?? (invocation.nodeGoal?.includes("`w2`") ? "w2" : "w1");
  const completed = options.completed ?? true;
  await writeFile(
    join(invocation.outputDir, "item-work-notes.md"),
    completed ? "# Item Work Notes\n\nExecuted with evidence.\n" : "# Item Work Notes\n\nBlocked pending retry evidence.\n",
    "utf8"
  );
  await writeFile(
    join(invocation.outputDir, "draft-item-handoff.md"),
    completed ? "# Draft Item Handoff\n\nCompleted with evidence.\n" : "# Draft Item Handoff\n\nBlocked pending retry evidence.\n",
    "utf8"
  );
  await writeFile(join(invocation.outputDir, "draft-item-result.json"), `${JSON.stringify({
    id: itemId,
    status: completed ? "completed" : "blocked",
    summary: options.summary ?? (completed ? "Produced the evidence handoff." : "This cycle intentionally lacks completion evidence."),
    validation: itemValidationEvidence(
      options.validationMessage ?? (completed ? "Runtime gate can verify this result." : "Runtime gate should reject this cycle."),
      { blocked: !completed }
    ),
    risks: [],
    downstream_implications: ["Downstream nodes can consume work_items after completion."]
  }, null, 2)}\n`, "utf8");
  await writeFile(join(invocation.outputDir, "draft-item-validation.md"), "Validation: runtime gate checks draft item evidence.\n", "utf8");
}

async function writeFinalItemArtifacts(invocation: AgentInvocation, options: {
  itemId?: string;
  summary?: string;
  validationMessage?: string;
} = {}): Promise<void> {
  const itemId = options.itemId ?? (invocation.nodeGoal?.includes("`w2`") ? "w2" : "w1");
  await writeFile(join(invocation.outputDir, "item-handoff.md"), "# Item Handoff\n\nCompleted with evidence.\n", "utf8");
  await writeFile(join(invocation.outputDir, "item-result.json"), `${JSON.stringify({
    id: itemId,
    status: "completed",
    summary: options.summary ?? "Produced the evidence handoff.",
    validation: itemValidationEvidence(options.validationMessage ?? "Runtime finalizer can verify this result."),
    risks: [],
    downstream_implications: ["Downstream nodes can consume work_items."]
  }, null, 2)}\n`, "utf8");
  await writeFile(join(invocation.outputDir, "item-validation.md"), "Validation: runtime finalizer verifies item-result.json.\n", "utf8");
}

function itemValidationEvidence(
  message: string,
  options: { blocked?: boolean } = {}
): { passed: string[]; failed_then_fixed: string[]; unavailable: string[]; blocked: string[] } {
  return options.blocked
    ? { passed: [], failed_then_fixed: [], unavailable: [], blocked: [message] }
    : { passed: [message], failed_then_fixed: [], unavailable: [], blocked: [] };
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
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemCyclePlan(invocation);
      } else if (isWorkListItemExecuteInvocation(invocation)) {
        await writeDraftItemArtifacts(invocation);
      } else if (isWorkListItemInvocation(invocation)) {
        await writeFinalItemArtifacts(invocation);
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
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemCyclePlan(invocation);
      } else if (isWorkListItemExecuteInvocation(invocation)) {
        state.runItemsCalls += 1;
        const completed = state.runItemsCalls > 1;
        await writeDraftItemArtifacts(invocation, {
          completed,
          summary: completed ? "Produced the evidence handoff." : "First cycle intentionally lacks completion evidence.",
          validationMessage: completed ? "Runtime gate can verify this result." : "Runtime gate should reject this cycle."
        });
      } else if (isWorkListItemInvocation(invocation)) {
        await writeFinalItemArtifacts(invocation, {
          summary: "Produced the evidence handoff.",
          validationMessage: "Runtime finalizer can verify this result."
        });
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

function buildParallelCriteriaHarness(state: { activeChecks: number; maxActiveChecks: number }): HarnessAdapter {
  const deliveryHarness = createPassingDeliveryHarness("codex-cli");
  return {
    kind: "codex-cli",
    capabilities: getHarnessCapabilities("codex-cli")!,
    async run(invocation: AgentInvocation) {
      if (invocation.promptKind === "delivery_curator") {
        return deliveryHarness.run(invocation);
      }

      if (invocation.promptKind === "ai_check") {
        state.activeChecks += 1;
        state.maxActiveChecks = Math.max(state.maxActiveChecks, state.activeChecks);
        await new Promise((resolve) => setTimeout(resolve, 50));
        state.activeChecks -= 1;
        return {
          status: "passed",
          exitCode: 0,
          transcript: {
            last_message: [
              "```json",
              JSON.stringify({ passed: true, score: 1, summary: "Criterion passed.", issues: [] }),
              "```"
            ].join("\n")
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
              JSON.stringify({ passed: true, summary: "Work-list verifier accepted the artifacts.", findings: [] }),
              "```"
            ].join("\n")
          }
        };
      }

      if (invocation.nodeGoal?.includes("work_list_json")) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemCyclePlan(invocation);
      } else if (isWorkListItemExecuteInvocation(invocation)) {
        await writeDraftItemArtifacts(invocation, {
          validationMessage: "Runtime finalizer can verify this result."
        });
      } else if (isWorkListItemInvocation(invocation)) {
        await writeFinalItemArtifacts(invocation, {
          summary: "Produced the evidence handoff.",
          validationMessage: "Runtime finalizer can verify this result."
        });
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

function buildLowRequiredCriterionHarness(state: { itemRuns: number }): HarnessAdapter {
  const deliveryHarness = createPassingDeliveryHarness("codex-cli");
  return {
    kind: "codex-cli",
    capabilities: getHarnessCapabilities("codex-cli")!,
    async run(invocation: AgentInvocation) {
      if (invocation.promptKind === "delivery_curator") {
        return deliveryHarness.run(invocation);
      }

      if (invocation.promptKind === "ai_check") {
        const isDesignCriterion = invocation.rubric?.includes("design system") === true;
        const score = isDesignCriterion && state.itemRuns === 1 ? 0.86 : 0.94;
        return {
          status: "passed",
          exitCode: 0,
          transcript: {
            last_message: [
              "```json",
              JSON.stringify({
                passed: true,
                score,
                summary: isDesignCriterion
                  ? "Design system fit is plausible but below the item threshold."
                  : "Criterion passed.",
                issues: []
              }),
              "```"
            ].join("\n")
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
              JSON.stringify({ passed: true, summary: "Work-list verifier accepted the artifacts.", findings: [] }),
              "```"
            ].join("\n")
          }
        };
      }

      if (invocation.nodeGoal?.includes("work_list_json")) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemCyclePlan(invocation);
      } else if (isWorkListItemExecuteInvocation(invocation)) {
        state.itemRuns += 1;
        await writeDraftItemArtifacts(invocation, {
          summary: `Produced the evidence handoff on run ${state.itemRuns}.`
        });
      } else if (isWorkListItemInvocation(invocation)) {
        await writeFinalItemArtifacts(invocation, {
          summary: `Produced the evidence handoff on run ${state.itemRuns}.`
        });
      } else if (invocation.nodeGoal?.includes("final public artifacts")) {
        await writeFile(join(invocation.outputDir, "summary.md"), "Completed one frozen work-list item after criterion retry.\n", "utf8");
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

function buildPhasedDeepWorkHarness(state: {
  agentPhases: string[];
  aiCheckModels: Array<string | undefined>;
  planModel?: string;
  executeReasoning?: string;
  publishSandbox?: string;
}): HarnessAdapter {
  const deliveryHarness = createPassingDeliveryHarness("codex-cli");
  return {
    kind: "codex-cli",
    capabilities: getHarnessCapabilities("codex-cli")!,
    async run(invocation: AgentInvocation) {
      if (invocation.promptKind === "delivery_curator") {
        return deliveryHarness.run(invocation);
      }

      if (invocation.promptKind === "ai_check") {
        state.aiCheckModels.push(invocation.model);
        expect(invocation.nodeGoal).toContain("VERIFY_PHASE_MARKER");
        return {
          status: "passed",
          exitCode: 0,
          transcript: {
            last_message: [
              "```json",
              JSON.stringify({ passed: true, score: 1, summary: "Verify phase accepted item evidence.", issues: [] }),
              "```"
            ].join("\n")
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
              JSON.stringify({ passed: true, summary: "Phased item verifier accepted final artifacts.", findings: [] }),
              "```"
            ].join("\n")
          }
        };
      }

      if (invocation.nodeGoal?.includes("work_list_json")) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (invocation.nodeGoal?.includes("Plan frozen work-list item")) {
        state.agentPhases.push("plan");
        state.planModel = invocation.model;
        expect(invocation.nodeGoal).toContain("PLAN_PHASE_MARKER");
        expect(invocation.nodeGoal).not.toContain("EXECUTE_PHASE_MARKER");
        await writeFile(join(invocation.outputDir, "item-cycle-plan.md"), "# Item Cycle Plan\n\nPlan evidence.\n", "utf8");
      } else if (invocation.nodeGoal?.includes("Execute frozen work-list item")) {
        state.agentPhases.push("execute");
        state.executeReasoning = invocation.reasoningEffort;
        expect(invocation.nodeGoal).toContain("EXECUTE_PHASE_MARKER");
        expect(invocation.nodeGoal).not.toContain("PUBLISH_PHASE_MARKER");
        await writeFile(join(invocation.outputDir, "item-work-notes.md"), "# Item Work Notes\n\nExecuted the planned item delta.\n", "utf8");
        await writeFile(join(invocation.outputDir, "draft-item-handoff.md"), "# Draft Item Handoff\n\nDraft evidence.\n", "utf8");
        await writeFile(join(invocation.outputDir, "draft-item-result.json"), `${JSON.stringify({
          id: "w1",
          status: "completed",
          summary: "Draft item result.",
          validation: itemValidationEvidence("Draft validation evidence."),
          risks: [],
          downstream_implications: ["Publish can finalize the accepted evidence."]
        }, null, 2)}\n`, "utf8");
        await writeFile(join(invocation.outputDir, "draft-item-validation.md"), "Draft validation evidence.\n", "utf8");
      } else if (isWorkListItemInvocation(invocation)) {
        state.agentPhases.push("publish");
        state.publishSandbox = invocation.sandbox;
        expect(invocation.nodeGoal).toContain("PUBLISH_PHASE_MARKER");
        expect(invocation.nodeGoal).not.toContain("PLAN_PHASE_MARKER");
        await writeFile(join(invocation.outputDir, "item-handoff.md"), "# Item Handoff\n\nFinal accepted evidence.\n", "utf8");
        await writeFile(join(invocation.outputDir, "item-result.json"), `${JSON.stringify({
          id: "w1",
          status: "completed",
          summary: "Published final item evidence.",
          validation: itemValidationEvidence("Published final validation evidence."),
          risks: [],
          downstream_implications: ["Downstream nodes can consume work_items."]
        }, null, 2)}\n`, "utf8");
        await writeFile(join(invocation.outputDir, "item-validation.md"), "Published validation evidence.\n", "utf8");
      } else if (invocation.nodeGoal?.includes("final public artifacts")) {
        await writeFile(join(invocation.outputDir, "summary.md"), "Completed one phased deep-work item.\n", "utf8");
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
          validation: itemValidationEvidence("Runtime finalizer can verify this result."),
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
          validation: itemValidationEvidence(
            shouldComplete ? "Runtime finalizer can verify this result." : "Runtime should reject this result.",
            { blocked: !shouldComplete }
          ),
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
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemCyclePlan(invocation);
      } else if (isWorkListItemExecuteInvocation(invocation)) {
        state.runItemsCalls += 1;
        await writeDraftItemArtifacts(invocation, {
          summary: state.runItemsCalls > 1
            ? "Produced the repaired evidence handoff."
            : "Produced an initial handoff that verifier will reject.",
          validationMessage: "Outcome verifier checks semantic evidence."
        });
      } else if (isWorkListItemInvocation(invocation)) {
        await writeFinalItemArtifacts(invocation, {
          summary: state.runItemsCalls > 1
            ? "Produced the repaired evidence handoff."
            : "Produced an initial handoff that verifier will reject.",
          validationMessage: "Outcome verifier checks semantic evidence."
        });
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
    await writeFile(join(repoDir, "phase-support.md"), "Execute-only support context.\n", "utf8");

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
    const itemProgress = run.events.filter((event) =>
      event.type === "managed.progress" &&
      event.payload.managed_kind === "pattern_work_list" &&
      event.payload.managed_authored_id === "deliver" &&
      event.payload.phase === "run_item"
    );
    expect(itemProgress.map((event) => event.payload.status)).toEqual(
      expect.arrayContaining(["item_started", "item_verifying", "item_verified", "item_completed"])
    );
    expect(itemProgress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            item_id: "w1",
            attempt: 1,
            max_attempts: 1
          })
        })
      ])
    );

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
    const resumedRunItemsAttempt = runItemAttempts.find((attempt) => attempt.outcome === "passed");
    const reuseDecision = JSON.parse(await readFile(
      join(resumedRunItemsAttempt!.execution_dir, "managed-items", "w1", "reuse-decision.json"),
      "utf8"
    )) as { item_id: string; decision: string; contract_hash?: string; frozen_item_hash?: string; validation_refs?: string[] };
    expect(reuseDecision).toEqual(expect.objectContaining({
      item_id: "w1",
      decision: "reuse_prior_completed_item",
      accepted_prior_attempt_state: "passed"
    }));
    expect(reuseDecision.contract_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(reuseDecision.frozen_item_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(reuseDecision.validation_refs?.length).toBeGreaterThan(0);

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
    const completionPacket = JSON.parse(
      await readFile(join(managedItemAttempts[0]!.execution_dir, "runtime", "completion-packet.json"), "utf8")
    ) as { ready_for_verification: boolean; completion_status: string };
    expect(completionPacket).toEqual(expect.objectContaining({
      ready_for_verification: true,
      completion_status: "ready_for_verification"
    }));
    const verifierPrompt = await readFile(join(managedItemAttempts[0]!.execution_dir, "human-debug", "verifier", "prompt.md"), "utf8");
    expect(verifierPrompt).toContain("## Completion Packet");
    expect(verifierPrompt).toContain("- Ready for verification: true");
    expect(verifierPrompt).not.toContain("(no completion packet was provided)");
    const runItemAttempts = attempts.filter((attempt) => attempt.authored_id === "deliver__managed__pattern_work_list__run_items");
    expect(runItemAttempts.map((attempt) => attempt.outcome)).toEqual(["passed"]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("runs deep-work item criteria in parallel", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-work-list-parallel-criteria-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-work-list-parallel-criteria",
      intent: {
        goal: "Exercise parallel work-list item criteria.",
        acceptance_criteria: ["The work-list pattern evaluates independent item criteria in parallel."]
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
              goal: "Deliver a bounded runtime-test work list with parallel criteria.",
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
                  max_cycles: 1,
                  pass_threshold: 1,
                  criteria: [
                    {
                      id: "contract",
                      kind: "rubric",
                      target: "workspace",
                      rubric: "The item satisfies its contract.",
                      weight: 0.5,
                      required: true
                    },
                    {
                      id: "handoff",
                      kind: "rubric",
                      target: "item_handoff",
                      rubric: "The item handoff is complete.",
                      weight: 0.5,
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

    const state = { activeChecks: 0, maxActiveChecks: 0 };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildParallelCriteriaHarness(state)
      }
    });

    expect(run.outcome).toBe("passed");
    expect(state.maxActiveChecks).toBeGreaterThan(1);
    const events = await readRunEvents(runRoot);
    const criterionProgress = events.filter((event) =>
      event.type === "managed.progress" &&
      event.payload?.phase === "item_criterion"
    );
    expect(criterionProgress.map((event) => event.payload?.status)).toEqual(expect.arrayContaining([
      "criterion_started",
      "criterion_completed"
    ]));
    expect(criterionProgress).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          item_id: "w1",
          criterion_id: "contract"
        })
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          item_id: "w1",
          criterion_id: "handoff"
        })
      })
    ]));

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("retries a required item criterion that scores below the item threshold", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-work-list-required-score-threshold-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-work-list-required-score-threshold",
      intent: {
        goal: "Exercise required criterion threshold behavior.",
        acceptance_criteria: ["The work-list pattern retries items with required criteria below threshold."]
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
              goal: "Deliver a bounded runtime-test work list with criterion threshold retry.",
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
                  pass_threshold: 0.88,
                  criteria: [
                    {
                      id: "contract",
                      kind: "rubric",
                      target: "workspace",
                      rubric: "The item satisfies its contract.",
                      weight: 0.8,
                      required: true
                    },
                    {
                      id: "design_system_fit",
                      kind: "rubric",
                      target: "workspace",
                      rubric: "The item fits the design system.",
                      weight: 0.2,
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

    const state = { itemRuns: 0 };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildLowRequiredCriterionHarness(state)
      }
    });

    expect(run.outcome).toBe("passed");
    expect(state.itemRuns).toBe(2);
    const attempts = await readRunExecutionAttempts(runRoot);
    const firstScorecardPath = join(
      attempts.find((attempt) =>
        attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1" &&
        attempt.attempt_index === 1
      )!.execution_dir,
      "artifacts",
      "scorecard.json"
    );
    const firstScorecard = JSON.parse(await readFile(firstScorecardPath, "utf8")) as {
      passed: boolean;
      blockers: Array<{ criterion_id: string; summary: string }>;
    };
    expect(firstScorecard.passed).toBe(false);
    expect(firstScorecard.blockers).toEqual([
      expect.objectContaining({ criterion_id: "design_system_fit" })
    ]);
    const itemAttempts = attempts.filter((attempt) =>
      attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1"
    );
    expect(itemAttempts.map((attempt) => attempt.outcome)).toEqual(["failed", "passed"]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("runs deep-work item phases with matching phase intent and policy", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-work-list-phased-deep-runtime-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-work-list-phased-deep",
      intent: {
        goal: "Exercise work-list item deep-work phase behavior.",
        acceptance_criteria: ["The work-list pattern runs item plan, execute, verify, and publish phases."]
      },
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: {
        default: { harness: "codex-cli", model: "default-model", reasoning_effort: "medium", sandbox: "workspace-write" },
        planner: { harness: "codex-cli", model: "planner-profile-model", sandbox: "read-only" },
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
              goal: "Deliver a bounded phased deep-work item.",
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
                phases: {
                  plan: {
                    runtime: { profile: "planner" },
                    intent: {
                      goal: "PLAN_PHASE_MARKER map item evidence before editing."
                    }
                  },
                  execute: {
                    reasoning_effort: "high",
                    support: {
                      context: [
                        {
                          name: "execute_phase_context",
                          kind: "workspace_file",
                          path: "phase-support.md",
                          what: "EXECUTE_SUPPORT_CONTEXT_MARKER",
                          why: "The execute phase needs this extra pointer; other item phases should not receive it."
                        }
                      ]
                    },
                    intent: {
                      goal: "EXECUTE_PHASE_MARKER implement only the planned item delta."
                    }
                  },
                  verify: {
                    model: "verify-phase-model",
                    intent: {
                      goal: "VERIFY_PHASE_MARKER require criterion evidence to cite draft outputs."
                    }
                  },
                  publish: {
                    sandbox: "read-only",
                    intent: {
                      goal: "PUBLISH_PHASE_MARKER write the accepted final item handoff only."
                    }
                  }
                },
                completion: {
                  max_cycles: 1,
                  pass_threshold: 1,
                  criteria: [
                    {
                      id: "item_contract",
                      kind: "rubric",
                      target: "item_handoff",
                      rubric: "The item handoff satisfies the frozen item contract.",
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

    const state = {
      agentPhases: [] as string[],
      aiCheckModels: [] as Array<string | undefined>,
      planModel: undefined as string | undefined,
      executeReasoning: undefined as string | undefined,
      publishSandbox: undefined as string | undefined
    };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildPhasedDeepWorkHarness(state)
      }
    });

    expect(run.outcome).toBe("passed");
    expect(state.agentPhases).toEqual(["plan", "execute", "publish"]);
    expect(state.planModel).toBe("planner-profile-model");
    expect(state.executeReasoning).toBe("high");
    expect(state.aiCheckModels).toEqual(["verify-phase-model"]);
    expect(state.publishSandbox).toBe("read-only");

    const attempts = await readRunExecutionAttempts(runRoot);
    const phaseAttempts = attempts
      .filter((attempt) => attempt.authored_id.startsWith("deliver__managed__pattern_work_list__run_items__item_w1__"))
      .sort((left, right) => left.started_at.localeCompare(right.started_at))
      .map((attempt) => attempt.authored_id);
    expect(phaseAttempts).toEqual([
      "deliver__managed__pattern_work_list__run_items__item_w1__plan",
      "deliver__managed__pattern_work_list__run_items__item_w1__execute",
      "deliver__managed__pattern_work_list__run_items__item_w1__publish"
    ]);
    const executeAttempt = attempts.find((attempt) =>
      attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1__execute"
    );
    const planAttempt = attempts.find((attempt) =>
      attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1__plan"
    );
    const publishAttempt = attempts.find((attempt) =>
      attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1__publish"
    );
    expect(executeAttempt).toBeDefined();
    expect(planAttempt).toBeDefined();
    expect(publishAttempt).toBeDefined();
    const executeContext = await readFile(join(executeAttempt!.execution_dir, "agent", "context.md"), "utf8");
    const planContext = await readFile(join(planAttempt!.execution_dir, "agent", "context.md"), "utf8");
    const publishContext = await readFile(join(publishAttempt!.execution_dir, "agent", "context.md"), "utf8");
    expect(executeContext).toContain("EXECUTE_SUPPORT_CONTEXT_MARKER");
    expect(planContext).not.toContain("EXECUTE_SUPPORT_CONTEXT_MARKER");
    expect(publishContext).not.toContain("EXECUTE_SUPPORT_CONTEXT_MARKER");

    await rm(tempRoot, { recursive: true, force: true });
  });
});
