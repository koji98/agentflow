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
    contextPacketPath: "/tmp/run/runtime/context.json",
    contextManifestPath: "/tmp/run/agent/context.md",
    contextManifest: "# Context Manifest\n\n## Pointers\n\n| Name | Kind | Pointer | What | Why |\n| --- | --- | --- | --- | --- |\n| `requirements` | `workspace_file` | `/tmp/requirements.md` | Requirements. | Needed for this node. |\n",
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
      "## Success Contract",
      "## Contract Priority",
      "## Workspace",
      "## Working Loop",
      "## Graph Context",
      "## Context",
      "## Agentflow Runtime CLI",
      "## Declared Artifacts",
      "## Completion Gate"
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
    expect(prompt.indexOf("## Success Contract")).toBeLessThan(prompt.indexOf("## Graph Context"));
    expect(prompt).toContain("The node task is the controlling objective.");
    expect(prompt).toContain("Why this node exists.");
    expect(prompt).not.toContain("## Diagnostics");
  });

  it("keeps context agent-facing and omits runtime/debug metadata", () => {
    const prompt = renderHarnessPrompt(baseInvocation());

    expect(prompt).toContain("Open only the source pointers relevant to this task.");
    expect(prompt).not.toContain("Pointer items");
    expect(prompt).not.toContain("Omitted items");
    expect(prompt).not.toContain("/tmp/run/output");
    expect(prompt).not.toContain("Output directory");
    expect(prompt).not.toContain("Context packet:");
    expect(prompt).not.toContain("Context provenance:");
    expect(prompt).not.toContain("provenance.json");
    expect(prompt).not.toContain("context.json");
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

  it("keeps declared artifact prompting compact and delegates mechanical checks to completion", () => {
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

    expect(prompt).toContain("## Declared Artifacts");
    expect(prompt).toContain("Publish content with `af artifact write <name>` using stdin.");
    expect(prompt).toContain("include the exact command and observed result/output");
    expect(prompt).toContain("include that exact wording in the artifact instead of only paraphrasing it");
    expect(prompt).toContain("render them as Markdown headings such as `## Scenario`, `## Changed files`, and `## Validation`");
    expect(prompt).toContain("Do not write stale completion language");
    expect(prompt).toContain("| `handoff` | `af artifact write handoff` | Handoff with literal Scenario:, Validation:, and Risks: fields. |");
    expect(prompt).not.toContain("| `handoff` | `/tmp/run/output/handoff.md` |");
    expect(prompt).not.toContain("If the node task, authored goal, acceptance criteria, or artifact description names required labels");
    expect(prompt).not.toContain("Do not use `/tmp`");
    expect(prompt).not.toContain("--file <path>");
  });

  it("renders a Working Loop section that anchors iterate-until-done behavior on the agent path", () => {
    const prompt = renderHarnessPrompt(baseInvocation());

    expect(prompt).toContain("## Working Loop");
    expect(prompt).toContain("Drive the node to completion within its boundary");
    expect(prompt).toContain("Run `af orient` before material work.");
    expect(prompt).toContain("Rerun `af orient` whenever the goal, acceptance criteria, context pointers, artifact expectations, retry state, or next action becomes unclear.");
    expect(prompt).toContain("If conversational continuity is lost after compaction, a long pause, or a long-running task drift, rerun `af orient` to re-ground before continuing.");
    expect(prompt).toContain("Understand the plan before committing to execution milestones");
    expect(prompt).toContain("read any relevant plan, research, context pointer, or supervisor recovery brief");
    expect(prompt).toContain("If no adequate plan exists, do the necessary discovery and planning required to choose a defensible execution path.");
    expect(prompt).toContain("There is no discovery quota or ceiling");
    expect(prompt).toContain("create a planning/research milestone first");
    expect(prompt).toContain("Create meaningful execution milestones with `af milestone add`");
    expect(prompt).toContain("add more as evidence changes instead of forcing the initial plan to fit");
    expect(prompt).toContain("Attach findings, decisions, and validation evidence with `af milestone log`.");
    expect(prompt).toContain("validation logs are not a substitute for required decision evidence");
    expect(prompt).toContain('quote the full command as one `--command "..."` value');
    expect(prompt).toContain("Publish declared artifacts with `af artifact write <name>` using stdin.");
    expect(prompt).toContain("When the node task names an exact command, attempt that command exactly at least once");
    expect(prompt).toContain("af complete check");
    expect(prompt).toContain("treat that output as repair feedback");
    expect(prompt).toContain("block the active milestone with evidence before the final response");
    expect(prompt).not.toContain("af log --type");
    expect(prompt).not.toContain("Every `af log --evidence` JSON value");
    expect(prompt).toContain("Investigate ambiguity instead of guessing");
    expect(prompt).toContain("Agentflow is the runner, not the work target.");
    expect(prompt).toContain("Use the node task and graph context pointers as the contract for this node.");
    expect(prompt).not.toContain("ambient skills");
    expect(prompt).not.toContain("Agentflow playbooks");
    expect(prompt).not.toContain("AGENTS.md files outside");
    expect(prompt).not.toContain("unrelated Agentflow docs");
    expect(prompt).not.toContain("af context show");
    expect(prompt).not.toContain("af status");
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
    const nodeTaskIdx = prompt.indexOf("## Success Contract");
    expect(workingLoopIdx).toBeGreaterThan(-1);
    expect(nodeTaskIdx).toBeLessThan(workingLoopIdx);
  });

  it("does not include the Working Loop on read-only ai_check or outcome_verification prompts", () => {
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
	          repairBriefPath: "/tmp/run/agent/artifact-repair.md",
	          priorResponsePath: "/tmp/run/output/agent-response.md",
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
    expect(repairPrompt).toContain("af milestone add");

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
	        repairBriefPath: "/tmp/run/agent/artifact-repair.md",
	        priorResponsePath: "/tmp/run/output/agent-response.md",
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
	    expect(prompt).toContain("Repair brief: /tmp/run/agent/artifact-repair.md");
	    expect(prompt).not.toContain("expected absolute path");
	    expect(prompt).not.toContain("/tmp/run/output/handoff.md");
	    expect(prompt).toContain("create a repair milestone");
	    expect(prompt).toContain("publish each missing artifact with `af artifact write <name>`");
	    expect(prompt).not.toContain("human-debug");
	    expect(prompt).not.toContain("stdout.log");
	    expect(prompt).not.toContain("stderr.log");
    expect(prompt).not.toContain("Keep artifact drafts inside the output directory");
    expect(prompt).not.toContain("Do not use `/tmp`, `/private/tmp`, or another external temp directory");
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
      resume_point: "continue_from_prior_progress",
      workspace_decision: "preserve",
      resume_decision: {
        resume_point: "continue_from_prior_progress",
        restart_boundary: "node_attempt",
        workspace_decision: "preserve",
        reuse: ["Existing artifact content from the prior attempt is still usable evidence."],
        discard: ["Discard the failed v3 API assumption."],
        reason_code: "evidence_delta_retry",
        confidence: "high",
        evidence: ["Supervisor found version-matched docs for the retry."],
        required_next_action: "Read the cited zod v4 docs fixture, then repair the API usage.",
        validation_gate: ["Run the existing failing test."]
      },
      preserve_progress: ["Existing artifact content from the prior attempt is still usable evidence."],
      do_not_redo: ["Do not repeat the failed v3 API assumption."],
      required_next_action: "Read the cited zod v4 docs fixture, then repair the API usage.",
      retry_directive: {
        summary: "The first attempt used the wrong v4 API.",
        must_do: ["Read the cited zod v4 docs fixture before editing."],
        must_not_do: ["Do not change acceptance criteria."],
        evidence_to_read: [
          "/tmp/run/exec-0/human-debug/interventions/recovery-1/evidence/external_context/evidence-patch.md",
          "/tmp/run/exec-0/runtime/context.json",
          "/tmp/run/exec-0/agent/context.md",
          "/tmp/run/exec-0/artifacts/prior-handoff.md"
        ],
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

    expect(prompt).toContain("## Supervisor Recovery Case");
    expect(prompt).toContain("Resume point");
    expect(prompt).toContain("continue_from_prior_progress");
    expect(prompt).toContain("Workspace decision");
    expect(prompt).toContain("preserve");
    expect(prompt).toContain("Read the cited zod v4 docs fixture, then repair the API usage.");
    expect(prompt).toContain("Retry from the selected resume point while preserving the original node contract and useful prior progress.");
    expect(prompt).toContain("Read the cited zod v4 docs fixture before editing.");
    expect(prompt).toContain("/tmp/run/exec-0/artifacts/prior-handoff.md");
    expect(prompt).not.toContain("human-debug");
    expect(prompt).not.toContain("runtime/context.json");
    expect(prompt).not.toContain("agent/context.md");
    expect(prompt).not.toContain("evidence-patch.md");
    expect(prompt).not.toContain("case-file.json");
    expect(prompt).not.toContain("recovery-plan.json");
    expect(prompt.indexOf("## Success Contract (Original Authored Node Task)")).toBeLessThan(
      prompt.indexOf("## Supervisor Recovery Case")
    );
    expect(prompt).toContain("## Success Contract (Original Authored Node Task)");
    expect(prompt).not.toContain("## Supervisor Revised Task");
  });
  it("labels supervisor evidence prompts as diagnostic audit prompts", () => {
    const prompt = renderHarnessPrompt(baseInvocation({
      promptKind: "supervisor_evidence",
      sandbox: "read-only",
      supervisorEvidence: {
        gatherKind: "local_context",
        caseFilePath: "/tmp/run/runtime/supervisor/case-file.json",
        evidencePatchPath: "/tmp/run/human-debug/interventions/evidence-patch.json",
        instructions: ["Inspect the failed attempt evidence."]
      }
    }));

    expect(prompt).toContain("diagnostic/audit helper");
    expect(prompt).toContain("audit/debug evidence");
    expect(prompt).toContain("not normal worker context");
    expect(prompt).toContain("Case file:");
  });
});
