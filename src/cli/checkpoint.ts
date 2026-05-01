import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";

import type { ArtifactReference } from "../graph/authored.js";
import type { CompiledCheckpointNode, CompiledGraph } from "../graph/compiled.js";
import type { GraphDiagnostic } from "../graph/schema.js";
import { resolveExecutionArtifactsDirectory } from "../artifacts/paths.js";
import type {
  RuntimeNodeExecutionResult,
  RuntimeNodeExecutor,
  RuntimeNodeExecutorContext
} from "../runtime/core/engine.js";
import type {
  ContextPacket,
  ContextPacketMaterializedItem,
  ContextPacketSource
} from "../runtime/context/packet.js";

interface TtyLike {
  isTTY?: boolean;
}

interface CheckpointTerminalStreams {
  stdin: NodeJS.ReadableStream & TtyLike;
  stderr: NodeJS.WritableStream & TtyLike;
}

interface InteractiveCheckpointOptions {
  streams?: CheckpointTerminalStreams;
  create_prompt_adapter?: (streams: CheckpointTerminalStreams) => CheckpointPromptAdapter;
}

export interface CheckpointPromptAdapter {
  write(chunk: string): void;
  readLine(prompt: string): Promise<string>;
  close(): void;
}

export interface CheckpointDecision {
  decision: "pass" | "deny" | "abort";
  feedback?: string;
}

interface CheckpointRenderInput {
  node: CompiledCheckpointNode;
  review_artifact_path: string;
  review_preview: string;
  supporting_context: Array<{
    label: string;
    path: string;
  }>;
  context_manifest_preview?: string;
}

function artifactReferenceKey(reference: ArtifactReference): string {
  return JSON.stringify({
    node: reference.node,
    artifact: reference.artifact,
    iteration: reference.iteration,
    attempt: reference.attempt
  });
}

function describeContextSource(source: ContextPacketSource): string {
  if ("ref" in source) {
    return source.ref;
  }

  return source.name;
}

function truncatePreview(
  text: string,
  options: {
    max_lines?: number;
    max_chars?: number;
  } = {}
): string {
  const max_lines = options.max_lines ?? 40;
  const max_chars = options.max_chars ?? 4000;
  const normalized = text.replace(/\r\n/g, "\n").trimEnd();

  if (normalized.length === 0) {
    return "(empty)";
  }

  const limitedByChars = normalized.length > max_chars;
  const charTrimmed = limitedByChars ? normalized.slice(0, max_chars) : normalized;
  const lines = charTrimmed.split("\n");
  const limitedByLines = lines.length > max_lines;
  const preview = lines.slice(0, max_lines).join("\n");

  if (!limitedByChars && !limitedByLines) {
    return preview;
  }

  return `${preview}\n\n[preview truncated]`;
}

function renderCheckpointReview(input: CheckpointRenderInput): string {
  const sections = [
    `Checkpoint: ${input.node.label ?? input.node.authored_id}`,
    input.node.intent.goal ?? "Review the referenced artifact and decide whether the graph may proceed.",
    "",
    "Acceptance criteria:",
    ...(input.node.intent.acceptance_criteria ?? ["No checkpoint-level acceptance criteria were authored."]).map((item) => `- ${item}`),
    "",
    "Constraints:",
    ...(input.node.intent.constraints ?? ["No checkpoint-level constraints were authored."]).map((item) => `- ${item}`),
    `Review artifact: ${input.review_artifact_path}`,
    "Preview:",
    input.review_preview
  ];

  if (input.supporting_context.length > 0) {
    sections.push(
      "Supporting context:",
      ...input.supporting_context.map((item) => `- ${item.label}: ${item.path}`)
    );
  }

  if (input.context_manifest_preview) {
    sections.push("Context manifest:", input.context_manifest_preview);
  }

  sections.push("Choose:", "  [1] Pass", "  [2] Deny", "  [3] Abort run");
  return `${sections.join("\n")}\n`;
}

function createReadlinePromptAdapter(
  streams: CheckpointTerminalStreams
): CheckpointPromptAdapter {
  const rl = createInterface({
    input: streams.stdin,
    output: streams.stderr,
    terminal: true
  });

  return {
    write(chunk) {
      streams.stderr.write(chunk);
    },
    readLine(prompt) {
      return rl.question(prompt);
    },
    close() {
      rl.close();
    }
  };
}

async function promptForDecision(adapter: CheckpointPromptAdapter): Promise<CheckpointDecision> {
  while (true) {
    const choice = (await adapter.readLine("> ")).trim();

    if (choice === "1" || choice.toLowerCase() === "pass") {
      return {
        decision: "pass"
      };
    }

    if (choice === "2" || choice.toLowerCase() === "deny") {
      adapter.write(
        "\nHow should this improve? Submit an empty line when finished.\n"
      );

      while (true) {
        const lines: string[] = [];

        while (true) {
          const line = await adapter.readLine("> ");
          if (line.length === 0) {
            break;
          }

          lines.push(line);
        }

        const feedback = lines.join("\n").trim();

        if (feedback.length > 0) {
          return {
            decision: "deny",
            feedback
          };
        }

        adapter.write("Feedback is required when denying the checkpoint.\n");
      }
    }

    if (choice === "3" || choice.toLowerCase() === "abort") {
      return {
        decision: "abort"
      };
    }

    adapter.write("Choose 1, 2, or 3.\n");
  }
}

