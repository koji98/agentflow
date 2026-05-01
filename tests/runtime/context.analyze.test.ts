import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AuthoredGraphDocument } from "../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../src/graph/profiles.js";
import { analyzeGraphContext } from "../../src/runtime/context/analyze.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";

function compileGraph(document: AuthoredGraphDocument) {
  const normalized = normalizeAuthoredGraphDocument(withNodeIntentDefaults({
    intent: {
      goal: "Analyze node context before launch.",
      acceptance_criteria: ["Context analysis reports launch-time token risk."]
    },
    ...document
  }));
  expect(normalized.diagnostics).toEqual([]);
  const launch = resolveLaunchConfig(normalized.document!);
  const compilation = compileAuthoredGraph(
    normalized.document!,
    launch,
    normalized.lowered_managed_nodes
  );

  expect(compilation.diagnostics).toEqual([]);
  expect(compilation.compiled_graph).toBeDefined();
  return compilation.compiled_graph!;
}

describe("context analysis", () => {
  it("honors default ignored dependency trees while allowing explicit ignored-root opt-in", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-analysis-ignore-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(join(repoDir, "src"), { recursive: true });
    await mkdir(join(repoDir, ".venv"), { recursive: true });
    await writeFile(join(repoDir, "src", "useful-eval.md"), "useful context\n", "utf8");
    await writeFile(join(repoDir, ".venv", "noisy-eval.md"), "ignored context\n", "utf8");

    const graph = compileGraph({
      version: "1",
      graph_id: "context-analysis-ignore",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default" },
      profiles: { default: { harness: "codex-cli" } },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "normal_glob",
            command: "true",
            context: [{ name: "evals", from: "workspace_glob", path: "**/*eval*.md" }]
          },
          {
            type: "exec",
            id: "explicit_venv",
            command: "true",
            context: [{ name: "venv", from: "workspace_glob", path: ".venv/*eval*.md" }]
          }
        ]
      }
    });

    const report = await analyzeGraphContext({
      graph,
      repo_workspaces: { main: repoDir }
    });

    const normal = report.nodes.find((node) => node.authored_id === "normal_glob")!.items[0]!;
    expect(normal.kind).toBe("workspace_glob");
    expect(normal.match_count).toBe(1);
    expect(normal.sample_matches).toEqual(["src/useful-eval.md"]);
    expect(normal.default_ignored_roots).toContain(".venv");

    const explicit = report.nodes.find((node) => node.authored_id === "explicit_venv")!.items[0]!;
    expect(explicit.match_count).toBe(1);
    expect(explicit.sample_matches).toEqual([".venv/noisy-eval.md"]);

    await rm(tempRoot, { recursive: true, force: true });
  });

  it("blocks run-ready analysis when projected context exceeds max_total_tokens", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-analysis-budget-"));
    const repoDir = join(tempRoot, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "first.md"), "one two three four five\n", "utf8");
    await writeFile(join(repoDir, "second.md"), "six seven eight nine ten\n", "utf8");

    const graph = compileGraph({
      version: "1",
      graph_id: "context-analysis-budget",
      repos: { main: { path: "." } },
      defaults: { launch_profile: "default" },
      profiles: {
        default: {
          harness: "codex-cli",
          input_rules: {
            max_total_tokens: 3,
            max_tokens_per_item: 100
          }
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [
          {
            type: "exec",
            id: "consumer",
            command: "true",
            context: [{ name: "all_markdown", from: "workspace_glob", path: "*.md" }]
          }
        ]
      }
    });

    const report = await analyzeGraphContext({
      graph,
      repo_workspaces: { main: repoDir }
    });

    expect(report.status).toBe("blocked");
    expect(report.nodes[0]!.would_exceed_total).toBe(true);
    expect(report.nodes[0]!.projected_total_tokens).toBeGreaterThan(3);

    await rm(tempRoot, { recursive: true, force: true });
  });
});
