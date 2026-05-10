import { describe, expect, it } from "vitest";

import { renderHarnessPrompt, type AgentInvocation } from "../../src/runtime/harness/types.js";
import type { SupervisorRecoveryEnvelope } from "../../src/supervisor/types.js";

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
  it("renders the standard worker prompt in the contract-first section order", () => {
    const prompt = renderHarnessPrompt(baseInvocation({
      graphGoal: "Ship the wider feature safely.",
      artifacts: {
        handoff: {
          from: "output_dir",
          path: "handoff.md",
          description: "Markdown handoff."
        }
      }
    }));
    const sections = [
      "## Role",
      "## Contract Priority",
      "## Working Loop",
      "## Node Task",
      "## Graph Context",
      "## Workspace",
      "## Context",
      "## Agentflow Runtime CLI",
      "## Artifact Contract",
      "## Final Handoff"
    ];

    for (const section of sections) {
      expect(prompt).toContain(section);
    }
    for (let index = 0; index < sections.length - 1; index += 1) {
      expect(prompt.indexOf(sections[index]!)).toBeLessThan(prompt.indexOf(sections[index + 1]!));
    }
  });

  it("makes the node task primary and graph context secondary", () => {
    const prompt = renderHarnessPrompt(baseInvocation({
      graphGoal: "Ship the wider feature safely.",
      graphAcceptanceCriteria: ["The full workflow validates."],
      graphConstraints: ["Stay within the repo."]
    }));

    expect(prompt).toContain("Agentflow is a local graph runner for long-running engineering work.");
    expect(prompt.indexOf("## Node Task")).toBeLessThan(prompt.indexOf("## Graph Context"));
    expect(prompt).toContain("The node task is the controlling objective.");
    expect(prompt).toContain("Why this node exists.");
    expect(prompt).not.toContain("## Diagnostics");
  });

  it("keeps context metadata just-in-time through packet and provenance paths", () => {
    const prompt = renderHarnessPrompt(baseInvocation());

    expect(prompt).toContain("Read the manifest, then open only the materialized items relevant to this task.");
    expect(prompt).toContain("Context packet: /tmp/run/context/packet.json");
    expect(prompt).toContain("Context provenance: /tmp/run/context/provenance.json");
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

  it("requires literal artifact labels and placeholder-free declared artifacts", () => {
    const prompt = renderHarnessPrompt(baseInvocation({
      nodeAcceptanceCriteria: [
        "The handoff artifact includes literal `Scenario:`, `Validation:`, and `Risks:` fields."
      ],
      artifacts: {
        handoff: {
          from: "output_dir",
          path: "handoff.md",
          description: "Handoff with literal Scenario:, Validation:, and Risks: fields."
        }
      }
    }));

    expect(prompt).toContain("If the node task, authored goal, acceptance criteria, or artifact description names required labels");
    expect(prompt).toContain("copy those strings exactly into the artifact body");
    expect(prompt).toContain("`Scenario:` is not satisfied by `# Scenario` or a paraphrase");
    expect(prompt).toContain("Forbidden or excluded content overrides exact-phrase copying");
    expect(prompt).toContain("including in a negated sentence saying you excluded it");
    expect(prompt).toContain("Do not restate excluded content to explain that it was ignored");
    expect(prompt).toContain("Risks:` sections should contain only live risks for the requested deliverable");
    expect(prompt).toContain("Do not copy stale prior-artifact payloads, any value or content described as stale/noise");
    expect(prompt).toContain("Summarize why they are non-authoritative without preserving exact marker values");
    expect(prompt).toContain("For multi-line Markdown, write a file and publish it with `af artifact write <name> --file <path>`");
    expect(prompt).toContain("do not encode newlines as literal `\\n`");
    expect(prompt).toContain("If a declared artifact path ends in `.json`, write valid JSON that parses cleanly");
    expect(prompt).toContain("Do not write prospective completion-state claims into artifacts");
    expect(prompt).toContain("artifacts must stay true after the final completion check runs");
    expect(prompt).toContain("If you mention validation, include the exact command/tool name and observed result");
    expect(prompt).toContain("ready once validation is recorded");
    expect(prompt).toContain("contains no placeholder text, blank evidence slots, or unresolved template values.");
  });

  it("renders a Working Loop section that anchors iterate-until-done behavior on the agent path", () => {
    const prompt = renderHarnessPrompt(baseInvocation());

    expect(prompt).toContain("## Working Loop");
    expect(prompt).toContain("Drive the node to completion within its boundary");
    expect(prompt).toContain(
      "run exact `af` commands named by the node task first"
    );
    expect(prompt).toContain("When the node task says to use `af context show`, run `af context show` before `af status`");
    expect(prompt).toContain("When the node task names an exact command, run that command exactly");
    expect(prompt).toContain("af complete check");
    expect(prompt).toContain("Log meaningful progress after verification");
    expect(prompt).toContain("Omit ignored context/noise rather than memorializing it in the artifact");
    expect(prompt).toContain("Do not log a blocking finding for an issue you can resolve inside this node");
    expect(prompt).toContain("treat that output as repair feedback");
    expect(prompt).toContain("blocking findings remain active completion blockers");
    expect(prompt).toContain("af log --type finding --finding-kind <observation|issue|risk|blocker>");
    expect(prompt).toContain("Every `af log --evidence` JSON value must include `kind` and `summary`");
    expect(prompt).toContain("`kind` must be one of `command_output`, `artifact`, `workspace_diff`, `context`, `runtime_event`, `external_state`, `human_input`, or `tool_output`");
    expect(prompt).toContain("For self-resolvable issues, use `finding-kind issue` or `risk`");
    expect(prompt).toContain("af log --type decision");
    expect(prompt).toContain("--rationale <why>");
    expect(prompt).toContain("--contract-implication <effect>");
    expect(prompt).toContain("Investigate ambiguity instead of guessing");
    expect(prompt).toContain("Agentflow is the runner, not the work target.");
    expect(prompt).toContain("Use the node task, graph context, and materialized context as the contract for this node.");
    expect(prompt).not.toContain("ambient skills");
    expect(prompt).not.toContain("Agentflow playbooks");
    expect(prompt).not.toContain("AGENTS.md files outside");
    expect(prompt).not.toContain("unrelated Agentflow docs");
    expect(prompt).toContain("If the node task names `af context show`, run that exact command before optional runtime status checks");
    expect(prompt).toContain("stop and respond immediately");
    expect(prompt).not.toContain("Use `af --help` only when the options below are insufficient.");
    expect(prompt).not.toContain("af artifact list");
    expect(prompt).not.toContain("af diagnose");
    expect(prompt).not.toContain("af learn");
    expect(prompt).not.toContain("af spawn");
    expect(prompt).toContain("If the same tactic fails twice with the same symptom");
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

  it("renders the supervisor recovery envelope before the original node task and preserves the contract", () => {
    const envelope: SupervisorRecoveryEnvelope = {
      envelope_id: "recovery-1",
      compiled_id: "root__node",
      authored_id: "node",
      prior_execution_id: "exec-0",
      recovery_plan_path: "/tmp/run/exec-0/interventions/recovery-1/recovery-plan.json",
      case_file_path: "/tmp/run/exec-0/interventions/recovery-1/case-file.json",
      action: "retry_node",
      classification: "missing_dependency_docs",
      failure_fingerprint: "abc123",
      repeated_fingerprint_count: 1,
      retry_directive: {
        summary: "The first attempt used the wrong v4 API.",
        must_do: ["Read the cited zod v4 docs fixture before editing."],
        must_not_do: ["Do not change acceptance criteria."],
        evidence_to_read: ["/tmp/run/exec-0/interventions/recovery-1/evidence/external_context/evidence-patch.md"],
        validation_focus: ["Run the existing failing test."],
        unchanged_contract: {
          goal: true,
          acceptance_criteria: true,
          constraints: true,
          repo_authority: true,
          sandbox: true,
          declared_artifacts: true
        }
      },
      created_at: "2026-04-24T00:00:02.000Z"
    };

    const prompt = renderHarnessPrompt(baseInvocation({
      supervisorRecoveryEnvelope: envelope,
      graphAcceptanceCriteria: ["The original graph acceptance criteria stay intact."],
      nodeAcceptanceCriteria: ["The original node acceptance criteria stay intact."],
      nodeConstraints: ["Do not broaden scope."]
    }));

    expect(prompt).toContain("## Supervisor Recovery Envelope");
    expect(prompt).toContain("The original goal, acceptance criteria, constraints, repo authority, sandbox, and declared artifacts are unchanged.");
    expect(prompt).toContain("Read the cited zod v4 docs fixture before editing.");
    expect(prompt.indexOf("## Supervisor Recovery Envelope")).toBeLessThan(
      prompt.indexOf("## Original Authored Node Task (Still Binding)")
    );
    expect(prompt).toContain("## Original Authored Node Task (Still Binding)");
    expect(prompt).not.toContain("## Supervisor Revised Task");
  });
});
