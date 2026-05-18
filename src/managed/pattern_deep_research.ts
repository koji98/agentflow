import type {
  AgentNode,
  ArtifactDefinition,
  BaseExecutableNode,
  ContextItem,
  ParallelNode,
  SequenceNode
} from "../graph/authored.js";
import {
  artifactContext,
  body,
  managedId,
  mergeSupportContext,
  outputDirArtifact,
  renderPrompt,
  section,
  sharedAgentBase,
  type ManagedPatternAgentOptions,
  type ManagedPatternRuntime
} from "./foundation.js";

export interface PatternDeepResearchConfig extends BaseExecutableNode, ManagedPatternAgentOptions {
  research: {
    angles: PatternDeepResearchAngle[];
  };
  runtime?: ManagedPatternRuntime;
}

export interface PatternDeepResearchAngle {
  id: string;
  prompt: string;
}

function workflowNodeId(rootId: string, suffix: string): string {
  return managedId(rootId, "pattern_deep_research", suffix);
}

function zeroPad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatList(title: string, values: string[] | undefined, fallback: string): string[] {
  return values && values.length > 0
    ? [title, ...values.map((value) => `- ${value}`)]
    : [`${title}: ${fallback}`];
}

function formatArtifactContract(artifacts: Record<string, ArtifactDefinition>): string[] {
  return Object.entries(artifacts).flatMap(([name, artifact]) => [
    `- ${name}: publish this declared artifact; the Declared Artifacts table shows the exact command.`,
    `  ${artifact.description}`
  ]);
}

interface ResearchMaterial {
  nodeId: string;
  reportArtifact: string;
  contextPrefix: string;
  what?: string;
  why?: string;
}

function materialContexts(materials: ResearchMaterial[]): ContextItem[] {
  return materials.map((material) =>
    artifactContext(`${material.contextPrefix}_report`, material.nodeId, material.reportArtifact, {
      ...(material.what ? { what: material.what } : {}),
      ...(material.why ? { why: material.why } : {})
    })
  );
}

function balancedGroups<T>(items: T[], maxGroupSize = 3): T[][] {
  if (items.length <= maxGroupSize) {
    return [items];
  }

  const groupCount = Math.ceil(items.length / maxGroupSize);
  const baseSize = Math.floor(items.length / groupCount);
  const largerGroupCount = items.length % groupCount;
  const sizes = Array.from({ length: groupCount }, (_, index) =>
    index >= groupCount - largerGroupCount ? baseSize + 1 : baseSize
  );
  const groups: T[][] = [];
  let cursor = 0;

  for (const size of sizes) {
    groups.push(items.slice(cursor, cursor + size));
    cursor += size;
  }

  return groups;
}

