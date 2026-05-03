import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompiledAgentNode } from "../../src/graph/compiled.js";
import { resolveExecutionArtifactsDirectory } from "../../src/artifacts/paths.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import {
  buildCompletionPacket,
  buildCompletionProjection,
  persistCompletionPacket
} from "../../src/runtime/completion/index.js";

function makeNode(overrides: Partial<CompiledAgentNode> = {}): CompiledAgentNode {
  return {
    compiled_id: "ship",
    authored_id: "ship",
    kind: "agent",
    intent: {
      goal: "Ship the implementation.",
      acceptance_criteria: ["The implementation satisfies the authored contract."],
      constraints: []
    },
    repo: "main",
    deps: [],
    scope_stack: ["root"],
    effective_policy: {
      profile_name: "default",
      sandbox: "workspace-write",
      timeout_sec: 60,
      input_rules: {},
      artifact_repair: { max_attempts: 0 }
    },
    context: [],
    declared_artifacts: {
      implementation_summary: {
        from: "output_dir",
        path: "implementation-summary.md",
        description: "Summarize implementation, validation, and risks."
      }
    },
    tools: [],
    ...overrides
  };
}

function makeAttempt(executionDir: string, overrides: Partial<RuntimeNodeAttempt> = {}): RuntimeNodeAttempt {
  return {
    execution_id: "exec__ship__attempt_1",
    compiled_id: "ship",
    authored_id: "ship",
    kind: "agent",
    repo_alias: "main",
    execution_dir: executionDir,
    attempt_index: 1,
    status: "running",
    started_at: "2026-05-03T12:00:00.000Z",
    artifacts: {},
    metadata: {},
    ...overrides
  };
}

