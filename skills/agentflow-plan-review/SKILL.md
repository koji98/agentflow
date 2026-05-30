---
name: agentflow-plan-review
description: Use when reviewing a draft Agentflow graph before launch, especially to catch over-specific nodes, brittle deterministic checks, weak artifacts, poor context, missing authority, or validation-readiness problems.
---

# Agentflow Plan Review

## Overview

Review Agentflow graphs before launch. The goal is to catch graph-design failures that validation may not fully judge: over-prescription, brittle checks, missing artifacts, weak authority boundaries, and poor assurance fit.

## When To Use

- A graph has been drafted and the user asks for review before launch.
- Validation fails or produces authoring warnings.
- The graph uses managed patterns, plugins, repeat loops, broad context, or custom checks.
- The author wants confidence that the graph will run well, not merely parse.

Use `agentflow-authoring` when no graph exists yet. Use `agentflow-operations` for actual launch, inspect, or resume.

## Core Workflow

1. Read the graph and intended workflow brief if available.
2. Review contract shape: top-level intent, node intent, constraints, acceptance criteria, repos, profiles, supervision, and delivery; see `references/review-rubric.md`.
3. Review whether authored fields will compile into strong AI prompts for each prompt-backed node type, including prompt-facing prose purity; use `references/prompt-translation-review.md`.
4. Review composition fit against the assurance profile.
5. Review deterministic checks for stable-outcome discipline; use `references/anti-patterns.md` to identify brittle graph designs.
6. Review artifacts, context, and downstream refs.
7. Review authority: sandbox, tools, credentials, profile isolation, and human gates.
8. Report findings first, ordered by severity, then list validation commands to run.

## Decision Rules

- Treat over-specific graph text as a defect when it closes agent freedom without a real constraint.
- Treat missing artifacts as a defect when later nodes or reviewers need durable handoffs.
- Treat broad context as a defect unless it is intentionally bounded, pointer-based, and explained with clear `what` and `why`.
- Treat deterministic checks as brittle when they depend on an optional implementation tactic.
- Treat graph-authoring or managed-pattern language in prompt-facing fields as a defect. Runtime prose should speak to the executing agent, verifier, researcher, planner, item worker, or reviewer.
- Do not redesign the whole graph unless the current shape cannot satisfy the brief.

## Red Flags

- Nodes named after tiny implementation steps.
- Constraints that are positive requirements or do not start with `Do not`.
- AI checks stacked after agent nodes just to repeat outcome verification.
- Parallel branches without artifacts.
- Checkpoints used as normal failure recovery.
- Plugin tools used where native CLIs are enough.

## Verification

Before approving the plan:

- [ ] Findings are actionable and tied to graph text.
- [ ] Every graph-level and node-level constraint starts with `Do not`; positive requirements are acceptance criteria, not constraints.
- [ ] Prompt-backed nodes receive the intended role, success contract, support tables, artifact contract, and evaluation contract after lowering.
- [ ] Runtime-facing prose does not mention graph construction mechanics, managed-pattern internals, compiled prompts, downstream-node mechanics, or `af` commands as task instructions.
- [ ] The graph preserves agent autonomy inside explicit authority boundaries.
- [ ] Checks, artifacts, and context all serve the stated outcome.
- [ ] Required validation commands are listed.
- [ ] Remaining risks are explicit.
