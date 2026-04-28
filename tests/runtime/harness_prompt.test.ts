import { describe, expect, it } from "vitest";

import { renderHarnessPrompt, type AgentInvocation } from "../../src/runtime/harness/types.js";

function baseInvocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    promptKind: "agent",
    runId: "run-1",
    executionId: "exec-1",
    repoAlias: "main",
    repoPath: "/tmp/workspace",
    sandbox: "workspace-write",
    model: undefined,
    nodeGoal: "Implement the focused node task.",
    contextPacketPath: "/tmp/run/context/packet.json",
    contextManifestPath: "/tmp/run/context/manifest.md",
    contextManifest: "# Context Manifest\n\n- Materialized items: `1`\n",
    outputDir: "/tmp/run/output",
    artifacts: {},
    timeoutSec: 1800,
    signal: undefined,
    ...overrides
  };
}

describe("harness prompt rendering", () => {
  it("makes the node task primary and graph context secondary", () => {
    const prompt = renderHarnessPrompt(baseInvocation({
      graphGoal: "Ship the wider feature safely.",
      graphAcceptanceCriteria: ["The full workflow validates."],
      graphConstraints: ["Stay within the repo."]
    }));

    expect(prompt).toContain("Agentflow is a local graph runner for long-running engineering work.");
    expect(prompt.indexOf("## Node Task")).toBeLessThan(prompt.indexOf("## Graph Context"));
    expect(prompt).toContain("The node task is the controlling objective.");
    expect(prompt).toContain("Use this to understand why this node exists.");
    expect(prompt).not.toContain("## Diagnostics");
  });

  it("keeps context metadata just-in-time through packet and provenance paths", () => {
    const prompt = renderHarnessPrompt(baseInvocation());

    expect(prompt).toContain("Read the manifest first");
    expect(prompt).toContain("Context packet (exact materialized paths, omissions, and structured metadata): /tmp/run/context/packet.json");
    expect(prompt).toContain("Context provenance (digests and harness instruction inputs, if needed): /tmp/run/context/provenance.json");
    expect(prompt).not.toContain("Run ID:");
    expect(prompt).not.toContain("Execution ID:");
  });

  it("renders read-only artifact declarations as blockers instead of write instructions", () => {
    const prompt = renderHarnessPrompt(baseInvocation({
      sandbox: "read-only",
      artifacts: {
        report: {
          from: "output_dir",
          path: "report.md",
          description: "Review report."
        }
      }
    }));

    expect(prompt).toContain("read-only sandbox prevents file writes");
    expect(prompt).toContain("Treat this as a blocker");
    expect(prompt).not.toContain("Every declared artifact must exist before you finish");
  });

  it("renders a Working Loop section that anchors iterate-until-done behavior on the agent path", () => {
    const prompt = renderHarnessPrompt(baseInvocation());

    expect(prompt).toContain("## Working Loop");
    expect(prompt).toContain("Drive this node to completion within its boundary.");
    expect(prompt).toContain(
      "Default loop: inspect context and repo state, plan the smallest maintainable path, execute, run the validation named by the task or context, fix failures or open questions, then rerun validation."
    );
    expect(prompt).toContain("For every major scope-affecting decision");
    expect(prompt).toContain("af log --type decision");
    expect(prompt).toContain("--rationale <why you made that decision>");
    expect(prompt).toContain("Final artifacts must be consistent with the decision log.");
    expect(prompt).toContain("Investigate ambiguity instead of guessing");
    expect(prompt).toContain("Be persistent without thrashing");
    expect(prompt).toContain(
      "Outcome verification grades your work against the acceptance criteria after this node finishes; declaring done before the criteria are met will be rejected."
    );
    const workingLoopIdx = prompt.indexOf("## Working Loop");
    const nodeTaskIdx = prompt.indexOf("## Node Task");
    expect(workingLoopIdx).toBeGreaterThan(-1);
    expect(workingLoopIdx).toBeLessThan(nodeTaskIdx);
  });

  it("does not include the Working Loop on read-only ai_check, artifact_repair, or outcome_verification prompts", () => {
    const aiCheckPrompt = renderHarnessPrompt(
      baseInvocation({
        promptKind: "ai_check",
        sandbox: "read-only",
        artifacts: {}
      })
    );
    expect(aiCheckPrompt).not.toContain("## Working Loop");

    const repairPrompt = renderHarnessPrompt(
      baseInvocation({
        promptKind: "artifact_repair",
        artifacts: {
          handoff: {
            from: "output_dir",
            path: "handoff.md",
            description: "Markdown handoff."
          }
        },
        repair: {
          repairAttempt: 1,
          maxAttempts: 2,
          priorResponsePath: "/tmp/run/output/agent-response.md",
          stdoutLogPath: "/tmp/run/logs/stdout.log",
          stderrLogPath: "/tmp/run/logs/stderr.log",
          previousAttemptEvidencePaths: [],
          missingArtifacts: [
            {
              name: "handoff",
              from: "output_dir",
              path: "handoff.md",
              description: "Markdown handoff.",
              expectedPath: "/tmp/run/output/handoff.md"
            }
          ]
        }
      })
    );
    expect(repairPrompt).not.toContain("## Working Loop");

    const verifierPrompt = renderHarnessPrompt(
      baseInvocation({
        promptKind: "outcome_verification",
        sandbox: "read-only",
        artifacts: {},
        rubric: "Pre-rendered verifier prompt body."
      })
    );
    expect(verifierPrompt).toBe("Pre-rendered verifier prompt body.");
    expect(verifierPrompt).not.toContain("## Working Loop");
  });

  it("renders artifact repair as a dedicated prompt kind", () => {
    const prompt = renderHarnessPrompt(baseInvocation({
      promptKind: "artifact_repair",
      nodeGoal: "Produce the missing artifact while preserving the original task.",
      artifacts: {
        handoff: {
          from: "output_dir",
          path: "handoff.md",
          description: "Markdown handoff."
        }
      },
      repair: {
        repairAttempt: 1,
        maxAttempts: 2,
        priorResponsePath: "/tmp/run/output/agent-response.md",
        stdoutLogPath: "/tmp/run/logs/stdout.log",
        stderrLogPath: "/tmp/run/logs/stderr.log",
        previousAttemptEvidencePaths: [],
        missingArtifacts: [{
          name: "handoff",
          from: "output_dir",
          path: "handoff.md",
          description: "Markdown handoff.",
          expectedPath: "/tmp/run/output/handoff.md"
        }]
      }
    }));

    expect(prompt).toContain("## Repair Task");
    expect(prompt).toContain("## Missing Artifacts");
    expect(prompt).toContain("expected absolute path: `/tmp/run/output/handoff.md`");
    expect(prompt).not.toContain("## Diagnostics");
  });
});
