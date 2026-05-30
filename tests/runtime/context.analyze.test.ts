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
            acceptance_criteria: ["Context analysis reports launch-time pointer footprint risk."]
        },
        ...document
    }));
    expect(normalized.diagnostics).toEqual([]);
    const launch = resolveLaunchConfig(normalized.document!);
    const compilation = compileAuthoredGraph(normalized.document!, launch, normalized.lowered_managed_nodes);
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
                        support: {
                            context: [{ name: "evals", kind: "workspace_glob", path: "**/*eval*.md", what: "Pointer evidence used by the node under test.", why: "This context is required by the test scenario." }]
                        }
                    },
                    {
                        type: "exec",
                        id: "explicit_venv",
                        command: "true",
                        support: {
                            context: [{ name: "venv", kind: "workspace_glob", path: ".venv/*eval*.md", what: "Pointer evidence used by the node under test.", why: "This context is required by the test scenario." }]
                        }
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
    it("warns for broad context globs while reporting pointer sizes", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-analysis-footprint-"));
        const repoDir = join(tempRoot, "repo");
        await mkdir(repoDir, { recursive: true });
        await writeFile(join(repoDir, "first.md"), "one two three four five\n", "utf8");
        await writeFile(join(repoDir, "second.md"), "six seven eight nine ten\n", "utf8");
        const graph = compileGraph({
            version: "1",
            graph_id: "context-analysis-footprint",
            repos: { main: { path: "." } },
            defaults: { launch_profile: "default" },
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
                        type: "exec",
                        id: "consumer",
                        command: "true",
                        support: {
                            context: [{ name: "all_markdown", kind: "workspace_glob", path: "*.md", what: "Pointer evidence used by the node under test.", why: "This context is required by the test scenario." }]
                        }
                    }
                ]
            }
        });
        const report = await analyzeGraphContext({
            graph,
            repo_workspaces: { main: repoDir }
        });
        expect(report.status).toBe("warnings");
        expect(report.nodes[0]!.pointer_count).toBe(2);
        expect(report.nodes[0]!.total_size_bytes).toBeGreaterThan(0);
        expect(report.nodes[0]!.warnings).toEqual(expect.arrayContaining([expect.stringContaining("has no max_files cap")]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("blocks missing required static context before launch", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-analysis-missing-static-"));
        const repoDir = join(tempRoot, "repo");
        await mkdir(repoDir, { recursive: true });
        const graph = compileGraph({
            version: "1",
            graph_id: "context-analysis-missing-static",
            repos: { main: { path: "." } },
            defaults: { launch_profile: "default" },
            profiles: { default: { harness: "codex-cli" } },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "consumer",
                        command: "true",
                        support: {
                            context: [
                                { name: "missing_file", kind: "workspace_file", path: "missing.md", what: "Required static context.", why: "This file must exist before launch." },
                                { name: "missing_glob", kind: "workspace_glob", path: "docs/*.md", what: "Required static context.", why: "At least one match must exist before launch." },
                                { name: "missing_plugin", kind: "plugin_file", path: join(tempRoot, "plugin-missing.md"), what: "Required plugin context.", why: "Plugin context must exist before launch." }
                            ]
                        }
                    }
                ]
            }
        });
        const report = await analyzeGraphContext({
            graph,
            repo_workspaces: { main: repoDir }
        });
        const itemErrors = report.nodes[0]!.items.flatMap((item) => item.errors);
        expect(report.status).toBe("blocked");
        expect(report.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ severity: "error", message: expect.stringContaining("workspace_file") }),
            expect.objectContaining({ severity: "error", message: expect.stringContaining("workspace_glob") }),
            expect.objectContaining({ severity: "error", message: expect.stringContaining("plugin_file") })
        ]));
        expect(itemErrors).toEqual(expect.arrayContaining([
            expect.stringContaining("missing.md"),
            expect.stringContaining("docs/*.md"),
            expect.stringContaining("plugin-missing.md")
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not preflight artifact refs by file existence", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-context-analysis-artifact-ref-"));
        const repoDir = join(tempRoot, "repo");
        await mkdir(repoDir, { recursive: true });
        const graph = compileGraph({
            version: "1",
            graph_id: "context-analysis-artifact-ref",
            repos: { main: { path: "." } },
            defaults: { launch_profile: "default" },
            profiles: { default: { harness: "codex-cli" } },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "produce",
                        command: "true",
                        artifacts: {
                            handoff: {
                                from: "output_dir",
                                path: "handoff.md",
                                description: "Runtime-produced handoff."
                            }
                        }
                    },
                    {
                        type: "exec",
                        id: "consume",
                        command: "true",
                        support: {
                            context: [
                                { name: "handoff", kind: "artifact", ref: "produce.handoff", what: "Runtime-produced context.", why: "Produced context flows through artifacts." }
                            ]
                        }
                    }
                ]
            }
        });
        const report = await analyzeGraphContext({
            graph,
            repo_workspaces: { main: repoDir }
        });
        expect(report.status).toBe("passed");
        expect(report.diagnostics).toEqual([]);
        await rm(tempRoot, { recursive: true, force: true });
    });
});
