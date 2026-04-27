# CLI And Validation

Core commands:

```bash
agentflow graph-help
agentflow plugin resolve --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json --run-ready
agentflow validate --graph agentflow.graph.json --show-compiled
agentflow run --graph agentflow.graph.json
agentflow inspect <run-root>
agentflow resume --run-root <run-root>
agentflow runs list --graph agentflow.graph.json
```

Agent-facing runtime commands are available as `af` inside agent nodes only. Agentflow injects the generated `af` wrapper on `PATH` with `$AGENTFLOW_RUNTIME_METADATA` pointing at the node contract.
Use `af --help` and `af <command> --help` inside a node for exact runtime CLI arguments, defaults, output shape, examples, and safety notes.

Useful in-node commands:

```bash
af --help
af artifact write --help
af status
af tools list
af context show
af artifact list
af artifact write <name> --file <path>
af log --type finding --summary "..."
af spawn --brief "..." --artifact helper-report.md --wait
af wait --agent <helper-id> --artifact helper-report.md
```

## Validation Levels

- `validate`: authored graph, normalization, compilation, graph diagnostics, plugin lockfile shape.
- `--run-ready`: local repos, command availability, env files, plugin executables, plugin tool `--help` contracts, and harness readiness.
- `--show-compiled`: compiled primitive graph, managed expansions, tool contracts, profile resolution, delivery and supervision contracts.

## Before Launch

Confirm:

- `intent.goal` and acceptance criteria match the requested work.
- scope boundaries and high-impact limits are explicit in `constraints`.
- write-capable nodes use a write-capable sandbox.
- plugin tools have the expected `capability`, `impact`, concise `usage`, and passing `--help` output.
- managed patterns publish the artifacts downstream nodes reference.
- `supervision.actions.<action>.max_uses` and `supervision.max_total_interventions` are intentionally bounded.
- terminal delivery is automatic and reviewer-facing.

## Command Results

Run and resume output include:

- run root
- status and outcome
- supervisor status
- intervention count
- remaining supervisor budget
- delivery package manifest
- reviewer guide
- interventions ledger

Inspect output also includes recent events, failed node summaries, stderr tails, delivery paths, and delivery artifact taxonomy counts when `delivery/manifest.json` is present.
