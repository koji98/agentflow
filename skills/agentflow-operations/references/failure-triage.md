# Failure Triage

Start with:

```bash
agentflow inspect <run-root>
```

Then inspect in this order:

1. `delivery/01-review-brief.md` if present.
2. `delivery/manifest.json` for file taxonomy.
3. `interventions.jsonl` and `supervisor-timeline.jsonl`.
4. Failed execution `runtime/result.json`, then `human-debug/harness/stderr.log` and `human-debug/harness/stdout.log` only as audit/debug evidence.
5. Missing artifact diagnostics and declared artifact paths.
6. `runtime/log.jsonl` and `runtime/helpers/` when worker evidence or helper sessions matter.
7. Attempt `agent/context.md`, `runtime/context.json`, and `human-debug/context-provenance.json` for context omissions.
8. `agentflow validate --graph <graph>` if environment or graph drift is suspected.

Classify the failure before changing anything: graph contract, context, artifact, validation strategy, workspace, environment, harness, typed authority, or semantic mismatch. Prefer structured runtime evidence first: `failure_code`, completion packet status, verifier finding categories, repeated-fingerprint state, and typed `AuthorityRequest`. Stdout, stderr, agent text, verifier prose, helper prose, and tool debug payloads explain evidence but do not choose the recovery class or create a human pause. Debug files are audit-only; normal retry agents should receive `agent/` briefs, declared artifacts, and explicit context pointers.

Harness launch configuration failures are control-plane failures, not worker mistakes. For example, if Cursor says sandbox mode is enabled but unavailable and suggests disabling it, the run should stop with structured harness configuration evidence unless the launch profile already authorizes that weaker sandbox mode. Do not expect a supervisor retry to change harness flags; retries rerun the same authored contract.
