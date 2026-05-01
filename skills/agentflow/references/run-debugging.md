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
- `runtime/helpers/`: helper session metadata, logs, outputs, and artifacts created through `af spawn`.
- `runtime/log.jsonl`: worker evidence recorded through `af log --type`.
- `supervisor-timeline.jsonl`: supervisor health and decision records.

`delivery/manifest.json` labels `human_entrypoints`, `declared_artifacts`, `resume_required`, `audit_trail`, `debug_only`, and `empty_or_noop`. Use delivery files first; use raw JSONL/state/node attempt files when resume, audit, or low-level debugging requires them.

## Node Attempts

Each node attempt records execution-specific context, logs, result, and artifacts. Look for:

- `context/packet.json`
- `context/manifest.md`
- `logs/stdout.log`
- `logs/stderr.log`
- `result.json`
- `artifacts/`
- `workspace-changes/`
- `verify-outcome.json` and `verify-outcome.md` when the attempt reached outcome verification
- `tool-invocations.jsonl`
- `tool-invocation-logs/`
- `interventions/`

For the implementation model behind these files, see `docs/technical/context-and-artifacts.md` and `docs/technical/runtime-tooling.md` in the repository.

## Debug Order

1. Read `delivery/reviewer-guide.md` if it exists.
2. Use `delivery/manifest.json` to identify human entrypoints, declared artifacts, and debug-only files.
3. Check `interventions.jsonl` for supervisor actions.
4. Check failed node `result.json` and stderr.
5. Check missing artifact diagnostics against the node's declared `artifacts`.
6. Check `runtime/log.jsonl` and helper sessions when the failure involves worker evidence or helper sub-nodes.
7. Check context omissions in `context/packet.json`.
8. Re-run `agentflow validate --graph <graph> --run-ready` if the failure suggests local environment drift.

## Resume

Use:

```bash
agentflow resume --run-root <run-root>
agentflow resume --run-root <run-root> --dry-run
agentflow resume --run-root <run-root> --reset-supervisor-budget
agentflow resume --graph agentflow.graph.json --latest
```

Resume preserves compatible completed work and restarts work affected by node-contract or graph-level `intent` or `supervision` changes.

Use `--dry-run` first when the resume boundary matters; it shows preserved, restarted, and initially startable nodes without executing anything. Use `--reset-supervisor-budget` only after the operator has fixed the graph, credentials, environment, or another blocker enough to justify fresh recovery actions.

## Human Gates And Pauses

- Authored `checkpoint` nodes are planned human gates inside `repeat` bodies. During a run, they ask the operator for loop-control judgment at the point the graph author intended.
- Supervisor `pause_for_human` is an authority pause chosen after runtime evidence shows the system needs credentials, scope expansion, product intent, security/compliance judgment, graph-contract changes, or another operator decision it must not infer.
- For a paused run, inspect `interventions.jsonl`, `supervisor-timeline.jsonl`, and `runtime/human-resume-input.jsonl` when present, then resume with structured human input through `agentflow resume --run-root <run-root> --human-action ...`. A dry-run preview of a paused run does not require `--human-action`.
