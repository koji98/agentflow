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

For retries inside a run, use attempt memory rather than raw debug files as the operator mental model:

- The next retry writes `runtime/attempt-memory.json` and `agent/attempt-memory.md`.
- `af orient` starts with retry orientation: failure symptom, prior execution, best resume point, restart boundary, workspace decision, progress to reuse, progress to discard, required next action, validation gate, and do-not-redo guidance.
- Prior milestones and validation logs are read-only evidence. The retry creates fresh milestones for current work.
- Verification substrate failures should resume at `rerun_verification`; they should not rerun worker output unless structured verifier findings identify an actual work defect.
- Best resume is evidence-based, not always smallest: preserve validated in-scope progress, but reset failed-attempt changes when structured evidence shows wrong-direction, contaminated, over-broad, or unsafe progress.
- `fresh_retry` is a last resort for absent, unsafe, irrelevant, or explicitly rejected prior progress.

Use `--reset-supervisor-budget` only after the operator has fixed graph, environment, credentials, or another blocker enough to justify fresh recovery while preserving compatible completed work.
