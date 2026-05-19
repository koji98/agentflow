# Run Postmortem

Use this structure for a run learning report.

```markdown
# Agentflow Run Learning Report

## Run Summary
Graph, run root, terminal status, outcome, major artifacts.

## What Worked
Composition, context, artifacts, checks, tools, supervision, delivery.

## What Did Not Work
Over-specific nodes, brittle checks, missing context, artifact gaps, authority issues, cost, latency, review gaps.

## Graph Lessons
What should change in future graphs.

## Workspace Improvements
Docs, comments, tests, scripts, setup, examples, module boundaries, or local development affordances that would make future agent runs easier and safer.

## Graph / Prompt / Support Lessons
Context pointers, skills, capabilities, CLI hints, managed tools, checks, node boundaries, prompts, or artifacts that should change because agents struggled or succeeded.

## Extraction Candidates
Plugins, evals, docs, skills, templates, or no extraction.

## Next Actions
Concrete follow-ups with the owning surface.
```

Start from delivery files. Use raw attempts, events, interventions, attempt memory, and tool logs only when they explain a lesson. For retries, inspect `agent/attempt-memory.md`, `runtime/attempt-memory.json`, `events.jsonl`, workspace diffs, and the `verification.started` / `verification.completed` events before deciding whether the supervisor chose the best restart boundary. Check both failure modes: rerunning too much when progress was trustworthy, and preserving too much when progress was contaminated or wrong-direction. Link evidence for every recommendation and include priority, confidence, and done-when when the output is meant to guide future work.
