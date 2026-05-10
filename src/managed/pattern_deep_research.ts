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
  defaultManagedPublicArtifacts,
  managedId,
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
  as_artifact?: boolean;
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
    `- ${name}: ${artifact.from}:${artifact.path}`,
    `  ${artifact.description}`
  ]);
}

interface ResearchMaterial {
  nodeId: string;
  reportArtifact: string;
  packetArtifact: string;
  contextPrefix: string;
}

function materialContexts(materials: ResearchMaterial[]): ContextItem[] {
  return materials.flatMap((material) => [
    artifactContext(`${material.contextPrefix}_report`, material.nodeId, material.reportArtifact),
    artifactContext(`${material.contextPrefix}_packet`, material.nodeId, material.packetArtifact)
  ]);
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

function formatAngleLabel(angle: PatternDeepResearchAngle): string {
  return angle.as_artifact
    ? `${angle.id}: ${angle.prompt} (exposed raw angle artifact)`
    : `${angle.id}: ${angle.prompt}`;
}

function buildAnglePrompt(config: PatternDeepResearchConfig, angle: PatternDeepResearchAngle, index: number): string {
  return renderPrompt([
    body("You are a research angle worker investigating one assigned angle for a larger managed research workflow. Your private report will be synthesized later, so gather useful evidence and preserve uncertainty clearly."),
    section("Final Managed Workflow Contract", [
      "This is a private helper node inside a managed workflow. The final managed node owns the public artifact shape and final acceptance criteria below.",
      "Use this contract to understand what your evidence must support, but do not format this private angle report as the final public artifact unless the private output contract below says so.",
      `Goal: ${config.intent.goal}`,
      ...formatList("Final acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...formatList("Constraints", config.intent.constraints, "Stay inside the authored graph contract.")
    ]),
    section("Assigned Angle", [
      `Angle id: ${angle.id}`,
      angle.prompt,
      "Stay focused on this angle. Do not duplicate the other angle workers unless overlap is needed to explain a conflict."
    ]),
    ...(angle.as_artifact
      ? [
          section("Exposed Raw Angle Report", [
            `This angle's Markdown report will be exposed as public artifact \`${angle.id}\` after the whole managed research node passes.`,
            "Write the report as raw angle evidence. It will not be rewritten by the final publisher."
          ])
        ]
      : []),
    section("Research Method", [
      "Use local repository files, provided context, available local CLIs, docs, or web research, whichever best serves this angle.",
      "Prefer authoritative local/source evidence when the question is repo-specific.",
      "Use external or web context when docs, package behavior, standards, release notes, or broader comparisons would materially improve the answer.",
      "Preserve source paths, commands, URLs, and uncertainty so final synthesis can audit the claim.",
      "Do not change graph intent, node intent, repo authority, sandbox, or declared artifacts."
    ]),
    section("Output Contract", [
      "Write `angle-report.md` and `packet.json` to the output directory.",
      "These are private research artifacts for synthesis, not the final public handoff.",
      "The report should be readable by a human researcher and focused on the assigned angle.",
      "The packet must be JSON with `angle`, `findings`, `evidence`, `sources`, `conflicts`, `uncertainty`, and `confidence` fields."
    ]),
    section("Quality Bar", [
      "Do not produce a shallow summary. Produce the most useful evidence-backed answer for this angle.",
      "Mark uncertainty instead of guessing. Include minority or conflicting evidence when it matters."
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
    body(`You are a research synthesis worker combining ${inputCount} research packets into one higher-signal research packet.`),
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
      "Do not discard a unique major finding just because it appears in only one packet."
    ]),
    section("Output Contract", [
      `Write \`synthesis-${zeroPad(layer)}-${zeroPad(group)}.md\` and \`synthesis-${zeroPad(layer)}-${zeroPad(group)}.json\` to the output directory.`,
      "These are private synthesis artifacts for the final publisher, not the final public handoff.",
      "The JSON packet must include `findings`, `evidence`, `sources`, `conflicts`, `uncertainty`, `confidence`, and `collapsed_duplicates`."
    ])
  ]);
}

function buildFinalPrompt(
  config: PatternDeepResearchConfig,
  publicArtifacts: Record<string, ArtifactDefinition>,
  inputCount: number
): string {
  const exposedAngleArtifacts = config.research.angles.filter((angle) => angle.as_artifact);
  return renderPrompt([
    body(`You are the final research publisher for a managed deep research result from ${inputCount} research packet${inputCount === 1 ? "" : "s"}. Create a complete answer that downstream work can use without inspecting private helper reports.`),
    section("Managed Workflow Contract", [
      "This final publisher owns the managed workflow's public artifact contract. Internal helper reports are only evidence.",
      `Goal: ${config.intent.goal}`,
      ...formatList("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...formatList("Constraints", config.intent.constraints, "Stay inside the authored graph contract.")
    ]),
    section("Research Angles", config.research.angles.map((angle) => `- ${formatAngleLabel(angle)}`)),
    section("Current Context", [
      "Use the research reports and packets in context as authority.",
      "Resolve disagreements explicitly. Preserve uncertainty and cite the evidence behind important claims.",
      "Collapse redundancy, but keep all major findings and the strongest provenance for each claim."
    ]),
    ...(exposedAngleArtifacts.length > 0
      ? [
          section("Exposed Raw Angle Artifacts", exposedAngleArtifacts.map((angle) =>
            `- ${angle.id}: runtime forwards the raw Markdown report for angle \`${angle.id}\`; do not rewrite it.`
          ))
        ]
      : []),
    section("Public Artifact Contract", [
      "Write exactly the declared public artifacts.",
      ...formatArtifactContract(publicArtifacts),
      "Honor each artifact description literally, including any required field labels or handoff sections.",
      "The `packet` artifact must include answer, findings, evidence, sources, uncertainties, confidence, recommended next actions, and an angle index with each angle id, exposed raw artifact when selected, source refs, confidence, conflicts, and private evidence paths."
    ]),
    section("Quality Bar", [
      "The final package should be useful for a downstream design, implementation, review, or decision node without making the reader inspect private internal artifacts.",
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
    },
    [`angle_packet_${suffix}`]: {
      from: "output_dir",
      path: "packet.json",
      description: `Structured findings, evidence, sources, conflicts, and uncertainty for research angle ${suffix}.`
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
    },
    [`synthesis_packet_${suffix}`]: {
      from: "output_dir",
      path: `synthesis-${zeroPad(layer)}-${zeroPad(group)}.json`,
      description: `Structured synthesis packet for research layer ${zeroPad(layer)} group ${zeroPad(group)}.`
    }
  };
}

function buildPublicArtifacts(angles: PatternDeepResearchAngle[]): Record<string, ArtifactDefinition> {
  const artifacts = defaultManagedPublicArtifacts();

  for (const angle of angles) {
    if (!angle.as_artifact) {
      continue;
    }
    artifacts[angle.id] = {
      from: "output_dir",
      path: `angles/${angle.id}.md`,
      description: `Raw Markdown report for deep research angle "${angle.id}".`
    };
  }

  return artifacts;
}

function buildManagedArtifactForwards(
  rootId: string,
  angles: PatternDeepResearchAngle[]
): AgentNode["managed_artifact_forwards"] {
  const forwards: NonNullable<AgentNode["managed_artifact_forwards"]> = {};

  angles.forEach((angle, index) => {
    if (!angle.as_artifact) {
      return;
    }
    const suffix = zeroPad(index + 1);
    forwards[angle.id] = {
      node: workflowNodeId(rootId, `angle_${suffix}`),
      artifact: `angle_report_${suffix}`
    };
  });

  return Object.keys(forwards).length > 0 ? forwards : undefined;
}

export function buildPatternDeepResearch(config: PatternDeepResearchConfig): SequenceNode {
  const workflowId = workflowNodeId(config.id, "workflow");
  const fanoutId = workflowNodeId(config.id, "angle_fanout");
  const publicArtifacts = buildPublicArtifacts(config.research.angles);
  const managedArtifactForwards = buildManagedArtifactForwards(config.id, config.research.angles);
  const agentShared = sharedAgentBase(config);

  const angleNodes: AgentNode[] = config.research.angles.map((angle, index) => {
    const suffix = zeroPad(index + 1);

    return {
      type: "agent",
      id: workflowNodeId(config.id, `angle_${suffix}`),
      label: `Research Angle ${suffix}`,
      ...agentShared,
      ...(config.context ? { context: config.context } : {}),
      artifacts: buildAngleArtifacts(index),
      intent: {
        goal: buildAnglePrompt(config, angle, index),
        acceptance_criteria: [
          "The angle report answers the assigned angle with sourced evidence.",
          "The packet preserves enough provenance, uncertainty, and confidence for final synthesis."
        ],
        constraints: config.intent.constraints
      }
    };
  });

  let materials: ResearchMaterial[] = config.research.angles.map((_, index) => {
    const suffix = zeroPad(index + 1);

    return {
      nodeId: workflowNodeId(config.id, `angle_${suffix}`),
      reportArtifact: `angle_report_${suffix}`,
      packetArtifact: `angle_packet_${suffix}`,
      contextPrefix: `angle_${suffix}`
    };
  });

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
        context: materialContexts(groupMaterials),
        artifacts: buildSynthesisArtifacts(layer, group),
        intent: {
          goal: buildSynthesisPrompt(config, groupMaterials.length, layer, group),
          acceptance_criteria: [
            "The synthesis preserves all major findings from its input research packets.",
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
        packetArtifact: `synthesis_packet_${suffix}`,
        contextPrefix: `synthesis_${suffix}`
      };
    });
    layer += 1;
  }

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
        context: materialContexts(materials),
        artifacts: publicArtifacts,
        ...(managedArtifactForwards ? { managed_artifact_forwards: managedArtifactForwards } : {}),
        intent: {
          goal: buildFinalPrompt(config, publicArtifacts, materials.length),
          acceptance_criteria: config.intent.acceptance_criteria,
          constraints: config.intent.constraints
        }
      }
    ]
  };
}
