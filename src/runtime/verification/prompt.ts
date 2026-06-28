export interface OutcomeVerificationPromptArtifactSnippet {
  name: string;
  description: string;
  path: string;
  content?: string;
  truncated?: boolean;
  byte_count?: number;
  content_type?: string;
  detected_content_type?: string;
  declared_content_type?: string;
  media_kind?: string;
  encoding?: string;
  sha256?: string;
  preview?: Record<string, unknown>;
  read_error?: string;
}

export interface OutcomeVerificationPromptDecisionLogEntry {
  decision: string;
  rationale: string;
  contract_implication?: string;
  evidence: string[];
  created_at?: string;
  log_id?: string;
}

export interface OutcomeVerificationPromptExecutionEvidence {
  stdout_path?: string;
  stderr_path?: string;
  excerpt?: string;
  truncated?: boolean;
  read_error?: string;
}

export interface OutcomeVerificationPromptCompletionPacket {
  completion_status: "ready_for_verification" | "incomplete" | "blocked";
  ready_for_verification: boolean;
  authority_requests?: Array<{
    kind: string;
    source: string;
    summary: string;
  }>;
  blocking_reasons: string[];
  missing_artifacts: string[];
  declared_artifacts?: Array<{
    name: string;
    status: string;
    current_attempt: boolean;
    size_bytes?: number;
    content_type?: string;
    detected_content_type?: string;
    media_kind?: string;
    encoding?: string;
    sha256?: string;
    preview?: Record<string, unknown>;
  }>;
  artifact_findings?: Array<{
    artifact: string;
    kind: string;
    summary: string;
  }>;
  orientation?: {
    orient_called: boolean;
    orient_call_count?: number;
    first_orient_at?: string;
    last_orient_at?: string;
    modes_seen?: string[];
  };
  milestones?: {
    total: number;
    active: number;
    completed: number;
    blocked: number;
    validation_logs: number;
    milestones: Array<{
      id: string;
      title: string;
      status: string;
      completion_evidence?: string;
      blocked_on?: string;
      logs: Array<{
        kind: string;
        summary: string;
        command?: string;
        result?: string;
        evidence?: string;
      }>;
    }>;
  };
  packet_path: string;
}

export interface OutcomeVerificationPromptInput {
  graph_goal: string;
  graph_acceptance_criteria: string[];
  graph_constraints: string[];
  node_authored_id: string;
  node_compiled_id: string;
  node_goal: string;
  node_acceptance_criteria: string[];
  node_constraints: string[];
  agent_response_snippet: OutcomeVerificationPromptArtifactSnippet;
  declared_artifact_snippets: OutcomeVerificationPromptArtifactSnippet[];
  decision_log_entries: OutcomeVerificationPromptDecisionLogEntry[];
  execution_evidence?: OutcomeVerificationPromptExecutionEvidence;
  workspace_diff_snippet?: {
    status: "captured" | "degraded" | "absent";
    changed_file_count: number;
    diff_path?: string;
    status_path?: string;
    changed_files_path?: string;
    diff_excerpt?: string;
    diff_truncated?: boolean;
    capture_error?: string;
  };
  completion_packet?: OutcomeVerificationPromptCompletionPacket;
  workspace_path: string;
  attempt: {
    execution_id: string;
    attempt_index: number;
    iteration_index?: number;
  };
}

const truncationMarker = "\n... [truncated for verifier prompt] ...\n";
const exampleResponse = `\`\`\`json
{
  "passed": false,
  "summary": "Agent claims success but the new function returns the wrong value for negative inputs.",
  "findings": [
    {
      "severity": "blocker",
      "category": "incorrect_output",
      "evidence": "agent-response.md says \\"returns 0 for negative inputs\\" but the implementation returns -1.",
      "recommendation": "Update the implementation so the function returns 0 for any negative input and add a regression test."
    }
  ]
}
\`\`\``;

function bullets(values: string[], emptyText: string): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : [`- ${emptyText}`];
}

