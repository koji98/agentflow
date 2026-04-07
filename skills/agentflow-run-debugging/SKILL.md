---
name: agentflow-run-debugging
description: Inspect, explain, and debug Agentflow runs. Use when a run failed, resumed unexpectedly, or needs artifact-level diagnosis; when tracing state.json, events.jsonl, execution logs, context packets, or context provenance; or when deciding why passed work did or did not preserve on resume.
---

# Agentflow Run Debugging

Debug Agentflow from durable artifacts first.

## Use when

Use this skill when:

- a run failed and you need the root cause
- `resume` preserved or restarted work unexpectedly
- you need to explain a terminal outcome from artifacts alone
- you need to decide whether the problem is graph design, context, command behavior, or harness behavior

Typical requests:

- "Why did this run fail?"
- "Can I resume this run?"
- "Why didn't this node preserve?"
- "What should I fix in the graph so this failure mode is cleaner next time?"

Read [references/run-artifacts.md](references/run-artifacts.md) before diagnosing a run. Read [references/resume.md](references/resume.md) when the issue involves preservation or restart behavior.

Read [references/failure-playbook.md](references/failure-playbook.md) when the question is why a run stopped, why a failure propagated, or what the graph should have done differently.

## Workflow

1. Start at the run root.

Read:

- `run.json`
- `summary.md`
- `state.json`
- `events.jsonl`

2. Move to the relevant execution.

Use the node and execution metadata to inspect:

- `execution.json`
- `context_packet.json`
- `context_summary.md`
- `context_provenance.json`
- `stdout.log`
- `stderr.log`
- `result.json`

3. Separate failure classes.

Common buckets:

- graph load or compile diagnostics
- workspace or harness preflight failures
- deterministic `check` failure
- harness failure
- context materialization failure
- resume invalidation or preservation surprise

4. Explain resume behavior with provenance, not guesses.

Preservation now depends on:

- unchanged compiled contract
- unchanged resolved context provenance

If `context_provenance.json` is missing from an older passed run, that node restarts.

5. Feed the diagnosis back into graph design.

Decide whether the issue points to:

- the wrong node kind
- the wrong validation boundary
- missing outputs or logs
- overly broad inputs or context
- a real runtime or harness problem

6. Use the CLI contract when the next action is operational.

- `agentflow resume --run-root <run-root>` when the run should continue
- `agentflow validate --graph <path>` when the graph itself may be invalid
- `agentflow compile --graph <path>` when you need to inspect the actual lowered contract that would execute next time

## Guardrails

- Use artifact files as the source of truth.
- Do not infer preservation from status alone; check provenance-sensitive inputs and harness instruction files.
- Remember that node and execution directories use hashed names on disk.
- `artifacts/` is optional; execution-root runtime files live directly in the execution directory.
- When a run failure suggests graph brittleness, say so explicitly and point to the graph design implication.
