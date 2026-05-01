export interface OutcomeVerificationPromptArtifactSnippet {
  name: string;
  description: string;
  path: string;
  content?: string;
  truncated?: boolean;
  byte_count?: number;
  read_error?: string;
}

export interface OutcomeVerificationPromptDecisionLogEntry {
  decision: string;
  rationale: string;
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

  if (snippet.read_error) {
    lines.push("", `Read error: ${snippet.read_error}`);
    return lines;
  }

  lines.push("", "```", snippet.content ?? "", "```");
  if (snippet.truncated) {
    lines.push("This artifact was truncated for the verifier prompt. Read the full file from the path above before judging.");
  }

  return lines;
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
    "Use declared artifacts, decision logs, and deterministic command/tool evidence as the primary supervision surface.",
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
    "## Decision Log",
    "Decision log entries are node-authored records of major decisions, rationale, and supporting evidence.",
    "Use them to understand intentional scope choices and to cross-check final artifacts. Missing or sparse decision logs should usually be a warning, not a blocker, unless the node contract specifically required the missing decision evidence."
  ];

  if (entries.length === 0) {
    lines.push("", "(no decision log entries captured)");
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

  if (evidence.stdout_path) {
    lines.push(`- stdout log: ${evidence.stdout_path}`);
  }
  if (evidence.stderr_path) {
    lines.push(`- stderr log: ${evidence.stderr_path}`);
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
    lines.push("This execution excerpt was truncated. Read the full log paths above before judging a point that depends on omitted command output.");
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
    "You are an external Agentflow outcome verifier. You did not write this code.",
    "Audit the agent's just-finished work against the graph goal, the node's authored intent, the declared artifacts, and the decision log.",
    "You must respond with a single fenced JSON object that follows the schema below. No prose outside the fence.",
    "",
    "## Decision Rule",
    "- Pass when the declared artifacts, final response, decision log, and available deterministic evidence reasonably satisfy the authored acceptance criteria.",
    "- Treat graph and node acceptance criteria as authoritative over any task text that describes an intentionally failing fallback, blocker report, or retry trigger.",
    "- A final response explicitly marked as an intentional failure, retry request, missing-context fallback, or not-done state is blocker evidence unless the acceptance criteria explicitly say that terminal fallback is acceptable.",
    "- A required declared artifact that is empty, placeholder-only, missing the requested content, or inconsistent with the final response is blocker evidence even when the final response claims success.",
    "- The Declared Artifacts section below is authoritative for artifact presence. If a declared artifact snippet has a path, size/content, and no read error, treat that artifact as present; do not claim it is missing because a separate file search, transcript, or directory listing appears incomplete.",
    "- Only fail for a missing declared artifact when the artifact is absent from the Declared Artifacts section, has a read error, or the inlined content proves the artifact does not satisfy the authored artifact contract.",
    "- If an artifact is truncated in this prompt, read the full artifact path before making a blocker judgment that depends on omitted content.",
    "- Set passed=false only when there is strong, concrete, actionable blocker evidence that the node violated the graph or node contract.",
    "- Ambiguous, incomplete, or lower-confidence evidence should become a non-blocker finding unless it directly contradicts a required contract point.",
    "- Prefer investigative recommendations over restating blockers. Tell the retrying agent what evidence to gather, what command/tool/doc to inspect, and what validation would prove recovery.",
    "- Distinguish an ambiguous configuration mismatch from an irreducible external blocker. For example, a first 404 or unavailable model id should usually recommend discovering available compatible ids, validating one in the target environment, updating the configuration/artifacts, and rerunning smoke checks. Reserve external-blocker language for missing credentials, forbidden approval, unavailable required inputs, or failures the node cannot investigate with its tools.",
    "- Workspace diff evidence is supporting audit evidence, not the default source of truth. Do not use it as the sole reason for passed=false unless it is the only authoritative evidence for the node's required change and shows a concrete violation.",
    "- Captured execution evidence is the primary source for commands the agent actually ran. Do not turn a verifier-side command rerun failure into a blocker when the captured node transcript already shows the required command succeeded.",
    "- One blocker finding means passed=false; passed=true may still include low, medium, or high non-blocker findings.",
    "- Cite exact artifact paths, decision log entries, commands, or response excerpts in evidence so the retrying agent can act without re-discovering the failure.",
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
    `Authored id: ${input.node_authored_id}`,
    `Compiled id: ${input.node_compiled_id}`,
    `Execution id: ${input.attempt.execution_id} (attempt ${input.attempt.attempt_index}${
      input.attempt.iteration_index !== undefined ? `, iteration ${input.attempt.iteration_index}` : ""
    })`,
    "",
    `Goal: ${input.node_goal.length > 0 ? input.node_goal : "(no node goal authored)"}`,
    "",
    "Acceptance criteria:",
    ...bullets(input.node_acceptance_criteria, "No node-level acceptance criteria were authored."),
    "",
    "Constraints:",
    ...bullets(input.node_constraints, "No node-level constraints were authored."),
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