function renderArtifactSnippet(snippet: OutcomeVerificationPromptArtifactSnippet): string[] {
  const header = `### \`${snippet.name}\`${snippet.truncated ? " (truncated)" : ""}`;
  const lines: string[] = [
    header,
    `Path: ${snippet.path}`,
    snippet.description.length > 0 ? `Purpose: ${snippet.description}` : "Purpose: (no description authored)"
  ];

  if (snippet.byte_count !== undefined) {
    lines.push(`Size: ${snippet.byte_count} bytes`);
  }
  if (snippet.content_type) {
    lines.push(`Content type: ${snippet.content_type}`);
  }
  if (snippet.detected_content_type) {
    lines.push(`Detected content type: ${snippet.detected_content_type}`);
  }
  if (snippet.media_kind) {
    lines.push(`Media kind: ${snippet.media_kind}`);
  }
  if (snippet.encoding) {
    lines.push(`Encoding: ${snippet.encoding}`);
  }
  if (snippet.sha256) {
    lines.push(`SHA-256: ${snippet.sha256}`);
  }
  if (snippet.preview) {
    lines.push(`Preview: ${renderArtifactPreview(snippet.preview)}`);
  }

  if (snippet.read_error) {
    lines.push("", `Read error: ${snippet.read_error}`);
    return lines;
  }

  if (snippet.encoding === "binary") {
    lines.push("", "This non-text artifact is not inlined. Judge it from the metadata, path, and worker-provided validation or milestone evidence.");
    return lines;
  }

  lines.push("", "```", snippet.content ?? "", "```");
  if (snippet.truncated) {
    lines.push("This artifact was truncated for the verifier prompt. Read the full file from the path above before judging.");
  }

  return lines;
}

function renderArtifactPreview(preview: Record<string, unknown>): string {
  const kind = typeof preview.kind === "string" ? preview.kind : "unknown";
  const details = Object.entries(preview)
    .filter(([key]) => key !== "kind")
    .map(([key, value]) => `${key}=${String(value)}`);
  return [kind, ...details].join("; ");
}

function renderWorkspaceDiff(snippet: OutcomeVerificationPromptInput["workspace_diff_snippet"]): string[] {
  if (!snippet) {
    return [
      "## Workspace Diff",
      "No per-node workspace diff was captured for this attempt. Treat this as missing audit evidence, not an automatic blocker."
    ];
  }

  const lines: string[] = [
    "## Workspace Diff",
    "Workspace diffs are audit/provenance evidence. They are not the primary pass/fail oracle.",
    "This diff is captured against the node-start baseline. Preexisting dirty workspace files are not node-local mutations and must not be treated as this node's contamination.",
    "Use declared artifacts, milestone decision/validation logs, and deterministic command/tool evidence as the primary supervision surface.",
    "Do not fail solely because the workspace diff is absent, degraded, ambiguous, or surprising. Fail on workspace evidence only when it provides strong, concrete, actionable proof of a contract violation and no stronger declared evidence resolves the contradiction.",
    `- Status: ${snippet.status}`,
    `- Changed file count: ${snippet.changed_file_count}`
  ];

  if (snippet.diff_path) {
    lines.push(`- Diff patch: ${snippet.diff_path}`);
  }
  if (snippet.status_path) {
    lines.push(`- Status text: ${snippet.status_path}`);
  }
  if (snippet.changed_files_path) {
    lines.push(`- Changed files JSON: ${snippet.changed_files_path}`);
  }
  if (snippet.capture_error) {
    lines.push(`- Capture error: ${snippet.capture_error}`);
  }

  lines.push("", "Diff excerpt: (not inlined by default; read the patch path above only when it is needed to investigate a concrete contradiction.)");

  return lines;
}

function renderDecisionLog(entries: OutcomeVerificationPromptDecisionLogEntry[]): string[] {
  const lines = [
    "## Runtime Decision Evidence",
    "Runtime decision entries are node-authored records of major decisions, rationale, and supporting evidence.",
    "Use them to understand intentional scope choices and to cross-check final artifacts. Missing or sparse decision evidence should usually be a warning, not a blocker, unless the node contract specifically required it."
  ];

  if (entries.length === 0) {
    lines.push("", "(no runtime decision entries captured)");
    return lines;
  }

  for (const entry of entries) {
    lines.push("");
    lines.push(`### ${entry.decision}`);
    if (entry.created_at || entry.log_id) {
      lines.push([
        entry.created_at ? `created_at: ${entry.created_at}` : undefined,
        entry.log_id ? `log_id: ${entry.log_id}` : undefined
      ].filter(Boolean).join(" | "));
    }
    lines.push(`Rationale: ${entry.rationale}`);
    if (entry.contract_implication) {
      lines.push(`Contract implication: ${entry.contract_implication}`);
    }
    lines.push("Evidence:");
    for (const evidence of entry.evidence) {
      lines.push(`- ${evidence}`);
    }
  }

  return lines;
}

