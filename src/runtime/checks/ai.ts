import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CliHint, ManagedPromptContract } from "../../graph/authored.js";
import type { ResolvedSkill } from "../../graph/compiled.js";
import type { EffectiveHarnessConfig } from "../../graph/profiles.js";
import type { ReasoningEffort } from "../../graph/schema.js";
import {
  renderHarnessPrompt,
  type AgentInvocation,
  type HarnessAdapter,
  type HarnessResult
} from "../harness/types.js";
import { writePromptDiagnostics } from "../harness/prompt_diagnostics.js";

export interface AiCheckResult {
  passed: boolean;
  score?: number;
  summary?: string;
  issues?: unknown[];
  raw?: Record<string, unknown>;
}

export type AiEvaluatorSurface = "ai_check" | "managed_criterion" | "eval_quality_judge";

export interface RunAiCheckInvocation {
  harness: HarnessAdapter;
  run_id: string;
  execution_id: string;
  compiled_id?: string;
  authored_id?: string;
  repo_alias: string;
  repo_path: string;
  model: string | undefined;
  reasoning_effort?: ReasoningEffort;
  harness_config?: EffectiveHarnessConfig;
  base_env?: NodeJS.ProcessEnv;
  skip_git_repo_check?: boolean;
  evaluator_surface?: AiEvaluatorSurface;
  quality_threshold?: number;
  rubric: string | undefined;
  graph_goal?: string;
  graph_acceptance_criteria?: string[];
  graph_constraints?: string[];
  node_goal?: string;
  node_acceptance_criteria?: string[];
  node_constraints?: string[];
  managed_prompt?: ManagedPromptContract;
  output_schema?: string;
  context_packet_path: string;
  context_manifest_path: string;
  context_manifest?: string;
  prompt_path?: string;
  runtime_dir?: string;
  output_dir: string;
  skills?: ResolvedSkill[];
  cli?: CliHint[];
  timeout_sec: number;
  signal: AbortSignal | undefined;
  on_stdout_chunk?: (chunk: string) => void;
  on_stderr_chunk?: (chunk: string) => void;
}

export interface RunAiCheckResult {
  harness_result: HarnessResult;
  evaluation: AiCheckResult;
  prompt_sha256?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseStructuredPayload(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    // Fall through to fenced or inline object parsing.
  }

  const fencedMatch = /```json\s*([\s\S]*?)\s*```/i.exec(trimmed);

