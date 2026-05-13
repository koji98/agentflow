---
name: agentflow-intake
description: Use when a user has an Agentflow idea, vague workflow, graph request, or asks to be grilled before writing a graph; use before graph authoring when goal, scope, assurance level, authority, evidence, or review surface is unclear.
---

# Agentflow Intake

## Overview

Turn a raw Agentflow idea into a workflow brief. Do not write the graph here; prevent premature graph syntax, brittle nodes, and over-specific implementation plans.

## When To Use

- The user asks to write an Agentflow graph but has not provided clear outcome, scope, authority, evidence, or assurance expectations.
- The user says "grill me", "help me think through the workflow", "make a plan", or describes a large agent run.
- A graph request risks closing the worker's freedom too early.

Use `agentflow-authoring` after a workflow brief exists.

## Core Workflow

1. Establish the top-level outcome: what should be true when the run ends.
2. Confirm why Agentflow is the right tool: long-running work, durable evidence, supervision, multi-node handoffs, or reusable workflow value.
3. Clarify scope, non-goals, authority, human approval points, and agent autonomy; use `references/grill-questions.md` when the requirements are still underdeveloped.
4. Choose an assurance profile: fast, balanced, high-assurance, exploration, or learning loop. See `references/assurance-profiles.md`.
5. Clarify evidence: deterministic checks, rubrics, artifacts, delivery review, PRs, reports, or eval outputs.
6. Produce a workflow brief using `references/workflow-brief.md`.
7. Stop before graph authoring unless the user explicitly asks to continue with `agentflow-authoring`.

## Decision Rules

- Ask about outcomes, authority, evidence, risk, and review surface; do not ask the user to choose node kinds.
- Prefer one meaningful question at a time when intent is unclear.
- Treat implementation details as optional context unless they are true constraints.
- Record where the agent should have freedom to inspect and choose the implementation path.
- If the request is actually plugin, eval, operations, or run-learning work, route to `agentflow-plugins`, `agentflow-evals`, `agentflow-operations`, or `agentflow-run-review`.

## Red Flags

- Asking "how many nodes do you want?"
- Turning user guesses into hard deterministic checks.
- Skipping assurance profile selection.
- Missing non-goals or authority boundaries.
- No answer to "what evidence would convince you this succeeded?"
- Producing a graph before the workflow brief is coherent.

## Verification

Before handing off to authoring:

- [ ] The workflow brief names outcome, scope, non-goals, authority, autonomy, evidence, review surface, risk, and open questions.
- [ ] The assurance profile is chosen and justified.
- [ ] Unknowns are either resolved or listed as open questions.
- [ ] No graph syntax or node layout has been treated as final.
