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
      const intent = (record.intent && typeof record.intent === "object" && !Array.isArray(record.intent))
        ? record.intent as Record<string, unknown>
        : {};
      intent.goal ??= `Complete node ${String(record.id ?? "unknown")} according to its runtime contract.`;
      intent.acceptance_criteria ??= [
        `Node ${String(record.id ?? "unknown")} satisfies its declared runtime behavior and artifact contract.`
      ];
      intent.constraints ??= [];
      record.intent = intent;
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
    const document = clone as Record<string, unknown>;
    const profiles =
      document.profiles && typeof document.profiles === "object" && !Array.isArray(document.profiles)
        ? document.profiles as Record<string, unknown>
        : {};
    profiles.default ??= { harness: "codex-cli" };
    profiles.supervisor ??= { harness: "codex-cli", sandbox: "read-only" };
    document.profiles = profiles;
    document.supervision ??= { profile: "supervisor", max_total_interventions: 3 };
    if (
      document.supervision &&
      typeof document.supervision === "object" &&
      !Array.isArray(document.supervision) &&
      !("profile" in document.supervision)
    ) {
      (document.supervision as Record<string, unknown>).profile = "supervisor";
    }
    visit(document.graph);
  }
  return clone;
}
