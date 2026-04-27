# Graph Examples

These graphs demonstrate the supervised v1 contract. Each example includes top-level `intent`; larger showcase graphs also include explicit `supervision` or managed pattern delivery configuration.

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
- `pattern-deep-research-showcase.json`: research pattern plus downstream handoff.
- `pattern-spec-design-showcase.json`: spec-design pattern plus downstream handoff.
- `pattern-generate-evaluate-fix-showcase.json`: design to implementation with evaluation and repair loop.
- `pattern-review-change-showcase.json`: implementation to structured review.
- `ship-feature.graph.json`: Codex/Cursor-compatible plugin tool example using the local babysit plugin.

Validate an example:

```bash
agentflow plugin resolve --graph docs/examples/graphs/ship-feature.graph.json
agentflow validate --graph docs/examples/graphs/ship-feature.graph.json --show-compiled
agentflow validate --graph docs/examples/graphs/feature-showcase.json
agentflow validate --graph docs/examples/graphs/feature-showcase.json --show-compiled
```

The `ship-feature.graph.json` example uses the local babysit plugin and a secret GitHub credential. Configure it before `--run-ready` or launch:

```bash
printf %s "$GITHUB_TOKEN" | agentflow auth set --scope github --key token --secret --value-stdin
```

Run only after confirming the selected harness and workspace backend are appropriate for your machine:

```bash
agentflow run --graph docs/examples/graphs/feature-showcase.json
```
