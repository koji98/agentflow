import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  checkpointPromptTestUtils,
  collectCheckpointTerminalDiagnostics,
  createInteractiveCheckpointExecutor,
  type CheckpointPromptAdapter
} from "../../src/cli/checkpoint.js";
import type { CompiledCheckpointNode, CompiledGraph } from "../../src/graph/compiled.js";

class FakePromptAdapter implements CheckpointPromptAdapter {
  private readonly responses: string[];
  readonly writes: string[] = [];

  constructor(responses: string[]) {
    this.responses = [...responses];
  }

  write(chunk: string): void {
    this.writes.push(chunk);
  }

  async readLine(_prompt: string): Promise<string> {
    return this.responses.shift() ?? "";
  }

  close(): void {
    return;
  }
}

function createCheckpointNode(): CompiledCheckpointNode {
  return {
    compiled_id: "root__review",
    authored_id: "review",
    kind: "checkpoint",
    repo: "main",
    deps: ["root__draft"],
    scope_stack: [],
    effective_policy: {
      profile_name: "default",
      sandbox: "workspace-write",
      timeout_sec: 60
    },
    inputs: [],
    context_from: [],
    declared_outputs: [
      {
        name: "operator_feedback",
        from: "attempt",
        path: "operator-feedback.md",
        required: false
      }
    ],
    prompt: "Review the draft.",
    review_from: {
      node: "draft",
      include: "output",
      output: "draft_spec"
    }
  };
}

