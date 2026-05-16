export function withNodeIntentDefaults<TDocument>(document: TDocument): TDocument {
  const clone = structuredClone(document) as TDocument;
  const graphDocument = clone && typeof clone === "object" && "graph" in (clone as Record<string, unknown>)
    ? clone as Record<string, unknown>
    : undefined;

  function visit(node: unknown): void {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    const record = node as Record<string, unknown>;
    const type = String(record.type ?? "");
    if (["agent", "exec", "check", "checkpoint", "pattern_deep_research", "pattern_deep_work", "pattern_work_list"].includes(type)) {
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

  if (graphDocument) {
    graphDocument.intent ??= {
      goal: "Run the test graph.",
      acceptance_criteria: ["The graph satisfies the current Agentflow contract."]
    };
    const profiles = graphDocument.profiles && typeof graphDocument.profiles === "object" && !Array.isArray(graphDocument.profiles)
      ? graphDocument.profiles as Record<string, unknown>
      : {};
    profiles.default ??= { harness: "codex-cli" };
    profiles.supervisor ??= { harness: "codex-cli", sandbox: "read-only" };
    graphDocument.profiles = profiles;

    const supervision = graphDocument.supervision && typeof graphDocument.supervision === "object" && !Array.isArray(graphDocument.supervision)
      ? graphDocument.supervision as Record<string, unknown>
      : {};
    supervision.profile ??= "supervisor";
    supervision.max_total_interventions ??= 3;
    graphDocument.supervision = supervision;
    visit(graphDocument.graph);
  }

  return clone;
}
