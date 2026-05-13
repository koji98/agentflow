# Validation, Launch, Resume

Core commands:

```bash
agentflow plugin resolve --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json --show-compiled
agentflow validate --graph agentflow.graph.json --output-dir .agentflow/validation/latest
agentflow run --graph agentflow.graph.json
agentflow inspect <run-root>
agentflow resume --run-root <run-root> --dry-run
agentflow resume --run-root <run-root>
```

Use `plugin resolve` when graph plugin declarations exist or plugin refs changed.

Use `--show-compiled` or `--output-dir` when reviewers need to understand managed pattern lowering, repeat loops, parallel handoffs, tool policy, context analysis, or delivery compatibility.

Resume preserves completed work only when graph intent, supervision, and node contracts remain compatible. Use `--reset-supervisor-budget` only after the operator has fixed graph, environment, credentials, or another blocker enough to justify fresh recovery.
