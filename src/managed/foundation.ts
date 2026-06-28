import type {
  AgentNode,
  ArtifactDefinition,
  ArtifactRepairPolicy,
  BaseExecutableNode,
  CheckNode,
  ContextItem,
  ManagedPromptContract,
  NodeRuntimeSelection,
  NodeSupport
} from "../graph/authored.js";
import type { ContextSelector, ReasoningEffort, SandboxMode } from "../graph/schema.js";

export interface ManagedPatternRuntime extends NodeRuntimeSelection {
  max_concurrency?: number;
}

export interface ManagedPatternAgentOptions {
  model?: string;
  reasoning_effort?: ReasoningEffort;
  sandbox?: SandboxMode;
  artifact_repair?: ArtifactRepairPolicy;
  support?: NodeSupport;
}

export type ManagedPatternExecutableConfig = BaseExecutableNode & ManagedPatternAgentOptions;

export interface PromptSection {
  title?: string;
  lines: string[];
}

export function managedPromptContract(
  phase: string,
  task: string,
  sections: PromptSection[]
): ManagedPromptContract {
  return {
    phase,
    task,
    sections: sections.map((entry, index) => ({
      title: entry.title ?? (index === 0 ? "Task" : "Details"),
      lines: entry.lines
    }))
  };
}

export function managedId(rootId: string, kind: string, suffix: string): string {
  return `${rootId}__managed__${kind}__${suffix}`;
}

export function sharedNodeBase(
  config: BaseExecutableNode
): Pick<AgentNode, "runtime" | "support"> {
  return {
    ...(config.runtime ? { runtime: config.runtime } : {}),
    ...(config.support ? { support: config.support } : {})
  };
}

function supportWithOnly(
  support: NodeSupport | undefined,
  fields: Array<keyof NodeSupport>
): NodeSupport | undefined {
  if (!support) {
    return undefined;
  }

  const narrowed: NodeSupport = {};

  if (fields.includes("context") && support.context && support.context.length > 0) {
    narrowed.context = support.context;
  }
  if (fields.includes("skills") && support.skills && support.skills.length > 0) {
    narrowed.skills = support.skills;
  }
  if (fields.includes("cli") && support.cli && support.cli.length > 0) {
    narrowed.cli = support.cli;
  }

  return Object.keys(narrowed).length > 0 ? narrowed : undefined;
}

export function supportForNonPromptNode(support: NodeSupport | undefined): NodeSupport | undefined {
  return supportWithOnly(support, ["context"]);
}

export function supportForAiCheck(support: NodeSupport | undefined): NodeSupport | undefined {
  return supportWithOnly(support, ["context", "skills", "cli"]);
}

export function sharedNonPromptNodeBase(
  config: BaseExecutableNode
): Pick<CheckNode, "runtime" | "support"> {
  const support = supportForNonPromptNode(config.support);

  return {
    ...(config.runtime ? { runtime: config.runtime } : {}),
    ...(support ? { support } : {})
  };
}

export function sharedAgentBase(
  config: ManagedPatternExecutableConfig
): Pick<AgentNode, "runtime" | "support" | "model" | "reasoning_effort" | "sandbox" | "artifact_repair"> {
  return {
    ...sharedNodeBase(config),
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoning_effort ? { reasoning_effort: config.reasoning_effort } : {}),
    ...(config.sandbox ? { sandbox: config.sandbox } : {}),
    ...(config.artifact_repair ? { artifact_repair: config.artifact_repair } : {})
  };
}

export function sharedAiCheckBase(
  config: ManagedPatternExecutableConfig
): Pick<CheckNode, "runtime" | "support" | "model" | "reasoning_effort"> {
  const support = supportForAiCheck(config.support);

  return {
    ...(config.runtime ? { runtime: config.runtime } : {}),
    ...(support ? { support } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoning_effort ? { reasoning_effort: config.reasoning_effort } : {})
  };
}

export function mergeSupportContext(
  support: NodeSupport | undefined,
  context: ContextItem[]
): NodeSupport {
  if (context.length === 0) {
    return support ?? {};
  }

  return {
    ...(support ?? {}),
    context: [
      ...(support?.context ?? []),
      ...context
    ]
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
  return outputDirArtifact("packet", "packet.json", "Machine-readable final evidence packet.");
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
    what?: string;
    why?: string;
  } = {}
): Extract<ContextItem, { ref: string }> {
  return {
    ref: `${node}.${artifact}`,
    name,
    node,
    artifact,
    what: options.what ?? `Artifact "${artifact}" produced by node "${node}".`,
    why: options.why ?? "This task needs the producer artifact as evidence for its contract.",
    ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(options.if_available !== undefined ? { if_available: options.if_available } : {})
  };
}

export function workspaceFileContext(name: string, path: string): Extract<ContextItem, { from: "workspace_file" }> {
  return {
    name,
    from: "workspace_file",
    path,
    what: `Workspace file ${path}.`,
    why: "This task needs this workspace file as evidence for its contract."
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
