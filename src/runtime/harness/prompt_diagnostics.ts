import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { AgentInvocation } from "./types.js";

export interface PromptDiagnosticsSection {
  name: string;
  chars: number;
  warnings?: string[];
}

export interface PromptDiagnostics {
  version: "1";
  prompt_kind: NonNullable<AgentInvocation["promptKind"]>;
  renderer: string;
  execution_id: string;
  compiled_id?: string;
  authored_id?: string;
  harness?: string;
  model?: string;
  reasoning_effort?: string;
  sandbox: AgentInvocation["sandbox"];
  ai_evaluator_surface?: NonNullable<AgentInvocation["aiEvaluatorSurface"]>;
  managed_kind?: string;
  managed_phase?: string;
  managed_item_id?: string;
  cycle?: number;
  total_chars: number;
  sections: PromptDiagnosticsSection[];
  context_pointer_count: number;
  context_pointer_kinds: string[];
  context_priority_bucket_counts: {
    read_first: number;
    current_work: number;
    task_context: number;
    progress_state: number;
    reference_set: number;
  };
  context_read_first_count: number;
  context_glob_set_count: number;
  context_glob_match_count: number;
  context_glob_included_count: number;
  context_limited_glob_count: number;
  context_uses_flat_glob_expansion: boolean;
  tool_count: number;
  skill_count: number;
  cli_hint_count: number;
  declared_artifact_count: number;
  has_supervisor_recovery: boolean;
  orient_required_by_prompt: boolean;
  complete_check_required_by_prompt: boolean;
  warnings: string[];
}

export interface PromptDiagnosticsMetadata {
  compiledId?: string;
  authoredId?: string;
  harness?: string;
  managedKind?: string;
  managedPhase?: string;
  managedItemId?: string;
  cycle?: number;
}

export interface BuildPromptDiagnosticsOptions {
  invocation: AgentInvocation;
  prompt: string;
  renderer: string;
  metadata?: PromptDiagnosticsMetadata;
}

export interface ResolvePromptDiagnosticsPathOptions {
  promptKind?: AgentInvocation["promptKind"];
  promptPath: string;
}

export interface WritePromptDiagnosticsOptions extends BuildPromptDiagnosticsOptions {
  promptPath?: string;
  diagnosticsPath?: string;
}

const contextPointerManyThreshold = 20;
const toolManyThreshold = 10;
const skillManyThreshold = 10;
const nodeGoalLargeThreshold = 6000;
const agentflowMetaHeavyThreshold = 30;

type ContextPriorityBucket = "read_first" | "current_work" | "task_context" | "progress_state" | "reference_set";

interface ContextManifestStats {
  pointerCount: number;
  pointerKinds: string[];
  bucketCounts: PromptDiagnostics["context_priority_bucket_counts"];
  readFirstCount: number;
  globSetCount: number;
  globMatchCount: number;
  globIncludedCount: number;
  limitedGlobCount: number;
  usesFlatGlobExpansion: boolean;
}

function promptKind(invocation: AgentInvocation): NonNullable<AgentInvocation["promptKind"]> {
  return invocation.promptKind ?? "agent";
}

function normalizeHeadingName(value: string): string {
  return value.replace(/\s+#+\s*$/u, "").trim() || "Untitled";
}

function parseSections(prompt: string): PromptDiagnosticsSection[] {
  const headingPattern = /^##\s+(.+?)\s*$/gmu;
  const matches = [...prompt.matchAll(headingPattern)];

  if (matches.length === 0) {
    return [{
      name: "Prompt",
      chars: prompt.length
    }];
  }

  const sections: PromptDiagnosticsSection[] = [];
  const firstMatch = matches[0]!;
  if ((firstMatch.index ?? 0) > 0) {
    sections.push({
      name: "Preamble",
      chars: firstMatch.index ?? 0
    });
  }

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const next = matches[index + 1];
    const start = match.index ?? 0;
    const end = next?.index ?? prompt.length;
    sections.push({
      name: normalizeHeadingName(match[1] ?? ""),
      chars: end - start
    });
  }

  return sections;
}

