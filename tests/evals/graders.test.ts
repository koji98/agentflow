import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EvalCriterion, EvalScenario, EvalTracePacket } from "../../src/evals/types.js";

const runAiCheckMock = vi.hoisted(() => vi.fn());
const fakeHarness = vi.hoisted(() => ({
    kind: "codex-cli",
    capabilities: { supports_ai_check: true },
    checkReadiness: vi.fn(async () => [])
}));

vi.mock("../../src/runtime/checks/ai.js", () => ({
    runAiCheck: runAiCheckMock
}));

vi.mock("../../src/runtime/harness/codex_cli.js", () => ({
    createCodexCliHarness: () => fakeHarness
}));

vi.mock("../../src/runtime/harness/cursor_cli.js", () => ({
    createCursorCliHarness: () => fakeHarness
}));

const { runQualityCriterion } = await import("../../src/evals/graders.js");

describe("eval quality graders", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("mounts the trial root for AI quality judges so trace and run evidence are inspectable", async () => {
        const root = await mkdtemp(join(tmpdir(), "agentflow-quality-grader-"));
        const suiteDir = join(root, "suite");
        const trialRoot = join(root, "trial");
        const outputDir = join(trialRoot, "judge-results", "quality");
        const rubricPath = join(suiteDir, "judges", "quality.md");
        await mkdir(join(suiteDir, "judges"), { recursive: true });
        await mkdir(trialRoot, { recursive: true });
        await writeFile(rubricPath, "Grade from trace evidence.\n", "utf8");

        runAiCheckMock.mockResolvedValueOnce({
            harness_result: { status: "passed", exitCode: 0, stdout: "", stderr: "" },
            evaluation: {
                raw: JSON.stringify({
                    passed_quality_bar: true,
                    score: 5,
                    dimension_scores: { artifact_quality: 5 },
                    blockers: [],
                    rationale: "Trace evidence is inspectable.",
                    prompt_feedback: {
                        helpful_sections: [],
                        noisy_sections: [],
                        missing_guidance: []
                    }
                })
            }
        });

        const criterion: EvalCriterion = {
            id: "quality",
            kind: "quality",
            required: false,
            rubric_path: rubricPath,
            threshold: 4,
            model: "gpt-5.4-mini"
        };
        const scenario = {
            id: "scenario",
            bucket: "simulated-control",
            difficulty: "hard",
            description: "Scenario description.",
            scenario_dir: join(suiteDir, "scenarios", "scenario"),
            graph_template_path: join(suiteDir, "scenarios", "scenario", "graph.template.json"),
            environment: {
                repo: "repo",
                repo_path: join(trialRoot, "workspace", "repo"),
                init_git: true
            },
            workflow: {
                graph_template: "graph.template.json",
                graph_template_path: join(suiteDir, "scenarios", "scenario", "graph.template.json"),
                harness: "codex-cli"
            },
            criteria: {},
            metadata: {}
        } satisfies EvalScenario;
        const tracePacket = {
            schema_version: "1",
            run_root: join(trialRoot, "runs", "run"),
            outcome: { status: "passed", counts: {} },
            attempts: [],
            artifacts: [],
            events: [],
            metrics: {}
        } as unknown as EvalTracePacket;

        const result = await runQualityCriterion({
            criterion,
            suite_dir: suiteDir,
            scenario,
            anonymized_variant_label: "variant-01",
            trial_id: "trial-001",
            trial_root: trialRoot,
            run_root: tracePacket.run_root,
            trace_packet: tracePacket,
            trace_packet_file: join(trialRoot, "trace-packet.json"),
            output_dir: outputDir
        });

        expect(result.passed).toBe(true);
        expect(runAiCheckMock).toHaveBeenCalledWith(expect.objectContaining({
            repo_path: suiteDir,
            runtime_dir: trialRoot,
            context_packet_path: join(outputDir, "context", "packet.json")
        }));
    });
});
