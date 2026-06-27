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

function isWorkListPlannerInvocation(invocation: AgentInvocation): boolean {
  return Boolean(invocation.artifacts && Object.prototype.hasOwnProperty.call(invocation.artifacts, "work_list_json"));
}

function isWorkListItemPlanInvocation(invocation: AgentInvocation): boolean {
  return invocation.managedPrompt?.phase === "item_plan";
}

function isWorkListItemExecuteInvocation(invocation: AgentInvocation): boolean {
  return invocation.managedPrompt?.phase === "item_execute";
}

async function writeItemPlan(invocation: AgentInvocation): Promise<void> {
  await writeFile(join(invocation.outputDir, "plan.md"), [
    "# Item Plan",
    "",
    "Task target",
    "Satisfy the current frozen item.",
    "",
    "Current state",
    "The item is ready for execution.",
    "",
    "Gap",
    "Execution evidence still needs to be produced.",
    "",
    "Execution plan",
    "Produce the required structured item result.",
    "",
    "Validation plan",
    "Run the item completion criteria.",
    "",
    "Expected material change",
    "The item result records supported completion evidence.",
    "",
    "Remaining gap",
    "None expected after successful execution.",
    "",
    "Risks or constraints",
    "Stay scoped to the frozen item."
  ].join("\n"), "utf8");
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
    completed
      ? "# Item Work Notes\n\nWhat changed\nExecuted with evidence.\n\nPlan.md deviations\nNo deviations from plan.md were needed.\n\nValidation evidence\nRuntime gate can verify this result.\n"
      : "# Item Work Notes\n\nWhat changed\nBlocked pending retry evidence.\n\nPlan.md deviations\nNo deviations from plan.md were needed.\n\nValidation evidence\nRuntime gate should reject this result.\n",
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
}

