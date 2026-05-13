---
name: agentflow-authoring
description: Use when converting an Agentflow workflow brief into a graph, choosing primitive nodes or managed patterns, sizing nodes, defining artifacts, selecting checks, or drafting graph contracts before launch.
---

# Agentflow Authoring

## Overview

Author Agentflow graphs as supervised execution contracts. A strong graph constrains outcomes, authority, evidence, and reviewability while leaving capable agents free to choose implementation tactics.

## When To Use

- A workflow brief exists and the next step is an Agentflow graph.
- You need to choose between primitive nodes, managed patterns, plugin workflows, checks, checkpoints, or artifacts.
- You are drafting or revising graph intent, node contracts, context, profiles, tools, or supervision.

If the brief is missing or vague, use `agentflow-intake` first. If a graph is already drafted, use `agentflow-plan-review` before launch.

## Core Workflow

1. Read the workflow brief and preserve the requested assurance profile.
2. Choose a composition from `references/composition-model.md`.
3. Size nodes around outcomes, not tiny edit steps.
4. Define authority: repos, profiles, workspace backend, sandbox, tools, credentials, and human approval boundaries.
5. Define durable artifacts for every downstream or review handoff.
6. Add checks only for stable facts. Deterministic checks validate outcomes, not guessed implementation tactics. See `references/deterministic-vs-rubric.md`.
7. Use managed patterns when the lifecycle is standard; see `references/managed-patterns.md`.
8. Include validation commands and route the draft to `agentflow-plan-review`.

## Decision Rules

- Use `pattern_deep_research` when the job is to understand, compare, plan, or review.
- Use `pattern_deep_work` when the job is to produce or mutate through a bounded feedback loop.
- Use deterministic `check` nodes for existing tests, builds, typechecks, smoke scripts, schema checks, or stable commands.
- Use rubrics, artifacts, or review nodes for semantic correctness or open implementation paths.
- Use checkpoints for planned human decisions; leave runtime authority pauses to supervisor behavior.
- Use plugins only for reusable workflow/tool capability, auth isolation, stable I/O, policy, or auditability.

## Red Flags

- Node goals read like a shell script or file-by-file implementation plan.
- A check depends on a script or file the agent might not need to create.
- Downstream nodes depend on raw logs or assumed workspace state instead of artifacts.
- Context uses broad globs because "the agent might need it."
- Acceptance criteria are vague, subjective, or duplicate generic working-loop instructions.
- The graph is called complete before validation is planned.

## Verification

Before handing off:

- [ ] The graph follows `references/graph-quality-bar.md`.
- [ ] Every executable node has meaningful intent and non-empty acceptance criteria.
- [ ] Every graph-level and node-level constraint is a prohibition-style boundary that starts with `Do not`; positive requirements are in acceptance criteria.
- [ ] Artifacts exist for durable handoffs.
- [ ] Deterministic checks validate stable outcomes.
- [ ] Agent freedom is preserved inside clear authority boundaries.
- [ ] `agentflow validate --graph <path>` is the stated preflight, and plugin resolution is included when needed.
