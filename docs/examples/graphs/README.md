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
- `deep-research-showcase.json`
  Managed workflow example showing `deep_research` plus a downstream handoff.
- `spec-design-showcase.json`
  Managed workflow example showing `spec_design` plus a downstream handoff.
- `execute-spec-showcase.json`
  Managed workflow example showing the `spec_design -> execute_spec` path.
- `review-change-showcase.json`
  Managed workflow example showing the `execute_spec -> review_change` path.

Run any example from the repository root with:

```bash
agentflow validate --graph docs/examples/graphs/feature-showcase.json
agentflow compile --graph docs/examples/graphs/feature-showcase.json
agentflow run --graph docs/examples/graphs/feature-showcase.json
```