async function writeFinalItemArtifacts(invocation: AgentInvocation, options: {
  itemId?: string;
  summary?: string;
  validationMessage?: string;
} = {}): Promise<void> {
  const itemId = options.itemId ?? (invocation.nodeGoal?.includes("`w2`") ? "w2" : "w1");
  await writeFile(join(invocation.outputDir, "item-result.json"), `${JSON.stringify({
    id: itemId,
    status: "completed",
    summary: options.summary ?? "Produced the evidence handoff.",
    validation: itemValidationEvidence(options.validationMessage ?? "Runtime finalizer can verify this result."),
    risks: [],
    downstream_implications: ["Downstream nodes can consume work_items."]
  }, null, 2)}\n`, "utf8");
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

      if (isWorkListPlannerInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemPlan(invocation);
      } else if (isWorkListItemExecuteInvocation(invocation)) {
        await writeDraftItemArtifacts(invocation);
      } else if (isWorkListItemInvocation(invocation)) {
        await writeFinalItemArtifacts(invocation);
      } else if (invocation.nodeGoal?.includes("final artifacts")) {
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

      if (isWorkListPlannerInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemPlan(invocation);
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
      } else if (invocation.nodeGoal?.includes("final artifacts")) {
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

function buildDraftContractFailureHarness(state: { executeCalls: number; sawContractFailureContext: boolean }): HarnessAdapter {
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
              JSON.stringify({ passed: true, summary: "Work-list contract-failure retry verifier accepted the artifacts.", findings: [] }),
              "```"
            ].join("\n")
          }
        };
      }

      if (isWorkListPlannerInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemPlan(invocation);
      } else if (isWorkListItemExecuteInvocation(invocation)) {
        state.executeCalls += 1;
        if (state.executeCalls > 1 && invocation.contextManifest?.includes("managed_contract_failure")) {
          state.sawContractFailureContext = true;
        }
        await writeFile(join(invocation.outputDir, "item-work-notes.md"), "# Item Work Notes\n\nExecuted with evidence.\n", "utf8");
        await writeFile(
          join(invocation.outputDir, "draft-item-result.json"),
          state.executeCalls === 1
            ? "{\n  \"id\": \"w1\",\n  \"status\": \"completed\"\n"
            : `${JSON.stringify({
                id: "w1",
                status: "completed",
                summary: "Produced the repaired evidence handoff.",
                validation: itemValidationEvidence("Runtime gate can verify this repaired result."),
                risks: [],
                downstream_implications: ["Downstream nodes can consume work_items after completion."]
              }, null, 2)}\n`,
          "utf8"
        );
      } else if (isWorkListItemInvocation(invocation)) {
        await writeFinalItemArtifacts(invocation, {
          summary: "Produced the repaired evidence handoff.",
          validationMessage: "Runtime finalizer can verify this result."
        });
      } else if (invocation.nodeGoal?.includes("final artifacts")) {
        await writeFile(join(invocation.outputDir, "summary.md"), "Completed one frozen work-list item after contract repair.\n", "utf8");
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

function buildSkippedPublisherHarness(state: { publishCalls: number }): HarnessAdapter {
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
              JSON.stringify({ passed: true, summary: "Skipped-publisher verifier accepted the artifacts.", findings: [] }),
              "```"
            ].join("\n")
          }
        };
      }

      if (isWorkListPlannerInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemPlan(invocation);
      } else if (isWorkListItemExecuteInvocation(invocation)) {
        await writeDraftItemArtifacts(invocation, {
          summary: "Produced draft evidence ready for deterministic finalization.",
          validationMessage: "Runtime gate can verify this result."
        });
      } else if (isWorkListItemInvocation(invocation)) {
        state.publishCalls += 1;
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

      if (isWorkListPlannerInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemPlan(invocation);
      } else if (isWorkListItemExecuteInvocation(invocation)) {
        await writeDraftItemArtifacts(invocation, {
          validationMessage: "Runtime finalizer can verify this result."
        });
      } else if (isWorkListItemInvocation(invocation)) {
        await writeFinalItemArtifacts(invocation, {
          summary: "Produced the evidence handoff.",
          validationMessage: "Runtime finalizer can verify this result."
        });
      } else if (invocation.nodeGoal?.includes("final artifacts")) {
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

      if (isWorkListPlannerInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemPlan(invocation);
      } else if (isWorkListItemExecuteInvocation(invocation)) {
        state.itemRuns += 1;
        await writeDraftItemArtifacts(invocation, {
          summary: `Produced the evidence handoff on run ${state.itemRuns}.`
        });
      } else if (isWorkListItemInvocation(invocation)) {
        await writeFinalItemArtifacts(invocation, {
          summary: `Produced the evidence handoff on run ${state.itemRuns}.`
        });
      } else if (invocation.nodeGoal?.includes("final artifacts")) {
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
        expect(JSON.stringify(invocation.managedPrompt)).toContain("VERIFY_PHASE_MARKER");
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

      if (isWorkListPlannerInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemPlanInvocation(invocation)) {
        state.agentPhases.push("plan");
        state.planModel = invocation.model;
        const phaseBrief = JSON.stringify(invocation.managedPrompt);
        expect(phaseBrief).toContain("PLAN_PHASE_MARKER");
        expect(phaseBrief).not.toContain("EXECUTE_PHASE_MARKER");
        await writeFile(join(invocation.outputDir, "plan.md"), [
          "# Item Plan",
          "",
          "Task target",
          "Satisfy the phased frozen item.",
          "",
          "Current state",
          "The phased item is ready for execution.",
          "",
          "Gap",
          "Execution evidence still needs to be produced.",
          "",
          "Execution plan",
          "Produce draft item evidence.",
          "",
          "Validation plan",
          "Run the verify phase.",
          "",
          "Expected material change",
          "Draft item evidence supports completion.",
          "",
          "Remaining gap",
          "None expected after successful execution.",
          "",
          "Risks or constraints",
          "Stay scoped to the frozen item."
        ].join("\n"), "utf8");
      } else if (isWorkListItemExecuteInvocation(invocation)) {
        state.agentPhases.push("execute");
        state.executeReasoning = invocation.reasoningEffort;
        const phaseBrief = JSON.stringify(invocation.managedPrompt);
        expect(phaseBrief).toContain("EXECUTE_PHASE_MARKER");
        expect(phaseBrief).not.toContain("PUBLISH_PHASE_MARKER");
        await writeFile(join(invocation.outputDir, "item-work-notes.md"), "# Item Work Notes\n\nWhat changed\nExecuted the planned item delta.\n\nPlan.md deviations\nNo deviations from plan.md were needed.\n\nValidation evidence\nDraft validation evidence.\n", "utf8");
        await writeFile(join(invocation.outputDir, "draft-item-result.json"), `${JSON.stringify({
          id: "w1",
          status: "completed",
          summary: "Draft item result.",
          validation: itemValidationEvidence("Draft validation evidence."),
          risks: [],
          downstream_implications: ["Publish can finalize the accepted evidence."]
        }, null, 2)}\n`, "utf8");
      } else if (isWorkListItemInvocation(invocation)) {
        state.agentPhases.push("publish");
        state.publishSandbox = invocation.sandbox;
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

function buildTwoItemHarness(state: { itemOrder: string[]; secondSawPriorResults: boolean }): HarnessAdapter {
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

      if (isWorkListPlannerInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedTwoItemWorkListJson(), "utf8");
      } else if (isWorkListItemInvocation(invocation)) {
        const itemId = invocation.nodeGoal?.includes("`w2`") ? "w2" : "w1";
        state.itemOrder.push(itemId);
        if (itemId === "w2" && invocation.contextManifest?.includes("prior_completed_item_results")) {
          state.secondSawPriorResults = true;
        }
        await writeFile(join(invocation.outputDir, "item-result.json"), `${JSON.stringify({
          id: itemId,
          status: "completed",
          summary: `${itemId} produced the evidence handoff.`,
          validation: itemValidationEvidence("Runtime finalizer can verify this result."),
          risks: [],
          downstream_implications: ["Downstream nodes can consume work_items."]
        }, null, 2)}\n`, "utf8");
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

      if (isWorkListPlannerInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedTwoItemWorkListJson(), "utf8");
      } else if (isWorkListItemInvocation(invocation)) {
        const itemId = invocation.nodeGoal?.includes("`w2`") ? "w2" : "w1";
        state.itemOrder.push(itemId);
        if (itemId === "w2") {
          state.w2Attempts += 1;
        }
        const shouldComplete = itemId !== "w2" || state.w2Attempts > 1;
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

      if (isWorkListPlannerInvocation(invocation)) {
        await writeFile(join(invocation.outputDir, "work-list.json"), plannedWorkListJson(), "utf8");
      } else if (isWorkListItemPlanInvocation(invocation)) {
        await writeItemPlan(invocation);
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
      } else if (invocation.nodeGoal?.includes("final artifacts")) {
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
      items: Array<{
        id: string;
        status: string;
        validation: { passed: string[]; failed_then_fixed: string[]; unavailable: string[]; blocked: string[] };
      }>;
    };
    expect(workItems).toEqual(expect.objectContaining({
      status: "completed",
      item_count: 1
    }));
    expect(workItems.items).toEqual([
      expect.objectContaining({
        id: "w1",
        status: "completed",
        validation: expect.objectContaining({
          passed: ["Runtime finalizer can verify this result."]
        })
      })
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

  it("runs one managed agent execution per item and passes prior item results forward", async () => {
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
        acceptance_criteria: ["The work-list pattern passes prior item results to later items."]
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

    const state = { itemOrder: [] as string[], secondSawPriorResults: false };
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
    expect(state.secondSawPriorResults).toBe(true);
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
    expect(firstItemPrompt).not.toContain("managed work-list item");
    expect(firstItemPrompt).not.toContain("public artifact");
    expect(firstItemPrompt).not.toContain("downstream graph node");
    expect(firstItemPrompt).toContain("## Item Output Contract");
    expect(firstItemPrompt).toContain("field id set to the current frozen item id");
    expect(firstItemPrompt).toContain("passed, failed_then_fixed, unavailable, and blocked keys");
    expect(firstItemPrompt).toContain("Use failed_then_fixed, not fixed.");
    expect(firstItemPrompt).toContain("add/edit tests only when the task asks or repo contract expects them");
    expect(firstItemPrompt).toContain("Do not use field item_id.");
    expect(firstItemPrompt).not.toContain("JSON with this exact shape");
    expect(firstItemPrompt).not.toContain('"failed_then_fixed": []');
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

  it("turns malformed draft item results into structured managed contract retry input", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-work-list-draft-contract-failure-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-work-list-draft-contract-failure",
      intent: {
        goal: "Exercise structured managed contract retry evidence.",
        acceptance_criteria: ["The work-list pattern retries only the current item with precise contract failure evidence."]
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
              goal: "Deliver a bounded runtime-test work list with draft contract repair.",
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

    const state = { executeCalls: 0, sawContractFailureContext: false };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildDraftContractFailureHarness(state)
      }
    });

    expect(run.outcome).toBe("passed");
    expect(state.executeCalls).toBe(2);
    expect(state.sawContractFailureContext).toBe(true);
    const attempts = await readRunExecutionAttempts(runRoot);
    const executeAttempts = attempts
      .filter((attempt) => attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1__execute")
      .sort((left, right) => left.attempt_index - right.attempt_index);
    expect(executeAttempts).toHaveLength(2);
    const failurePacket = JSON.parse(await readFile(
      join(executeAttempts[0]!.execution_dir, "runtime", "managed-contract-failure.json"),
      "utf8"
    )) as {
      findings: Array<{
        managed_kind: string;
        phase: string;
        item_id?: string;
        artifact_name?: string;
        failure_kind: string;
        retry_boundary: string;
        required_next_action: string;
      }>;
    };
    expect(failurePacket.findings).toEqual([
      expect.objectContaining({
        managed_kind: "pattern_work_list",
        phase: "item_execute",
        item_id: "w1",
        artifact_name: "draft_item_result",
        failure_kind: "invalid_json",
        retry_boundary: "current_item",
        required_next_action: expect.stringContaining("draft-item-result.json")
      })
    ]);
    const retryContext = await readFile(join(executeAttempts[1]!.execution_dir, "agent", "context.md"), "utf8");
    expect(retryContext).toContain("## Read First");
    expect(retryContext).toContain("## Current Work");
    expect(retryContext).toContain("## Progress State");
    expect(retryContext).toContain("managed_contract_failure");
    expect(retryContext).toContain("draft_item_result");
    expect(retryContext.indexOf("## Read First")).toBeLessThan(retryContext.indexOf("## Current Work"));
    expect(retryContext.indexOf("managed_contract_failure")).toBeLessThan(retryContext.indexOf("current_item"));
    expect(retryContext.indexOf("current_item")).toBeLessThan(retryContext.indexOf("work_list_ledger"));
    expect(retryContext).not.toContain("human-debug");

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("skips the deep-work item publisher when deterministic promotion is enough", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-work-list-skip-item-publisher-"));
    const repoDir = join(tempRoot, "repo");
    const runRoot = join(tempRoot, "run");
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);

    const graph = compileGraph({
      version: "1",
      graph_id: "runtime-work-list-skip-item-publisher",
      intent: {
        goal: "Exercise deterministic item finalization.",
        acceptance_criteria: ["The work-list pattern finalizes accepted item results without an item publisher agent."]
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
              goal: "Deliver a bounded runtime-test work list with deterministic finalization.",
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

    const state = { publishCalls: 0 };
    const run = await runCompiledGraph({
      run_root: runRoot,
      compiled_graph: graph,
      repo_sources: { main: repoDir },
      harnesses: {
        "codex-cli": buildSkippedPublisherHarness(state)
      }
    });

    expect(run.outcome).toBe("passed");
    expect(state.publishCalls).toBe(0);
    const attempts = await readRunExecutionAttempts(runRoot);
    const publishAttempts = attempts
      .filter((attempt) => attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1__publish")
      .sort((left, right) => left.attempt_index - right.attempt_index);
    expect(publishAttempts).toHaveLength(0);
    const finalAttempt = attempts.find((attempt) => attempt.authored_id === "deliver");
    expect(finalAttempt?.artifacts.work_items).toBeDefined();
    const workItems = JSON.parse(await readFile(finalAttempt!.artifacts.work_items!, "utf8")) as {
      items: Array<{ id: string; summary: string }>;
    };
    expect(workItems.items).toEqual([
      expect.objectContaining({
        id: "w1",
        summary: "Produced draft evidence ready for deterministic finalization."
      })
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
        acceptance_criteria: ["The work-list pattern runs item plan and execute phases, verifies criteria, and finalizes deterministically."]
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
                      goal: "PUBLISH_PHASE_MARKER would write user-authored final artifacts if any existed."
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
                      rubric: "The canonical item result satisfies the frozen item contract.",
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
    expect(state.agentPhases).toEqual(["plan", "execute"]);
    expect(state.planModel).toBe("planner-profile-model");
    expect(state.executeReasoning).toBe("high");
    expect(state.aiCheckModels).toEqual(["verify-phase-model"]);
    expect(state.publishSandbox).toBeUndefined();

    const attempts = await readRunExecutionAttempts(runRoot);
    const phaseAttempts = attempts
      .filter((attempt) => attempt.authored_id.startsWith("deliver__managed__pattern_work_list__run_items__item_w1__"))
      .sort((left, right) => left.started_at.localeCompare(right.started_at))
      .map((attempt) => attempt.authored_id);
    expect(phaseAttempts).toEqual([
      "deliver__managed__pattern_work_list__run_items__item_w1__plan",
      "deliver__managed__pattern_work_list__run_items__item_w1__execute"
    ]);
    const executeAttempt = attempts.find((attempt) =>
      attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1__execute"
    );
    const planAttempt = attempts.find((attempt) =>
      attempt.authored_id === "deliver__managed__pattern_work_list__run_items__item_w1__plan"
    );
    expect(executeAttempt).toBeDefined();
    expect(planAttempt).toBeDefined();
    const planPrompt = await readFile(join(planAttempt!.execution_dir, "agent", "prompt.md"), "utf8");
    expect(planPrompt).toContain("Preserve exact task-specific names, labels, commands, and required phrases from the parent work-list and current item contract in the plan.");
    expect(planPrompt).toContain("Write it to `plan.md` as the executor handoff for this frozen item, not as the final item result.");
    expect(planPrompt).not.toContain("item_cycle_plan");
    expect(planPrompt).not.toContain("item-cycle-plan.md");
    expect(planPrompt).not.toContain("smallest justified deviation");
    const executeContext = await readFile(join(executeAttempt!.execution_dir, "agent", "context.md"), "utf8");
    const planContext = await readFile(join(planAttempt!.execution_dir, "agent", "context.md"), "utf8");
    expect(executeContext).toContain("EXECUTE_SUPPORT_CONTEXT_MARKER");
    expect(planContext).not.toContain("EXECUTE_SUPPORT_CONTEXT_MARKER");

    await rm(tempRoot, { recursive: true, force: true });
  });
});
