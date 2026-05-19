# Delivery Review

At terminal state, review in this order:

1. `delivery/01-review-brief.md`
2. `delivery/02-run-learnings.md`
3. `delivery/03-audit-index.md` only when auditing or debugging
4. `delivery/manifest.json`
5. declared artifacts and evidence files named by the manifest
6. raw runtime files only for debug, audit, or resume

The review brief and run learnings are AI-curated from deterministic runtime evidence. The audit index maps raw evidence for deeper inspection. The manifest uses semantic keys for tools, automation, and exact provenance. Treat `delivery/evidence/delivery-source.json` and `delivery/evidence/curation-verdict.json` as the trust boundary: if curation failed, the graph may have reached terminal state, but the run is not review-ready.

Review questions:

- Does the review brief explain outcome, changed files, final artifacts, validation evidence, active risks, recovered issues, interventions, and review order?
- Do run learnings identify workspace, graph, prompt, skill, tool, or eval improvements with evidence?
- Do declared artifacts satisfy their descriptions?
- Does validation evidence support the claimed outcome?
- Did supervisor interventions change tactics or reveal missing context?
- Are active risks real unresolved work, while recovered issues are separated from current follow-ups?
- Does `delivery/evidence/curation-verdict.json` pass, with no invented files, commands, validation claims, or hidden active failures?