  if (fencedMatch?.[1]) {
    try {
      const parsed = JSON.parse(fencedMatch[1]) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }

  const firstObject = trimmed.match(/\{[\s\S]*\}/);

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

function createMalformedResult(message: string, raw?: Record<string, unknown>): AiCheckResult {
  return {
    passed: false,
    summary: message,
    issues: [message],
    ...(raw ? { raw } : {})
  };
}

function createHarnessFailureResult(message: string): AiCheckResult {
  return {
    passed: false,
    summary: message,
    issues: [message],
    raw: {
      error: message
    }
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMetadataFlag(
  metadata: HarnessResult["metadata"],
  key: string
): boolean {
  return Boolean(metadata && typeof metadata[key] === "boolean" && metadata[key]);
}

function summarizeHarnessFailure(harness_result: HarnessResult): string {
  if (harness_result.status === "canceled" || readMetadataFlag(harness_result.metadata, "canceled")) {
    return "AI check canceled before completion.";
  }

  if (readMetadataFlag(harness_result.metadata, "timed_out")) {
    return readMetadataFlag(harness_result.metadata, "force_killed")
      ? "AI check harness timed out and required a force kill."
      : "AI check harness timed out.";
  }

  const stderr = harness_result.stderr?.trim();

  if (stderr) {
    return stderr;
  }

  const metadataError =
    harness_result.metadata && typeof harness_result.metadata.error === "string"
      ? harness_result.metadata.error
      : undefined;

  if (metadataError) {
    return metadataError;
  }

  return `AI check harness exited with status ${harness_result.status}.`;
}

function parseStandardAiCheckResult(record: Record<string, unknown>): AiCheckResult {
  if (typeof record.passed !== "boolean") {
    return createMalformedResult("AI check output must include boolean passed.", record);
  }

  return {
    passed: record.passed,
    ...(typeof record.score === "number" ? { score: record.score } : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    ...(Array.isArray(record.issues) ? { issues: record.issues } : {}),
    raw: record
  };
}

function parseManagedCriterionResult(record: Record<string, unknown>): AiCheckResult {
  if (typeof record.passed !== "boolean") {
    return createMalformedResult("Managed criterion output must include boolean passed.", record);
  }
  if (typeof record.score !== "number" || record.score < 0 || record.score > 1) {
    return createMalformedResult("Managed criterion output must include score as a number from 0 to 1.", record);
  }
  if (typeof record.summary !== "string" || record.summary.trim().length === 0) {
    return createMalformedResult("Managed criterion output must include non-empty string summary.", record);
  }
  if (!Array.isArray(record.issues)) {
    return createMalformedResult("Managed criterion output must include issues as an array.", record);
  }

  return {
    passed: record.passed,
    score: record.score,
    summary: record.summary,
    issues: record.issues,
    raw: record
  };
}

function parseEvalQualityJudgeResult(
  record: Record<string, unknown>,
  qualityThreshold: number | undefined
): AiCheckResult {
  if (typeof record.passed_quality_bar !== "boolean") {
    return createMalformedResult("Eval quality judge output must include boolean passed_quality_bar.", record);
  }
  if (typeof record.score !== "number" || record.score < 1 || record.score > 5) {
    return createMalformedResult("Eval quality judge output score must be a number from 1 to 5.", record);
  }
  if (!isRecord(record.dimension_scores)) {
    return createMalformedResult("Eval quality judge output must include dimension_scores as an object.", record);
  }
  if (Object.values(record.dimension_scores).some((value) => typeof value !== "number" || value < 1 || value > 5)) {
    return createMalformedResult("Eval quality judge dimension_scores values must be numbers from 1 to 5.", record);
  }
  if (!Array.isArray(record.blockers)) {
    return createMalformedResult("Eval quality judge output must include blockers as an array.", record);
  }
  if (typeof record.rationale !== "string" || record.rationale.trim().length === 0) {
    return createMalformedResult("Eval quality judge output must include non-empty string rationale.", record);
  }
  const promptFeedback = record.prompt_feedback;
  if (!isRecord(promptFeedback)) {
    return createMalformedResult("Eval quality judge output must include prompt_feedback as an object.", record);
  }
  for (const key of ["helpful_sections", "noisy_sections", "missing_guidance"]) {
    if (!Array.isArray(promptFeedback[key])) {
      return createMalformedResult(`Eval quality judge prompt_feedback.${key} must be an array.`, record);
    }
  }

  const threshold = qualityThreshold ?? 4;
  const blockers = stringArray(record.blockers);
  const passed = record.passed_quality_bar && record.score >= threshold && blockers.length === 0;

  return {
    passed,
    score: record.score,
    summary: record.rationale,
    issues: blockers,
    raw: record
  };
}

export function parseAiCheckResult(
  payload: unknown,
  options: {
    evaluator_surface?: AiEvaluatorSurface;
    quality_threshold?: number;
  } = {}
): AiCheckResult {
  const record =
    typeof payload === "string"
      ? parseStructuredPayload(payload)
      : payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : undefined;

  if (!record) {
    return createMalformedResult("AI check output was not valid structured JSON.");
  }

  switch (options.evaluator_surface ?? "ai_check") {
    case "managed_criterion":
      return parseManagedCriterionResult(record);
    case "eval_quality_judge":
      return parseEvalQualityJudgeResult(record, options.quality_threshold);
    case "ai_check":
      return parseStandardAiCheckResult(record);
  }
}

async function readContextManifest(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function runAiCheck(
  invocation: RunAiCheckInvocation
): Promise<RunAiCheckResult> {
  if (!invocation.harness.capabilities.supports_ai_check) {
    const message =
      `AI check harness failed: ${invocation.harness.kind} does not provide a strict read-only evaluation contract. Use a harness that supports AI checks.`;

    return {
      harness_result: {
        status: "failed",
        exitCode: 1,
        stderr: message,
        metadata: {
          error: message,
          failure_code: "verification_substrate_failure"
        }
      },
      evaluation: createHarnessFailureResult(message)
    };
  }

  let harness_result: HarnessResult;
  const contextManifest = invocation.context_manifest ?? await readContextManifest(invocation.context_manifest_path);
  let promptSha256: string | undefined;

  try {
    const harnessInvocation: AgentInvocation = {
      promptKind: "ai_check",
      runId: invocation.run_id,
      executionId: invocation.execution_id,
      repoAlias: invocation.repo_alias,
      repoPath: invocation.repo_path,
      sandbox: "read-only",
      ...(invocation.skip_git_repo_check ? { skipGitRepoCheck: true } : {}),
      ...(invocation.harness_config ? { harnessConfig: invocation.harness_config } : {}),
      model: invocation.model,
      ...(invocation.reasoning_effort ? { reasoningEffort: invocation.reasoning_effort } : {}),
      ...(invocation.base_env ? { baseEnv: invocation.base_env } : {}),
      ...(invocation.evaluator_surface ? { aiEvaluatorSurface: invocation.evaluator_surface } : {}),
      ...(invocation.quality_threshold !== undefined ? { aiCheckQualityThreshold: invocation.quality_threshold } : {}),
      ...(invocation.rubric ? { rubric: invocation.rubric } : {}),
      ...(invocation.graph_goal ? { graphGoal: invocation.graph_goal } : {}),
      ...(invocation.graph_acceptance_criteria
        ? { graphAcceptanceCriteria: invocation.graph_acceptance_criteria }
        : {}),
      ...(invocation.graph_constraints ? { graphConstraints: invocation.graph_constraints } : {}),
      ...(invocation.node_goal ? { nodeGoal: invocation.node_goal } : {}),
      ...(invocation.node_acceptance_criteria
        ? { nodeAcceptanceCriteria: invocation.node_acceptance_criteria }
        : {}),
      ...(invocation.node_constraints ? { nodeConstraints: invocation.node_constraints } : {}),
      ...(invocation.managed_prompt ? { managedPrompt: invocation.managed_prompt } : {}),
      ...(invocation.output_schema ? { aiCheckOutputSchema: invocation.output_schema } : {}),
      contextPacketPath: invocation.context_packet_path,
      contextManifestPath: invocation.context_manifest_path,
      contextManifest,
      ...(invocation.runtime_dir ? { runtimeDir: invocation.runtime_dir } : {}),
      outputDir: invocation.output_dir,
      artifacts: {},
      ...(invocation.skills ? { skills: invocation.skills } : {}),
      ...(invocation.cli ? { cli: invocation.cli } : {}),
      timeoutSec: invocation.timeout_sec,
      signal: invocation.signal,
      ...(invocation.on_stdout_chunk ? { onStdoutChunk: invocation.on_stdout_chunk } : {}),
      ...(invocation.on_stderr_chunk ? { onStderrChunk: invocation.on_stderr_chunk } : {}),
      ...(invocation.prompt_path ? { promptPath: invocation.prompt_path } : {})
    };

    if (invocation.prompt_path) {
      const renderedPrompt = renderHarnessPrompt(harnessInvocation);
      await mkdir(dirname(invocation.prompt_path), { recursive: true });
      await writeFile(invocation.prompt_path, `${renderedPrompt}\n`, "utf8");
      await writePromptDiagnostics({
        invocation: harnessInvocation,
        prompt: `${renderedPrompt}\n`,
        renderer: "renderHarnessPrompt",
        promptPath: invocation.prompt_path,
        metadata: {
          harness: invocation.harness.kind,
          ...(invocation.compiled_id ? { compiledId: invocation.compiled_id } : {}),
          ...(invocation.authored_id ? { authoredId: invocation.authored_id } : {})
        }
      });
      promptSha256 = createHash("sha256").update(`${renderedPrompt}\n`).digest("hex");
    }

    harness_result = await invocation.harness.run(harnessInvocation);
  } catch (error) {
    const message = errorMessage(error);
    const canceled = invocation.signal?.aborted ?? false;

    return {
      harness_result: {
        status: canceled ? "canceled" : "failed",
        exitCode: 1,
        ...(canceled ? {} : { stderr: message }),
        metadata: {
          error: message,
          failure_code: "verification_substrate_failure"
        }
      },
      evaluation: createHarnessFailureResult(
        canceled
          ? "AI check canceled before completion."
          : `AI check harness failed: ${message}`
      ),
      ...(promptSha256 ? { prompt_sha256: promptSha256 } : {})
    };
  }

  const rawPayload =
    harness_result.transcript?.last_message ??
    harness_result.outputJson ??
    harness_result.stdout ??
    "";
  const parsedEvaluation = parseAiCheckResult(rawPayload, {
    ...(invocation.evaluator_surface ? { evaluator_surface: invocation.evaluator_surface } : {}),
    ...(invocation.quality_threshold !== undefined ? { quality_threshold: invocation.quality_threshold } : {})
  });
  const evaluation =
    harness_result.status !== "passed"
      ? createHarnessFailureResult(summarizeHarnessFailure(harness_result))
      : parsedEvaluation;

  return {
    harness_result,
    evaluation,
    ...(promptSha256 ? { prompt_sha256: promptSha256 } : {})
  };
}
