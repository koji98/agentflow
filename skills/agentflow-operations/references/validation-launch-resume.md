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

Resume preserves completed work only when the compiled run contract remains compatible:

- Graph-level intent and supervision policy must match.
- A node restarts when its compiled contract changes: repo, dependencies, intent, effective policy, context pointers, selected skills, CLI hints, managed tool grants/config, declared artifacts, checks/commands, or managed lowering metadata.
- Downstream nodes restart when an upstream node restarts.
- Repeat scopes restart when the repeat shape, max attempts, exit node, or any prior node state inside the scope is incompatible.
- Raw pointed file contents, glob matches, AGENTS.md, and provenance/debug files do not by themselves restart completed work unless the graph contract changes to point somewhere else.

Use `agentflow resume --run-root <run-root> --dry-run` before resuming any changed graph when preservation matters. Read the dry-run preserved/restarted counts and spot-check the compiled ids before launching real work.

Do not confuse resume contract fingerprints with supervisor failure fingerprints. Resume fingerprints decide whether old completed work is still compatible with the current graph. Supervisor failure fingerprints group repeated failures inside a run so recovery can stop repeating the same tactic.

Use `--reset-supervisor-budget` only after the operator has fixed graph, environment, credentials, or another blocker enough to justify fresh recovery while preserving compatible completed work.