function renderExecutionEvidence(evidence: OutcomeVerificationPromptExecutionEvidence | undefined): string[] {
  const lines = [
    "## Captured Execution Evidence",
    "Captured command transcript is deterministic evidence from the completed node attempt. Prefer it over rerunning commands from this read-only audit sandbox.",
    "Rerun a command only when captured evidence is absent, contradictory, or too incomplete to judge. If a verifier-side rerun is blocked by sandbox or temp-file permissions, treat that as verifier-environment evidence, not as a node failure by itself."
  ];

  if (!evidence) {
    lines.push("", "(no execution transcript captured)");
    return lines;
  }

  if (evidence.read_error) {
    lines.push(`- Read error: ${evidence.read_error}`);
  }

  if (!evidence.excerpt || evidence.excerpt.trim().length === 0) {
    lines.push("", "(no compact command excerpt available)");
    return lines;
  }

  lines.push("", "```", evidence.excerpt.trimEnd(), "```");
  if (evidence.truncated) {
    lines.push("This execution excerpt was truncated. Treat omitted command output as unavailable unless another structured evidence summary proves it.");
  }

  return lines;
}

function renderCompletionPacket(packet: OutcomeVerificationPromptCompletionPacket | undefined): string[] {
  const lines = [
    "## Completion Packet",
    "Runtime mechanical completion facts are primary structured evidence. Do not pass an incomplete packet; judge semantic correctness only when the packet is ready for verification.",
  ];

  if (!packet) {
    lines.push("", "(no completion packet was provided)");
    return lines;
  }

  lines.push(
    `- Status: ${packet.completion_status}`,
    `- Ready for verification: ${packet.ready_for_verification}`,
    `- Packet: ${packet.packet_path}`
  );

  if (packet.orientation) {
    lines.push(`- af orient called: ${packet.orientation.orient_called}`);
    if (packet.orientation.orient_call_count !== undefined) {
      lines.push(`- af orient calls: ${packet.orientation.orient_call_count}`);
    }
    if (packet.orientation.modes_seen && packet.orientation.modes_seen.length > 0) {
      lines.push(`- af orient modes: ${packet.orientation.modes_seen.join(", ")}`);
    }
    if (packet.orientation.first_orient_at || packet.orientation.last_orient_at) {
      lines.push(`- af orient timing: first=${packet.orientation.first_orient_at ?? "unknown"}; last=${packet.orientation.last_orient_at ?? "unknown"}`);
    }
  }

  if (packet.milestones) {
    lines.push(
      `- Milestones: total=${packet.milestones.total}; completed=${packet.milestones.completed}; active=${packet.milestones.active}; blocked=${packet.milestones.blocked}; validation_logs=${packet.milestones.validation_logs}`
    );
    for (const milestone of packet.milestones.milestones) {
      lines.push(`  - ${milestone.id} [${milestone.status}] ${milestone.title}`);
      if (milestone.completion_evidence) {
        lines.push(`    - completion evidence: ${milestone.completion_evidence}`);
      }
      if (milestone.blocked_on) {
        lines.push(`    - blocked on: ${milestone.blocked_on}`);
      }
      for (const log of milestone.logs) {
        lines.push(`    - ${log.kind}: ${log.summary}${log.command ? `; command=${log.command}` : ""}${log.result ? `; result=${log.result}` : ""}${log.evidence ? `; evidence=${log.evidence}` : ""}`);
      }
    }
  }

  if (packet.missing_artifacts.length > 0) {
    lines.push("- Missing artifacts:");
    for (const artifact of packet.missing_artifacts) {
      lines.push(`  - ${artifact}`);
    }
  }

  if (packet.declared_artifacts && packet.declared_artifacts.length > 0) {
    lines.push("- Declared artifact status:");
    for (const artifact of packet.declared_artifacts) {
      lines.push([
        `  - ${artifact.name}: ${artifact.status}`,
        `current_attempt=${artifact.current_attempt}`,
        ...(artifact.size_bytes !== undefined ? [`size=${artifact.size_bytes}`] : []),
        ...(artifact.content_type ? [`content_type=${artifact.content_type}`] : []),
        ...(artifact.media_kind ? [`media_kind=${artifact.media_kind}`] : []),
        ...(artifact.encoding ? [`encoding=${artifact.encoding}`] : [])
      ].join("; "));
    }
  }

  if (packet.artifact_findings && packet.artifact_findings.length > 0) {
    lines.push("- Artifact findings:");
    for (const finding of packet.artifact_findings) {
      lines.push(`  - ${finding.artifact}:${finding.kind}: ${finding.summary}`);
    }
  }

  if (packet.blocking_reasons.length > 0) {
    lines.push("- Blocking reasons:");
    for (const reason of packet.blocking_reasons) {
      lines.push(`  - ${reason}`);
    }
  }

  if (packet.authority_requests && packet.authority_requests.length > 0) {
    lines.push("- Authority requests:");
    for (const request of packet.authority_requests) {
      lines.push(`  - ${request.kind} from ${request.source}: ${request.summary}`);
    }
  }

  return lines;
}

