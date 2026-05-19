import { readFile } from "node:fs/promises";

import { getHarnessCapabilities } from "../../src/graph/harness_capabilities.js";
import type { DeliverySourcePacket } from "../../src/runtime/delivery/curation.js";
import type { HarnessAdapter, HarnessResult } from "../../src/runtime/harness/types.js";

function markdownList(items: string[], empty: string): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${empty}`];
}

function evidenceLink(source: DeliverySourcePacket, key: string, fallback: string): string {
  return source.evidence_links[key] ?? fallback;
}

function renderCuratedDelivery(source: DeliverySourcePacket): string {
  const artifactLines = source.final_declared_artifacts.length > 0
    ? source.final_declared_artifacts.map((artifact) =>
        `- \`${artifact.id}\`: [${artifact.declared_path}](${artifact.relative_path})`
      )
    : ["- No final declared artifacts were captured."];
  const changedLines = source.changed_files.length > 0
    ? source.changed_files.flatMap((change) => [
        `- ${change.repo}:`,
        ...change.files.map((file) => `  - \`${file}\``)
      ])
    : [`- [Change map](${evidenceLink(source, "change_map", "evidence/change-map.json")}) recorded no workspace changes.`];
  const validationLines = [
    ...source.validation.milestone_validation_logs.map((log) =>
      `- \`${log.milestone_id}\`: ${log.command ? `\`${log.command}\` ` : ""}${log.result ?? "recorded"} - ${log.summary}`
    ),
    ...source.validation.outcome_verifications.map((entry) =>
      `- \`${entry.node}\`: ${entry.passed ? "pass" : "fail"} - ${entry.summary}`
    )
  ];
  const learningRows = source.workspace_improvements.length > 0
    ? source.workspace_improvements.map((entry) =>
        `| ${entry.area} | ${entry.recommendation} | ${entry.evidence} | ${entry.priority} | ${entry.confidence} | ${entry.done_when} |`
      )
    : ["| none | No action. | source packet | low | medium | No action required. |"];

  return [
    "```review-brief",
    "# Review Brief",
    "## Outcome",
    `Run \`${source.run.run_id}\` ended with status \`${source.run.status}\`.`,
    "## Reviewer Decision",
    source.failures.active.length > 0
      ? "Do not approve until active failures are addressed."
      : "Review the changed files, final artifacts, and validation evidence.",
    "## What To Inspect First",
    `- [Change map](${evidenceLink(source, "change_map", "evidence/change-map.json")})`,
    `- [Validation ledger](${evidenceLink(source, "validation_ledger", "evidence/validation-ledger.json")})`,
    "## Success Contract",
    source.intent.goal,
    "## Changed Files",
    ...changedLines,
    "## Final Declared Artifacts",
    ...artifactLines,
    "## Validation Evidence",
    ...markdownList(validationLines, `See [validation ledger](${evidenceLink(source, "validation_ledger", "evidence/validation-ledger.json")}).`),
    "## Active Failures And Risks",
    ...markdownList(
      source.failures.active.map((failure) => `\`${failure.node}\`: ${failure.summary}`),
      "No active failures remain."
    ),
    "## Recovered Issues",
    ...markdownList(
      source.failures.recovered.map((failure) => `\`${failure.node}\`: ${failure.summary}`),
      "No recovered issues were recorded."
    ),
    "## Historical Attempts",
    ...markdownList(
      source.failures.historical.map((failure) => `\`${failure.node}\`: ${failure.summary}`),
      "No historical attempts require reviewer action."
    ),
    "## Supervisor And Human Interventions",
    ...markdownList(
      source.interventions.map((intervention) => `\`${intervention.action}\`: ${intervention.reason}`),
      "No supervisor or human interventions were recorded."
    ),
    "## Supporting Evidence",
    "- [Run learnings](02-run-learnings.md)",
    "- [Audit index](03-audit-index.md)",
    "```",
    "```run-learnings",
    "# Run Learnings",
    "## Where Agents Struggled",
    source.failures.active.length + source.failures.recovered.length > 0
      ? "- Inspect failure and recovery sections in the review brief for concrete struggle points."
      : "- No concrete agent struggle was inferred from this fixture.",
    "## Workspace Improvements",
    "| Area | Recommendation | Evidence | Priority | Confidence | Done When |",
    "| --- | --- | --- | --- | --- | --- |",
    ...learningRows,
    "## Graph Prompt And Support Improvements",
    "- No changes identified.",
    "## Plugin Skill And Eval Opportunities",
    "- No changes identified.",
    "## What Worked",
    "- Deterministic delivery source evidence was available for curation.",
    "## Evidence Links",
    `- [Milestones](${evidenceLink(source, "milestones", "evidence/milestones.json")})`,
    `- [Validation ledger](${evidenceLink(source, "validation_ledger", "evidence/validation-ledger.json")})`,
    "```"
  ].join("\n");
}

export function createPassingDeliveryHarness(kind: HarnessAdapter["kind"] = "codex-cli"): HarnessAdapter {
  return {
    kind,
    capabilities: getHarnessCapabilities(kind)!,
    async run(invocation): Promise<HarnessResult> {
      if (invocation.promptKind !== "delivery_curator") {
        throw new Error(`Unexpected prompt kind for delivery fixture harness: ${invocation.promptKind ?? "agent"}`);
      }
      const source = JSON.parse(await readFile(invocation.contextPacketPath, "utf8")) as DeliverySourcePacket;
      return {
        status: "passed",
        exitCode: 0,
        transcript: {
          last_message: renderCuratedDelivery(source)
        }
      };
    },
    async cancel() {
      return;
    }
  };
}
