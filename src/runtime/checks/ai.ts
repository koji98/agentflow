import type { ReasoningEffort } from "../../graph/schema.js";
import type { HarnessAdapter, HarnessResult } from "../harness/types.js";

export interface AiCheckResult {
  passed: boolean;
  score?: number;
  summary?: string;
  issues?: unknown[];
  raw?: Record<string, unknown>;
}

export interface RunAiCheckInvocation {
  harness: HarnessAdapter;
  run_id: string;
  execution_id: string;
  repo_alias: string;
  repo_path: string;
  model: string | undefined;
  reasoning_effort?: ReasoningEffort;
  skip_git_repo_check?: boolean;
  prompt: string;
  rubric: string | undefined;
  context_packet_path: string;
  output_dir: string;
  timeout_sec: number;
  signal: AbortSignal | undefined;
  on_stdout_chunk?: (chunk: string) => void;
  on_stderr_chunk?: (chunk: string) => void;
}

export interface RunAiCheckResult {
  harness_result: HarnessResult;
  evaluation: AiCheckResult;
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

function createMalformedResult(message: string): AiCheckResult {
  return {
    passed: false,
    summary: message,
    issues: [message]
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

export function parseAiCheckResult(payload: unknown): AiCheckResult {
  const record =
    typeof payload === "string"
      ? parseStructuredPayload(payload)
      : payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : undefined;

  if (!record) {
    return createMalformedResult("AI check output was not valid structured JSON.");
  }

  if (typeof record.passed !== "boolean") {
    return createMalformedResult("AI check output must include boolean passed.");
  }

  return {
    passed: record.passed,
    ...(typeof record.score === "number" ? { score: record.score } : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    ...(Array.isArray(record.issues) ? { issues: record.issues } : {}),
    raw: record
  };
}

export function buildAiCheckPrompt(options: {
  prompt: string;
  rubric?: string;
  context_packet_path: string;
}): string {
  return [
    "Evaluate the graph node against the provided context.",
    "Return JSON only with this shape:",
    '{"passed":true,"score":0.0,"summary":"short summary","issues":[]}',
    "",
    "## Evaluation Task",
    options.prompt,
    "",
    "## Context",
    `- Context packet: ${options.context_packet_path}`,
    "- Review the context packet before deciding.",
    "- Use the context summary to identify omitted or truncated materials before making a judgment.",
    "- Treat any project instructions the harness loads automatically from the repository as the default local contract, unless the evaluation task explicitly changes them or a higher-priority instruction overrides them.",
    "- This is a read-only evaluation.",
    ...(options.rubric
      ? [
          "",
          "## Rubric",
          options.rubric
        ]
      : [])
  ].join("\n");
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
          error: message
        }
      },
      evaluation: createHarnessFailureResult(message)
    };
  }

  let harness_result: HarnessResult;

  try {
    harness_result = await invocation.harness.run({
      runId: invocation.run_id,
      executionId: invocation.execution_id,
      repoAlias: invocation.repo_alias,
      repoPath: invocation.repo_path,
      sandbox: "read-only",
      ...(invocation.skip_git_repo_check ? { skipGitRepoCheck: true } : {}),
      model: invocation.model,
      ...(invocation.reasoning_effort ? { reasoningEffort: invocation.reasoning_effort } : {}),
      prompt: buildAiCheckPrompt({
        prompt: invocation.prompt,
        ...(invocation.rubric ? { rubric: invocation.rubric } : {}),
        context_packet_path: invocation.context_packet_path
      }),
      contextPacketPath: invocation.context_packet_path,
      outputDir: invocation.output_dir,
      timeoutSec: invocation.timeout_sec,
      signal: invocation.signal,
      ...(invocation.on_stdout_chunk ? { onStdoutChunk: invocation.on_stdout_chunk } : {}),
      ...(invocation.on_stderr_chunk ? { onStderrChunk: invocation.on_stderr_chunk } : {})
    });
  } catch (error) {
    const message = errorMessage(error);
    const canceled = invocation.signal?.aborted ?? false;

    return {
      harness_result: {
        status: canceled ? "canceled" : "failed",
        exitCode: 1,
        ...(canceled ? {} : { stderr: message }),
        metadata: {
          error: message
        }
      },
      evaluation: createHarnessFailureResult(
        canceled
          ? "AI check canceled before completion."
          : `AI check harness failed: ${message}`
      )
    };
  }

  const rawPayload =
    harness_result.outputJson ??
    harness_result.transcript?.last_message ??
    harness_result.stdout ??
    "";
  const parsedEvaluation = parseAiCheckResult(rawPayload);
  const evaluation =
    harness_result.status !== "passed"
      ? createHarnessFailureResult(summarizeHarnessFailure(harness_result))
      : parsedEvaluation;

  return {
    harness_result,
    evaluation
  };
}
