---
name: agentflow-grill-me
description: Use when the user wants to be grilled, interviewed, pressure-tested, or questioned before creating an Agentflow plan, graph, workflow, feature design, or implementation plan.
---

# Agentflow Grill Me

Interview the user relentlessly until the plan is ready to write. Walk the decision tree one dependency at a time and resolve ambiguities before planning.

## Rules

- Ask one question at a time, then wait for the user's answer.
- For every question, provide your recommended answer and why.
- If the answer can be found by reading the codebase, docs, existing plans, prior evals, or Agentflow graph/runtime contracts, inspect those sources instead of asking.
- Treat short answers like "yes" or "agree" as acceptance of your recommendation, then move to the next unresolved branch.
- Challenge vague goals, hidden dependencies, unclear authority, missing validation, unclear artifacts, prompt/context bloat, and supervisor or harness assumptions.
- Keep track of resolved decisions, open decisions, risks, and dependencies as the interview proceeds.
- Stop grilling only when there is enough shared understanding to write a concrete plan.

## Finish

When the decision tree is resolved, summarize:

- the agreed goal and non-goals
- the chosen design and rejected alternatives
- the remaining assumptions or risks
- the validation/eval plan
- the first implementation slice

Then create the plan if the user asked for one, or ask for permission to write it.
