import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createCodexCliHarness } from "../runtime/harness/codex_cli.js";
import { createCursorCliHarness } from "../runtime/harness/cursor_cli.js";
import { runAiCheck } from "../runtime/checks/ai.js";
import { runLocalProcess } from "../runtime/checks/deterministic.js";
import type { HarnessAdapter } from "../runtime/harness/types.js";
import type {
  EvalAiRubricGrader,
  EvalCase,
  EvalGrader,
  EvalGraderNormalizedPayload,
  EvalGraderResult,
  EvalScriptGrader
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
    // Fall through to object extraction.
  }

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

function normalizePayload(payload: unknown): {
  payload?: EvalGraderNormalizedPayload;
  error?: string;
} {
  const record =
    typeof payload === "string"
      ? parseStructuredPayload(payload)
      : payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : undefined;

  if (!record) {
    return { error: "Grader output was not valid structured JSON." };
  }

  if (typeof record.passed !== "boolean") {
    return { error: "Grader output must include boolean passed." };
  }

  if (record.assertions !== undefined && !Array.isArray(record.assertions)) {
    return { error: "Grader assertions must be an array when present." };
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

  return {
    payload: {
      passed: record.passed,
      ...(typeof record.score === "number" ? { score: record.score } : {}),
      ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
      ...(assertions ? { assertions } : {}),
      ...(metrics ? { metrics } : {})
    }
  };
}

function errorResult(options: {
  grader: EvalGrader;
  output_dir: string;
  error: string;
}): EvalGraderResult {
  const required = options.grader.required !== false;

  return {
    id: options.grader.id,
    kind: options.grader.kind,
    required,
    status: "errored",
    passed: false,
    output_dir: options.output_dir,
    summary: options.error,
    error: options.error
  };
}

function createAiRubricHarness(grader: EvalAiRubricGrader): HarnessAdapter {
  switch (grader.harness ?? "codex-cli") {
    case "codex-cli":
      return createCodexCliHarness();
    case "cursor-cli":
      return createCursorCliHarness();
  }
}

async function runScriptGrader(options: {
  grader: EvalScriptGrader;
  suite_dir: string;
  case_file: string;
  run_root: string;
  trace_file: string;
  variant_id: string;
  output_dir: string;
  signal?: AbortSignal;
}): Promise<EvalGraderResult> {
  await mkdir(options.output_dir, { recursive: true });

  const processResult = await runLocalProcess({
    command: "sh",
    args: ["-lc", options.grader.command],
    cwd: options.suite_dir,
    env: {
      AGENTFLOW_EVAL_CASE_FILE: options.case_file,
      AGENTFLOW_EVAL_RUN_ROOT: options.run_root,
      AGENTFLOW_EVAL_TRACE_FILE: options.trace_file,
      AGENTFLOW_EVAL_VARIANT: options.variant_id,
      AGENTFLOW_EVAL_OUTPUT_DIR: options.output_dir
    },
    timeout_sec: options.grader.timeout_sec ?? 300,
    signal: options.signal
  });

  await Promise.all([
    writeFile(resolve(options.output_dir, "stdout.txt"), processResult.stdout, "utf8"),
    writeFile(resolve(options.output_dir, "stderr.txt"), processResult.stderr, "utf8")
  ]);

  if (processResult.exit_code !== 0 || processResult.timed_out || processResult.canceled) {
    return errorResult({
      grader: options.grader,
      output_dir: options.output_dir,
      error: processResult.timed_out
        ? "Script grader timed out."
        : processResult.canceled
          ? "Script grader canceled."
          : processResult.stderr.trim() || `Script grader exited with code ${processResult.exit_code}.`
    });
  }

  const normalized = normalizePayload(processResult.stdout);

  if (!normalized.payload) {
    return errorResult({
      grader: options.grader,
      output_dir: options.output_dir,
      error: normalized.error ?? "Script grader produced invalid output."
    });
  }

  return {
    id: options.grader.id,
    kind: options.grader.kind,
    required: options.grader.required !== false,
    status: normalized.payload.passed ? "passed" : "failed",
    output_dir: options.output_dir,
    ...normalized.payload
  };
}

async function runAiRubricGrader(options: {
  grader: EvalAiRubricGrader;
  suite_dir: string;
  case: EvalCase;
  case_file: string;
  run_root: string;
  trace_file: string;
  variant_id: string;
  output_dir: string;
  signal?: AbortSignal;
}): Promise<EvalGraderResult> {
  await mkdir(options.output_dir, { recursive: true });

  const harness = createAiRubricHarness(options.grader);
  if (!harness.capabilities.supports_ai_check) {
    return errorResult({
      grader: options.grader,
      output_dir: options.output_dir,
      error: `${harness.kind} does not support AI rubric grading.`
    });
  }
  const readiness = await harness.checkReadiness?.();

  if (readiness && readiness.length > 0) {
    return errorResult({
      grader: options.grader,
      output_dir: options.output_dir,
      error: readiness.join(" ")
    });
  }

  const rubricPath = resolve(options.suite_dir, options.grader.rubric);
  const rubric = await readFile(rubricPath, "utf8");
  const contextDir = resolve(options.output_dir, "context");
  const contextPacketPath = resolve(contextDir, "packet.json");
  const contextManifestPath = resolve(contextDir, "manifest.md");
  await mkdir(contextDir, { recursive: true });

  await Promise.all([
    writeFile(
      contextPacketPath,
      `${JSON.stringify(
        {
          case: options.case,
          case_file: options.case_file,
          run_root: options.run_root,
          trace_file: options.trace_file,
          variant_id: options.variant_id
        },
        null,
        2
      )}\n`,
      "utf8"
    ),
    writeFile(
      contextManifestPath,
      [
        "# Eval Grader Context",
        "",
        `- Case: ${options.case.id}`,
        `- Variant: ${options.variant_id}`,
        `- Run root: ${options.run_root}`,
        `- Trace file: ${options.trace_file}`,
        `- Case file: ${options.case_file}`
      ].join("\n"),
      "utf8"
    )
  ]);

  const aiResult = await runAiCheck({
    harness,
    run_id: `eval-${options.case.id}-${options.variant_id}`,
    execution_id: `grader-${options.grader.id}`,
    repo_alias: "eval",
    repo_path: options.suite_dir,
    model: options.grader.model,
    ...(options.grader.reasoning_effort ? { reasoning_effort: options.grader.reasoning_effort } : {}),
    skip_git_repo_check: true,
    prompt: [
      "Grade this local Agentflow eval case using only the referenced local files.",
      "Return normalized grader JSON with passed, score, summary, assertions, and metrics.",
      `Case: ${options.case.id}`,
      `Variant: ${options.variant_id}`,
      `Run root: ${options.run_root}`,
      `Trace file: ${options.trace_file}`
    ].join("\n"),
    rubric,
    context_packet_path: contextPacketPath,
    context_manifest_path: contextManifestPath,
    output_dir: options.output_dir,
    timeout_sec: options.grader.timeout_sec ?? 900,
    signal: options.signal
  });

  await writeFile(
    resolve(options.output_dir, "ai-check-result.json"),
    `${JSON.stringify(aiResult, null, 2)}\n`,
    "utf8"
  );

  const normalized = normalizePayload(aiResult.evaluation.raw ?? aiResult.evaluation);

  if (aiResult.harness_result.status !== "passed" || !normalized.payload) {
    return errorResult({
      grader: options.grader,
      output_dir: options.output_dir,
      error: aiResult.evaluation.summary ?? normalized.error ?? "AI rubric grader failed."
    });
  }

  return {
    id: options.grader.id,
    kind: options.grader.kind,
    required: options.grader.required !== false,
    status: normalized.payload.passed ? "passed" : "failed",
    output_dir: options.output_dir,
    ...normalized.payload
  };
}

export async function runEvalGrader(options: {
  grader: EvalGrader;
  suite_dir: string;
  case: EvalCase;
  case_file: string;
  run_root: string;
  trace_file: string;
  variant_id: string;
  output_dir: string;
  signal?: AbortSignal;
}): Promise<EvalGraderResult> {
  try {
    if (options.grader.kind === "script") {
      return await runScriptGrader({
        grader: options.grader,
        suite_dir: options.suite_dir,
        case_file: options.case_file,
        run_root: options.run_root,
        trace_file: options.trace_file,
        variant_id: options.variant_id,
        output_dir: options.output_dir,
        ...(options.signal ? { signal: options.signal } : {})
      });
    }

    return await runAiRubricGrader({
      grader: options.grader,
      suite_dir: options.suite_dir,
      case: options.case,
      case_file: options.case_file,
      run_root: options.run_root,
      trace_file: options.trace_file,
      variant_id: options.variant_id,
      output_dir: options.output_dir,
      ...(options.signal ? { signal: options.signal } : {})
    });
  } catch (error) {
    return errorResult({
      grader: options.grader,
      output_dir: options.output_dir,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
