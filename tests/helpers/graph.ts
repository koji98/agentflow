import type { AuthoredGraphDocument } from "../../src/graph/authored.js";

export function withNodeIntentDefaults<TDocument extends AuthoredGraphDocument | Parameters<typeof import("../../src/graph/normalize.js").normalizeAuthoredGraphDocument>[0]>(
  document: TDocument
): TDocument {
  const clone = structuredClone(document) as TDocument;

  function visit(node: unknown): void {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    const record = node as Record<string, unknown>;
    const type = String(record.type ?? "");
    if (["agent", "exec", "check", "checkpoint", "pattern_deep_research", "pattern_deep_work"].includes(type)) {
      record.goal ??= `Complete node ${String(record.id ?? "unknown")} according to its runtime contract.`;
      record.acceptance_criteria ??= [
        `Node ${String(record.id ?? "unknown")} satisfies its declared runtime behavior and artifact contract.`
      ];
      record.constraints ??= [];
    }
    if (Array.isArray(record.steps)) {
      record.steps.forEach(visit);
    }
    if (Array.isArray(record.cleanup)) {
      record.cleanup.forEach(visit);
    }
    if (record.body) {
      visit(record.body);
    }
  }

  if (clone && typeof clone === "object" && "graph" in (clone as Record<string, unknown>)) {
    visit((clone as Record<string, unknown>).graph);
  }
  return clone;
}