function buildAnglePrompt(config: PatternDeepResearchConfig, angle: PatternDeepResearchAngle, index: number): string {
  return renderPrompt([
    body("You are a research angle worker investigating one assigned angle for a larger managed research workflow. Your private report will be synthesized later, so gather useful evidence and preserve uncertainty clearly."),
    section("Assigned Angle", [
      `Angle id: ${angle.id}`,
      angle.prompt,
      "This assigned angle is your controlling objective. Do not let the broader workflow goal shift your focus.",
      "Do not duplicate other angle workers unless overlap is needed to explain a conflict."
    ]),
    section("Final Managed Workflow Contract", [
      "This is a private helper node inside a managed workflow. The final managed node owns the public artifact shape and final acceptance criteria below.",
      "Use this contract as background for what your angle evidence must support, not as permission to broaden the assigned angle.",
      `Goal: ${config.intent.goal}`,
      ...formatList("Final acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...formatList("Constraints", config.intent.constraints, "Stay inside the authored graph contract.")
    ]),
    section("Research Method", [
      "Treat repository files as read-only evidence. Do not edit, create, or delete files in the repo workspace.",
      "Use local repository files, provided context, available local CLIs, docs, or web research, whichever best serves this angle.",
      "Prefer authoritative local/source evidence when the question is repo-specific.",
      "Use external or web context when docs, package behavior, standards, release notes, or broader comparisons would materially improve the answer.",
      "Preserve source paths, commands, URLs, and uncertainty so final synthesis can audit the claim.",
      "Do not change graph intent, node intent, repo authority, sandbox, or declared artifacts."
    ]),
    section("Output Contract", [
      `Publish the \`angle_report_${zeroPad(index + 1)}\` artifact; the Declared Artifacts table shows the exact command.`,
      "This is a private research artifact for synthesis, not the final public handoff.",
      "Do not create a report file in the repo workspace; stream the final Markdown directly to `af artifact write`.",
      "Do not create links to other angle reports; you may reference related findings in prose, and the final summary will provide raw evidence links.",
      `The assigned angle id is ${angle.id}. Use that value in the report heading or metadata.`,
      "The report should be readable by a human researcher and focused on the assigned angle.",
      "Include findings, evidence, sources, conflicts, uncertainty, and confidence in Markdown."
    ]),
    section("Quality Bar", [
      "Do not produce a shallow summary. Produce the most useful evidence-backed answer for this angle.",
      "Mark uncertainty instead of guessing. Include minority or conflicting evidence when it matters.",
      `Final reminder: complete angle \`${angle.id}\`, not the entire research workflow.`
    ])
  ]);
}

function buildSynthesisPrompt(
  config: PatternDeepResearchConfig,
  inputCount: number,
  layer: number,
  group: number
): string {
  return renderPrompt([
    body(`You are a research synthesis worker combining ${inputCount} research reports into one higher-signal synthesis report.`),
    section("Final Managed Workflow Contract", [
      "This is a private synthesis step inside a larger managed research workflow. The final public result will be published later.",
      "Use the final contract to preserve relevant evidence, but do not format this private synthesis as the final public artifact unless the private output contract below says so.",
      `Goal: ${config.intent.goal}`,
      ...formatList("Final acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...formatList("Constraints", config.intent.constraints, "Stay inside the authored graph contract.")
    ]),
    section("Synthesis Task", [
      "Preserve every major finding from the input material.",
      "Collapse redundant claims while keeping the strongest provenance.",
      "Keep evidence attached to claims; do not detach conclusions from sources.",
      "Surface conflicts, weak evidence, missing coverage, and uncertainty.",
      "Do not discard a unique major finding just because it appears in only one report.",
      "Do not create links to individual angle reports; preserve references in prose and let the runtime-owned summary evidence table own raw report links."
    ]),
    section("Output Contract", [
      `Publish the \`synthesis_report_${zeroPad(layer)}_${zeroPad(group)}\` artifact; the Declared Artifacts table shows the exact command.`,
      "This is a private synthesis artifact for the final publisher, not the final public handoff.",
      "Include findings, evidence, sources, conflicts, uncertainty, confidence, and collapsed duplicates in Markdown."
    ])
  ]);
}

function buildFinalPrompt(
  config: PatternDeepResearchConfig,
  publicArtifacts: Record<string, ArtifactDefinition>,
  inputCount: number
): string {
  return renderPrompt([
    body(`You are the final research publisher for a managed deep research result from ${inputCount} research report${inputCount === 1 ? "" : "s"}. Create the complete, coherent research handoff that downstream work can rely on, with links to raw research evidence for progressive disclosure.`),
    section("Managed Workflow Contract", [
      "This final publisher owns the managed workflow's single public artifact contract. Raw angle reports are the public evidence pointers; synthesis reports are internal working notes.",
      `Goal: ${config.intent.goal}`,
      ...formatList("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...formatList("Constraints", config.intent.constraints, "Stay inside the authored graph contract.")
    ]),
    section("Evidence Link Ownership", [
      "Raw angle reports are part of the research evidence packet, but Agentflow owns the raw report link table.",
      "After you publish the summary, the runtime prepends the table of authored angles, assigned focus, and exact report file paths.",
      "Do not author raw angle links yourself. Reference related angle findings in prose without extra links.",
      "Synthesis reports are intermediate working notes for this publisher only; use them to resolve conflicts, but do not expose them as downstream evidence links."
    ]),
    section("Current Context", [
      "Use the research reports in context as evidence.",
      "Resolve disagreements explicitly. Preserve uncertainty and cite the evidence behind important claims.",
      "Collapse redundancy, but keep all major findings and the strongest provenance for each claim."
    ]),
    section("Summary Shape", [
      "Write `summary.md` as the canonical research handoff, not a high-level abstract.",
      "Write a holistic, sufficiently detailed, conflict-resolved answer that covers every angle. Do not merely copy raw reports through.",
      "End with the integrated conclusion, controlling decisions, unresolved uncertainty, risks, and downstream implications."
    ]),
    section("Declared Public Artifacts", [
      "Publish the declared public artifact.",
      ...formatArtifactContract(publicArtifacts)
    ]),
    section("Quality Bar", [
      "The summary must be internally consistent on controlling decisions, names, routes, states, risks, and downstream instructions.",
      "When raw reports disagree, decide what controls, explain what was superseded, and make the summary consistent with that decision.",
      "The summary should be useful for a downstream design, implementation, review, or decision node without requiring the reader to inspect raw evidence first.",
      "Do not bury uncertainty or present one angle's evidence as the whole answer."
    ])
  ]);
}

function buildAngleArtifacts(index: number): Record<string, ArtifactDefinition> {
  const suffix = zeroPad(index + 1);

  return {
    [`angle_report_${suffix}`]: {
      from: "output_dir",
      path: "angle-report.md",
      description: `Markdown findings for research angle ${suffix}.`
    }
  };
}

function buildSynthesisArtifacts(layer: number, group: number): Record<string, ArtifactDefinition> {
  const suffix = `${zeroPad(layer)}_${zeroPad(group)}`;

  return {
    [`synthesis_report_${suffix}`]: {
      from: "output_dir",
      path: `synthesis-${zeroPad(layer)}-${zeroPad(group)}.md`,
      description: `Markdown synthesis report for research layer ${zeroPad(layer)} group ${zeroPad(group)}.`
    }
  };
}

function buildPublicArtifacts(): Record<string, ArtifactDefinition> {
  return outputDirArtifact("summary", "summary.md", "Human-readable final summary for the managed deep research result.");
}

export function buildPatternDeepResearch(config: PatternDeepResearchConfig): SequenceNode {
  const workflowId = workflowNodeId(config.id, "workflow");
  const fanoutId = workflowNodeId(config.id, "angle_fanout");
  const publicArtifacts = buildPublicArtifacts();
  const agentShared = sharedAgentBase(config);

  const angleNodes: AgentNode[] = config.research.angles.map((angle, index) => {
    const suffix = zeroPad(index + 1);

    return {
      type: "agent",
      id: workflowNodeId(config.id, `angle_${suffix}`),
      label: `Research Angle ${suffix}`,
      ...agentShared,
      artifacts: buildAngleArtifacts(index),
      intent: {
        goal: buildAnglePrompt(config, angle, index),
        acceptance_criteria: [
          "The angle report answers the assigned angle with sourced evidence.",
          "The angle report preserves enough provenance, uncertainty, and confidence for final synthesis."
        ],
        constraints: config.intent.constraints
      }
    };
  });

  const angleMaterials: ResearchMaterial[] = config.research.angles.map((angle, index) => {
    const suffix = zeroPad(index + 1);

    return {
      nodeId: workflowNodeId(config.id, `angle_${suffix}`),
      reportArtifact: `angle_report_${suffix}`,
      contextPrefix: `angle_${suffix}`,
      what: `Raw report for deep research angle \`${angle.id}\`: ${angle.prompt}`,
      why: "The final summary must link this raw angle evidence and rewrite it into the conflict-resolved synthesis."
    };
  });
  let materials: ResearchMaterial[] = angleMaterials;

  const fanout: ParallelNode = {
    type: "parallel",
    id: fanoutId,
    label: "Research Angles",
    max_concurrency: angleNodes.length,
    steps: angleNodes
  };
  const synthesisLayers: ParallelNode[] = [];
  let layer = 1;

  while (materials.length > 3) {
    const groups = balancedGroups(materials, 3);
    const synthesisNodes: AgentNode[] = groups.map((groupMaterials, groupIndex) => {
      const group = groupIndex + 1;
      const suffix = `${zeroPad(layer)}_${zeroPad(group)}`;

      return {
        type: "agent",
        id: workflowNodeId(config.id, `synthesis_${suffix}`),
        label: `Research Synthesis ${zeroPad(layer)}.${zeroPad(group)}`,
        ...agentShared,
        support: mergeSupportContext(agentShared.support, materialContexts(groupMaterials)),
        artifacts: buildSynthesisArtifacts(layer, group),
        intent: {
          goal: buildSynthesisPrompt(config, groupMaterials.length, layer, group),
          acceptance_criteria: [
            "The synthesis preserves all major findings from its input research reports.",
            "The synthesis collapses redundant claims without dropping provenance, uncertainty, or conflicts."
          ],
          constraints: config.intent.constraints
        }
      };
    });

    synthesisLayers.push({
      type: "parallel",
      id: workflowNodeId(config.id, `synthesis_layer_${zeroPad(layer)}`),
      label: `Research Synthesis Layer ${zeroPad(layer)}`,
      max_concurrency: synthesisNodes.length,
      steps: synthesisNodes
    });

    materials = synthesisNodes.map((node, index) => {
      const suffix = `${zeroPad(layer)}_${zeroPad(index + 1)}`;

      return {
        nodeId: node.id,
        reportArtifact: `synthesis_report_${suffix}`,
        contextPrefix: `synthesis_${suffix}`,
        what: `Synthesis report ${suffix} from the managed deep research workflow.`,
        why: "The final summary uses synthesis evidence to resolve conflicts and preserve major findings."
      };
    });
    layer += 1;
  }

  const hasSynthesis = materials !== angleMaterials;
  const finalEvidenceMaterials = hasSynthesis ? [...angleMaterials, ...materials] : angleMaterials;

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Deep Research Workflow",
    steps: [
      fanout,
      ...synthesisLayers,
      {
        type: "agent",
        id: config.id,
        ...(config.label ? { label: config.label } : { label: "Publish Deep Research" }),
        ...agentShared,
        support: mergeSupportContext(
          agentShared.support,
          materialContexts(finalEvidenceMaterials)
        ),
        artifacts: publicArtifacts,
        intent: {
          goal: buildFinalPrompt(config, publicArtifacts, materials.length),
          acceptance_criteria: config.intent.acceptance_criteria,
          constraints: config.intent.constraints
        }
      }
    ]
  };
}
