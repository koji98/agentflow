import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createCodexCliHarness } from "../runtime/harness/codex_cli.js";
import { createCursorCliHarness } from "../runtime/harness/cursor_cli.js";
import { runAiCheck } from "../runtime/checks/ai.js";
import { runLocalProcess } from "../runtime/checks/deterministic.js";
import type { HarnessAdapter } from "../runtime/harness/types.js";
import { parseJudgeResult } from "./suite.js";
import type {
  EvalCriterion,
  EvalCriterionResult,
  EvalJudgePayload,
  EvalScenario,
  EvalScriptCriterionPayload,
  EvalTracePacket
} from "./types.js";

function parseStructuredPayload(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();

  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    const firstObject = trimmed.match(/\{[\s\S]*\}/u);
    if (!firstObject?.[0]) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(firstObject[0]) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function normalizeScriptPayload(payload: unknown): {
  payload?: EvalScriptCriterionPayload;
  error?: string;
} {
  const record =
    typeof payload === "string"
      ? parseStructuredPayload(payload)
      : payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : undefined;

  if (!record) {
    return { error: "custom_script criterion output was not valid structured JSON." };
  }

  if (typeof record.passed !== "boolean") {
    return { error: "custom_script criterion output must include boolean passed." };
  }

  if (record.assertions !== undefined && !Array.isArray(record.assertions)) {
    return { error: "custom_script criterion assertions must be an array when present." };
  }

  if (record.blockers !== undefined && !Array.isArray(record.blockers)) {
    return { error: "custom_script criterion blockers must be an array when present." };
  }

  const assertions = Array.isArray(record.assertions)
    ? record.assertions
        .filter((assertion): assertion is Record<string, unknown> => Boolean(
          assertion && typeof assertion === "object" && !Array.isArray(assertion)
        ))
        .map((assertion) => ({
          id: typeof assertion.id === "string" ? assertion.id : "assertion",
          passed: assertion.passed === true,
          ...(typeof assertion.evidence === "string" ? { evidence: assertion.evidence } : {})
        }))
    : undefined;
  const metrics = record.metrics && typeof record.metrics === "object" && !Array.isArray(record.metrics)
    ? record.metrics as Record<string, unknown>
    : undefined;
  const blockers = Array.isArray(record.blockers)
    ? record.blockers.filter((blocker): blocker is string => typeof blocker === "string")
    : undefined;

  return {
    payload: {
      passed: record.passed,
      ...(typeof record.score === "number" ? { score: record.score } : {}),
      ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
      ...(assertions ? { assertions } : {}),
      ...(metrics ? { metrics } : {}),
      ...(blockers ? { blockers } : {})
    }
  };
}

function criterionErrorResult(options: {
  criterion: EvalCriterion;
  output_dir: string;
  error: string;
}): EvalCriterionResult {
  return {
    id: options.criterion.id,
    kind: options.criterion.kind,
    required: options.criterion.required,
    status: "errored",
    passed: false,
    blockers: [options.error],
    assertions: [{ id: "criterion_error", passed: false, evidence: options.error }],
    output_dir: options.output_dir,
    error: options.error
  };
}

function createJudgeHarness(criterion: EvalCriterion): HarnessAdapter {
  switch (criterion.harness) {
    case "cursor-cli":
      return createCursorCliHarness();
    case "codex-cli":
    default:
      return createCodexCliHarness();
  }
}

export async function runScriptCriterion(options: {
  criterion: EvalCriterion;
  suite_dir: string;
  scenario: EvalScenario;
  variant_id: string;
  variant_env?: Record<string, string>;
  trial_id: string;
  run_root: string;
  trace_file: string;
  trace_packet_file: string;
  scorecard_file: string;
  output_dir: string;
  signal?: AbortSignal;
}): Promise<EvalCriterionResult> {
  await mkdir(options.output_dir, { recursive: true });

  const processResult = await runLocalProcess({
    command: "sh",
    args: ["-lc", options.criterion.command ?? ""],
    cwd: options.suite_dir,
    env: {
      ...(options.variant_env ?? {}),
      AGENTFLOW_EVAL_SCENARIO_ID: options.scenario.id,
      AGENTFLOW_EVAL_VARIANT: options.variant_id,
      AGENTFLOW_EVAL_TRIAL_ID: options.trial_id,
      AGENTFLOW_EVAL_CRITERION_ID: options.criterion.id,
      AGENTFLOW_EVAL_RUN_ROOT: options.run_root,
      AGENTFLOW_EVAL_TRACE_FILE: options.trace_file,
      AGENTFLOW_EVAL_TRACE_PACKET_FILE: options.trace_packet_file,
      AGENTFLOW_EVAL_SCORECARD_FILE: options.scorecard_file,
      AGENTFLOW_EVAL_OUTPUT_DIR: options.output_dir
    },
    timeout_sec: options.criterion.timeout_sec ?? 300,
    signal: options.signal
  });

  await Promise.all([
    writeFile(resolve(options.output_dir, "stdout.txt"), processResult.stdout, "utf8"),
    writeFile(resolve(options.output_dir, "stderr.txt"), processResult.stderr, "utf8")
  ]);

  if (processResult.exit_code !== 0 || processResult.timed_out || processResult.canceled) {
    return criterionErrorResult({
      criterion: options.criterion,
      output_dir: options.output_dir,
      error: processResult.timed_out
        ? "custom_script criterion timed out."
        : processResult.canceled
          ? "custom_script criterion canceled."
          : processResult.stderr.trim() || `custom_script criterion exited with code ${processResult.exit_code}.`
    });
  }

  const normalized = normalizeScriptPayload(processResult.stdout);

  if (!normalized.payload) {
    return criterionErrorResult({
      criterion: options.criterion,
      output_dir: options.output_dir,
      error: normalized.error ?? "custom_script criterion produced invalid output."
    });
  }

  const blockers = normalized.payload.blockers ?? (normalized.payload.passed ? [] : [normalized.payload.summary ?? "custom_script criterion failed."]);

  return {
    id: options.criterion.id,
    kind: "custom_script",
    required: options.criterion.required,
    status: normalized.payload.passed ? "passed" : "failed",
    passed: normalized.payload.passed,
    blockers,
    assertions: normalized.payload.assertions ?? [],
    output_dir: options.output_dir,
    ...(typeof normalized.payload.score === "number" ? { score: normalized.payload.score } : {}),
    ...(normalized.payload.summary ? { rationale: normalized.payload.summary } : {}),
    ...(normalized.payload.metrics ? { metrics: normalized.payload.metrics } : {})
  };
}

export async function runQualityCriterion(options: {
  criterion: EvalCriterion;
  suite_dir: string;
  scenario: EvalScenario;
  anonymized_variant_label: string;
  trial_id: string;
  trial_root: string;
  run_root: string;
  trace_packet: EvalTracePacket;
  trace_packet_file: string;
  output_dir: string;
  signal?: AbortSignal;
}): Promise<EvalCriterionResult> {
  await mkdir(options.output_dir, { recursive: true });

  const harness = createJudgeHarness(options.criterion);
  if (!harness.capabilities.supports_ai_check) {
    return criterionErrorResult({
      criterion: options.criterion,
      output_dir: options.output_dir,
      error: `${harness.kind} does not support AI rubric grading.`
    });
  }

  const readiness = await harness.checkReadiness?.();
  if (readiness && readiness.length > 0) {
    return criterionErrorResult({
      criterion: options.criterion,
      output_dir: options.output_dir,
      error: readiness.join(" ")
    });
  }

  if (!options.criterion.rubric_path) {
    return criterionErrorResult({
      criterion: options.criterion,
      output_dir: options.output_dir,
      error: "quality criterion is missing rubric path."
    });
  }

  const rubric = await readFile(options.criterion.rubric_path, "utf8");
  const contextDir = resolve(options.output_dir, "context");
  const contextPacketPath = resolve(contextDir, "packet.json");
  const contextManifestPath = resolve(contextDir, "manifest.md");
  const judgePacketPath = resolve(options.output_dir, "judge-packet.json");
  await mkdir(contextDir, { recursive: true });

  const judgePacket = {
    criterion: {
      id: options.criterion.id,
      kind: options.criterion.kind,
      required: options.criterion.required,
      dimensions: options.criterion.dimensions ?? [],
      threshold: options.criterion.threshold ?? 4
    },
    scenario: {
      id: options.scenario.id,
      bucket: options.scenario.bucket,
      difficulty: options.scenario.difficulty,
      description: options.scenario.description,
      criteria: options.scenario.criteria
    },
    variant_label: options.anonymized_variant_label,
    trial_id: options.trial_id,
    run_root: options.run_root,
    trace_packet_file: options.trace_packet_file,
    trace_packet: options.trace_packet
  };

  await Promise.all([
    writeFile(judgePacketPath, `${JSON.stringify(judgePacket, null, 2)}\n`, "utf8"),
    writeFile(contextPacketPath, `${JSON.stringify(judgePacket, null, 2)}\n`, "utf8"),
    writeFile(
      contextManifestPath,
      [
      "# Eval Quality Criterion Context",
      "",
      `- Criterion: ${options.criterion.id}`,
      `- Scenario: ${options.scenario.id}`,
      `- Variant label: ${options.anonymized_variant_label}`,
      `- Trial: ${options.trial_id}`,
      `- Run root: ${options.run_root}`,
      `- Trace packet: ${options.trace_packet_file}`,
      "",
      "The full trace packet is embedded in the context packet and the trial root is mounted read-only for local evidence inspection."
    ].join("\n"),
      "utf8"
    )
  ]);

  const aiResult = await runAiCheck({
    harness,
    run_id: `eval-${options.scenario.id}-${options.anonymized_variant_label}`,
    execution_id: `quality-${options.criterion.id}-${options.trial_id}`,
    repo_alias: "eval",
    repo_path: options.suite_dir,
    model: options.criterion.model,
    ...(options.criterion.reasoning_effort ? { reasoning_effort: options.criterion.reasoning_effort } : {}),
    skip_git_repo_check: true,
    node_goal: [
      "Grade this eval quality criterion for one completed Agentflow workflow trial.",
      "Judge the trace packet and declared eval artifacts; do not rerun the workflow or do the task yourself.",
      "Quality scores cannot excuse deterministic blockers recorded in the trace packet or criterion evidence.",
      "Return strict JSON with passed_quality_bar, score, dimension_scores, blockers, rationale, and prompt_feedback.",
      "The trace packet is embedded in the context packet and the trial root is available for inspecting run-root artifacts.",
      `Criterion: ${options.criterion.id}`,
      `Scenario: ${options.scenario.id}`,
      `Variant label: ${options.anonymized_variant_label}`,
      `Trial: ${options.trial_id}`
    ].join("\n"),
    rubric,
    evaluator_surface: "eval_quality_judge",
    quality_threshold: options.criterion.threshold ?? 4,
    output_schema: JSON.stringify({
      passed_quality_bar: true,
      score: 4,
      dimension_scores: {
        artifact_quality: 4
      },
      blockers: [],
      rationale: "short evidence-backed explanation",
      prompt_feedback: {
        helpful_sections: [],
        noisy_sections: [],
        missing_guidance: []
      }
    }),
    context_packet_path: contextPacketPath,
    context_manifest_path: contextManifestPath,
    runtime_dir: options.trial_root,
    output_dir: options.output_dir,
    timeout_sec: options.criterion.timeout_sec ?? 900,
    signal: options.signal
  });

  await writeFile(resolve(options.output_dir, "ai-check-result.json"), `${JSON.stringify(aiResult, null, 2)}\n`, "utf8");

  const parsed = parseJudgeResult(JSON.stringify(aiResult.evaluation.raw ?? aiResult.evaluation));

  if (aiResult.harness_result.status !== "passed" || !parsed.result) {
    return criterionErrorResult({
      criterion: options.criterion,
      output_dir: options.output_dir,
      error: aiResult.evaluation.summary ?? parsed.error ?? "AI rubric judge failed."
    });
  }

  const payload: EvalJudgePayload = parsed.result;
  const threshold = options.criterion.threshold ?? 4;
  const deterministicBlockers =
    options.trace_packet.outcome.status === "passed"
      ? []
      : [`Trace outcome status is ${options.trace_packet.outcome.status}; quality scoring cannot override a non-passing run outcome.`];
  const blockers = [...deterministicBlockers, ...payload.blockers];
  const passed = deterministicBlockers.length === 0
    && payload.passed_quality_bar
    && payload.score >= threshold
    && payload.blockers.length === 0;

  return {
    id: options.criterion.id,
    kind: "quality",
    required: options.criterion.required,
    status: passed ? "passed" : "failed",
    passed,
    blockers,
    assertions: [{
      id: "quality_threshold",
      passed,
      evidence: `score=${payload.score}; threshold=${threshold}; passed_quality_bar=${payload.passed_quality_bar}; deterministic_blockers=${deterministicBlockers.length}`
    }],
    output_dir: options.output_dir,
    score: payload.score,
    dimension_scores: payload.dimension_scores,
    rationale: payload.rationale,
    prompt_feedback: payload.prompt_feedback
  };
}
