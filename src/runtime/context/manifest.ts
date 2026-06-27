import type {
  ContextPacket,
  ContextPacketMaterializedItem,
  ContextPriorityBucket
} from "./packet.js";

const bucketOrder: ContextPriorityBucket[] = [
  "read_first",
  "current_work",
  "task_context",
  "progress_state",
  "reference_set"
];

function sourceKind(item: ContextPacketMaterializedItem): string {
  return "ref" in item.source ? "artifact" : item.source.from;
}

function sourceWhat(item: ContextPacketMaterializedItem): string {
  return "what" in item.source && typeof item.source.what === "string"
    ? item.source.what
    : item.description ?? "";
}

function sourceWhy(item: ContextPacketMaterializedItem): string {
  return "why" in item.source && typeof item.source.why === "string"
    ? item.source.why
    : "";
}

export function formatContextManifestPointerPath(pointerPath: string): string {
  const match = /[/\\]context[/\\]runtime[/\\](.+)$/u.exec(pointerPath);
  if (!match?.[1]) {
    return pointerPath;
  }
  return `runtime/${match[1].replace(/\\/gu, "/")}`;
}

function bucketFor(item: ContextPacketMaterializedItem): ContextPriorityBucket {
  return item.priority_bucket ?? "task_context";
}

function sortedMaterials(materials: ContextPacketMaterializedItem[]): ContextPacketMaterializedItem[] {
  return [...materials].sort((left, right) => {
    const bucketDelta = bucketOrder.indexOf(bucketFor(left)) - bucketOrder.indexOf(bucketFor(right));
    if (bucketDelta !== 0) {
      return bucketDelta;
    }
    return (left.priority_rank ?? 0) - (right.priority_rank ?? 0);
  });
}

function renderStandardTable(lines: string[], materials: ContextPacketMaterializedItem[]): void {
  lines.push("| Name | Kind | Pointer | What | Why |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const item of materials) {
    lines.push(`| \`${item.key}\` | \`${sourceKind(item)}\` | \`${formatContextManifestPointerPath(item.pointer_path)}\` | ${sourceWhat(item)} | ${sourceWhy(item)} |`);
  }
}

function renderCompactPointers(lines: string[], materials: ContextPacketMaterializedItem[]): void {
  lines.push("## Pointers", "");
  renderStandardTable(lines, sortedMaterials(materials));
  lines.push("");
}

function groupedMaterials(packet: ContextPacket): Map<ContextPriorityBucket, ContextPacketMaterializedItem[]> {
  const groups = new Map<ContextPriorityBucket, ContextPacketMaterializedItem[]>();
  for (const item of sortedMaterials(packet.materials)) {
    const bucket = bucketFor(item);
    groups.set(bucket, [...(groups.get(bucket) ?? []), item]);
  }
  return groups;
}

function renderReadFirst(lines: string[], materials: ContextPacketMaterializedItem[]): void {
  lines.push("## Read First", "", "Pointers that explain this attempt or define the immediate repair.", "");
  lines.push("| Name | Kind | Pointer | Why first |");
  lines.push("| --- | --- | --- | --- |");
  for (const item of materials) {
    lines.push(`| \`${item.key}\` | \`${sourceKind(item)}\` | \`${formatContextManifestPointerPath(item.pointer_path)}\` | ${item.priority_reason ?? sourceWhy(item) ?? sourceWhat(item)} |`);
  }
  lines.push("");
}

function renderCurrentWork(lines: string[], materials: ContextPacketMaterializedItem[]): void {
  lines.push("## Current Work", "", "Pointers that define the immediate unit of work.", "");
  renderStandardTable(lines, materials);
  lines.push("");
}

function renderTaskContext(lines: string[], materials: ContextPacketMaterializedItem[]): void {
  lines.push("## Task Context", "", "Authored context and direct artifacts/files for this task.", "");
  renderStandardTable(lines, materials);
  lines.push("");
}

function renderProgressState(lines: string[], materials: ContextPacketMaterializedItem[]): void {
  lines.push("## Progress State", "", "Runtime state for continuation.", "");
  renderStandardTable(lines, materials);
  lines.push("");
}

function renderReferenceSets(lines: string[], materials: ContextPacketMaterializedItem[]): void {
  lines.push(
    "## Reference Sets",
    "",
    "Broad file sets. Use these as indexes/search spaces; do not read every file linearly unless the task requires it.",
    ""
  );
  lines.push("| Name | Kind | Pointer | Matches | How to use |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const item of materials) {
    const matches = item.match_count !== undefined && item.included_count !== undefined
      ? `${item.included_count} of ${item.match_count}`
      : item.included_count !== undefined
        ? String(item.included_count)
        : "";
    lines.push(`| \`${item.key}\` | \`${sourceKind(item)}\` | \`${formatContextManifestPointerPath(item.pointer_path)}\` | ${matches} | ${sourceWhy(item) || item.priority_reason || "Search selectively when relevant."} |`);
  }
  lines.push("");
}

function shouldUseCompactManifest(packet: ContextPacket): boolean {
  if (packet.materials.length === 0) {
    return false;
  }
  const buckets = new Set(packet.materials.map(bucketFor));
  return buckets.size === 1 && buckets.has("task_context");
}

export function renderContextManifest(packet: ContextPacket): string {
  const lines = [
    "# Context Manifest",
    "",
    "Context entries are pointers. Agentflow does not copy or truncate source context into this prompt package.",
    ""
  ];

  if (packet.materials.length === 0) {
    lines.push("No context pointers were provided for this node.", "");
    return `${lines.join("\n")}\n`;
  }

  if (shouldUseCompactManifest(packet)) {
    renderCompactPointers(lines, packet.materials);
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "Open read-first pointers before broad search unless the task clearly requires discovery. Use reference sets as search spaces, not as linear reading lists.",
    ""
  );

  const groups = groupedMaterials(packet);
  for (const bucket of bucketOrder) {
    const materials = groups.get(bucket);
    if (!materials || materials.length === 0) {
      continue;
    }
    if (bucket === "read_first") {
      renderReadFirst(lines, materials);
    } else if (bucket === "current_work") {
      renderCurrentWork(lines, materials);
    } else if (bucket === "task_context") {
      renderTaskContext(lines, materials);
    } else if (bucket === "progress_state") {
      renderProgressState(lines, materials);
    } else {
      renderReferenceSets(lines, materials);
    }
  }

  return `${lines.join("\n")}\n`;
}