describe("checkpoint CLI helpers", () => {
  it("accepts only valid menu selections before passing", async () => {
    const adapter = new FakePromptAdapter(["4", "1"]);

    const decision = await checkpointPromptTestUtils.promptForDecision(adapter);

    expect(decision).toEqual({
      decision: "pass"
    });
    expect(adapter.writes.join("")).toContain("Choose 1, 2, or 3.");
  });

  it("requires non-empty deny feedback and preserves multiline input", async () => {
    const adapter = new FakePromptAdapter(["2", "", "First line", "Second line", ""]);

    const decision = await checkpointPromptTestUtils.promptForDecision(adapter);

    expect(decision).toEqual({
      decision: "deny",
      feedback: "First line\nSecond line"
    });
    expect(adapter.writes.join("")).toContain("Feedback is required when denying the checkpoint.");
  });

  it("preflights checkpoint graphs for interactive TTY support", () => {
    const graph: CompiledGraph = {
      graph_id: "checkpoint-graph",
      launch: {
        launch_profile: "default",
        workspace_backend: "inplace"
      },
      entry_node_ids: ["root__review"],
      nodes: [createCheckpointNode()],
      edges: [],
      scopes: [],
      authored_to_compiled: {
        review: ["root__review"]
      }
    };

    expect(
      collectCheckpointTerminalDiagnostics(graph, {
        stdin: {
          isTTY: false
        } as NodeJS.ReadableStream,
        stderr: {
          isTTY: true
        } as NodeJS.WritableStream
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("interactive TTY stdin and stderr")
        })
      ])
    );
  });

  it("renders checkpoint review output to stderr and leaves no feedback file on pass", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-checkpoint-pass-"));
    const executionDir = join(tempRoot, "execution");
    const reviewPath = join(executionDir, "context_materialized", "context_1", "spec-revision.md");
    const packetPath = join(executionDir, "context_packet.json");
    const summaryPath = join(executionDir, "context_summary.md");
    const stderrChunks: string[] = [];

    await mkdir(join(executionDir, "context_materialized", "context_1"), {
      recursive: true
    });
    await writeFile(reviewPath, `${"line\n".repeat(60)}`, "utf8");
    await writeFile(
      packetPath,
      JSON.stringify({
        execution_id: "exec__review__attempt_1",
        compiled_id: "root__review",
        authored_id: "review",
        repo_alias: "main",
        workspace_path: "/repo",
        materials: [
          {
            key: "context_1",
            kind: "context",
            source: {
              node: "draft",
              include: "output",
              output: "draft_spec"
            },
            materialized_path: reviewPath,
            bytes: 300,
            truncated: false
          }
        ],
        omitted: [],
        totals: {
          material_count: 1,
          file_count: 1,
          total_bytes: 300
        }
      }),
      "utf8"
    );
    await writeFile(summaryPath, "Context summary\n", "utf8");

    const adapter = new FakePromptAdapter(["1"]);
    const executor = createInteractiveCheckpointExecutor({
      streams: {
        stdin: Readable.from([]) as NodeJS.ReadableStream,
        stderr: new Writable({
          write(chunk, _encoding, callback) {
            stderrChunks.push(String(chunk));
            callback();
          }
        }) as NodeJS.WritableStream
      },
      create_prompt_adapter: () => ({
        write(chunk) {
          stderrChunks.push(chunk);
        },
        readLine(prompt) {
          stderrChunks.push(prompt);
          return adapter.readLine(prompt);
        },
        close() {
          return;
        }
      })
    });

    const result = await executor({
      run_id: "run-1",
      node: createCheckpointNode(),
      attempt: {
        execution_id: "exec__review__attempt_1",
        compiled_id: "root__review",
        authored_id: "review",
        kind: "checkpoint",
        repo_alias: "main",
        execution_dir: executionDir,
        attempt_index: 1,
        status: "running",
        started_at: new Date().toISOString(),
        output_artifacts: {},
        metadata: {}
      },
      workspace_path: tempRoot,
      execution_dir: executionDir,
      context_packet_path: packetPath,
      context_summary_path: summaryPath,
      signal: undefined
    });

    expect(result.status).toBe("passed");
    expect(stderrChunks.join("")).toContain("Checkpoint: review");
    expect(stderrChunks.join("")).toContain("[preview truncated]");

    await expect(access(join(executionDir, "operator-feedback.md"))).rejects.toThrow();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("writes multiline feedback on deny", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-checkpoint-deny-"));
    const executionDir = join(tempRoot, "execution");
    const reviewPath = join(executionDir, "context_materialized", "context_1", "spec-revision.md");
    const packetPath = join(executionDir, "context_packet.json");
    const summaryPath = join(executionDir, "context_summary.md");

    await mkdir(join(executionDir, "context_materialized", "context_1"), {
      recursive: true
    });
    await writeFile(reviewPath, "draft\n", "utf8");
    await writeFile(
      packetPath,
      JSON.stringify({
        execution_id: "exec__review__attempt_1",
        compiled_id: "root__review",
        authored_id: "review",
        repo_alias: "main",
        workspace_path: "/repo",
        materials: [
          {
            key: "context_1",
            kind: "context",
            source: {
              node: "draft",
              include: "output",
              output: "draft_spec"
            },
            materialized_path: reviewPath,
            bytes: 6,
            truncated: false
          }
        ],
        omitted: [],
        totals: {
          material_count: 1,
          file_count: 1,
          total_bytes: 6
        }
      }),
      "utf8"
    );
    await writeFile(summaryPath, "Context summary\n", "utf8");

    const adapter = new FakePromptAdapter(["2", "", "Add rollback details", "Define owner", ""]);
    const executor = createInteractiveCheckpointExecutor({
      streams: {
        stdin: Readable.from([]) as NodeJS.ReadableStream,
        stderr: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          }
        }) as NodeJS.WritableStream
      },
      create_prompt_adapter: () => adapter
    });

    const result = await executor({
      run_id: "run-1",
      node: createCheckpointNode(),
      attempt: {
        execution_id: "exec__review__attempt_1",
        compiled_id: "root__review",
        authored_id: "review",
        kind: "checkpoint",
        repo_alias: "main",
        execution_dir: executionDir,
        attempt_index: 1,
        status: "running",
        started_at: new Date().toISOString(),
        output_artifacts: {},
        metadata: {}
      },
      workspace_path: tempRoot,
      execution_dir: executionDir,
      context_packet_path: packetPath,
      context_summary_path: summaryPath,
      signal: undefined
    });

    expect(result.status).toBe("failed");
    expect(await readFile(join(executionDir, "operator-feedback.md"), "utf8")).toBe(
      "Add rollback details\nDefine owner\n"
    );

    await rm(tempRoot, { recursive: true, force: true });
  });
});
