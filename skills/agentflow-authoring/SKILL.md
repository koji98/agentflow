---
name: agentflow-authoring
description: Use when converting an Agentflow workflow brief into a graph, choosing primitive nodes or managed patterns by product fit, sizing nodes, defining artifacts, selecting checks, or drafting graph contracts before launch.
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
2. Draft an authoring plan outside the graph: topology, managed-pattern choices, dependencies, assurance profile, and rationale.
3. Write a runtime prose table before JSON; every prompt-facing field must name its runtime audience and exact text. Use `references/runtime-prose-field-guide.md`.
4. Run a graph-semantics leak review before JSON: graph-building rationale, node topology, managed-pattern mechanics, downstream-node mechanics, and Agentflow authoring vocabulary must stay out of prompt-facing graph fields.
5. Write graph and node intent for the agents that will execute the graph; see `references/intent-writing.md`.
6. Check how authored graph inputs will compile into AI prompts; see `references/prompt-translation.md`.
7. Choose a composition from `references/composition-model.md`. Treat pattern choice as product quality: pick the lifecycle that makes the final user outcome more likely, not the most elaborate orchestration.
8. Size nodes around outcomes, not tiny edit steps.
9. Define authority: repos, profiles, workspace backend, sandbox, credentials, tools, planned checkpoints, and typed authority boundaries.
10. Define support surfaces: skill sources, capabilities, CLI hints, managed tools, and node-local context; see `references/support-surfaces.md`.
11. Define durable artifacts for every downstream or review handoff, including `content_type` for JSON, screenshots, PDFs, traces, archives, or other format-sensitive evidence.
12. Add checks only for stable facts. Deterministic checks validate outcomes, not guessed implementation tactics. See `references/deterministic-vs-rubric.md`.
13. Use managed patterns when the lifecycle is standard; see `references/managed-patterns.md`.
14. Assemble graph JSON only after the runtime prose table is clean, then include validation commands and route the draft to `agentflow-plan-review`.

## Decision Rules

- Choose patterns by the ask. There is no default managed pattern; the best pattern is the one that preserves the user outcome, validation path, and review evidence with the least unnecessary coordination.
- Use `pattern_deep_research` when the job is to understand, compare, plan, or review.
- Use `pattern_deep_work` when one coherent work product should be produced or mutated through a bounded feedback loop.
- Use `pattern_work_list` when the bounded outcome requires discovering, freezing, and completing a finite list of independently reviewable items whose item-level completion improves product quality.
- Use `pattern_map_reduce` when the bounded outcome requires discovering, freezing, and judging or processing a finite independent item set with the same item contract, then publishing one aggregate evidence packet. It may also fit write-partitioned refactors when each item owns exact disjoint paths and downstream checks verify no out-of-scope edits.
- Use deterministic `check` nodes for existing tests, builds, typechecks, smoke scripts, schema checks, or stable commands.
- Use rubrics, artifacts, or review nodes for semantic correctness or open implementation paths.
- Use checkpoints for planned human decisions; leave runtime authority pauses to trusted typed `AuthorityRequest` producers. Do not design graphs that rely on free-text failures, ambiguity, graph contract gaps, sandbox expansion, or repo/scope gaps to ask a human.
- Use plugins only for reusable workflow/tool capability, auth isolation, stable I/O, policy, or auditability.
- Use capabilities for reusable support bundles. Keep context node-local because every pointer needs node-specific `what` and `why`.
- Keep authoring rationale outside prompt-facing graph fields. Runtime prose must speak only to the executing agent, verifier, researcher, planner, or reviewer.
- Building an Agentflow graph is never the worker's task unless the product being built is Agentflow itself. Do not put graph-construction semantics, pattern-selection rationale, node ids, downstream routing, or authoring commentary into `intent`, context `what`/`why`, artifact descriptions, rubrics, research angles, work-list fields, or phase intents.
- Use `workspace_file`, `workspace_glob`, and `plugin_file` only for static launch-time context that already exists before validation. If a prior node produces context for a later node, declare it as an artifact on the producer and consume it with a `ref`.
- Use artifact `content_type` when the expected format matters, such as `application/json`, `image/png`, or `application/pdf`; binary artifacts still need textual milestone or handoff evidence explaining what they prove.
- Use CLI hints for ordinary local commands; use managed plugin tools only when reuse, credentials, policy, stable I/O, or auditability matter.

## Red Flags

- Node goals read like a shell script or file-by-file implementation plan.
- A coherent implementation task is split into work-list items that make agents locally obedient but less likely to complete the final product.
- `pattern_work_list` is used only because the task has multiple steps, not because item boundaries have independent product value.
- Runtime-facing prose mentions graph mechanics, managed-pattern internals, compiled prompts, downstream nodes, or `af` commands instead of the actual work.
- Prompt-facing fields explain why the author chose Agentflow, a node type, a managed pattern, a publisher, or a downstream handoff instead of telling the runtime reader what outcome, evidence, or boundary it owns.
- Research angles describe deep-research mechanics, report routing, or internal synthesis mechanics instead of the angle's evidence lens.
- A check depends on a script or file the agent might not need to create.
- Downstream nodes depend on raw logs or assumed workspace state instead of artifacts.
- Downstream nodes use `workspace_file` for files expected to be produced earlier in the run.
- Context uses broad globs because "the agent might need it."
- Acceptance criteria are vague, subjective, or duplicate generic working-loop instructions.
- The graph is called complete before validation is planned.

## Verification

Before handing off:

- [ ] The graph follows `references/graph-quality-bar.md`.
- [ ] Graph intent is useful to every downstream node and does not narrate graph topology.
- [ ] Every executable node has meaningful intent and non-empty acceptance criteria.
- [ ] A runtime prose table was drafted before JSON, and prompt-facing fields contain no graph-authoring rationale or pattern mechanics.
- [ ] Every prompt-facing field was reviewed as LLM input and contains no graph-construction semantics, authoring rationale, topology narration, downstream-node mechanics, or managed-pattern lifecycle explanation.
- [ ] Authored inputs translate into the intended AI prompt surfaces for `agent`, AI `check`, plugin-lowered, `pattern_deep_research`, `pattern_deep_work`, `pattern_work_list`, and `pattern_map_reduce` nodes.
- [ ] The chosen primitive or managed pattern improves the final product outcome, validation path, and review evidence; it is not just an orchestration preference.
- [ ] Every graph-level and node-level constraint is a prohibition-style boundary that starts with `Do not`; positive requirements are in acceptance criteria.
- [ ] Support is expressed through capabilities, selected skills, CLI hints, managed tools, and node-local context pointers.
- [ ] Artifacts exist for durable handoffs.
- [ ] Deterministic checks validate stable outcomes.
- [ ] Agent freedom is preserved inside clear authority boundaries.
- [ ] `agentflow validate --graph <path>` is the stated preflight, and plugin resolution is included when needed.
