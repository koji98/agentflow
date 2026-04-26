# Run Debugging

Start with:

```bash
agentflow inspect <run-root>
```

Then inspect the run files directly.

## High-Signal Files

- `run.json`: terminal status and counts.
- `delivery/manifest.json`: delivery package index.
- `delivery/run-map.md`: plain-English map of human, resume, audit, debug, and empty/no-op files.
- `delivery/reviewer-guide.md`: review order and risk notes.
- `delivery/task-brief.md`: authored goal, constraints, and acceptance criteria.
- `delivery/implementation-summary.md`: captured agent handoff responses.
- `delivery/evaluation-ledger.json`: check and evaluator evidence.
- `delivery/intervention-trace.json`: supervisor trace for review.
- `summary.md`: human run summary.
- `events.jsonl`: ordered runtime event log for debugging.
- `interventions.jsonl`: supervisor decisions and intervention records for debugging.
- `runtime/channel.jsonl`: typed coordination messages posted through `af`.
- `runtime/mailboxes/`: durable direct messages for agent sessions.
- `runtime/helpers/`: helper session metadata, logs, outputs, and artifacts created through `af spawn`.
- `runtime/supervisor-requests.jsonl`: requests recorded through `af supervisor request`.

`delivery/manifest.json` labels `human_entrypoints`, `declared_artifacts`, `resume_required`, `audit_trail`, `debug_only`, and `empty_or_noop`. Use delivery files first; use raw JSONL/state/node attempt files when resume, audit, or low-level debugging requires them.

## Node Attempts

Each node attempt records execution-specific context, logs, result, and artifacts. Look for:

- `context/packet.json`
- `context/manifest.md`
- `logs/stdout.log`
- `logs/stderr.log`
- `result.json`
- `artifacts/`
- `tool-invocations.jsonl`
- `tool-invocation-logs/`
- `interventions/`

## Debug Order

1. Read `delivery/reviewer-guide.md` if it exists.
2. Use `delivery/manifest.json` to identify human entrypoints, declared artifacts, and debug-only files.
3. Check `interventions.jsonl` for supervisor actions.
4. Check failed node `result.json` and stderr.
5. Check missing artifact diagnostics against the node's declared `artifacts`.
6. Check `runtime/channel.jsonl` and helper sessions when the failure involves agent coordination.
7. Check context omissions in `context/packet.json`.
8. Re-run `agentflow validate --graph <graph> --run-ready` if the failure suggests local environment drift.

## Resume

Use:

```bash
agentflow resume --run-root <run-root>
```

Resume preserves compatible completed work and restarts work affected by node-contract or graph-level `intent` or `supervision` changes.