describe("completion packet", () => {
  let tempRoot: string;
  let runRoot: string;
  let workspace: string;
  let executionDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentflow-completion-"));
    runRoot = join(tempRoot, "run");
    workspace = join(tempRoot, "workspace");
    executionDir = join(runRoot, "nodes", "node-ship", "executions", "001-ship");
    await mkdir(resolveExecutionArtifactsDirectory(executionDir), { recursive: true });
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("marks a missing declared artifact incomplete and persists the packet", async () => {
    const packet = await buildCompletionPacket({
      runRoot,
      node: makeNode(),
      attempt: makeAttempt(executionDir),
      workspacePath: workspace,
      sandbox: "workspace-write"
    });

    expect(packet.completion_status).toBe("incomplete");
    expect(packet.ready_for_verification).toBe(false);
    expect(packet.missing_artifacts).toEqual(["implementation_summary"]);
    expect(packet.declared_artifacts[0]).toEqual(
      expect.objectContaining({
        name: "implementation_summary",
        status: "missing",
        current_attempt: false
      })
    );

    const packetPath = await persistCompletionPacket(packet);
    await expect(readFile(packetPath, "utf8")).resolves.toContain('"completion_status": "incomplete"');
  });

  it("blocks read-only nodes with declared write artifacts", async () => {
    const packet = await buildCompletionPacket({
      runRoot,
      node: makeNode({
        effective_policy: {
          profile_name: "default",
          sandbox: "read-only",
          timeout_sec: 60,
          input_rules: {},
          artifact_repair: { max_attempts: 0 }
        }
      }),
      attempt: makeAttempt(executionDir),
      workspacePath: workspace,
      sandbox: "read-only"
    });

    expect(packet.completion_status).toBe("blocked");
    expect(packet.blocking_reasons.join("\n")).toContain("read-only sandbox");
  });

  it("rejects empty and placeholder declared artifacts before semantic verification", async () => {
    const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
    await writeFile(artifactPath, "TODO: fill this in before shipping.\n", "utf8");

    const packet = await buildCompletionPacket({
      runRoot,
      node: makeNode(),
      attempt: makeAttempt(executionDir, {
        artifacts: { implementation_summary: artifactPath }
      }),
      workspacePath: workspace,
      sandbox: "workspace-write"
    });

    expect(packet.completion_status).toBe("incomplete");
    expect(packet.artifact_findings).toEqual([
      expect.objectContaining({
        artifact: "implementation_summary",
        kind: "placeholder"
      })
    ]);
  });

  it("distinguishes current-attempt artifacts from stale prior-attempt artifacts", async () => {
    const priorArtifactPath = join(tempRoot, "prior", "implementation-summary.md");
    await mkdir(join(tempRoot, "prior"), { recursive: true });
    await writeFile(priorArtifactPath, "prior handoff\n", "utf8");

    const packet = await buildCompletionPacket({
      runRoot,
      node: makeNode(),
      attempt: makeAttempt(executionDir),
      priorAttempts: [
        makeAttempt(join(tempRoot, "prior-exec"), {
          execution_id: "exec__ship__attempt_0",
          attempt_index: 0,
          status: "passed",
          outcome: "passed",
          artifacts: { implementation_summary: priorArtifactPath }
        })
      ],
      workspacePath: workspace,
      sandbox: "workspace-write"
    });

    expect(packet.completion_status).toBe("incomplete");
    expect(packet.artifact_findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact: "implementation_summary",
        kind: "stale_prior_attempt",
        evidence_ref: priorArtifactPath
      })
    ]));
  });

  it("requires validation evidence only for unambiguous literal commands", async () => {
    const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
    await writeFile(artifactPath, "real handoff\n", "utf8");

    const broadPacket = await buildCompletionPacket({
      runRoot,
      node: makeNode({
        intent: {
          goal: "Ship the implementation.",
          acceptance_criteria: ["Tests pass.", "Reviewer guide explains risk."],
          constraints: []
        }
      }),
      attempt: makeAttempt(executionDir, {
        artifacts: { implementation_summary: artifactPath }
      }),
      workspacePath: workspace,
      sandbox: "workspace-write"
    });
    expect(broadPacket.completion_status).toBe("ready_for_verification");
    expect(broadPacket.validation_evidence).toEqual([]);

    const literalPacket = await buildCompletionPacket({
      runRoot,
      node: makeNode({
        intent: {
          goal: "Ship the implementation.",
          acceptance_criteria: ["`npm test` exits successfully."],
          constraints: []
        }
      }),
      attempt: makeAttempt(executionDir, {
        artifacts: { implementation_summary: artifactPath }
      }),
      workspacePath: workspace,
      sandbox: "workspace-write"
    });
    expect(literalPacket.completion_status).toBe("incomplete");
    expect(literalPacket.validation_evidence).toEqual([
      expect.objectContaining({
        requirement: "npm test",
        status: "missing_evidence"
      })
    ]);
  });

  it("treats active blocking findings as blocked completion evidence", async () => {
    await mkdir(join(runRoot, "runtime"), { recursive: true });
    await writeFile(
      join(runRoot, "runtime", "log.jsonl"),
      `${JSON.stringify({
        log_id: "log-1",
        execution_id: "exec__ship__attempt_1",
        type: "finding",
        finding_kind: "blocker",
        blocking: true,
        summary: "External worker is unavailable.",
        evidence: [{ kind: "external_state", ref: "worker", summary: "worker offline" }],
        created_at: "2026-05-03T12:01:00.000Z"
      })}\n`,
      "utf8"
    );
    const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
    await writeFile(artifactPath, "real handoff\n", "utf8");

    const packet = await buildCompletionPacket({
      runRoot,
      node: makeNode(),
      attempt: makeAttempt(executionDir, {
        artifacts: { implementation_summary: artifactPath }
      }),
      workspacePath: workspace,
      sandbox: "workspace-write"
    });

    expect(packet.completion_status).toBe("blocked");
    expect(packet.active_blockers).toHaveLength(1);
    expect(packet.blocking_reasons).toContain("External worker is unavailable.");
  });

  it("does not count non-terminal spawned helpers as completion evidence", async () => {
    await mkdir(join(runRoot, "runtime", "helpers", "helper_pending"), { recursive: true });
    await writeFile(
      join(runRoot, "runtime", "helpers", "helper_pending", "session.json"),
      `${JSON.stringify({
        agent_id: "helper_pending",
        parent_agent_id: "exec__ship__attempt_1",
        run_id: "run-test",
        status: "running",
        purpose: "verification",
        brief: "Verify the implementation.",
        output_dir: join(runRoot, "runtime", "helpers", "helper_pending", "artifacts"),
        log_path: join(runRoot, "runtime", "helpers", "helper_pending", "logs", "harness.log"),
        result_path: join(runRoot, "runtime", "helpers", "helper_pending", "result.json"),
        artifacts: {
          "helper-report.md": join(runRoot, "runtime", "helpers", "helper_pending", "artifacts", "helper-report.md")
        },
        created_at: "2026-05-03T12:01:00.000Z"
      }, null, 2)}\n`,
      "utf8"
    );
    const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
    await writeFile(artifactPath, "real handoff\n", "utf8");

    const packet = await buildCompletionPacket({
      runRoot,
      node: makeNode(),
      attempt: makeAttempt(executionDir, {
        artifacts: { implementation_summary: artifactPath }
      }),
      workspacePath: workspace,
      sandbox: "workspace-write"
    });

    expect(packet.completion_status).toBe("incomplete");
    expect(packet.helpers).toEqual(
      expect.objectContaining({
        active: 1,
        pending: 1,
        completed: 0,
        missing_artifacts: ["helper_pending:helper-report.md"]
      })
    );
    expect(packet.blocking_reasons).toContain("Helper helper_pending is running and has not produced required evidence.");
  });

  it("folds completed helper artifacts into completion packets", async () => {
    const helperRoot = join(runRoot, "runtime", "helpers", "helper_done");
    const helperArtifact = join(helperRoot, "artifacts", "helper-report.md");
    await mkdir(join(helperRoot, "artifacts"), { recursive: true });
    await writeFile(helperArtifact, "helper verification passed\n", "utf8");
    await writeFile(
      join(helperRoot, "session.json"),
      `${JSON.stringify({
        agent_id: "helper_done",
        parent_agent_id: "exec__ship__attempt_1",
        run_id: "run-test",
        status: "completed",
        purpose: "verification",
        brief: "Verify the implementation.",
        output_dir: join(helperRoot, "artifacts"),
        log_path: join(helperRoot, "logs", "harness.log"),
        result_path: join(helperRoot, "result.json"),
        artifacts: {
          "helper-report.md": helperArtifact
        },
        created_at: "2026-05-03T12:01:00.000Z",
        ended_at: "2026-05-03T12:02:00.000Z",
        exit_code: 0
      }, null, 2)}\n`,
      "utf8"
    );
    const artifactPath = join(resolveExecutionArtifactsDirectory(executionDir), "implementation-summary.md");
    await writeFile(artifactPath, "real handoff\n", "utf8");

    const packet = await buildCompletionPacket({
      runRoot,
      node: makeNode(),
      attempt: makeAttempt(executionDir, {
        artifacts: { implementation_summary: artifactPath }
      }),
      workspacePath: workspace,
      sandbox: "workspace-write"
    });

    expect(packet.completion_status).toBe("ready_for_verification");
    expect(packet.helpers).toEqual(
      expect.objectContaining({
        active: 1,
        completed: 1,
        pending: 0,
        failed: 0,
        missing_artifacts: []
      })
    );
    expect(packet.helpers.latest[0]).toEqual(
      expect.objectContaining({
        agent_id: "helper_done",
        purpose: "verification",
        status: "completed",
        artifact_refs: [helperArtifact]
      })
    );
  });

  it("builds compact projections without raw logs or artifact bodies", async () => {
    const packet = await buildCompletionPacket({
      runRoot,
      node: makeNode(),
      attempt: makeAttempt(executionDir),
      workspacePath: workspace,
      sandbox: "workspace-write"
    });

    const projection = buildCompletionProjection(packet, { maxItems: 2 });

    expect(projection).toEqual(
      expect.objectContaining({
        completion_status: "incomplete",
        blocking_reasons: expect.arrayContaining([
          expect.stringContaining("Missing expected artifact")
        ]),
        packet_path: packet.packet_path
      })
    );
    expect(JSON.stringify(projection)).not.toContain("TODO");
    expect(JSON.stringify(projection)).not.toContain("runtime_logs_raw");
  });
});
