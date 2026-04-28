import { describe, expect, it } from "vitest";

import {
  renderOutcomeVerificationPrompt,
  truncateForPrompt,
  type OutcomeVerificationPromptInput
} from "../../../src/runtime/verification/prompt.js";

function buildInput(overrides: Partial<OutcomeVerificationPromptInput> = {}): OutcomeVerificationPromptInput {
  return {
    graph_goal: "Make widgets pass acceptance.",
    graph_acceptance_criteria: ["All widget tests pass."],
    graph_constraints: ["No new dependencies."],
    node_authored_id: "implement_widget",
    node_compiled_id: "root__implement_widget",
    node_goal: "Implement the widget module.",
    node_acceptance_criteria: ["Module exports `widget` and tests pass."],
    node_constraints: ["Do not refactor unrelated modules."],
    agent_response_snippet: {
      name: "agent_response",
      description: "Agent's final response.",
      path: "/run/widget/agent-response.md",
      content: "Done.",
      byte_count: 4
    },
    declared_artifact_snippets: [
      {
        name: "patch_summary",
        description: "Summary of code changes.",
        path: "/run/widget/patch_summary.md",
        content: "Added widget module.",
        byte_count: 19
      }
    ],
    decision_log_entries: [
      {
        decision: "Use the existing widget module path",
        rationale: "The node contract asks for the focused widget module and no repo evidence points to a broader refactor.",
        evidence: [
          "Context manifest listed widget.ts as the relevant source file.",
          "Repository inspection found no alternate widget package."
        ],
        created_at: "2026-04-28T12:00:00.000Z",
        log_id: "log_decision_1"
      }
    ],
    workspace_diff_snippet: {
      status: "captured",
      changed_file_count: 1,
      diff_path: "/run/widget/workspace-changes/diff.patch",
      status_path: "/run/widget/workspace-changes/status.txt",
      changed_files_path: "/run/widget/workspace-changes/changed-files.json",
      diff_excerpt: "diff --git a/widget.ts b/widget.ts\n+export const widget = 1;",
      diff_truncated: false
    },
    workspace_path: "/repo",
    attempt: {
      execution_id: "exec__implement_widget__attempt_1",
      attempt_index: 1
    },
    ...overrides
  };
}

describe("renderOutcomeVerificationPrompt", () => {
  it("renders graph and node intent including acceptance criteria and constraints", () => {
    const prompt = renderOutcomeVerificationPrompt(buildInput());
    expect(prompt).toContain("Make widgets pass acceptance.");
    expect(prompt).toContain("All widget tests pass.");
    expect(prompt).toContain("No new dependencies.");
    expect(prompt).toContain("Implement the widget module.");
    expect(prompt).toContain("Module exports `widget` and tests pass.");
    expect(prompt).toContain("Do not refactor unrelated modules.");
  });

  it("includes the agent response snippet, declared artifacts, decision log, and workspace diff paths", () => {
    const prompt = renderOutcomeVerificationPrompt(buildInput());
    expect(prompt).toContain("Done.");
    expect(prompt).toContain("Added widget module.");
    expect(prompt).toContain("Use the existing widget module path");
    expect(prompt).toContain("The node contract asks for the focused widget module");
    expect(prompt).toContain("Context manifest listed widget.ts as the relevant source file.");
    expect(prompt).toContain("/run/widget/workspace-changes/diff.patch");
    expect(prompt).toContain("Diff excerpt: (not inlined by default");
    expect(prompt).not.toContain("export const widget = 1;");
  });

  it("notes when an artifact was truncated", () => {
    const prompt = renderOutcomeVerificationPrompt(
      buildInput({
        agent_response_snippet: {
          name: "agent_response",
          description: "Agent's final response.",
          path: "/run/widget/agent-response.md",
          content: "Done. ...",
          truncated: true,
          byte_count: 1024
        }
      })
    );
    expect(prompt).toContain("(truncated)");
    expect(prompt).toContain("Read the full file from the path above before judging.");
  });

  it("flags missing diff capture in degraded mode", () => {
    const prompt = renderOutcomeVerificationPrompt(
      buildInput({
        workspace_diff_snippet: {
          status: "degraded",
          changed_file_count: 0,
          capture_error: "git failed"
        }
      })
    );
    expect(prompt).toContain("- Status: degraded");
    expect(prompt).toContain("Capture error: git failed");
  });

  it("notes when workspace diff is absent", () => {
    const overrides: Partial<OutcomeVerificationPromptInput> = {};
    delete (overrides as { workspace_diff_snippet?: unknown }).workspace_diff_snippet;
    const input = buildInput(overrides);
    delete (input as { workspace_diff_snippet?: unknown }).workspace_diff_snippet;
    const prompt = renderOutcomeVerificationPrompt(input);
    expect(prompt).toContain("No per-node workspace diff was captured");
  });

  it("renders an empty decision log as missing audit evidence rather than a blocker", () => {
    const prompt = renderOutcomeVerificationPrompt(
      buildInput({
        decision_log_entries: []
      })
    );
    expect(prompt).toContain("Missing or sparse decision logs should usually be a warning, not a blocker");
    expect(prompt).toContain("(no decision log entries captured)");
  });

  it("instructs the model to respond with a single fenced JSON block", () => {
    const prompt = renderOutcomeVerificationPrompt(buildInput());
    expect(prompt).toContain("Respond with exactly one fenced ```json``` block");
    expect(prompt).toContain('"passed": boolean');
    expect(prompt).toContain('"severity": "blocker" | "high" | "medium" | "low"');
  });
});

describe("truncateForPrompt", () => {
  it("returns the original when within budget", () => {
    const result = truncateForPrompt("hello", 100);
    expect(result.content).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  it("truncates and appends a marker when over budget", () => {
    const long = "a".repeat(500);
    const result = truncateForPrompt(long, 100);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(100);
    expect(result.content).toContain("[truncated for verifier prompt]");
  });
});
