import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    resolveExecutionAgentContextPath,
    resolveExecutionHumanDebugHarnessDirectory,
    resolveExecutionRuntimeContextPath
} from "../../src/artifacts/paths.js";
import { readRunExecutionAttempts } from "../../src/artifacts/reader.js";
import { executeCli as executeCliRaw, renderCliStdout } from "../../src/cli/index.js";
import { withNodeIntentDefaults } from "../helpers/graph.js";
const execFileAsync = promisify(execFile);
async function applyNodeIntentDefaultsToGraphFile(graphPath: string): Promise<void> {
    try {
        const graph = JSON.parse(await readFile(graphPath, "utf8")) as Record<string, unknown>;
        await writeFile(graphPath, `${JSON.stringify(withNodeIntentDefaults(graph as never), null, 2)}\n`, "utf8");
    }
    catch {
        // Tests that intentionally pass invalid paths or non-JSON graph files should keep their original failure.
    }
}
async function writeMockCodexCli(root: string): Promise<string> {
    const path = join(root, "mock-codex.mjs");
    await mkdir(root, { recursive: true });
    await writeFile(path, `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("mock-codex 0.0.0\\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  const lastMessagePath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const finish = (message) => {
    if (lastMessagePath) {
      mkdirSync(dirname(lastMessagePath), { recursive: true });
      writeFileSync(lastMessagePath, message);
    }
    process.stdout.write(message);
  };
  const bullet = (items, empty) => items.length > 0 ? items.map((item) => "- " + item) : ["- " + empty];
  if (prompt.includes("Agentflow outcome verifier")) {
    finish("\`\`\`json\\n" + JSON.stringify({ passed: true, summary: "Mock verifier accepts the attempt.", findings: [], blockers: [] }, null, 2) + "\\n\`\`\`\\n");
    return;
  }
  if (prompt.includes("Agentflow delivery curator")) {
    const sourcePath = process.env.AGENTFLOW_CONTEXT_PACKET;
    if (!sourcePath) {
      throw new Error("AGENTFLOW_CONTEXT_PACKET is required for delivery curation.");
    }
    const source = JSON.parse(readFileSync(sourcePath, "utf8"));
    const artifacts = source.final_declared_artifacts.length > 0
      ? source.final_declared_artifacts.map((artifact) => "- \`" + artifact.id + "\`: [" + artifact.declared_path + "](" + artifact.relative_path + ")")
      : ["- No final declared artifacts were captured."];
    const validation = [
      ...source.validation.milestone_validation_logs.map((log) => "- \`" + log.milestone_id + "\`: " + (log.command ? "\`" + log.command + "\` " : "") + (log.result || "recorded") + " - " + log.summary),
      ...source.validation.outcome_verifications.map((entry) => "- \`" + entry.node + "\`: " + (entry.passed ? "pass" : "fail") + " - " + entry.summary)
    ];
    const learningRows = source.workspace_improvements.length > 0
      ? source.workspace_improvements.map((entry) => "| " + entry.area + " | " + entry.recommendation + " | " + entry.evidence + " | " + entry.priority + " | " + entry.confidence + " | " + entry.done_when + " |")
      : ["| none | No action. | source packet | low | medium | No action required. |"];
    finish([
      "\`\`\`review-brief",
      "# Review Brief",
      "## Outcome",
      "Run \`" + source.run.run_id + "\` ended with status \`" + source.run.status + "\`.",
      "## Reviewer Decision",
      source.failures.active.length > 0 ? "Do not approve until active failures are resolved." : "Review changed files, final artifacts, and validation evidence.",
      "## What To Inspect First",
      "- [Change map](" + source.evidence_links.change_map + ")",
      "- [Validation ledger](" + source.evidence_links.validation_ledger + ")",
      "## Success Contract",
      source.intent.goal,
      "## Changed Files",
      "- [Change map](" + source.evidence_links.change_map + ")",
      "## Final Declared Artifacts",
      ...artifacts,
      "## Validation Evidence",
      ...(validation.length > 0 ? validation : ["- [Validation ledger](" + source.evidence_links.validation_ledger + ")"]),
      "## Active Failures And Risks",
      ...bullet(source.failures.active.map((failure) => "\`" + failure.node + "\`: " + failure.summary), "No active failures remain."),
      "## Recovered Issues",
      ...bullet(source.failures.recovered.map((failure) => "\`" + failure.node + "\`: " + failure.summary), "No recovered issues were recorded."),
      "## Historical Attempts",
      ...bullet(source.failures.historical.map((failure) => "\`" + failure.node + "\`: " + failure.summary), "No historical attempts require reviewer action."),
      "## Supervisor And Human Interventions",
      ...bullet(source.interventions.map((intervention) => "\`" + intervention.action + "\`: " + intervention.reason), "No supervisor or human interventions were recorded."),
      "## Supporting Evidence",
      "- [Run learnings](02-run-learnings.md)",
      "- [Audit index](03-audit-index.md)",
      "\`\`\`",
      "\`\`\`run-learnings",
      "# Run Learnings",
      "## Where Agents Struggled",
      "- See the review brief for failure and recovery details.",
      "## Workspace Improvements",
      "| Area | Recommendation | Evidence | Priority | Confidence | Done When |",
      "| --- | --- | --- | --- | --- | --- |",
      ...learningRows,
      "## Graph Prompt And Support Improvements",
      "- No changes identified.",
      "## Plugin Skill And Eval Opportunities",
      "- No changes identified.",
      "## What Worked",
      "- Runtime produced deterministic evidence for the delivery curator.",
      "## Evidence Links",
      "- [Milestones](" + source.evidence_links.milestones + ")",
      "- [Validation ledger](" + source.evidence_links.validation_ledger + ")",
      "\`\`\`"
    ].join("\\n") + "\\n");
    return;
  }
  if (prompt.includes("supervisor")) {
    finish(JSON.stringify({ claims: ["Mock supervisor evidence recorded."], retry_guidance: ["Retry with focused guidance."], conflicts: [], confidence: "medium" }) + "\\n");
    return;
  }
  finish("mock codex response\\n");
});
`, "utf8");
    await chmod(path, 0o755);
    return path;
}
let sharedMockCodexCliPath: string | undefined;
async function getSharedMockCodexCli(): Promise<string> {
    if (!sharedMockCodexCliPath) {
        sharedMockCodexCliPath = await writeMockCodexCli(join(tmpdir(), `agentflow-cli-mock-codex-${process.pid}`));
    }
    return sharedMockCodexCliPath;
}
async function executeCli(args: string[], cwd?: string, execution: {
    signal?: AbortSignal;
} = {}) {
    const previousCodex = process.env.AGENTFLOW_CODEX_CLI_BIN;
    const previousCursor = process.env.AGENTFLOW_CURSOR_CLI_BIN;
    if (previousCodex === undefined) {
        process.env.AGENTFLOW_CODEX_CLI_BIN = await getSharedMockCodexCli();
    }
    process.env.AGENTFLOW_CURSOR_CLI_BIN ??= process.execPath;
    const graphFlagIndex = args.indexOf("--graph");
    const graphPath = graphFlagIndex === -1 ? undefined : args[graphFlagIndex + 1];
    if (graphPath) {
        await applyNodeIntentDefaultsToGraphFile(graphPath);
    }
    const runRootFlagIndex = args.indexOf("--run-root");
    const runRoot = runRootFlagIndex === -1 ? undefined : args[runRootFlagIndex + 1];
    if (!graphPath && runRoot) {
        try {
            const runRecord = JSON.parse(await readFile(join(runRoot, "run.json"), "utf8")) as {
                graph_path?: string;
            };
            if (runRecord.graph_path) {
                await applyNodeIntentDefaultsToGraphFile(runRecord.graph_path);
            }
        }
        catch {
            // Resume tests that intentionally use invalid run roots should keep their original failure.
        }
    }
    try {
        return await executeCliRaw(args, cwd, execution);
    }
    finally {
        if (previousCodex === undefined) {
            delete process.env.AGENTFLOW_CODEX_CLI_BIN;
        }
        else {
            process.env.AGENTFLOW_CODEX_CLI_BIN = previousCodex;
        }
        if (previousCursor === undefined) {
            delete process.env.AGENTFLOW_CURSOR_CLI_BIN;
        }
        else {
            process.env.AGENTFLOW_CURSOR_CLI_BIN = previousCursor;
        }
    }
}
async function initGitRepo(repoDir: string): Promise<void> {
    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repoDir });
    await writeFile(join(repoDir, "README.md"), "seed\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
}
async function withMockValidateHarnesses<T>(run: () => Promise<T>): Promise<T> {
    const previousCodex = process.env.AGENTFLOW_CODEX_CLI_BIN;
    const previousCursor = process.env.AGENTFLOW_CURSOR_CLI_BIN;
    process.env.AGENTFLOW_CODEX_CLI_BIN = process.execPath;
    process.env.AGENTFLOW_CURSOR_CLI_BIN = process.execPath;
    try {
        return await run();
    }
    finally {
        if (previousCodex === undefined) {
            delete process.env.AGENTFLOW_CODEX_CLI_BIN;
        }
        else {
            process.env.AGENTFLOW_CODEX_CLI_BIN = previousCodex;
        }
        if (previousCursor === undefined) {
            delete process.env.AGENTFLOW_CURSOR_CLI_BIN;
        }
        else {
            process.env.AGENTFLOW_CURSOR_CLI_BIN = previousCursor;
        }
    }
}
async function withFastSupervisorRetries<T>(run: () => Promise<T>): Promise<T> {
    const previousBaseDelay = process.env.AGENTFLOW_RETRY_BASE_DELAY_MS;
    const previousMaxDelay = process.env.AGENTFLOW_RETRY_MAX_DELAY_MS;
    process.env.AGENTFLOW_RETRY_BASE_DELAY_MS = "0";
    process.env.AGENTFLOW_RETRY_MAX_DELAY_MS = "0";
    try {
        return await run();
    }
    finally {
        if (previousBaseDelay === undefined) {
            delete process.env.AGENTFLOW_RETRY_BASE_DELAY_MS;
        }
        else {
            process.env.AGENTFLOW_RETRY_BASE_DELAY_MS = previousBaseDelay;
        }
        if (previousMaxDelay === undefined) {
            delete process.env.AGENTFLOW_RETRY_MAX_DELAY_MS;
        }
        else {
            process.env.AGENTFLOW_RETRY_MAX_DELAY_MS = previousMaxDelay;
        }
    }
}
async function waitForPath(path: string, timeoutMs = 15000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            await access(path, constants.F_OK);
            return;
        }
        catch {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
    throw new Error(`Timed out waiting for ${path}`);
}
describe("graph CLI", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it("renders graph-native help with the release command surface", async () => {
        const result = await executeCli([]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Agentflow CLI");
        expect(result.stdout).toContain("validate");
        expect(result.stdout).toContain("run");
        expect(result.stdout).toContain("runs");
        expect(result.stdout).toContain("inspect");
        expect(result.stdout).toContain("observe");
        expect(result.stdout).toContain("resume");
        expect(result.stdout).toContain("apply");
        expect(result.stdout).toContain("graph-help");
        expect(result.stdout).not.toContain("control");
        expect(result.stdout).toContain("Local workflow:");
        expect(result.stdout).toContain("Path rules:");
        expect(result.stdout).toContain("graph-help: review the authored graph contract");
        expect(result.stdout).toContain("AGENTFLOW_RUNS_ROOT");
    });
    it("emits the compiled graph contract under validate --show-compiled", async () => {
        const graphPath = fileURLToPath(new URL("../graph/fixtures/repeat.graph.json", import.meta.url));
        const result = await withMockValidateHarnesses(() => executeCli(["validate", "--graph", graphPath, "--show-compiled"]));
        const payload = JSON.parse(result.stdout);
        expect(result.exitCode).toBe(0);
        expect(payload.command).toBe("validate");
        expect(payload.status).toBe("passed");
        expect(payload.path_resolution.graph_path).toBe(graphPath);
        expect(payload.path_resolution.rules.repo_paths).toContain("graph file directory");
        expect(payload.compiled_graph.graph_id).toBe("repeat-graph");
        expect(payload.next_steps.run).toContain("agentflow run --graph");
        expect(payload.compiled_graph.nodes).toHaveLength(7);
        expect(payload.compiled_graph.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "repeat-back"
            })
        ]));
    });
    it("validates through the compiler and returns compiled summary data", async () => {
        const graphPath = fileURLToPath(new URL("../graph/fixtures/repeat.graph.json", import.meta.url));
        const result = await withMockValidateHarnesses(() => executeCli(["validate", "--graph", graphPath]));
        const payload = JSON.parse(result.stdout);
        expect(result.exitCode).toBe(0);
        expect(payload.command).toBe("validate");
        expect(payload.status).toBe("passed");
        expect(payload.message).toContain('launch profile "default"');
        expect(payload.path_resolution.graph_path).toBe(graphPath);
        expect(payload.path_resolution.rules.graph_path).toContain("launch shell");
        expect(payload.launch.launch_profile).toBe("default");
        expect(payload.compiled_summary.node_count).toBe(7);
        expect(payload.compiled_summary.scope_count).toBeGreaterThan(0);
        expect(payload.validation_level).toBe("run-ready");
        expect(payload.checks.authored.status).toBe("passed");
        expect(payload.checks.compiled.status).toBe("passed");
        expect(payload.checks.compiled.compiled_summary.node_count).toBe(7);
        expect(payload.checks.compiled.managed_expansion).toEqual([]);
        expect(payload.checks.readiness.status).toBe("ready");
        expect(payload.checks.context.status).toMatch(/passed|warnings/);
        expect(payload.checks.authoring_review.mode).toBe("review");
        expect(payload.checks.authoring_review.summary.reviewed_node_count).toBe(7);
        expect(payload.findings.blockers).toEqual([]);
        expect(payload.findings.warnings).toBeInstanceOf(Array);
        expect(payload.next_steps.run).toContain("agentflow run --graph");
        expect(payload.next_steps.graph_help).toBe("agentflow graph-help");
    });
    it("reports full authoring review findings by default and fails only under strict validate", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-authoring-review-"));
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await initGitRepo(tempRoot);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "authoring-review",
            intent: {
                goal: "Implement a reviewable change.",
                acceptance_criteria: ["The implementation is ready to review."]
            },
            repos: {
                main: {
                    path: "."
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {
                    harness: "codex-cli",
                    sandbox: "workspace-write"
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "implement",
                        intent: {
                            goal: "Implement the requested change.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const normalResult = await withMockValidateHarnesses(() => executeCli(["validate", "--graph", graphPath], tempRoot));
        const normalPayload = JSON.parse(normalResult.stdout);
        const strictResult = await withMockValidateHarnesses(() => executeCli(["validate", "--graph", graphPath, "--strict"], tempRoot));
        const strictPayload = JSON.parse(strictResult.stdout);
        expect(normalResult.exitCode).toBe(0);
        expect(normalPayload.status).toBe("passed");
        expect(normalPayload.checks.authoring_review.mode).toBe("review");
        expect(normalPayload.checks.authoring_review.status).toBe("serious_findings");
        expect(normalPayload.checks.authoring_review.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                severity: "serious",
                category: "artifact_contract",
                node_id: "implement"
            }),
            expect.objectContaining({
                severity: "serious",
                category: "verification"
            })
        ]));
        expect(normalPayload.checks.authoring_review.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                category: "intent",
                path: "$.intent.constraints"
            })
        ]));
        expect(strictResult.exitCode).toBe(1);
        expect(strictPayload.status).toBe("failed");
        expect(strictPayload.message).toContain("strict authoring review");
        expect(strictPayload.checks.authoring_review.mode).toBe("strict");
        expect(strictPayload.checks.readiness.status).toBe("ready");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("emits and writes compiled Mermaid diagrams from validate", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-diagram-"));
        const graphPath = fileURLToPath(new URL("../graph/fixtures/repeat.graph.json", import.meta.url));
        const diagramPath = join(tempRoot, "graph.mmd");
        const outputDir = join(tempRoot, "validation-package");
        const npxImagePath = join(tempRoot, "graph-npx.svg");
        const mmdcImagePath = join(tempRoot, "graph-mmdc.svg");
        const fakeNpxPath = join(tempRoot, "npx");
        const fakeMmdcPath = join(tempRoot, "fake-mmdc.cjs");
        const previousPath = process.env.PATH;
        const previousMermaidCliBin = process.env.AGENTFLOW_MERMAID_CLI_BIN;
        const previousMermaidRenderer = process.env.AGENTFLOW_MERMAID_RENDERER;
        const previousMermaidNpxPackage = process.env.AGENTFLOW_MERMAID_NPX_PACKAGE;
        await writeFile(fakeNpxPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const packageSpec = args[1];
const inputPath = args[args.indexOf("-i") + 1];
const outputPath = args[args.indexOf("-o") + 1];
const mermaid = fs.readFileSync(inputPath, "utf8");
fs.writeFileSync(outputPath, \`rendered by npx \${packageSpec}\\n\${mermaid}\`);
`, "utf8");
        await writeFile(fakeMmdcPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const inputPath = args[args.indexOf("-i") + 1];
const outputPath = args[args.indexOf("-o") + 1];
const mermaid = fs.readFileSync(inputPath, "utf8");
fs.writeFileSync(outputPath, \`rendered svg\\n\${mermaid}\`);
`, "utf8");
        await chmod(fakeNpxPath, 0o755);
        await chmod(fakeMmdcPath, 0o755);
        process.env.PATH = `${tempRoot}:${previousPath ?? ""}`;
        process.env.AGENTFLOW_MERMAID_CLI_BIN = fakeMmdcPath;
        delete process.env.AGENTFLOW_MERMAID_RENDERER;
        delete process.env.AGENTFLOW_MERMAID_NPX_PACKAGE;
        try {
            const writtenResult = await withMockValidateHarnesses(() => executeCli(["validate", "--graph", graphPath, "--diagram-output", diagramPath], tempRoot));
            const writtenPayload = JSON.parse(writtenResult.stdout);
            const packageResult = await withMockValidateHarnesses(() => executeCli(["validate", "--graph", graphPath, "--output-dir", outputDir], tempRoot));
            const packagePayload = JSON.parse(packageResult.stdout);
            const npxImageResult = await withMockValidateHarnesses(() => executeCli([
                "validate",
                "--graph",
                graphPath,
                "--diagram-image-output",
                npxImagePath,
                "--diagram-image-package",
                "fixture-mermaid-cli@1.0.0"
            ], tempRoot));
            const npxImagePayload = JSON.parse(npxImageResult.stdout);
            const mmdcImageResult = await withMockValidateHarnesses(() => executeCli([
                "validate",
                "--graph",
                graphPath,
                "--diagram-image-output",
                mmdcImagePath,
                "--diagram-image-renderer",
                "mmdc"
            ], tempRoot));
            const mmdcImagePayload = JSON.parse(mmdcImageResult.stdout);
            const writtenDiagram = await readFile(diagramPath, "utf8");
            const packageManifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8"));
            const packageCompiledGraph = JSON.parse(await readFile(join(outputDir, "compiled-graph.json"), "utf8"));
            const packageMermaid = await readFile(join(outputDir, "compiled-graph.mmd"), "utf8");
            const renderedNpxImage = await readFile(npxImagePath, "utf8");
            const renderedMmdcImage = await readFile(mmdcImagePath, "utf8");
            expect(writtenResult.exitCode).toBe(0);
            expect(writtenPayload.exports.diagram_output_path).toBe(diagramPath);
            expect(writtenPayload).not.toHaveProperty("diagram");
            expect(writtenDiagram).toContain("flowchart TD");
            expect(writtenDiagram).toContain("repeat: repair_loop");
            expect(packageResult.exitCode).toBe(0);
            expect(packagePayload.exports.output_dir).toBe(outputDir);
            expect(packagePayload.exports.files).toEqual(expect.arrayContaining([
                join(outputDir, "manifest.json"),
                join(outputDir, "compiled-graph.json"),
                join(outputDir, "compiled-graph.mmd"),
                join(outputDir, "authoring-review.json"),
                join(outputDir, "readiness.json"),
                join(outputDir, "context-analysis.json")
            ]));
            expect(packageManifest.command).toBe("validate");
            expect(packageCompiledGraph.graph_id).toBe("repeat-graph");
            expect(packageMermaid).toContain("flowchart TD");
            expect(npxImageResult.exitCode).toBe(0);
            expect(npxImagePayload.exports.diagram_image_output_path).toBe(npxImagePath);
            expect(npxImagePayload.exports.diagram_image_renderer.renderer).toBe("npx");
            expect(npxImagePayload.exports.diagram_image_renderer.npx_package).toBe("fixture-mermaid-cli@1.0.0");
            expect(renderedNpxImage).toContain("rendered by npx fixture-mermaid-cli@1.0.0");
            expect(renderedNpxImage).toContain("flowchart TD");
            expect(mmdcImageResult.exitCode).toBe(0);
            expect(mmdcImagePayload.exports.diagram_image_output_path).toBe(mmdcImagePath);
            expect(mmdcImagePayload.exports.diagram_image_renderer.renderer).toBe("mmdc");
            expect(mmdcImagePayload.exports.diagram_image_renderer.cli_binary).toBe(fakeMmdcPath);
            expect(renderedMmdcImage).toContain("rendered svg");
            expect(renderedMmdcImage).toContain("flowchart TD");
        }
        finally {
            if (previousPath === undefined) {
                delete process.env.PATH;
            }
            else {
                process.env.PATH = previousPath;
            }
            if (previousMermaidCliBin === undefined) {
                delete process.env.AGENTFLOW_MERMAID_CLI_BIN;
            }
            else {
                process.env.AGENTFLOW_MERMAID_CLI_BIN = previousMermaidCliBin;
            }
            if (previousMermaidRenderer === undefined) {
                delete process.env.AGENTFLOW_MERMAID_RENDERER;
            }
            else {
                process.env.AGENTFLOW_MERMAID_RENDERER = previousMermaidRenderer;
            }
            if (previousMermaidNpxPackage === undefined) {
                delete process.env.AGENTFLOW_MERMAID_NPX_PACKAGE;
            }
            else {
                process.env.AGENTFLOW_MERMAID_NPX_PACKAGE = previousMermaidNpxPackage;
            }
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("renders compact interactive validate success output", async () => {
        const graphPath = fileURLToPath(new URL("../graph/fixtures/repeat.graph.json", import.meta.url));
        const result = await withMockValidateHarnesses(() => executeCli(["validate", "--graph", graphPath]));
        const rendered = renderCliStdout(result, { isTty: true });
        expect(result.exitCode).toBe(0);
        expect(rendered).toContain("Graph validated and run-ready.");
        expect(rendered).toContain("Context:");
        expect(rendered).not.toContain("Run-ready checks: not requested");
        expect(rendered).not.toContain("{");
    });
    it("surfaces readiness warnings and blocks from first-class validate checks", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-validate-prereqs-"));
        const repoDir = join(tempRoot, "repo");
        const warningGraphPath = join(tempRoot, "warning.graph.json");
        const blockedGraphPath = join(tempRoot, "blocked.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const baseGraph = {
            version: "1",
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
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
                        type: "agent",
                        id: "ok",
                        runtime: { repo: "main" },
                        intent: {
                            goal: "Exercise CLI readiness validation.",
                            acceptance_criteria: ["The validation command reports readiness accurately."],
                            constraints: []
                        }
                    }
                ]
            }
        };
        await writeFile(warningGraphPath, `${JSON.stringify({
            ...baseGraph,
            graph_id: "cli-validate-prereq-warning",
            intent: { goal: "Exercise cli-validate-prereq-warning.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: { main: { path: "." } }
        }, null, 2)}\n`);
        await writeFile(blockedGraphPath, `${JSON.stringify({
            ...baseGraph,
            graph_id: "cli-validate-prereq-blocked",
            intent: { goal: "Exercise cli-validate-prereq-blocked.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            graph: {
                ...baseGraph.graph,
                steps: [
                    {
                        ...baseGraph.graph.steps[0],
                        support: {
                            cli: [
                                {
                                    cmd: "definitely-missing-command",
                                    description: "Missing command required by this fixture."
                                }
                            ]
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const warningResult = await executeCli(["validate", "--graph", warningGraphPath], tempRoot);
        const blockedResult = await executeCli(["validate", "--graph", blockedGraphPath], tempRoot);
        const warningPayload = JSON.parse(warningResult.stdout);
        const blockedPayload = JSON.parse(blockedResult.stdout);
        expect(warningResult.exitCode).toBe(0);
        expect(warningPayload.status).toBe("passed");
        expect(warningPayload.checks.readiness.status).toBe("warnings");
        expect(warningPayload.checks.readiness.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "repo",
                status: "warning",
                message: expect.stringContaining("must be a git worktree")
            })
        ]));
        expect(blockedResult.exitCode).toBe(1);
        expect(blockedPayload.status).toBe("failed");
        expect(blockedPayload.checks.compiled.status).toBe("passed");
        expect(blockedPayload.checks.readiness.status).toBe("blocked");
        expect(blockedPayload.checks.readiness.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "cli",
                status: "blocked",
                message: expect.stringContaining("definitely-missing-command")
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("checks local runtime dependencies during default validate", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-ready-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const writeGraph = async (command: string) => {
            await writeFile(graphPath, `${JSON.stringify({
                version: "1",
                graph_id: "cli-run-ready",
                intent: { goal: "Exercise cli-run-ready.", acceptance_criteria: ["CLI behavior matches the command contract."] },
                repos: {
                    main: {
                        path: "./repo"
                    }
                },
                defaults: {
                    launch_profile: "default",
                    workspace_backend: "worktree"
                },
                profiles: {
                    default: {}
                },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "exec",
                            id: "verify_tooling",
                            command,
                            args: ["-e", "process.exit(0)"],
                            runtime: {
                                repo: "main"
                            }
                        }
                    ]
                }
            }, null, 2)}\n`);
        };
        await writeGraph(process.execPath);
        const readyResult = await executeCli(["validate", "--graph", graphPath], tempRoot);
        const readyPayload = JSON.parse(readyResult.stdout);
        expect(readyResult.exitCode).toBe(0);
        expect(readyPayload.validation_level).toBe("run-ready");
        expect(readyPayload.checks.readiness.status).toBe("ready");
        expect(readyPayload.checks.readiness.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "command",
                target: `verify_tooling: ${process.execPath}`,
                status: "passed"
            }),
            expect.objectContaining({
                kind: "repo",
                target: "main",
                status: "passed"
            })
        ]));
        await writeGraph("definitely-missing-node-command");
        const blockedResult = await executeCli(["validate", "--graph", graphPath], tempRoot);
        const blockedPayload = JSON.parse(blockedResult.stdout);
        expect(blockedResult.exitCode).toBe(1);
        expect(blockedPayload.validation_level).toBe("run-ready");
        expect(blockedPayload.checks.readiness.status).toBe("blocked");
        expect(blockedPayload.checks.readiness.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "command",
                target: "verify_tooling: definitely-missing-node-command",
                status: "blocked",
                message: expect.stringContaining("not available on PATH")
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("checks required harness binaries during default validate", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-ready-harness-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        const missingCodex = join(tempRoot, "missing-codex");
        const previousCodex = process.env.AGENTFLOW_CODEX_CLI_BIN;
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-run-ready-harness",
            intent: { goal: "Exercise cli-run-ready-harness.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "worktree"
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
                        type: "agent",
                        id: "implement",
                        intent: {
                            goal: "Implement the change.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        process.env.AGENTFLOW_CODEX_CLI_BIN = missingCodex;
        try {
            const result = await executeCli(["validate", "--graph", graphPath], tempRoot);
            const payload = JSON.parse(result.stdout);
            expect(result.exitCode).toBe(1);
            expect(payload.checks.readiness.checks).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: "harness",
                    target: "codex-cli",
                    status: "blocked",
                    message: expect.stringContaining(missingCodex)
                })
            ]));
        }
        finally {
            if (previousCodex === undefined) {
                delete process.env.AGENTFLOW_CODEX_CLI_BIN;
            }
            else {
                process.env.AGENTFLOW_CODEX_CLI_BIN = previousCodex;
            }
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("checks required Cursor MCPs from the node repo workspace during default validate", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-ready-cursor-mcp-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        const mockAgent = join(tempRoot, "mock-agent.mjs");
        const previousCursor = process.env.AGENTFLOW_CURSOR_CLI_BIN;
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(mockAgent, `#!/usr/bin/env node
if (process.argv[2] === "mcp" && process.argv[3] === "list-tools") {
  const identifier = process.argv[4];
  if (identifier === "Glean") {
    process.stdout.write("Tools for Glean (1):\\n- search (query)\\n");
    process.exit(0);
  }
  process.stderr.write("MCP '" + identifier + "' requires authentication.\\nPlease run: cursor agent mcp login " + identifier + "\\n");
  process.exit(1);
}
process.exit(0);
`, "utf8");
        await chmod(mockAgent, 0o755);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-run-ready-cursor-mcp",
            intent: { goal: "Exercise cursor MCP readiness.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {
                    harness: "cursor-cli",
                    harness_config: {
                        cursor: {
                            required_mcps: ["Glean"]
                        }
                    }
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "probe",
                        intent: {
                            goal: "Probe MCP.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        process.env.AGENTFLOW_CURSOR_CLI_BIN = mockAgent;
        try {
            const readyResult = await executeCli(["validate", "--graph", graphPath], tempRoot);
            const readyPayload = JSON.parse(readyResult.stdout);
            expect(readyResult.exitCode).toBe(0);
            expect(readyPayload.checks.readiness.checks).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: "mcp",
                    target: "main:Glean",
                    status: "passed",
                    message: expect.stringContaining("Cursor MCP \"Glean\" is authenticated")
                })
            ]));
            const graph = JSON.parse(await readFile(graphPath, "utf8")) as Record<string, unknown>;
            const defaultProfile = (graph.profiles as Record<string, unknown>).default as Record<string, unknown>;
            defaultProfile.harness_config = {
                cursor: {
                    required_mcps: ["MissingMcp"]
                }
            };
            await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
            const blockedResult = await executeCli(["validate", "--graph", graphPath], tempRoot);
            const blockedPayload = JSON.parse(blockedResult.stdout);
            expect(blockedResult.exitCode).toBe(1);
            expect(blockedPayload.checks.readiness.checks).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: "mcp",
                    target: "main:MissingMcp",
                    status: "blocked",
                    message: expect.stringContaining("agent mcp login")
                })
            ]));
        }
        finally {
            if (previousCursor === undefined) {
                delete process.env.AGENTFLOW_CURSOR_CLI_BIN;
            }
            else {
                process.env.AGENTFLOW_CURSOR_CLI_BIN = previousCursor;
            }
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("validates pointer context packaging", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-ready-context-"));
        const repoDir = join(tempRoot, "repo");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(join(repoDir, "first.md"), "one two three four five\n", "utf8");
        await writeFile(join(repoDir, "second.md"), "six seven eight nine ten\n", "utf8");
        await execFileAsync("git", ["add", "first.md", "second.md"], { cwd: repoDir });
        await execFileAsync("git", ["commit", "-m", "add context"], { cwd: repoDir });
        const graphPath = join(tempRoot, "graph.json");
        await writeFile(graphPath, JSON.stringify({
            version: "1",
            graph_id: "cli-run-ready-context-pointers",
            intent: {
                goal: "Validate context pointer packaging.",
                acceptance_criteria: ["Run-ready validation blocks bad context packages."]
            },
            repos: { main: { path: repoDir } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: {
                default: {
                    harness: "codex-cli",
                    skip_git_repo_check: true
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
                            context: [
                                {
                                    name: "markdown",
                                    kind: "workspace_glob",
                                    path: "*.md",
                                    what: "Markdown files in the fixture repo.",
                                    why: "The node validates that context is represented by pointers, not prompt inlining."
                                }
                            ]
                        }
                    }
                ]
            }
        }, null, 2), "utf8");
        const result = await executeCli(["validate", "--graph", graphPath], tempRoot);
        const payload = JSON.parse(result.stdout);
        expect(result.exitCode).toBe(0);
        expect(payload.status).toBe("passed");
        expect(payload.checks.context.status).not.toBe("blocked");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("runs a deterministic graph end to end and writes run artifacts", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-run-graph",
            intent: { goal: "Exercise cli-run-graph.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
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
                        type: "exec",
                        id: "write_marker",
                        command: "node",
                        args: [
                            "-e",
                            "require('node:fs').writeFileSync('marker.txt', 'ok\\n')"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    },
                    {
                        type: "check",
                        id: "verify_marker",
                        check_kind: "deterministic",
                        command: "node",
                        args: [
                            "-e",
                            "const fs=require('node:fs'); const path=require('node:path'); const passed=fs.existsSync('marker.txt'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'verification.json'), JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                        ],
                        pass_if: {
                            json_path: "$.passed",
                            equals: true
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const result = await executeCli(["run", "--graph", graphPath], tempRoot);
        const payload = JSON.parse(result.stdout);
        const state = JSON.parse(await readFile(payload.artifacts.state_file, "utf8")) as {
            status: string;
        };
        const progressOutput = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(result.exitCode).toBe(0);
        expect(payload.command).toBe("run");
        expect(payload.status).toBe("passed");
        expect(payload.message).toContain("durable artifacts are ready");
        expect(payload.path_resolution.graph_path).toBe(graphPath);
        expect(payload.runs_root).toBe(join(tempRoot, ".agentflow", "runs"));
        expect(payload.runs_root_source).toBe("graph-directory-default");
        expect(payload.default_runs_root).toBe(join(tempRoot, ".agentflow", "runs"));
        expect(payload.runs_root_contract).toContain("AGENTFLOW_RUNS_ROOT");
        expect(payload.run_root).toBe(join(payload.runs_root, payload.run_id));
        expect(payload.counts.passed).toBe(2);
        expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
        expect(payload.cancel_note).toContain("Ctrl-C");
        expect(payload.next_steps.rerun).toContain("agentflow run --graph");
        expect(payload.next_steps.resume).toContain("agentflow resume --run-root");
        expect(state.status).toBe("passed");
        const attempts = await readRunExecutionAttempts(payload.run_root);
        const writeAttempt = attempts.find((attempt) => attempt.authored_id === "write_marker");
        expect(writeAttempt?.execution_dir).toMatch(/\/nodes\/001-write-marker-[0-9a-f]{12}\/executions\/001-exec-[0-9a-f]{16}$/);
        expect(writeAttempt?.context_packet_path).toBe(resolveExecutionRuntimeContextPath(writeAttempt!.execution_dir));
        expect(writeAttempt?.context_manifest_path).toBe(resolveExecutionAgentContextPath(writeAttempt!.execution_dir));
        await expect(access(join(resolveExecutionHumanDebugHarnessDirectory(writeAttempt!.execution_dir), "stdout.log"), constants.F_OK)).resolves.toBeUndefined();
        await expect(access(join(resolveExecutionHumanDebugHarnessDirectory(writeAttempt!.execution_dir), "stderr.log"), constants.F_OK)).resolves.toBeUndefined();
        expect(await readFile(join(repoDir, "marker.txt"), "utf8")).toBe("ok\n");
        expect(progressOutput).toContain('agentflow: compiled graph "cli-run-graph" with 2 executable nodes');
        expect(progressOutput).toContain("agentflow: RUN      run · workspace=inplace");
        expect(progressOutput).toContain("[0/2] RUN      exec write_marker · repo=main");
        expect(progressOutput).toContain("[1/2] PASS     exec write_marker");
        expect(progressOutput).toContain("[1/2] RUN      check verify_marker · repo=main");
        expect(progressOutput).toContain("[2/2] PASS     check verify_marker");
        expect(progressOutput).toContain("agentflow: PASS     run · 2/2 terminal nodes");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("executes plugin tool --help during default validate", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-plugin-help-"));
        const repoDir = join(tempRoot, "repo");
        const pluginDir = join(tempRoot, "fixture-plugin");
        const toolPath = join(pluginDir, "scripts", "inspect.sh");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        const mockCodex = join(tempRoot, "mock-codex.mjs");
        const previousCodex = process.env.AGENTFLOW_CODEX_CLI_BIN;
        await mkdir(repoDir, { recursive: true });
        await mkdir(join(pluginDir, "scripts"), { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(mockCodex, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
        await chmod(mockCodex, 0o755);
        const writeTool = async (body: string) => {
            await writeFile(toolPath, body, "utf8");
            await chmod(toolPath, 0o755);
        };
        await writeFile(join(pluginDir, "agentflow.plugin.json"), `${JSON.stringify({
            schema: "agentflow.plugin/1",
            id: "fixture",
            version: "1.0.0",
            workflows: {},
            credentials: {},
            tools: {
                inspect: {
                    executable: "scripts/inspect.sh",
                    description: "Inspect fixture state."
                }
            }
        }, null, 2)}\n`);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "plugin-help-validation",
            intent: {
                goal: "Validate plugin help readiness.",
                acceptance_criteria: ["Plugin tool help is enforced during validation."]
            },
            plugins: {
                fixture: {
                    path: "./fixture-plugin"
                }
            },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {
                    harness: "codex-cli"
                }
            },
            tools: {
                fixture_inspect: {
                    ref: "fixture/inspect"
                }
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "inspect",
                        intent: {
                            goal: "Use the fixture inspect tool.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        },
                        support: {
                            tools: [{ ref: "fixture_inspect" }]
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        await writeTool("#!/usr/bin/env bash\necho missing structured help\n");
        process.env.AGENTFLOW_CODEX_CLI_BIN = mockCodex;
        try {
            const resolveResult = await executeCli(["plugin", "resolve", "--graph", graphPath], tempRoot);
            expect(resolveResult.exitCode).toBe(0);
            const blockedResult = await executeCli(["validate", "--graph", graphPath], tempRoot);
            const blockedPayload = JSON.parse(blockedResult.stdout);
            expect(blockedResult.exitCode).toBe(1);
            expect(blockedPayload.checks.readiness.checks).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: "tool",
                    target: "$.plugins.fixture.tools.inspect.help",
                    status: "blocked",
                    message: expect.stringContaining("missing required help sections/signals")
                })
            ]));
            await writeTool([
                "#!/usr/bin/env bash",
                "if [[ \"${1:-}\" == \"--help\" ]]; then",
                "  cat <<'HELP'",
                "inspect - inspect fixture state",
                "",
                "Usage:",
                "  inspect [--format json] [--help]",
                "",
                "Options:",
                "  --format <json>  Output format. Default: json",
                "  --help           Show this help and exit. Default: false",
                "",
                "Output:",
                "  JSON object: { \"ok\": true }",
                "",
                "Exit codes:",
                "  0 success",
                "  1 runtime failure",
                "",
                "Examples:",
                "  inspect --format json",
                "HELP",
                "  exit 0",
                "fi",
                "echo '{\"ok\":true}'",
                ""
            ].join("\n"));
            const resolveUpdated = await executeCli(["plugin", "resolve", "--graph", graphPath], tempRoot);
            expect(resolveUpdated.exitCode).toBe(0);
            const readyResult = await executeCli(["validate", "--graph", graphPath], tempRoot);
            const readyPayload = JSON.parse(readyResult.stdout);
            expect(readyResult.exitCode).toBe(0);
            expect(readyPayload.checks.readiness.checks).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: "tool",
                    target: "$.plugins.fixture.tools.inspect.help",
                    status: "passed"
                })
            ]));
        }
        finally {
            if (previousCodex === undefined) {
                delete process.env.AGENTFLOW_CODEX_CLI_BIN;
            }
            else {
                process.env.AGENTFLOW_CODEX_CLI_BIN = previousCodex;
            }
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("captures worktree status, binary diff, and changed files before cleanup", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-worktree-changes-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-worktree-change-capture",
            intent: { goal: "Exercise cli-worktree-change-capture.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "worktree"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "mutate_workspace",
                        command: process.execPath,
                        args: [
                            "-e",
                            [
                                "const fs = require('node:fs');",
                                "fs.writeFileSync('README.md', 'changed from worktree\\n');",
                                "fs.writeFileSync('new-file.txt', 'new workspace file\\n');"
                            ].join(" ")
                        ],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const result = await executeCli(["run", "--graph", graphPath], tempRoot);
        const payload = JSON.parse(result.stdout);
        const capture = payload.workspace_change_artifacts.main;
        const status = await readFile(capture.status_file, "utf8");
        const diff = await readFile(capture.diff_file, "utf8");
        const changedFiles = JSON.parse(await readFile(capture.changed_files_file, "utf8"));
        const summary = await readFile(payload.artifacts.summary_file, "utf8");
        expect(result.exitCode).toBe(0);
        expect(payload.status).toBe("passed");
        expect(payload.artifacts.workspace_changes_dir).toBe(join(payload.run_root, "workspace-changes"));
        expect(capture.changed_files).toEqual(["README.md", "new-file.txt"]);
        expect(changedFiles).toEqual(["README.md", "new-file.txt"]);
        expect(status).toContain(" M README.md");
        expect(status).toContain("?? new-file.txt");
        expect(diff).toContain("changed from worktree");
        expect(diff).toContain("new workspace file");
        expect(summary).toContain("## Workspace Changes");
        expect(summary).toContain(capture.diff_file);
        await expect(access(payload.repo_workspaces.main.workspace_path)).rejects.toThrow();
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("applies captured worktree changes back to the source repo", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-apply-worktree-changes-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-apply-worktree-change",
            intent: { goal: "Exercise cli-apply-worktree-change.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "worktree"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "mutate_workspace",
                        command: process.execPath,
                        args: [
                            "-e",
                            [
                                "const fs = require('node:fs');",
                                "fs.writeFileSync('README.md', 'changed from captured patch\\n');",
                                "fs.writeFileSync('new-file.txt', 'new workspace file\\n');"
                            ].join(" ")
                        ],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const runResult = await executeCli(["run", "--graph", graphPath], tempRoot);
        const runPayload = JSON.parse(runResult.stdout);
        expect(runResult.exitCode).toBe(0);
        expect(await readFile(join(repoDir, "README.md"), "utf8")).toBe("seed\n");
        const applyResult = await executeCli(["apply", "--run-root", runPayload.run_root], tempRoot);
        const applyPayload = JSON.parse(applyResult.stdout);
        expect(applyResult.exitCode).toBe(0);
        expect(applyPayload.command).toBe("apply");
        expect(applyPayload.status).toBe("passed");
        expect(applyPayload.repo_alias).toBe("main");
        expect(applyPayload.target_path).toBe(repoDir);
        expect(applyPayload.changed_files).toEqual(["README.md", "new-file.txt"]);
        expect(await readFile(join(repoDir, "README.md"), "utf8")).toBe("changed from captured patch\n");
        expect(await readFile(join(repoDir, "new-file.txt"), "utf8")).toBe("new workspace file\n");
        await expect(execFileAsync("git", ["status", "--porcelain=v1"], { cwd: repoDir }).then((result) => result.stdout)).resolves.toContain(" M README.md");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("commits captured worktree changes when a commit message is provided", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-apply-commit-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-apply-commit",
            intent: { goal: "Exercise cli-apply-commit.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "worktree"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "mutate_workspace",
                        command: process.execPath,
                        args: [
                            "-e",
                            [
                                "const fs = require('node:fs');",
                                "fs.writeFileSync('README.md', 'committed captured patch\\n');"
                            ].join(" ")
                        ],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const runResult = await executeCli(["run", "--graph", graphPath], tempRoot);
        const runPayload = JSON.parse(runResult.stdout);
        const applyResult = await executeCli([
            "apply",
            "--run-root",
            runPayload.run_root,
            "--commit-message",
            "Apply captured Agentflow changes"
        ], tempRoot);
        const applyPayload = JSON.parse(applyResult.stdout);
        const logSubject = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: repoDir });
        const status = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: repoDir });
        expect(applyResult.exitCode).toBe(0);
        expect(applyPayload.status).toBe("passed");
        expect(applyPayload.commit.message).toBe("Apply captured Agentflow changes");
        expect(applyPayload.commit.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(logSubject.stdout.trim()).toBe("Apply captured Agentflow changes");
        expect(status.stdout).toBe("");
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("returns a primary terminal diagnostic for failed runs", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-failed-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-run-failed-graph",
            intent: { goal: "Exercise cli-run-failed-graph.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "check",
                        id: "verify_missing",
                        check_kind: "deterministic",
                        command: "node",
                        args: [
                            "-e",
                            "const fs=require('node:fs'); const path=require('node:path'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'verification.json'), JSON.stringify({passed:false})); process.exit(1);"
                        ],
                        pass_if: {
                            json_path: "$.passed",
                            equals: true
                        },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const result = await withFastSupervisorRetries(() => executeCli(["run", "--graph", graphPath], tempRoot));
        const payload = JSON.parse(result.stdout);
        expect(result.exitCode).toBe(1);
        expect(payload.command).toBe("run");
        expect(payload.status).toBe("failed");
        expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
        expect(payload.terminal_error).toContain("Deterministic check failed.");
        expect(payload.terminal_diagnostics).toContainEqual(expect.stringContaining("Deterministic check failed."));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("ignores unused broken repo aliases during run resolution", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-unused-repo-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-unused-repo",
            intent: { goal: "Exercise cli-unused-repo.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                },
                unused: {
                    path: "./does-not-exist"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "ok",
                        command: process.execPath,
                        args: [
                            "-e",
                            "process.exit(0)"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const result = await executeCli(["run", "--graph", graphPath], tempRoot);
        const payload = JSON.parse(result.stdout);
        expect(result.exitCode).toBe(0);
        expect(payload.status).toBe("passed");
        expect(payload.repo_sources).toEqual({
            main: repoDir
        });
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("does not fail launch just because a blocked checkpoint would require an interactive terminal", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-checkpoint-lazy-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        const originalStdinTty = process.stdin.isTTY;
        const originalStderrTty = process.stderr.isTTY;
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "checkpoint-cli-preflight",
            intent: { goal: "Exercise checkpoint-cli-preflight.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
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
                        type: "exec",
                        id: "fail_first",
                        command: process.execPath,
                        args: ["-e", "process.exit(1)"],
                        runtime: {
                            repo: "main"
                        }
                    },
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
                                    id: "draft",
                                    command: process.execPath,
                                    args: ["-e", "process.exit(0)"],
                                    artifacts: {
                                        draft_spec: {
                                            from: "output_dir",
                                            path: "draft.md",
                                            description: "Test artifact produced at draft.md."
                                        }
                                    },
                                    runtime: {
                                        repo: "main"
                                    }
                                },
                                {
                                    type: "checkpoint",
                                    id: "review",
                                    intent: {
                                        goal: "Review the artifact.",
                                        acceptance_criteria: ["The node satisfies its acceptance criteria."],
                                        constraints: []
                                    },
                                    review_from: {
                                        node: "draft",
                                        artifact: "draft_spec"
                                    },
                                    runtime: {
                                        repo: "main"
                                    }
                                }
                            ]
                        },
                        until: {
                            node: "review"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        try {
            Object.defineProperty(process.stdin, "isTTY", {
                value: false,
                configurable: true
            });
            Object.defineProperty(process.stderr, "isTTY", {
                value: true,
                configurable: true
            });
            const result = await executeCli(["run", "--graph", graphPath], tempRoot);
            const payload = JSON.parse(result.stdout);
            expect(result.exitCode).toBe(1);
            expect(payload.command).toBe("run");
            expect(payload.status).toBe("failed");
            expect(payload.message).toContain("terminal failure state");
            expect(payload.counts.failed).toBe(1);
            expect(payload.counts.blocked).toBe(2);
        }
        finally {
            Object.defineProperty(process.stdin, "isTTY", {
                value: originalStdinTty,
                configurable: true
            });
            Object.defineProperty(process.stderr, "isTTY", {
                value: originalStderrTty,
                configurable: true
            });
            await rm(tempRoot, { recursive: true, force: true });
        }
    }, 60000);
    it("honors AGENTFLOW_RUNS_ROOT for artifact placement", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-root-"));
        const launchRoot = join(tempRoot, "launch-shell");
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        const runsRoot = join(tempRoot, "shared-runs");
        const previousRunsRoot = process.env.AGENTFLOW_RUNS_ROOT;
        await mkdir(launchRoot, { recursive: true });
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-run-root-graph",
            intent: { goal: "Exercise cli-run-root-graph.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "write_marker",
                        command: "node",
                        args: [
                            "-e",
                            "require('node:fs').writeFileSync('marker.txt', 'ok\\n')"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        try {
            process.env.AGENTFLOW_RUNS_ROOT = runsRoot;
            const result = await executeCli(["run", "--graph", graphPath], launchRoot);
            const payload = JSON.parse(result.stdout);
            expect(result.exitCode).toBe(0);
            expect(payload.runs_root).toBe(runsRoot);
            expect(payload.runs_root_source).toBe("environment");
            expect(payload.runs_root_input).toBe(runsRoot);
            expect(payload.run_root).toBe(join(runsRoot, payload.run_id));
            expect(payload.artifacts.run_file).toBe(join(payload.run_root, "run.json"));
            expect(await readFile(join(repoDir, "marker.txt"), "utf8")).toBe("ok\n");
        }
        finally {
            if (previousRunsRoot === undefined) {
                delete process.env.AGENTFLOW_RUNS_ROOT;
            }
            else {
                process.env.AGENTFLOW_RUNS_ROOT = previousRunsRoot;
            }
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("resumes a failed run root while preserving passed work", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-resume-graph",
            intent: { goal: "Exercise cli-resume-graph.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "write_seed",
                        command: "node",
                        args: [
                            "-e",
                            "require('node:fs').writeFileSync('seed.txt', 'seed\\n')"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    },
                    {
                        type: "check",
                        id: "gate_resume",
                        check_kind: "deterministic",
                        command: "node",
                        args: [
                            "-e",
                            "const fs=require('node:fs'); const path=require('node:path'); const passed=fs.existsSync('resume-ok.txt'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'verification.json'), JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                        ],
                        pass_if: {
                            json_path: "$.passed",
                            equals: true
                        },
                        runtime: {
                            repo: "main"
                        }
                    },
                    {
                        type: "exec",
                        id: "after_resume",
                        command: "node",
                        args: [
                            "-e",
                            "const fs=require('node:fs'); if (!fs.existsSync('seed.txt')) process.exit(1); fs.writeFileSync('done.txt', 'done\\n');"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const firstStderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
        const firstPayload = JSON.parse(firstRun.stdout);
        const firstRunRecord = JSON.parse(await readFile(join(firstPayload.run_root, "run.json"), "utf8")) as {
            graph_path?: string;
        };
        const firstProgress = firstStderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(firstRun.exitCode).toBe(1);
        expect(firstPayload.command).toBe("run");
        expect(firstPayload.status).toBe("failed");
        expect(firstRunRecord.graph_path).toBe(graphPath);
        expect(firstProgress).toContain('agentflow: compiled graph "cli-resume-graph" with 3 executable nodes');
        expect(firstProgress).toContain("[0/3] RUN      exec write_seed · repo=main");
        expect(firstProgress).toContain("[1/3] PASS     exec write_seed");
        expect(firstProgress).toContain("[1/3] RUN      check gate_resume · repo=main");
        expect(firstProgress).toContain("  FAIL     check gate_resume");
        expect(firstProgress).toContain("[2/3] FAIL     check gate_resume");
        expect(firstProgress).toContain("[3/3] BLOCK    exec after_resume · terminal_failure");
        expect(firstProgress).toContain("agentflow: FAIL     run · 3/3 terminal nodes");
        firstStderrSpy.mockRestore();
        await writeFile(join(repoDir, "resume-ok.txt"), "ok\n");
        const dryRun = await executeCli(["resume", "--run-root", firstPayload.run_root, "--dry-run"], tempRoot);
        const dryRunPayload = JSON.parse(dryRun.stdout);
        const attemptsBeforeResume = await readRunExecutionAttempts(firstPayload.run_root);
        expect(dryRun.exitCode).toBe(0);
        expect(dryRunPayload.command).toBe("resume");
        expect(dryRunPayload.status).toBe("dry_run");
        expect(dryRunPayload.message).toContain("no nodes were executed");
        expect(dryRunPayload.preserved_node_count).toBe(1);
        expect(dryRunPayload.restarted_node_count).toBe(2);
        expect(dryRunPayload.would_start_node_count).toBe(1);
        expect(dryRunPayload.resume_plan.start_nodes.map((node: {
            authored_id: string;
        }) => node.authored_id)).toEqual([
            "gate_resume"
        ]);
        expect(dryRunPayload.resume_plan.restarted_nodes.map((node: {
            authored_id: string;
        }) => node.authored_id)).toEqual([
            "gate_resume",
            "after_resume"
        ]);
        expect(await readRunExecutionAttempts(firstPayload.run_root)).toHaveLength(attemptsBeforeResume.length);
        const resumedStderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const resumedRun = await executeCli(["resume", "--run-root", firstPayload.run_root], tempRoot);
        const resumedPayload = JSON.parse(resumedRun.stdout);
        const resumedState = JSON.parse(await readFile(join(firstPayload.run_root, "state.json"), "utf8")) as {
            status: string;
            counts: {
                passed: number;
            };
        };
        const resumedEvents = (await readFile(join(firstPayload.run_root, "events.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as {
            type: string;
            payload?: Record<string, unknown>;
        });
        const attempts = await readRunExecutionAttempts(firstPayload.run_root);
        const resumedProgress = resumedStderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(resumedRun.exitCode).toBe(0);
        expect(resumedPayload.command).toBe("resume");
        expect(resumedPayload.status).toBe("passed");
        expect(resumedPayload.run_root).toBe(firstPayload.run_root);
        expect(resumedPayload.resumed_from_status).toBe("failed");
        expect(resumedPayload.preserved_node_count).toBe(1);
        expect(resumedPayload.restarted_node_count).toBe(2);
        expect(resumedState.status).toBe("passed");
        expect(resumedState.counts.passed).toBe(3);
        expect(await readFile(join(repoDir, "done.txt"), "utf8")).toBe("done\n");
        expect(resumedEvents.filter((event) => event.type === "run.started").at(-1)?.payload).toEqual(expect.objectContaining({
            resumed: true,
            previous_status: "failed",
            preserved_node_count: 1,
            restarted_node_count: 2
        }));
        expect(attempts.filter((attempt) => attempt.authored_id === "write_seed")).toHaveLength(2);
        expect(attempts.filter((attempt) => attempt.authored_id === "gate_resume")).toHaveLength(3);
        expect(attempts.filter((attempt) => attempt.authored_id === "after_resume")).toHaveLength(1);
        expect(resumedProgress).toContain("agentflow: RUN      resume · from=failed · preserved=1 restarted=2 · workspace=inplace");
        expect(resumedProgress).toContain("[1/3] RUN      check gate_resume · repo=main");
        expect(resumedProgress).toContain("[2/3] PASS     check gate_resume");
        expect(resumedProgress).toContain("[2/3] RUN      exec after_resume · repo=main");
        expect(resumedProgress).toContain("[3/3] PASS     exec after_resume");
        expect(resumedProgress).toContain("agentflow: PASS     run · 3/3 terminal nodes");
        await rm(tempRoot, { recursive: true, force: true });
    }, 60000);
    it("recompiles the original graph on resume and invalidates changed passed work", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-recompile-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const writeGraph = async (seedValue: string) => {
            await writeFile(graphPath, `${JSON.stringify({
                version: "1",
                graph_id: "cli-resume-recompile",
                intent: { goal: "Exercise cli-resume-recompile.", acceptance_criteria: ["CLI behavior matches the command contract."] },
                repos: {
                    main: {
                        path: "./repo"
                    }
                },
                defaults: {
                    launch_profile: "default",
                    workspace_backend: "inplace"
                },
                profiles: {
                    default: {}
                },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "exec",
                            id: "write_seed",
                            command: "node",
                            args: [
                                "-e",
                                `require('node:fs').writeFileSync('seed.txt', '${seedValue}\\n')`
                            ],
                            runtime: {
                                repo: "main"
                            }
                        },
                        {
                            type: "check",
                            id: "gate_resume",
                            check_kind: "deterministic",
                            command: "node",
                            args: [
                                "-e",
                                "const fs=require('node:fs'); const path=require('node:path'); const passed=fs.existsSync('resume-ok.txt'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'verification.json'), JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                            ],
                            pass_if: {
                                json_path: "$.passed",
                                equals: true
                            },
                            runtime: {
                                repo: "main"
                            }
                        },
                        {
                            type: "exec",
                            id: "after_resume",
                            command: "node",
                            args: [
                                "-e",
                                "const fs=require('node:fs'); const seed=fs.readFileSync('seed.txt','utf8'); fs.writeFileSync('done.txt', seed);"
                            ],
                            runtime: {
                                repo: "main"
                            }
                        }
                    ]
                }
            }, null, 2)}\n`);
        };
        await writeGraph("seed-v1");
        const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
        const firstPayload = JSON.parse(firstRun.stdout);
        expect(firstRun.exitCode).toBe(1);
        expect(await readFile(join(repoDir, "seed.txt"), "utf8")).toBe("seed-v1\n");
        await writeGraph("seed-updated");
        await writeFile(join(repoDir, "resume-ok.txt"), "ok\n");
        const resumedRun = await executeCli(["resume", "--run-root", firstPayload.run_root], tempRoot);
        const resumedPayload = JSON.parse(resumedRun.stdout);
        const attempts = await readRunExecutionAttempts(firstPayload.run_root);
        expect(resumedRun.exitCode).toBe(0);
        expect(resumedPayload.status).toBe("passed");
        expect(resumedPayload.preserved_node_count).toBe(0);
        expect(resumedPayload.restarted_node_count).toBe(3);
        expect(await readFile(join(repoDir, "seed.txt"), "utf8")).toBe("seed-updated\n");
        expect(await readFile(join(repoDir, "done.txt"), "utf8")).toBe("seed-updated\n");
        expect(attempts.filter((attempt) => attempt.authored_id === "write_seed")).toHaveLength(3);
        expect(attempts.filter((attempt) => attempt.authored_id === "gate_resume")).toHaveLength(3);
        expect(attempts.filter((attempt) => attempt.authored_id === "after_resume")).toHaveLength(1);
        await rm(tempRoot, { recursive: true, force: true });
    }, 60000);
    it("restarts a passed repeat scope when resume invalidation reaches it from upstream changes", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-repeat-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        const writeGraph = async (seedValue: string) => {
            await writeFile(graphPath, `${JSON.stringify({
                version: "1",
                graph_id: "cli-resume-repeat",
                intent: { goal: "Exercise cli-resume-repeat.", acceptance_criteria: ["CLI behavior matches the command contract."] },
                repos: {
                    main: {
                        path: "./repo"
                    }
                },
                defaults: {
                    launch_profile: "default",
                    workspace_backend: "inplace"
                },
                profiles: {
                    default: {}
                },
                graph: {
                    type: "sequence",
                    id: "root",
                    steps: [
                        {
                            type: "exec",
                            id: "write_seed",
                            command: "node",
                            args: [
                                "-e",
                                `require('node:fs').writeFileSync('seed.txt', '${seedValue}\\n')`
                            ],
                            runtime: {
                                repo: "main"
                            }
                        },
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
                                        id: "prepare_loop_output",
                                        command: "node",
                                        args: [
                                            "-e",
                                            "const fs=require('node:fs'); fs.writeFileSync('loop.txt', fs.readFileSync('seed.txt', 'utf8'));"
                                        ],
                                        runtime: {
                                            repo: "main"
                                        }
                                    },
                                    {
                                        type: "check",
                                        id: "verify_loop",
                                        check_kind: "deterministic",
                                        command: "node",
                                        args: [
                                            "-e",
                                            "const fs=require('node:fs'); const path=require('node:path'); const passed=fs.existsSync('loop.txt'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'verification.json'), JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                                        ],
                                        pass_if: {
                                            json_path: "$.passed",
                                            equals: true
                                        },
                                        runtime: {
                                            repo: "main"
                                        }
                                    }
                                ]
                            },
                            until: {
                                node: "verify_loop"
                            }
                        },
                        {
                            type: "check",
                            id: "gate_resume",
                            check_kind: "deterministic",
                            command: "node",
                            args: [
                                "-e",
                                "const fs=require('node:fs'); const path=require('node:path'); const passed=fs.existsSync('resume-ok.txt'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'verification.json'), JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                            ],
                            pass_if: {
                                json_path: "$.passed",
                                equals: true
                            },
                            runtime: {
                                repo: "main"
                            }
                        },
                        {
                            type: "exec",
                            id: "finalize",
                            command: "node",
                            args: [
                                "-e",
                                "const fs=require('node:fs'); fs.writeFileSync('done.txt', fs.readFileSync('loop.txt', 'utf8'));"
                            ],
                            runtime: {
                                repo: "main"
                            }
                        }
                    ]
                }
            }, null, 2)}\n`);
        };
        await writeGraph("seed-v1");
        const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
        const firstPayload = JSON.parse(firstRun.stdout);
        expect(firstRun.exitCode).toBe(1);
        expect(await readFile(join(repoDir, "seed.txt"), "utf8")).toBe("seed-v1\n");
        expect(await readFile(join(repoDir, "loop.txt"), "utf8")).toBe("seed-v1\n");
        await writeGraph("seed-updated");
        await writeFile(join(repoDir, "resume-ok.txt"), "ok\n");
        const resumedRun = await executeCli(["resume", "--run-root", firstPayload.run_root], tempRoot);
        const resumedPayload = JSON.parse(resumedRun.stdout);
        const resumedState = JSON.parse(await readFile(join(firstPayload.run_root, "state.json"), "utf8")) as {
            status: string;
            counts: {
                passed: number;
            };
            repeat_scopes: Record<string, {
                status: string;
                latest_iteration_index: number;
            }>;
        };
        const attempts = await readRunExecutionAttempts(firstPayload.run_root);
        expect(resumedRun.exitCode).toBe(0);
        expect(resumedPayload.status).toBe("passed");
        expect(resumedPayload.preserved_node_count).toBe(0);
        expect(resumedPayload.restarted_node_count).toBe(5);
        expect(resumedState.status).toBe("passed");
        expect(resumedState.counts.passed).toBe(5);
        expect(resumedState.repeat_scopes.scope__root__retry.status).toBe("passed");
        expect(resumedState.repeat_scopes.scope__root__retry.latest_iteration_index).toBe(1);
        expect(await readFile(join(repoDir, "seed.txt"), "utf8")).toBe("seed-updated\n");
        expect(await readFile(join(repoDir, "loop.txt"), "utf8")).toBe("seed-updated\n");
        expect(await readFile(join(repoDir, "done.txt"), "utf8")).toBe("seed-updated\n");
        expect(attempts.filter((attempt) => attempt.authored_id === "write_seed")).toHaveLength(2);
        expect(attempts.filter((attempt) => attempt.authored_id === "prepare_loop_output")).toHaveLength(3);
        expect(attempts.filter((attempt) => attempt.authored_id === "verify_loop")).toHaveLength(2);
        expect(attempts.filter((attempt) => attempt.authored_id === "gate_resume")).toHaveLength(3);
        expect(attempts.filter((attempt) => attempt.authored_id === "finalize")).toHaveLength(1);
        expect(attempts.filter((attempt) => attempt.authored_id === "write_seed").map((attempt) => ({
            attempt_index: attempt.attempt_index,
            execution_dir: attempt.execution_dir
        }))).toEqual([
            {
                attempt_index: 1,
                execution_dir: expect.stringMatching(/\/executions\/001-exec-[0-9a-f]{16}$/)
            },
            {
                attempt_index: 2,
                execution_dir: expect.stringMatching(/\/executions\/002-exec-[0-9a-f]{16}$/)
            }
        ]);
        expect(attempts.filter((attempt) => attempt.authored_id === "prepare_loop_output" && attempt.iteration_index !== undefined).map((attempt) => ({
            iteration_index: attempt.iteration_index,
            iteration_attempt_index: attempt.iteration_attempt_index,
            execution_dir: attempt.execution_dir
        }))).toEqual([
            {
                iteration_index: 1,
                iteration_attempt_index: 1,
                execution_dir: expect.stringMatching(/\/executions\/i001-a001-exec-[0-9a-f]{16}$/)
            },
            {
                iteration_index: 1,
                iteration_attempt_index: 2,
                execution_dir: expect.stringMatching(/\/executions\/i001-a002-exec-[0-9a-f]{16}$/)
            }
        ]);
        await rm(tempRoot, { recursive: true, force: true });
    }, 60000);
    it("repairs a passed repeat scope whose stored node statuses became inconsistent before resume", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-repeat-repair-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-resume-repeat-repair",
            intent: { goal: "Exercise cli-resume-repeat-repair.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "write_seed",
                        command: "node",
                        args: [
                            "-e",
                            "require('node:fs').writeFileSync('seed.txt', 'seed-v1\\n')"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    },
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
                                    id: "prepare_loop_output",
                                    command: "node",
                                    args: [
                                        "-e",
                                        "const fs=require('node:fs'); fs.writeFileSync('loop.txt', fs.readFileSync('seed.txt', 'utf8'));"
                                    ],
                                    runtime: {
                                        repo: "main"
                                    }
                                },
                                {
                                    type: "check",
                                    id: "verify_loop",
                                    check_kind: "deterministic",
                                    command: "node",
                                    args: [
                                        "-e",
                                        "const fs=require('node:fs'); const path=require('node:path'); const passed=fs.existsSync('loop.txt'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'verification.json'), JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                                    ],
                                    pass_if: {
                                        json_path: "$.passed",
                                        equals: true
                                    },
                                    runtime: {
                                        repo: "main"
                                    }
                                }
                            ]
                        },
                        until: {
                            node: "verify_loop"
                        }
                    },
                    {
                        type: "check",
                        id: "gate_resume",
                        check_kind: "deterministic",
                        command: "node",
                        args: [
                            "-e",
                            "const fs=require('node:fs'); const path=require('node:path'); const passed=fs.existsSync('resume-ok.txt'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'verification.json'), JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                        ],
                        pass_if: {
                            json_path: "$.passed",
                            equals: true
                        },
                        runtime: {
                            repo: "main"
                        }
                    },
                    {
                        type: "exec",
                        id: "finalize",
                        command: "node",
                        args: [
                            "-e",
                            "const fs=require('node:fs'); fs.writeFileSync('done.txt', fs.readFileSync('loop.txt', 'utf8'));"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
        const firstPayload = JSON.parse(firstRun.stdout);
        const statePath = join(firstPayload.run_root, "state.json");
        const mutatedState = JSON.parse(await readFile(statePath, "utf8")) as {
            counts: Record<string, number>;
            node_statuses: Record<string, string>;
            repeat_scopes: Record<string, {
                status: string;
            }>;
        };
        expect(firstRun.exitCode).toBe(1);
        expect(await readFile(join(repoDir, "loop.txt"), "utf8")).toBe("seed-v1\n");
        for (const compiledId of Object.keys(mutatedState.node_statuses)) {
            if (compiledId.includes("__prepare_loop_output") || compiledId.includes("__verify_loop")) {
                mutatedState.node_statuses[compiledId] = "blocked";
            }
        }
        mutatedState.repeat_scopes.scope__root__retry.status = "passed";
        mutatedState.counts = Object.values(mutatedState.node_statuses).reduce((counts, status) => {
            counts.total += 1;
            counts[status] = (counts[status] ?? 0) + 1;
            return counts;
        }, {
            total: 0,
            pending: 0,
            ready: 0,
            running: 0,
            passed: 0,
            failed: 0,
            blocked: 0,
            canceled: 0,
            skipped: 0
        } as Record<string, number>);
        await writeFile(statePath, `${JSON.stringify(mutatedState, null, 2)}\n`);
        await writeFile(join(repoDir, "seed.txt"), "seed-updated\n");
        await writeFile(join(repoDir, "resume-ok.txt"), "ok\n");
        const resumedRun = await executeCli(["resume", "--run-root", firstPayload.run_root], tempRoot);
        const resumedPayload = JSON.parse(resumedRun.stdout);
        const resumedState = JSON.parse(await readFile(statePath, "utf8")) as {
            status: string;
            repeat_scopes: Record<string, {
                status: string;
                latest_iteration_index: number;
            }>;
        };
        const attempts = await readRunExecutionAttempts(firstPayload.run_root);
        expect(resumedRun.exitCode).toBe(0);
        expect(resumedPayload.status).toBe("passed");
        expect(resumedPayload.preserved_node_count).toBe(1);
        expect(resumedPayload.restarted_node_count).toBe(4);
        expect(resumedState.status).toBe("passed");
        expect(resumedState.repeat_scopes.scope__root__retry.status).toBe("passed");
        expect(resumedState.repeat_scopes.scope__root__retry.latest_iteration_index).toBe(1);
        expect(await readFile(join(repoDir, "loop.txt"), "utf8")).toBe("seed-updated\n");
        expect(await readFile(join(repoDir, "done.txt"), "utf8")).toBe("seed-updated\n");
        expect(attempts.filter((attempt) => attempt.authored_id === "write_seed")).toHaveLength(1);
        expect(attempts.filter((attempt) => attempt.authored_id === "prepare_loop_output")).toHaveLength(3);
        expect(attempts.filter((attempt) => attempt.authored_id === "verify_loop")).toHaveLength(2);
        expect(attempts.filter((attempt) => attempt.authored_id === "gate_resume")).toHaveLength(3);
        expect(attempts.filter((attempt) => attempt.authored_id === "finalize")).toHaveLength(1);
        await rm(tempRoot, { recursive: true, force: true });
    }, 60000);
    it("rejects a relative AGENTFLOW_RUNS_ROOT override before launching a run", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-run-runs-root-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        const previousRunsRoot = process.env.AGENTFLOW_RUNS_ROOT;
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-run-relative-runs-root",
            intent: { goal: "Exercise cli-run-relative-runs-root.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "noop",
                        command: "node",
                        args: [
                            "-e",
                            "process.stdout.write('ok\\n')"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        try {
            process.env.AGENTFLOW_RUNS_ROOT = "relative-runs";
            const result = await executeCli(["run", "--graph", graphPath], tempRoot);
            const payload = JSON.parse(result.stdout);
            expect(result.exitCode).toBe(1);
            expect(payload.command).toBe("run");
            expect(payload.status).toBe("failed");
            expect(payload.message).toContain("AGENTFLOW_RUNS_ROOT must be an absolute path");
            await expect(access(join(tempRoot, ".agentflow", "runs"))).rejects.toThrow();
        }
        finally {
            if (previousRunsRoot === undefined) {
                delete process.env.AGENTFLOW_RUNS_ROOT;
            }
            else {
                process.env.AGENTFLOW_RUNS_ROOT = previousRunsRoot;
            }
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("cancels an active run through the CLI signal contract and writes canceled artifacts", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-cancel-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        const startedPath = join(repoDir, "hang-started.txt");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-cancel-graph",
            intent: { goal: "Exercise cli-cancel-graph.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "hang",
                        command: "node",
                        args: [
                            "-e",
                            "require('node:fs').writeFileSync('hang-started.txt', 'started\\n'); setInterval(() => {}, 1000);"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    },
                    {
                        type: "exec",
                        id: "after-cancel",
                        command: "node",
                        args: [
                            "-e",
                            "require('node:fs').writeFileSync('should-not-exist.txt', 'unexpected\\n')"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const controller = new AbortController();
        const resultPromise = executeCli(["run", "--graph", graphPath], tempRoot, {
            signal: controller.signal
        });
        await waitForPath(startedPath);
        controller.abort();
        const result = await resultPromise;
        const payload = JSON.parse(result.stdout);
        const state = JSON.parse(await readFile(payload.artifacts.state_file, "utf8")) as {
            status: string;
            counts: {
                canceled: number;
                skipped: number;
            };
        };
        const events = (await readFile(payload.artifacts.events_file, "utf8"))
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as {
            type: string;
        });
        const runCanceledEvents = events.filter((event) => event.type === "run.canceled");
        const nodeCanceledEvents = events.filter((event) => event.type === "node.canceled");
        expect(result.exitCode).toBe(1);
        expect(payload.command).toBe("run");
        expect(payload.status).toBe("canceled");
        expect(state.status).toBe("canceled");
        expect(state.counts.canceled).toBeGreaterThanOrEqual(1);
        expect(state.counts.skipped).toBeGreaterThanOrEqual(1);
        expect(runCanceledEvents).toHaveLength(1);
        expect(nodeCanceledEvents.length).toBeGreaterThanOrEqual(1);
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("fails loudly when a repo path resolves to a file instead of a directory", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-repo-path-file-"));
        const repoFile = join(tempRoot, "repo.txt");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await writeFile(repoFile, "not a directory\n");
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-repo-path-file",
            intent: { goal: "Exercise cli-repo-path-file.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "./repo.txt"
                }
            },
            defaults: {
                launch_profile: "default",
                workspace_backend: "inplace"
            },
            profiles: {
                default: {}
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "noop",
                        command: "node",
                        args: [
                            "-e",
                            "process.stdout.write('ok\\n')"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        try {
            const result = await executeCli(["run", "--graph", graphPath], tempRoot);
            const payload = JSON.parse(result.stdout);
            expect(result.exitCode).toBe(1);
            expect(payload.command).toBe("run");
            expect(payload.status).toBe("failed");
            expect(payload.message).toBe("One or more repo sources could not be resolved for runtime execution.");
            expect(payload.path_resolution.graph_path).toBe(graphPath);
            expect(payload.diagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    path: "$.repos.main.path",
                    message: expect.stringContaining("Resolved repo path is not a directory")
                })
            ]));
            expect(payload.next_steps.validate).toContain("agentflow validate --graph");
            expect(payload.next_steps).not.toHaveProperty("compile");
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("surfaces unknown authored launch profiles from the graph itself", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-launch-settings-"));
        const graphPath = join(tempRoot, "invalid-launch.graph.json");
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "invalid-launch-settings",
            intent: { goal: "Exercise invalid-launch-settings.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: {
                main: {
                    path: "."
                }
            },
            defaults: {
                launch_profile: "missing",
                workspace_backend: "inplace"
            },
            profiles: {
                review: {},
                supervisor: {
                    harness: "codex-cli",
                    sandbox: "read-only"
                }
            },
            supervision: {
                profile: "supervisor",
                max_total_interventions: 3
            },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "agent",
                        id: "implement",
                        intent: {
                            goal: "Implement the requested change.",
                            acceptance_criteria: ["The node satisfies its acceptance criteria."],
                            constraints: []
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const invalidValidate = await executeCli(["validate", "--graph", graphPath], tempRoot);
        const invalidValidatePayload = JSON.parse(invalidValidate.stdout);
        expect(invalidValidate.exitCode).toBe(1);
        expect(invalidValidatePayload.command).toBe("validate");
        expect(invalidValidatePayload.message).toContain("Graph could not be loaded or normalized from --graph");
        expect(invalidValidatePayload.checks.authored.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                path: "$.defaults.launch_profile",
                message: expect.stringContaining('defaults.launch_profile references unknown profile "missing"')
            })
        ]));
        await rm(tempRoot, { recursive: true, force: true });
    });
    it("prints graph help with the local-first contract", async () => {
        const graphHelp = await executeCli(["graph-help"]);
        expect(graphHelp.exitCode).toBe(0);
        expect(graphHelp.stdout).toContain("Executable node kinds: agent, exec, check, checkpoint");
        expect(graphHelp.stdout).toContain("Managed pattern scaffolds: pattern_deep_research, pattern_deep_work, pattern_work_list");
        expect(graphHelp.stdout).not.toContain("Legacy thin aliases");
        expect(graphHelp.stdout).toContain(`"version": "1"`);
        expect(graphHelp.stdout).toContain("checkpoint nodes are planned human gates inside repeat bodies");
        expect(graphHelp.stdout).toContain("evaluation lanes are distinct");
        expect(graphHelp.stdout).toContain("latest_passed, latest_failed, previous");
        expect(graphHelp.stdout).toContain("Recommended local workflow:");
        expect(graphHelp.stdout).toContain("--strict for release gates");
        expect(graphHelp.stdout).toContain("--diagram-output graph.mmd");
        expect(graphHelp.stdout).toContain("--diagram-image-output graph.svg");
        expect(graphHelp.stdout).toContain("Repo paths in $.repos.*.path resolve relative to the graph file directory.");
    });
    it("rejects the removed control command", async () => {
        const result = await executeCli(["control", "--mission", "mission.json"]);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toContain("Unknown command: control");
    });
    it("rejects removed validate mode flags", async () => {
        const graphPath = fileURLToPath(new URL("../graph/fixtures/repeat.graph.json", import.meta.url));
        const runReady = await executeCli(["validate", "--graph", graphPath, "--run-ready"]);
        const review = await executeCli(["validate", "--graph", graphPath, "--review"]);
        const strictReview = await executeCli(["validate", "--graph", graphPath, "--strict-review"]);
        const diagram = await executeCli(["validate", "--graph", graphPath, "--diagram"]);
        expect(runReady.exitCode).toBe(2);
        expect(runReady.stdout).toContain("Unexpected option(s): --run-ready");
        expect(review.exitCode).toBe(2);
        expect(review.stdout).toContain("Unexpected option(s): --review");
        expect(strictReview.exitCode).toBe(2);
        expect(strictReview.stdout).toContain("Unexpected option(s): --strict-review");
        expect(diagram.exitCode).toBe(2);
        expect(diagram.stdout).toContain("Unexpected option(s): --diagram");
    });
    it("renders command help and rejects unexpected positionals or options", async () => {
        const help = await executeCli(["run", "--help"]);
        const positional = await executeCli(["validate", "--graph", "agentflow.graph.json", "extra"]);
        const unexpectedOption = await executeCli(["validate", "--graph", "agentflow.graph.json", "--label", "oops"]);
        const removedLaunchOptions = await executeCli(["run", "--graph", "agentflow.graph.json", "--profile", "default"]);
        expect(help.exitCode).toBe(0);
        expect(help.stdout).toContain("Usage: agentflow run --graph");
        expect(help.stdout).not.toContain("--workspace-backend <name>");
        expect(help.stdout).not.toContain("--profile <name>");
        expect(help.stdout).toContain("Examples:");
        expect(help.stdout).toContain("Press Ctrl-C");
        expect(positional.exitCode).toBe(2);
        expect(positional.stdout).toContain("Unexpected positional arguments: extra");
        expect(positional.stdout).toContain("Try: agentflow validate --help");
        expect(positional.stdout).toContain("Graph contract: agentflow graph-help");
        expect(unexpectedOption.exitCode).toBe(2);
        expect(unexpectedOption.stdout).toContain("Unexpected option(s): --label");
        expect(unexpectedOption.stdout).toContain("Try: agentflow validate --help");
        expect(removedLaunchOptions.exitCode).toBe(2);
        expect(removedLaunchOptions.stdout).toContain("Unexpected option(s): --profile");
        expect(removedLaunchOptions.stdout).toContain("Try: agentflow run --help");
    });
    it("supports explicit help entrypoints", async () => {
        const mainHelp = await executeCli(["--help"]);
        const validateHelp = await executeCli(["validate", "-h"]);
        const runsHelp = await executeCli(["runs", "--help"]);
        const inspectHelp = await executeCli(["inspect", "--help"]);
        const evalHelp = await executeCli(["eval", "--help"]);
        const evalSubcommandHelp = await executeCli(["eval", "help"]);
        expect(mainHelp.exitCode).toBe(0);
        expect(mainHelp.stdout).toContain("Agentflow CLI");
        expect(mainHelp.stdout).toContain("Runs root contract:");
        expect(mainHelp.stdout).not.toContain("control");
        expect(validateHelp.exitCode).toBe(0);
        expect(validateHelp.stdout).toContain("validate: Validate launch readiness for an authored graph without launching a run.");
        expect(validateHelp.stdout).toContain("--show-compiled");
        expect(validateHelp.stdout).toContain("--strict");
        expect(validateHelp.stdout).toContain("--output-dir");
        expect(validateHelp.stdout).toContain("--diagram-output");
        expect(validateHelp.stdout).toContain("--diagram-image-output");
        expect(validateHelp.stdout).toContain("--diagram-image-renderer");
        expect(validateHelp.stdout).toContain("--diagram-image-package");
        expect(validateHelp.stdout).not.toContain("--run-ready");
        expect(validateHelp.stdout).not.toContain("--review");
        expect(validateHelp.stdout).not.toContain("--strict-review");
        expect(runsHelp.exitCode).toBe(0);
        expect(runsHelp.stdout).toContain("runs: Inspect previously recorded run roots");
        expect(runsHelp.stdout).toContain("--graph");
        expect(inspectHelp.exitCode).toBe(0);
        expect(inspectHelp.stdout).toContain("inspect: Inspect a recorded run root");
        expect(inspectHelp.stdout).toContain("Usage: agentflow inspect <run-root>");
        expect(evalHelp.exitCode).toBe(0);
        expect(evalHelp.stdout).toContain("local workflow eval suites");
        expect(evalSubcommandHelp.exitCode).toBe(0);
        expect(evalSubcommandHelp.stdout).toContain("complete workflow traces");
    });
    it("lists recorded run summaries for a graph through agentflow runs list", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-runs-list-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-runs-list-graph",
            intent: { goal: "Exercise cli-runs-list-graph.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: { main: { path: "./repo" } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: { default: {} },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "noop",
                        command: "node",
                        args: ["-e", "process.stdout.write('ok\\n');"],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
            const secondRun = await executeCli(["run", "--graph", graphPath], tempRoot);
            expect(firstRun.exitCode).toBe(0);
            expect(secondRun.exitCode).toBe(0);
            const listResult = await executeCli(["runs", "list", "--graph", graphPath], tempRoot);
            const listPayload = JSON.parse(listResult.stdout);
            expect(listResult.exitCode).toBe(0);
            expect(listPayload.command).toBe("runs list");
            expect(listPayload.status).toBe("passed");
            expect(listPayload.runs_root).toBe(join(tempRoot, ".agentflow", "runs"));
            expect(listPayload.runs_root_source).toBe("graph-directory-default");
            expect(listPayload.graph_path).toBe(graphPath);
            expect(listPayload.runs_count).toBe(2);
            expect(listPayload.runs).toHaveLength(2);
            for (const summary of listPayload.runs) {
                expect(summary.graph_id).toBe("cli-runs-list-graph");
                expect(summary.graph_path).toBe(graphPath);
                expect(summary.status).toBe("passed");
                expect(summary.workspace_backend).toBe("inplace");
                expect(summary.launch_profile).toBe("default");
                expect(typeof summary.run_id).toBe("string");
                expect(typeof summary.started_at).toBe("string");
            }
            const firstParsed = JSON.parse(firstRun.stdout);
            const secondParsed = JSON.parse(secondRun.stdout);
            expect(listPayload.runs[0]!.run_id).toBe(secondParsed.run_id);
            expect(listPayload.runs[1]!.run_id).toBe(firstParsed.run_id);
            const explicitRunsRoot = await executeCli(["runs", "list", "--runs-root", join(tempRoot, ".agentflow", "runs")], tempRoot);
            const explicitPayload = JSON.parse(explicitRunsRoot.stdout);
            expect(explicitRunsRoot.exitCode).toBe(0);
            expect(explicitPayload.runs_count).toBe(2);
            expect(explicitPayload.runs_root).toBe(join(tempRoot, ".agentflow", "runs"));
            expect(explicitPayload.runs_root_source).toBe("explicit");
            expect(explicitPayload.runs_root_input).toBe(join(tempRoot, ".agentflow", "runs"));
        }
        finally {
            stderrSpy.mockRestore();
            await rm(tempRoot, { recursive: true, force: true });
        }
    }, 60000);
    it("rejects invalid runs subcommands and combinations", async () => {
        const missing = await executeCli(["runs"]);
        const conflicting = await executeCli([
            "runs",
            "list",
            "--graph",
            "agentflow.graph.json",
            "--runs-root",
            "/tmp/runs"
        ]);
        const wrongSubcommand = await executeCli(["runs", "show"]);
        expect(missing.exitCode).toBe(2);
        expect(missing.stdout).toContain("Missing runs subcommand");
        expect(conflicting.exitCode).toBe(2);
        expect(conflicting.stdout).toContain("Provide either --graph or --runs-root, not both.");
        expect(wrongSubcommand.exitCode).toBe(2);
        expect(wrongSubcommand.stdout).toContain("Unexpected runs subcommand");
    });
    it("inspects a recorded run root and surfaces stderr tails for failures", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-inspect-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-inspect-graph",
            intent: { goal: "Exercise cli-inspect-graph.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: { main: { path: "./repo" } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: { default: {} },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "boom",
                        command: "node",
                        args: [
                            "-e",
                            "process.stderr.write('failure-marker-12345\\n'); process.exit(1);"
                        ],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const runResult = await executeCli(["run", "--graph", graphPath], tempRoot);
            const runPayload = JSON.parse(runResult.stdout);
            expect(runResult.exitCode).toBe(1);
            expect(runPayload.status).toBe("failed");
            const inspectResult = await executeCli(["inspect", runPayload.run_root], tempRoot);
            const inspectPayload = JSON.parse(inspectResult.stdout);
            expect(inspectResult.exitCode).toBe(0);
            expect(inspectPayload.command).toBe("inspect");
            expect(inspectPayload.status).toBe("passed");
            expect(inspectPayload.run_root).toBe(runPayload.run_root);
            expect(inspectPayload.run_id).toBe(runPayload.run_id);
            expect(inspectPayload.graph_id).toBe("cli-inspect-graph");
            expect(inspectPayload.graph_path).toBe(graphPath);
            expect(inspectPayload.run_status).toBe("failed");
            expect(inspectPayload.failed_node_count).toBeGreaterThan(0);
            expect(inspectPayload.failed_node_stderr_tails).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    authored_id: "boom",
                    status: "failed",
                    stderr_tail: expect.stringContaining("failure-marker-12345")
                })
            ]));
            expect(inspectPayload.delivery_artifact_taxonomy).toEqual(expect.objectContaining({
                human_entrypoints: expect.any(Number),
                resume_required: expect.any(Number),
                audit_trail: expect.any(Number),
                debug_only: expect.any(Number),
                empty_or_noop: expect.any(Number)
            }));
            expect(inspectPayload.artifacts.run_file).toBe(join(runPayload.run_root, "run.json"));
            expect(inspectPayload.artifacts.state_file).toBe(join(runPayload.run_root, "state.json"));
        }
        finally {
            stderrSpy.mockRestore();
            await rm(tempRoot, { recursive: true, force: true });
        }
    }, 60000);
    it("reports missing run roots for inspect and rejects unexpected positionals", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-inspect-missing-"));
        try {
            const missing = await executeCli(["inspect"]);
            expect(missing.exitCode).toBe(2);
            expect(missing.stdout).toContain("Missing required positional argument: <run-root>");
            const extras = await executeCli(["inspect", "a", "b"]);
            expect(extras.exitCode).toBe(2);
            expect(extras.stdout).toContain("Unexpected positional arguments: b");
            const nonexistent = await executeCli(["inspect", join(tempRoot, "missing-run-root")], tempRoot);
            const nonexistentPayload = JSON.parse(nonexistent.stdout);
            expect(nonexistent.exitCode).toBe(1);
            expect(nonexistentPayload.command).toBe("inspect");
            expect(nonexistentPayload.status).toBe("failed");
            expect(nonexistentPayload.message).toContain("Run root could not be resolved");
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("handles missing or corrupted durable run files during inspect", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-inspect-damaged-"));
        try {
            const missingRunJson = join(tempRoot, "missing-run-json");
            await mkdir(missingRunJson, { recursive: true });
            const missing = await executeCli(["inspect", missingRunJson], tempRoot);
            const missingPayload = JSON.parse(missing.stdout);
            expect(missing.exitCode).toBe(1);
            expect(missingPayload.message).toContain("run.json could not be read");
            const corruptRunJson = join(tempRoot, "corrupt-run-json");
            await mkdir(corruptRunJson, { recursive: true });
            await writeFile(join(corruptRunJson, "run.json"), "{not-json", "utf8");
            const corrupt = await executeCli(["inspect", corruptRunJson], tempRoot);
            const corruptPayload = JSON.parse(corrupt.stdout);
            expect(corrupt.exitCode).toBe(1);
            expect(corruptPayload.message).toContain("run.json could not be read");
            const partialState = join(tempRoot, "partial-state");
            await mkdir(partialState, { recursive: true });
            await writeFile(join(partialState, "run.json"), `${JSON.stringify({
                run_id: "run-partial-state",
                graph_id: "partial-state",
                launch_profile: "default",
                workspace_backend: "inplace",
                status: "failed",
                started_at: "2026-04-24T00:00:00.000Z",
                ended_at: "2026-04-24T00:00:01.000Z"
            }, null, 2)}\n`, "utf8");
            await writeFile(join(partialState, "state.json"), "{partial", "utf8");
            const inspectedPartial = await executeCli(["inspect", partialState], tempRoot);
            const partialPayload = JSON.parse(inspectedPartial.stdout);
            expect(inspectedPartial.exitCode).toBe(0);
            expect(partialPayload.status).toBe("passed");
            expect(partialPayload.run_status).toBe("failed");
            expect(partialPayload.counts).toBeUndefined();
            expect(partialPayload.artifacts.state_file).toBe(join(partialState, "state.json"));
            const partialDelivery = join(tempRoot, "partial-delivery");
            await mkdir(join(partialDelivery, "delivery"), { recursive: true });
            await writeFile(join(partialDelivery, "run.json"), `${JSON.stringify({
                run_id: "run-partial-delivery",
                graph_id: "partial-delivery",
                launch_profile: "default",
                workspace_backend: "inplace",
                status: "passed",
                started_at: "2026-04-24T00:00:00.000Z",
                ended_at: "2026-04-24T00:00:01.000Z"
            }, null, 2)}\n`, "utf8");
            await writeFile(join(partialDelivery, "state.json"), `${JSON.stringify({
                run_id: "run-partial-delivery",
                graph_id: "partial-delivery",
                snapshot_seq: 1,
                status: "passed",
                evidence_status: "clean",
                workspace_backend: "inplace",
                repo_workspaces: {},
                workspace_change_artifacts: {},
                counts: {
                    total: 0,
                    pending: 0,
                    ready: 0,
                    running: 0,
                    passed: 0,
                    failed: 0,
                    blocked: 0,
                    canceled: 0,
                    skipped: 0
                },
                soft_verification_counts: { passed: 0, failed: 0 },
                failed_soft_verifications: [],
                supervisor: {
                    status: "healthy",
                    intervention_count: 0,
                    budget_remaining: {},
                    timeline: [],
                    escalations: []
                },
                node_statuses: {},
                active_executions: {},
                latest_execution_by_compiled_id: {},
                repeat_scopes: {},
                started_at: "2026-04-24T00:00:00.000Z",
                ended_at: "2026-04-24T00:00:01.000Z"
            }, null, 2)}\n`, "utf8");
            await writeFile(join(partialDelivery, "delivery", "manifest.json"), "{partial", "utf8");
            const inspectedDelivery = await executeCli(["inspect", partialDelivery], tempRoot);
            const deliveryPayload = JSON.parse(inspectedDelivery.stdout);
            expect(inspectedDelivery.exitCode).toBe(0);
            expect(deliveryPayload.status).toBe("passed");
            expect(deliveryPayload.delivery_package).toBe(join(partialDelivery, "delivery", "manifest.json"));
            expect(deliveryPayload.delivery_artifact_taxonomy).toBeUndefined();
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("resumes the latest failed run for a graph via resume --graph --latest", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-latest-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-resume-latest-graph",
            intent: { goal: "Exercise cli-resume-latest-graph.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: { main: { path: "./repo" } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: { default: {} },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "check",
                        id: "gate",
                        check_kind: "deterministic",
                        command: "node",
                        args: [
                            "-e",
                            "const fs=require('node:fs'); const path=require('node:path'); const passed=fs.existsSync('latest-ok.txt'); fs.writeFileSync(path.join(process.env.AGENTFLOW_OUTPUT_DIR,'verification.json'), JSON.stringify({passed})); process.exit(passed ? 0 : 1);"
                        ],
                        pass_if: { json_path: "$.passed", equals: true },
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const firstRun = await executeCli(["run", "--graph", graphPath], tempRoot);
            const firstPayload = JSON.parse(firstRun.stdout);
            expect(firstRun.exitCode).toBe(1);
            expect(firstPayload.status).toBe("failed");
            const secondRun = await executeCli(["run", "--graph", graphPath], tempRoot);
            const secondPayload = JSON.parse(secondRun.stdout);
            expect(secondRun.exitCode).toBe(1);
            expect(secondPayload.status).toBe("failed");
            expect(secondPayload.run_id).not.toBe(firstPayload.run_id);
            await writeFile(join(repoDir, "latest-ok.txt"), "ok\n");
            const resumed = await executeCli(["resume", "--graph", graphPath, "--latest"], tempRoot);
            const resumedPayload = JSON.parse(resumed.stdout);
            expect(resumed.exitCode).toBe(0);
            expect(resumedPayload.command).toBe("resume");
            expect(resumedPayload.status).toBe("passed");
            expect(resumedPayload.run_root).toBe(secondPayload.run_root);
            expect(resumedPayload.run_id).toBe(secondPayload.run_id);
        }
        finally {
            stderrSpy.mockRestore();
            await rm(tempRoot, { recursive: true, force: true });
        }
    }, 60000);
    it("reports a friendly message when resume --latest finds no resumable runs", async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-cli-resume-latest-empty-"));
        const repoDir = join(tempRoot, "repo");
        const graphPath = join(tempRoot, "agentflow.graph.json");
        await mkdir(repoDir, { recursive: true });
        await initGitRepo(repoDir);
        await writeFile(graphPath, `${JSON.stringify({
            version: "1",
            graph_id: "cli-resume-latest-empty-graph",
            intent: { goal: "Exercise cli-resume-latest-empty-graph.", acceptance_criteria: ["CLI behavior matches the command contract."] },
            repos: { main: { path: "./repo" } },
            defaults: { launch_profile: "default", workspace_backend: "inplace" },
            profiles: { default: {} },
            graph: {
                type: "sequence",
                id: "root",
                steps: [
                    {
                        type: "exec",
                        id: "noop",
                        command: "node",
                        args: ["-e", "process.exit(0);"],
                        runtime: {
                            repo: "main"
                        }
                    }
                ]
            }
        }, null, 2)}\n`);
        try {
            const conflicting = await executeCli([
                "resume",
                "--run-root",
                "/tmp/some/run-root",
                "--graph",
                graphPath,
                "--latest"
            ]);
            expect(conflicting.exitCode).toBe(2);
            expect(conflicting.stdout).toContain("Provide either --run-root or --latest with --graph, not both.");
            const missingGraph = await executeCli(["resume", "--latest"]);
            expect(missingGraph.exitCode).toBe(2);
            expect(missingGraph.stdout).toContain("--latest requires --graph to locate the runs root.");
            const missingAll = await executeCli(["resume"]);
            expect(missingAll.exitCode).toBe(2);
            expect(missingAll.stdout).toContain("Missing required option: --run-root (or --graph with --latest)");
            const noRunsRoot = await executeCli(["resume", "--graph", graphPath, "--latest"], tempRoot);
            const noRunsRootPayload = JSON.parse(noRunsRoot.stdout);
            expect(noRunsRoot.exitCode).toBe(1);
            expect(noRunsRootPayload.command).toBe("resume");
            expect(noRunsRootPayload.status).toBe("failed");
            expect(noRunsRootPayload.message).toContain("No runs root found for the supplied graph.");
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
    it("returns usage errors for missing required options and unknown commands", async () => {
        const missingGraph = await executeCli(["run"]);
        const unknownCommand = await executeCli(["ui"]);
        expect(missingGraph.exitCode).toBe(2);
        expect(missingGraph.stdout).toContain("Missing required option: --graph");
        expect(missingGraph.stdout).toContain("Try: agentflow run --help");
        expect(missingGraph.stdout).toContain("Graph contract: agentflow graph-help");
        expect(unknownCommand.exitCode).toBe(2);
        expect(unknownCommand.stdout).toContain("Unknown command: ui");
    });
});
