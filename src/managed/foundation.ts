import type {
  AgentNode,
  BaseExecutableNode,
  OutputDefinition
} from "../graph/authored.js";

export interface ManagedWorkflowRuntime {
  max_concurrency?: number;
}

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

export function appendOutput(outputs: OutputDefinition[], output: OutputDefinition): OutputDefinition[] {
  return outputs.some((item) => item.name === output.name) ? outputs : [...outputs, output];
}

export function attemptOutput(name: string, path: string, required: boolean): OutputDefinition {
  return {
    name,
    from: "attempt",
    path,
    required
  };
}

export function maxConcurrency(runtime: ManagedWorkflowRuntime | undefined, desired: number): number {
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

export function workflowBriefOutput(): OutputDefinition {
  return attemptOutput("workflow_brief", "workflow-brief.md", true);
}

export function workflowPlanMarkdownOutput(): OutputDefinition {
  return attemptOutput("workflow_plan_markdown", "workflow-plan.md", true);
}

export function workflowPlanJsonOutput(): OutputDefinition {
  return attemptOutput("workflow_plan_json", "workflow-plan.json", true);
}

export function workflowStatusOutput(): OutputDefinition {
  return attemptOutput("workflow_status", "workflow-status.json", true);
}

export function workflowEventsOutput(): OutputDefinition {
  return attemptOutput("workflow_events", "workflow-events.jsonl", true);
}