export function truncateForPrompt(value: string, maxBytes: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { content: value, truncated: false };
  }

  const buffer = Buffer.from(value, "utf8");
  const sliced = buffer.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(truncationMarker, "utf8")));
  return {
    content: `${sliced.toString("utf8")}${truncationMarker}`,
    truncated: true
  };
}

export function renderOutcomeVerificationPrompt(input: OutcomeVerificationPromptInput): string {
  const lines: string[] = [
    "## Role",
    "You are an external outcome verifier. You did not write this code.",
    "Audit the agent's just-finished work against the graph goal, the node's authored intent, the declared artifacts, and the milestone evidence.",
    "You must respond with a single fenced JSON object that follows the schema below. No prose outside the fence.",
    "",
    "## Decision Rule",
    "### Mechanical Readiness",
    "- Treat the Completion Packet section as primary structured evidence for mechanical readiness.",
    "- Do not pass when completion_status is incomplete. Treat blocked as a terminal attempt state only when it includes a typed authority request from runtime; blocked is not node success.",
    "- Pass when the declared artifacts, final response, milestone evidence, and available deterministic evidence reasonably satisfy the authored acceptance criteria.",
    "- Treat graph and node acceptance criteria as authoritative over task text that describes an intentionally failing fallback, blocker report, or retry trigger.",
    "- A final response explicitly marked as an intentional failure, retry request, missing-context fallback, or not-done state is blocker evidence unless the acceptance criteria explicitly allow that terminal fallback.",
    "",
    "### Artifact Judgment",
    "- Declared artifact snippets are authoritative for artifact presence.",
    "- A required artifact that is empty, placeholder-only, missing requested content, or inconsistent with the final response is blocker evidence even when the final response claims success.",
    "- Only fail for a missing declared artifact when it is absent from the Declared Artifacts section, has a read error, or the visible content/metadata proves it does not satisfy the artifact contract.",
    "- Non-text artifacts are valid when they have a path, content type, byte size, hash, and no read error. Judge their meaning from metadata plus milestone/final-response validation evidence; do not fail only because binary bytes are not inlined.",
    "- For exact labels or literal phrase requirements, defer to ready Completion Packet artifact findings. Do not invent a missing-literal blocker when the packet reports the artifact present with no placeholder, forbidden-content, or missing-required-content finding and the inlined artifact text contains the literal.",
    "- If an artifact quotes an earlier incomplete `af complete check` result, treat that as stale embedded diagnostic text when the final Completion Packet is ready and has no matching artifact finding.",
    "- If an artifact is truncated, read the full artifact path before making a blocker judgment that depends on omitted content.",
    "",
    "### Evidence Precedence",
    "- Captured execution evidence is the primary source for commands the agent actually ran.",
    "- Do not turn a verifier-side command rerun failure into a blocker when the captured node transcript already shows the required command succeeded.",
    "- For command/tool output evidence, judge material observed values rather than line breaks, bullets, punctuation, or prose wrapping differences.",
    "",
    "### Workspace Diff",
    "- Workspace diff evidence is supporting audit evidence, not the default source of truth.",
    "- Do not use workspace diff as the sole reason for passed=false unless it is the only authoritative evidence for the node's required change and shows a concrete violation.",
    "",
    "### Blocker Standard",
    "- Set passed=false only when there is strong, concrete, actionable blocker evidence that the node violated the graph or node contract.",
    "- Ambiguous, incomplete, or lower-confidence evidence should become a non-blocker finding unless it directly contradicts a required contract point.",
    "- Prefer investigative recommendations over restating blockers. Tell the retrying agent what evidence to gather, what command/tool/doc to inspect, and what validation would prove recovery.",
    "- Distinguish an ambiguous configuration mismatch from an irreducible external blocker. Reserve external-blocker language for missing credentials, forbidden approval, unavailable required inputs, or failures the node cannot investigate with its tools.",
    "- One blocker finding means passed=false; passed=true may still include low, medium, or high non-blocker findings.",
    "- Cite exact artifact paths, milestone evidence, commands, or response excerpts in evidence so the retrying agent can act without re-discovering the failure.",
    "",
    "## Graph Intent",
    `Goal: ${input.graph_goal.length > 0 ? input.graph_goal : "(no graph goal authored)"}`,
    "",
    "Acceptance criteria:",
    ...bullets(input.graph_acceptance_criteria, "No graph-level acceptance criteria were authored."),
    "",
    "Constraints:",
    ...bullets(input.graph_constraints, "No graph-level constraints were authored."),
    "",
    "## Node Intent",
    `Node: ${input.node_authored_id}`,
    `Attempt: ${input.attempt.attempt_index}${
      input.attempt.iteration_index !== undefined ? `, iteration ${input.attempt.iteration_index}` : ""
    }`,
    "",
    `Goal: ${input.node_goal.length > 0 ? input.node_goal : "(no node intent goal authored)"}`,
    "",
    "Acceptance criteria:",
    ...bullets(input.node_acceptance_criteria, "No node intent acceptance criteria were authored."),
    "",
    "Constraints:",
    ...bullets(input.node_constraints, "No node-level constraints were authored."),
    "",
    ...renderCompletionPacket(input.completion_packet),
    "",
    "## Workspace",
    `Workspace path: ${input.workspace_path}`,
    "Sandbox: read-only. You may read any file under the workspace, but never modify it.",
    "",
    ...renderWorkspaceDiff(input.workspace_diff_snippet),
    "",
    ...renderExecutionEvidence(input.execution_evidence),
    "",
    ...renderDecisionLog(input.decision_log_entries),
    "",
    "## Agent Response",
    ...renderArtifactSnippet(input.agent_response_snippet),
    "",
    "## Declared Artifacts",
    ...(input.declared_artifact_snippets.length === 0
      ? ["(no declared artifacts for this node)"]
      : input.declared_artifact_snippets.flatMap((snippet) => [...renderArtifactSnippet(snippet), ""])),
    "## Output",
    "Respond with exactly one fenced ```json``` block matching this schema:",
    "{",
    '  "passed": boolean,',
    '  "summary": string,',
    '  "findings": [',
    "    {",
    '      "severity": "blocker" | "high" | "medium" | "low",',
    '      "category": string, // examples: "incorrect_output", "missing_validation", "ambiguous_configuration_mismatch", "irreducible_external_blocker"',
    '      "evidence": string,',
    '      "recommendation": string, // concrete next investigation/fix/validation steps for the retrying worker',
    '      "references": [string] // optional',
    "    }",
    "  ]",
    "}",
    "Do not include any other text. The fenced JSON block is the entire response.",
    "",
    "Example of a failing verdict:",
    exampleResponse
  ];

  return lines.join("\n");
}
