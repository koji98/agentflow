import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { summarizeAuthoredGraph, validateAuthoredGraphDocument } from "../../src/graph/validate.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/repeat.graph.json", import.meta.url)
);

async function readFixture(): Promise<unknown> {
  const contents = await readFile(fixturePath, "utf8");
  return JSON.parse(contents) as unknown;
}

describe("graph validation", () => {
  it("normalizes and summarizes the repeat fixture", async () => {
    const normalized = normalizeAuthoredGraphDocument(await readFixture());

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.document).toBeDefined();
    expect(normalized.lowered_managed_nodes).toEqual([]);

    const summary = summarizeAuthoredGraph(normalized.document!);

    expect(summary).toEqual({
      graph_id: "repeat-graph",
      node_count: 11,
      executable_node_count: 7,
      container_node_count: 4,
      profile_count: 2,
      repo_count: 1,
      repeat_count: 1,
      node_kind_counts: {
        agent: 4,
        exec: 2,
        check: 1,
        sequence: 2,
        parallel: 1,
        repeat: 1
      }
    });
  });

  it("rejects repeat.until references that do not resolve to descendant checks", () => {
    const diagnostics = validateAuthoredGraphDocument({
      version: "1",
      graph_id: "invalid-repeat",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {
          harness: "codex-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "repeat",
            id: "retry",
            max_attempts: 2,
            body: {
              type: "sequence",
              id: "body",
              steps: [
                {
                  type: "exec",
                  id: "lint",
                  command: "npm"
                }
              ]
            },
            until: {
              node: "lint"
            }
          }
        ]
      }
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].until.node",
          message: expect.stringContaining("descendant check node")
        })
      ])
    );
  });

  it("rejects check fields that do not apply to the selected check kind", () => {
    const diagnostics = validateAuthoredGraphDocument({
      version: "1",
      graph_id: "invalid-check-fields",
      repos: {
        main: {
          path: "."
        }
      },
      defaults: {
        launch_profile: "default"
      },
      profiles: {
        default: {
          harness: "codex-cli"
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "check",
            id: "deterministic_gate",
            check_kind: "deterministic",
            command: "npm",
            prompt: "This should not be allowed.",
            model: "gpt-5"
          },
          {
            type: "check",
            id: "ai_gate",
            check_kind: "ai",
            prompt: "Evaluate the change.",
            command: "npm",
            pass_if: {
              exit_code: 0
            }
          }
        ]
      }
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.graph.steps[0].prompt",
          message: expect.stringContaining("does not apply to deterministic checks")
        }),
        expect.objectContaining({
          path: "$.graph.steps[0].model",
          message: expect.stringContaining("does not apply to deterministic checks")
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].command",
          message: expect.stringContaining("does not apply to AI checks")
        }),
        expect.objectContaining({
          path: "$.graph.steps[1].pass_if",
          message: expect.stringContaining("does not apply to AI checks")
        })
      ])
    );
  });
});
