# Graph Examples

These graphs demonstrate the supervised v1 contract. Each example includes top-level `intent`, executable node `intent`, and explicit `supervision.profile` plus a bounded intervention budget.

The examples live under `docs/examples/graphs/`, so graphs that target this repository use:

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

- `fake-plan.json`: small read-only primitive graph.
- `feature-showcase.json`: primitive graph covering profiles, parallelism, repeat, checks, artifacts, and delivery.
- `pattern-deep-research-showcase.json`: explicit research angles plus downstream handoff.
- `pattern-candidate-selection-showcase.json`: authored candidate strategies, shared criteria, and stable selection verification.
- `pattern-deep-work-showcase.json`: completion criteria, scorecard loop, and downstream handoff.
- `pattern-map-reduce-showcase.json`: independent item discovery, bounded map item fan-out, aggregate verification.
- `pattern-work-list-showcase.json`: ordered item discovery, item execution, and stable work-list verification.
- `ship-feature.graph.json`: Codex/Cursor-compatible plugin tool example using the local babysit plugin.

Validate an example:

```bash
agentflow plugin resolve --graph docs/examples/graphs/ship-feature.graph.json
agentflow validate --graph docs/examples/graphs/ship-feature.graph.json --show-compiled
agentflow validate --graph docs/examples/graphs/feature-showcase.json
agentflow validate --graph docs/examples/graphs/feature-showcase.json --show-compiled
```

The `ship-feature.graph.json` example uses the local babysit plugin and a secret GitHub credential. Configure it before validation or launch:

```bash
printf %s "$GITHUB_TOKEN" | agentflow auth set --scope github --key token --secret --value-stdin
```

Run only after confirming the selected harness and workspace backend are appropriate for your machine:

```bash
agentflow run --graph docs/examples/graphs/feature-showcase.json
```
