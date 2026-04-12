# Graph Examples

These example graphs are committed and safe to reference from the docs.

They live under `docs/examples/graphs/`, so the example repo path for the Agentflow repository itself is:

```json
{
  "repos": {
    "main": {
      "path": "../../.."
    }
  }
}
```

Included examples:

- `fake-plan.json`
  Small read-only graph using primitive `agent` and deterministic `check` nodes.
- `feature-showcase.json`
  Broader primitive-graph example covering profiles, `parallel`, `repeat`, deterministic checks, AI checks, and context flow.
- `pattern-deep-research-showcase.json`
  Managed pattern example showing `pattern_deep_research` plus a downstream handoff.
- `pattern-spec-design-showcase.json`
  Managed pattern example showing `pattern_spec_design` plus a downstream handoff.
- `pattern-generate-evaluate-fix-showcase.json`
  Managed pattern example showing the `pattern_spec_design -> pattern_generate_evaluate_fix` path with the narrow generate/evaluate/fix contract.
- `pattern-review-change-showcase.json`
  Managed pattern example showing the `pattern_generate_evaluate_fix -> pattern_review_change` path with structured review packets and calibrated findings.

Run any example from the repository root with:

```bash
agentflow validate --graph docs/examples/graphs/feature-showcase.json
agentflow compile --graph docs/examples/graphs/feature-showcase.json
agentflow run --graph docs/examples/graphs/feature-showcase.json
```
