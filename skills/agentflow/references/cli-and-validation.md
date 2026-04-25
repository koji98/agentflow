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

Useful in-node commands:

```bash
af status
af tools list
af context show
af artifact list
af artifact write <name> --file <path>
af channel post --type finding --summary "..."
af agents list
af inbox read
af spawn --brief "..." --artifact helper-report.md --wait
```

## Validation Levels

- `validate`: authored graph, normalization, compilation, graph diagnostics, plugin lockfile shape.
- `--run-ready`: local repos, command availability, env files, plugin executables, and harness readiness.
- `--show-compiled`: compiled primitive graph, managed expansions, tool contracts, profile resolution, delivery and supervision contracts.

## Before Launch

Confirm:

- `intent.goal` and acceptance criteria match the requested work.
- scope and approval boundaries are explicit.
- write-capable nodes use a write-capable sandbox.
- plugin tools have the expected `capability` and `impact`.
- managed patterns publish the artifacts downstream nodes reference.
- `supervision.retry_budget` is intentionally bounded.
- `delivery.required_sections` includes reviewer-facing sections.

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

Inspect output also includes recent events, failed node summaries, stderr tails, and delivery paths.
