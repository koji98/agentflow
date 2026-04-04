# Managed Workflows

Agentflow currently runs primitive executable nodes:

- `agent`
- `exec`
- `check`

and primitive control-flow containers:

- `sequence`
- `parallel`
- `repeat`

The real managed-workflow direction is:

- `deep_research`
- `spec_design`
- `execute_spec`
- `review_change`

These are intended to become true compiled subgraphs with built-in orchestration, prompts, artifacts, and UI phases. All four are implemented now.

## Design Rule

A primitive node is user-prompted.

- The graph author writes the exact `prompt`.
- The runtime executes one primitive step.

A managed workflow is system-authored.

- The graph author supplies structured intent and constraints.
- Agentflow expands that into an internal subgraph of primitive nodes.
- The runtime executes the compiled subgraph.

## Managed Workflow Inventory

### `deep_research`

Purpose:
- Clarify a research ask, decompose it, run multiple investigators, reconcile conflicts, and synthesize a final report.

Planned phases:
- clarify
- plan
- investigate
- reconcile
- council
- deliver

Expected orchestration:
- planner
- parallel workers
- synthesis council
- validation

Current status:
- implemented authored node
- implemented normalizer expansion into a generated primitive subgraph
- implemented track fan-out and summary-tree reduction
- optional final critique gate

Current authored fields:
- `question`
- `objective`
- optional `audience`
- optional `inputs`
- optional `context_from`
- optional `sources`
- optional `deliverable`
- optional `orchestration.track_count`
- optional `orchestration.max_parallel_tracks`
- optional `orchestration.summary_fan_in`
- optional `orchestration.final_critique`

### `spec_design`

Purpose:
- Turn an idea or problem into an implementation-ready architecture or design spec.

Planned phases:
- clarify
- inspect
- assess information gap
- optional targeted external research
- synthesize constraints
- explore
- tradeoffs
- draft
- critique
- revise
- finalize

Expected orchestration:
- planner
- repo-first inspection
- targeted web fallback when repo context is insufficient
- parallel option exploration
- critique council
- validation

Concrete contract:
- see [SPEC_DESIGN_WORKFLOW.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/SPEC_DESIGN_WORKFLOW.md)

Design rule:
- repo-first, not repo-only
- the workflow should inspect the repository first, then use targeted web research only if the repository does not contain enough information to support a strong design

Current status:
- implemented authored node
- implemented normalizer expansion into a generated primitive subgraph
- implemented repo inspection, information-gap assessment, and targeted external research fan-out
- implemented parallel option generation
- implemented bounded revision loop with critique panel and quality check

### `execute_spec`

Purpose:
- Execute an existing spec by planning work, applying changes, validating them, and repairing failures.

Planned phases:
- clarify
- plan
- implement
- validate
- repair
- handoff

Expected orchestration:
- planner
- single-writer implementation
- deterministic validation
- repair loop

Concrete contract:
- see [EXECUTE_SPEC_WORKFLOW.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/EXECUTE_SPEC_WORKFLOW.md)

Design rule:
- spec-driven, not idea-driven
- the workflow must require a structured `spec_source`
- it should implement an existing design, not invent one during execution

Current contract highlights:
- required structured `spec_source`
- supports `managed_node` sources for `spec_design -> execute_spec`
- supports `artifact_bundle` sources for hand-written or external specs
- spec-readiness gate before implementation begins
- single-writer implementation path
- deterministic validation plus bounded repair loop

Current status:
- implemented authored node
- implemented normalizer expansion into a generated primitive subgraph
- implemented structured `spec_source` parsing for managed-node and artifact-bundle sources
- implemented spec-readiness AI gate
- implemented single-writer implementation path with bounded repair loop
- implemented deterministic validation gate and final handoff outputs

### `review_change`

Purpose:
- Review a diff or artifact with multiple reviewer passes, merge findings, normalize severity, and publish a final review.

Planned phases:
- prepare
- reviewers
- merge
- normalize
- deliver

Expected orchestration:
- parallel reviewers
- council merge
- validation

Concrete contract:
- see [REVIEW_CHANGE_WORKFLOW.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/REVIEW_CHANGE_WORKFLOW.md)

Design rule:
- findings-driven, not commentary-driven
- the workflow must require a structured `review_source`
- it should prioritize concrete bugs, regressions, and missing tests over low-value style commentary

Current contract highlights:
- required structured `review_source`
- supports `managed_node` sources for `execute_spec -> review_change`
- supports `artifact_bundle` sources for file-based review bundles
- parallel role-based reviewer panel
- merged machine-readable findings plus normalization gate
- final prose and JSON review outputs

Current status:
- implemented authored node
- implemented normalizer expansion into a generated primitive subgraph
- implemented structured `review_source` parsing for managed-node and artifact-bundle sources
- implemented reviewer panel, merge step, normalization AI gate, and final review outputs

## Current Status

What exists now:
- canonical managed-workflow kinds in `src/graph/schema.ts`
- a managed-workflow registry in `src/managed/registry.ts`
- implemented `deep_research` authored node support and graph expansion
- implemented `spec_design` authored node support and graph expansion
- implemented `execute_spec` authored node support and graph expansion
- implemented `review_change` authored node support and graph expansion
- CLI help and docs that describe the target model

What is deferred:
- runtime and UI treatment of managed workflows as collapsible, inspectable workflow groups