function findReviewMaterial(
  packet: ContextPacket,
  reviewFrom: ArtifactReference
): ContextPacketMaterializedItem | undefined {
  const key = artifactReferenceKey(reviewFrom);
  return packet.materials.find(
    (item) =>
      "ref" in item.source &&
      artifactReferenceKey(item.source) === key
  );
}

export function collectCheckpointTerminalDiagnostics(
  graph: CompiledGraph,
  streams: CheckpointTerminalStreams = {
    stdin: process.stdin,
    stderr: process.stderr
  }
): GraphDiagnostic[] {
  if (!graph.nodes.some((node) => node.kind === "checkpoint")) {
    return [];
  }

  if (streams.stdin.isTTY === true && streams.stderr.isTTY === true) {
    return [];
  }

  return [
    {
      path: "$.graph",
      message: "Checkpoint nodes require interactive TTY stdin and stderr when launched from the CLI."
    }
  ];
}

export function createInteractiveCheckpointExecutor(
  options: InteractiveCheckpointOptions = {}
): RuntimeNodeExecutor<CompiledCheckpointNode> {
  const streams = options.streams ?? {
    stdin: process.stdin,
    stderr: process.stderr
  };
  const create_prompt_adapter = options.create_prompt_adapter ?? createReadlinePromptAdapter;

  return async (
    context: RuntimeNodeExecutorContext<CompiledCheckpointNode>
  ): Promise<RuntimeNodeExecutionResult> => {
    if (streams.stdin.isTTY !== true || streams.stderr.isTTY !== true) {
      throw new Error(
        'Checkpoint nodes require interactive TTY stdin and stderr when they reach execution.'
      );
    }

    const packet = JSON.parse(await readFile(context.context_packet_path, "utf8")) as ContextPacket;
    const reviewMaterial = findReviewMaterial(packet, context.node.review_from);

    if (!reviewMaterial) {
      throw new Error(
        `Checkpoint "${context.node.compiled_id}" could not resolve its review artifact from the context packet.`
      );
    }

    const reviewText = await readFile(reviewMaterial.materialized_path, "utf8");
    const contextManifestPreview = truncatePreview(
      await readFile(context.context_manifest_path, "utf8"),
      {
        max_lines: 20,
        max_chars: 2000
      }
    );
    const supporting_context = packet.materials
      .filter((item) => item.materialized_path !== reviewMaterial.materialized_path)
      .map((item) => ({
        label: describeContextSource(item.source),
        path: item.materialized_path
      }));

    const adapter = create_prompt_adapter(streams);

    try {
      adapter.write(
        `\n${renderCheckpointReview({
          node: context.node,
          review_artifact_path: reviewMaterial.materialized_path,
          review_preview: truncatePreview(reviewText),
          supporting_context,
          context_manifest_preview: contextManifestPreview
        })}`
      );

      const decision = await promptForDecision(adapter);

      if (decision.decision === "pass") {
        return {
          status: "passed",
          outcome: "passed",
          result: {
            checkpoint_decision: "pass",
            review_artifact_path: reviewMaterial.materialized_path
          },
          stdout: undefined,
          stderr: undefined,
          metadata: {
            checkpoint_decision: "pass",
            review_artifact_path: reviewMaterial.materialized_path
          }
        };
      }

      if (decision.decision === "abort") {
        return {
          status: "canceled",
          result: {
            checkpoint_decision: "abort",
            review_artifact_path: reviewMaterial.materialized_path
          },
          stdout: undefined,
          stderr: undefined,
          metadata: {
            checkpoint_decision: "abort",
            review_artifact_path: reviewMaterial.materialized_path
          }
        };
      }

      const feedbackPath = join(
        resolveExecutionArtifactsDirectory(context.execution_dir),
        "operator-feedback.md"
      );
      await mkdir(dirname(feedbackPath), { recursive: true });
      await writeFile(feedbackPath, `${decision.feedback?.trim()}\n`, "utf8");

      return {
        status: "failed",
        outcome: "failed",
        result: {
          checkpoint_decision: "deny",
          review_artifact_path: reviewMaterial.materialized_path,
          operator_feedback_path: feedbackPath
        },
        stdout: undefined,
        stderr: undefined,
        metadata: {
          checkpoint_decision: "deny",
          review_artifact_path: reviewMaterial.materialized_path,
          operator_feedback_path: feedbackPath
        }
      };
    } finally {
      adapter.close();
    }
  };
}

export const checkpointPromptTestUtils = {
  truncatePreview,
  renderCheckpointReview,
  promptForDecision
};
