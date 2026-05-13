# Failure Triage

Start with:

```bash
agentflow inspect <run-root>
```

Then inspect in this order:

1. `delivery/reviewer-guide.md` if present.
2. `delivery/manifest.json` for file taxonomy.
3. `interventions.jsonl` and `supervisor-timeline.jsonl`.
4. Failed node `result.json`, `logs/stderr.log`, and `logs/stdout.log`.
5. Missing artifact diagnostics and declared artifact paths.
6. `runtime/log.jsonl` and `runtime/helpers/` when worker evidence or helper sessions matter.
7. Attempt `context/packet.json` and `context/manifest.md` for context omissions.
8. `agentflow validate --graph <graph>` if environment or graph drift is suspected.

Classify the failure before changing anything: graph contract, context, artifact, validation strategy, workspace, environment, harness, authority, or semantic mismatch.
