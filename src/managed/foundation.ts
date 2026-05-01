import type {
  AgentNode,
  ArtifactDefinition,
  ArtifactRepairPolicy,
  BaseExecutableNode,
  CheckNode,
  ContextItem
} from "../graph/authored.js";
import type { ContextSelector, ReasoningEffort, SandboxMode } from "../graph/schema.js";
import type { ToolDeclaration } from "../graph/authored.js";

export interface ManagedPatternRuntime {
  max_concurrency?: number;
}

export interface ManagedPatternAgentOptions {
  model?: string;
  reasoning_effort?: ReasoningEffort;
  sandbox?: SandboxMode;
  artifact_repair?: ArtifactRepairPolicy;
  tools?: ToolDeclaration[];
}

export type ManagedPatternExecutableConfig = BaseExecutableNode & ManagedPatternAgentOptions;

export interface PromptSection {
  title?: string;
  lines: string[];
}

export function managedId(rootId: string, kind: string, suffix: string): string {
  return `${rootId}__managed__${kind}__${suffix}`;
}

export function sharedNodeBase(
  config: BaseExecutableNode
): Pick<AgentNode, "repo" | "profile" | "timeout_sec"> {
  return {
    ...(config.repo ? { repo: config.repo } : {}),
    ...(config.profile ? { profile: config.profile } : {}),
    ...(config.timeout_sec !== undefined ? { timeout_sec: config.timeout_sec } : {})
  };
}

export function sharedAgentBase(
  config: ManagedPatternExecutableConfig
): Pick<AgentNode, "repo" | "profile" | "timeout_sec" | "model" | "reasoning_effort" | "sandbox" | "artifact_repair" | "tools"> {
  return {
    ...sharedNodeBase(config),
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoning_effort ? { reasoning_effort: config.reasoning_effort } : {}),
    ...(config.sandbox ? { sandbox: config.sandbox } : {}),
    ...(config.artifact_repair ? { artifact_repair: config.artifact_repair } : {}),
    ...(config.tools && config.tools.length > 0 ? { tools: config.tools } : {})
  };
}

export function sharedAiCheckBase(
  config: ManagedPatternExecutableConfig
): Pick<CheckNode, "repo" | "profile" | "timeout_sec" | "model" | "reasoning_effort"> {
  return {
    ...sharedNodeBase(config),
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoning_effort ? { reasoning_effort: config.reasoning_effort } : {})
  };
}

export function mergeArtifacts(
  ...artifacts: Array<Record<string, ArtifactDefinition>>
): Record<string, ArtifactDefinition> {
  return Object.assign({}, ...artifacts);
}

function defaultArtifactDescription(name: string, path: string): string {
  const readableName = name.replace(/_/gu, " ");
  const format = path.endsWith(".jsonl")
    ? "Line-delimited JSON"
    : path.endsWith(".json")
      ? "Structured JSON"
      : path.endsWith(".md")
        ? "Markdown"
        : "Durable";

  return `${format} artifact containing the ${readableName} expected from this node.`;
}

export function defaultManagedPublicArtifacts(): Record<string, ArtifactDefinition> {
  return mergeArtifacts(
    outputDirArtifact("summary", "summary.md", "Human-readable final summary for the managed pattern."),
    outputDirArtifact("packet", "packet.json", "Machine-readable final packet for downstream Agentflow nodes.")
  );
}

export function mergeManagedPublicArtifacts(
  artifacts: Record<string, ArtifactDefinition> | undefined
): Record<string, ArtifactDefinition> {
  return mergeArtifacts(defaultManagedPublicArtifacts(), artifacts ?? {});
}

export function outputDirArtifact(
  name: string,
  path: string,
  description = defaultArtifactDescription(name, path)
): Record<string, ArtifactDefinition> {
  return {
    [name]: {
      from: "output_dir",
      path,
      description
    }
  };
}

export function artifactContext(
  name: string,
  node: string,
  artifact: string,
  options: {
    iteration?: ContextSelector;
    attempt?: ContextSelector;
    if_available?: boolean;
  } = {}
): Extract<ContextItem, { ref: string }> {
  return {
    ref: `${node}.${artifact}`,
    name,
    node,
    artifact,
    ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(options.if_available !== undefined ? { if_available: options.if_available } : {})
  };
}

export function workspaceFileContext(name: string, path: string): Extract<ContextItem, { from: "workspace_file" }> {
  return {
    name,
    from: "workspace_file",
    path
  };
}

export function maxConcurrency(runtime: ManagedPatternRuntime | undefined, desired: number): number {
  if (!runtime?.max_concurrency || runtime.max_concurrency < 1) {
    return desired;
  }

  return Math.min(runtime.max_concurrency, desired);
}

export function section(title: string, lines: string[] | string): PromptSection {
  return {
    title,
    lines: Array.isArray(lines) ? lines : [lines]
  };
}

export function body(lines: string[] | string): PromptSection {
  return {
    lines: Array.isArray(lines) ? lines : [lines]
  };
}

export function renderPrompt(sections: PromptSection[]): string {
  return sections
    .flatMap((entry, index) => {
      const chunk: string[] = [];

      if (index > 0) {
        chunk.push("");
      }

      if (entry.title) {
        chunk.push(`${entry.title}:`);
      }

      chunk.push(...entry.lines);
      return chunk;
    })
    .join("\n");
}

export function listOrFallback(title: string, values: string[], fallback: string): string[] {
  if (values.length === 0) {
    return [`${title}: ${fallback}`];
  }

  return [title, ...values.map((value) => `- ${value}`)];
}

export function workflowBriefOutput(): Record<string, ArtifactDefinition> {
  return outputDirArtifact("workflow_brief", "workflow-brief.md");
}

export function workflowPlanMarkdownOutput(): Record<string, ArtifactDefinition> {
  return outputDirArtifact("workflow_plan_markdown", "workflow-plan.md");
}

export function workflowPlanJsonOutput(): Record<string, ArtifactDefinition> {
  return outputDirArtifact("workflow_plan_json", "workflow-plan.json");
}