function bucketFromHeading(heading: string): ContextPriorityBucket | undefined {
  const normalized = heading.trim().toLowerCase();
  if (normalized === "read first") return "read_first";
  if (normalized === "current work") return "current_work";
  if (normalized === "task context" || normalized === "pointers") return "task_context";
  if (normalized === "progress state") return "progress_state";
  if (normalized === "reference sets") return "reference_set";
  return undefined;
}

function initialBucketCounts(): PromptDiagnostics["context_priority_bucket_counts"] {
  return {
    read_first: 0,
    current_work: 0,
    task_context: 0,
    progress_state: 0,
    reference_set: 0
  };
}

function parseTableCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return undefined;
  }
  if (/^\|\s*-+/u.test(trimmed) || /\|\s*Name\s*\|\s*Kind\s*\|/iu.test(trimmed)) {
    return undefined;
  }
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim().replace(/^`|`$/gu, ""));
}

function parseMatchCount(value: string | undefined): { included: number; matched: number } | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/\b(\d+)\s+of\s+(\d+)\b/u);
  if (!match) {
    return undefined;
  }
  return {
    included: Number(match[1]),
    matched: Number(match[2])
  };
}

function parseContextManifestStats(manifest: string): ContextManifestStats {
  const kinds = new Set<string>();
  const bucketCounts = initialBucketCounts();
  let currentBucket: ContextPriorityBucket | undefined;
  let pointerCount = 0;
  let globSetCount = 0;
  let globMatchCount = 0;
  let globIncludedCount = 0;
  let limitedGlobCount = 0;
  let usesFlatGlobExpansion = false;

  for (const line of manifest.split(/\r?\n/u)) {
    const heading = line.match(/^##\s+(.+?)\s*$/u);
    if (heading?.[1]) {
      currentBucket = bucketFromHeading(heading[1]);
      continue;
    }

    const cells = parseTableCells(line);
    if (!cells) {
      continue;
    }
    pointerCount += 1;
    const bucket = currentBucket ?? "task_context";
    bucketCounts[bucket] += 1;
    const kind = cells[1];
    if (kind) {
      kinds.add(kind);
    }
    if (kind === "workspace_glob") {
      globSetCount += 1;
      if (bucket !== "reference_set") {
        usesFlatGlobExpansion = true;
      }
      const matchCount = parseMatchCount(cells[3]);
      if (matchCount) {
        globIncludedCount += matchCount.included;
        globMatchCount += matchCount.matched;
        if (matchCount.included < matchCount.matched) {
          limitedGlobCount += 1;
        }
      }
    }
  }

  return {
    pointerCount,
    pointerKinds: [...kinds].sort(),
    bucketCounts,
    readFirstCount: bucketCounts.read_first,
    globSetCount,
    globMatchCount,
    globIncludedCount,
    limitedGlobCount,
    usesFlatGlobExpansion
  };
}

function countOccurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function collectWarnings(options: {
  invocation: AgentInvocation;
  prompt: string;
  contextPointerCount: number;
  toolCount: number;
  skillCount: number;
}): string[] {
  const warnings = new Set<string>();
  const { invocation, prompt } = options;

  if ((invocation.nodeGoal?.length ?? 0) > nodeGoalLargeThreshold) {
    warnings.add("node_goal_large");
  }
  if (options.contextPointerCount > contextPointerManyThreshold) {
    warnings.add("context_many_pointers");
  }
  if (options.toolCount > toolManyThreshold) {
    warnings.add("tool_many_entries");
  }
  if (options.skillCount > skillManyThreshold) {
    warnings.add("skill_many_entries");
  }
  if (countOccurrences(prompt, /\bAgentflow\b/gu) > agentflowMetaHeavyThreshold) {
    warnings.add("agentflow_meta_heavy");
  }
  if (
    promptKind(invocation) === "agent" &&
    (countOccurrences(prompt, /af complete check/gu) > 1 || countOccurrences(prompt, /af orient/gu) > 1)
  ) {
    warnings.add("duplicated_operating_guidance");
  }
  if (
    promptKind(invocation) === "ai_check" &&
    (invocation.nodeGoal?.length ?? 0) > nodeGoalLargeThreshold
  ) {
    warnings.add("judge_goal_overfed");
  }
  if (
    invocation.supervisorRecoveryEnvelope &&
    !/Required next action/iu.test(prompt)
  ) {
    warnings.add("recovery_without_priority");
  }

  return [...warnings].sort();
}

export function buildPromptDiagnostics(options: BuildPromptDiagnosticsOptions): PromptDiagnostics {
  const contextManifest = options.invocation.contextManifest ?? "";
  const contextStats = parseContextManifestStats(contextManifest);
  const toolCount = options.invocation.tools?.length ?? 0;
  const skillCount = options.invocation.skills?.length ?? 0;
  const cliHintCount = options.invocation.cli?.length ?? 0;
  const declaredArtifactCount = Object.keys(options.invocation.artifacts).length;
  const warnings = collectWarnings({
    invocation: options.invocation,
    prompt: options.prompt,
    contextPointerCount: contextStats.pointerCount,
    toolCount,
    skillCount
  });

  return {
    version: "1",
    prompt_kind: promptKind(options.invocation),
    renderer: options.renderer,
    execution_id: options.invocation.executionId,
    ...(options.metadata?.compiledId ? { compiled_id: options.metadata.compiledId } : {}),
    ...(options.metadata?.authoredId ? { authored_id: options.metadata.authoredId } : {}),
    harness: options.metadata?.harness ?? "codex-cli",
    ...(options.invocation.model ? { model: options.invocation.model } : {}),
    ...(options.invocation.reasoningEffort ? { reasoning_effort: options.invocation.reasoningEffort } : {}),
    sandbox: options.invocation.sandbox,
    ...(options.invocation.aiEvaluatorSurface ? { ai_evaluator_surface: options.invocation.aiEvaluatorSurface } : {}),
    ...(options.metadata?.managedKind ? { managed_kind: options.metadata.managedKind } : {}),
    ...(options.metadata?.managedPhase ? { managed_phase: options.metadata.managedPhase } : {}),
    ...(options.metadata?.managedItemId ? { managed_item_id: options.metadata.managedItemId } : {}),
    ...(options.metadata?.cycle !== undefined ? { cycle: options.metadata.cycle } : {}),
    total_chars: options.prompt.length,
    sections: parseSections(options.prompt),
    context_pointer_count: contextStats.pointerCount,
    context_pointer_kinds: contextStats.pointerKinds,
    context_priority_bucket_counts: contextStats.bucketCounts,
    context_read_first_count: contextStats.readFirstCount,
    context_glob_set_count: contextStats.globSetCount,
    context_glob_match_count: contextStats.globMatchCount,
    context_glob_included_count: contextStats.globIncludedCount,
    context_limited_glob_count: contextStats.limitedGlobCount,
    context_uses_flat_glob_expansion: contextStats.usesFlatGlobExpansion,
    tool_count: toolCount,
    skill_count: skillCount,
    cli_hint_count: cliHintCount,
    declared_artifact_count: declaredArtifactCount,
    has_supervisor_recovery: Boolean(options.invocation.supervisorRecoveryEnvelope),
    orient_required_by_prompt: /`?af orient`?/u.test(options.prompt),
    complete_check_required_by_prompt: /`?af complete check`?/u.test(options.prompt),
    warnings
  };
}

export function resolvePromptDiagnosticsPath(options: ResolvePromptDiagnosticsPathOptions): string {
  const kind = options.promptKind ?? "agent";
  const promptPath = options.promptPath;
  const promptDir = dirname(promptPath);

  if (
    (kind === "agent" || kind === "ai_check" || kind === "artifact_repair") &&
    basename(promptDir) === "agent" &&
    basename(promptPath) === "prompt.md"
  ) {
    return join(dirname(promptDir), "human-debug", "prompt-diagnostics.json");
  }

  return join(promptDir, "prompt-diagnostics.json");
}

export async function writePromptDiagnostics(options: WritePromptDiagnosticsOptions): Promise<string | undefined> {
  const diagnosticsPath = options.diagnosticsPath ?? (
    options.promptPath || options.invocation.promptPath
      ? resolvePromptDiagnosticsPath({
          promptKind: promptKind(options.invocation),
          promptPath: options.promptPath ?? options.invocation.promptPath!
        })
      : undefined
  );

  if (!diagnosticsPath) {
    return undefined;
  }

  try {
    const diagnostics = buildPromptDiagnostics(options);
    await mkdir(dirname(diagnosticsPath), { recursive: true });
    await writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
    return diagnosticsPath;
  } catch {
    return undefined;
  }
}
