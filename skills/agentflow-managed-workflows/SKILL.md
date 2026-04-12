---
name: agentflow-managed-workflows
description: Author and review Agentflow managed patterns. Use when choosing between pattern_deep_research, pattern_spec_design, pattern_generate_evaluate_fix, and pattern_review_change, or when filling their pattern-specific contracts and downstream handoffs.
---

# Agentflow Managed Patterns

Use the shipped managed patterns as fixed strategy contracts, not as loose prompt buckets.

## Use when

Use this skill when the graph should contain:

- `pattern_deep_research`
- `pattern_spec_design`
- `pattern_generate_evaluate_fix`
- `pattern_review_change`

Typical requests:

- "Should this be `pattern_deep_research` or a custom primitive graph?"
- "Fill the fields for this `pattern_generate_evaluate_fix` node."
- "Should this be `pattern_review_change` or just a few primitive reviewer nodes?"
- "What should downstream nodes consume from this pattern?"

## Start here

Author or review the pattern node first, then validate the whole graph with:

1. `agentflow validate --graph <path>`
2. `agentflow compile --graph <path>` when you need the lowered shape

Read [references/workflows.md](references/workflows.md) before authoring any pattern node.

Read [references/selection-and-handoffs.md](references/selection-and-handoffs.md) when choosing between managed patterns and primitives, or when deciding what should consume a pattern output.

## Shared model

Every managed pattern uses:

- `brief`
- `context_policy`
- `strategy`
- optional `runtime`

Pattern-specific fields vary:

- `pattern_deep_research`: optional `approval_policy`, `delivery`
- `pattern_spec_design`: optional `approval_policy`, `delivery`
- `pattern_generate_evaluate_fix`: `task_source`, `evaluation`
- `pattern_review_change`: `review_source`, `delivery`

Rules:

- put user intent and scope in `brief`
- put allowed sources and repo/web policy in `context_policy`
- use `approval_policy` only on the patterns that support it, and only when the pattern intentionally inserts a checkpoint
- keep pattern-specific intent knobs in `strategy`
- use `delivery` only where the pattern supports it, and never to toggle the pattern’s core output set
- keep concurrency tuning in `runtime`, not in `strategy`

Managed patterns are autonomous by default.

## Workflow

1. Choose the pattern that matches the real lifecycle.

- do not use managed patterns for tiny one-step tasks
- do not use the wrong pattern just because the name sounds close

2. Author intent, not scheduler math.

- `brief` says what the pattern is trying to achieve
- `context_policy` says what sources and repo surfaces are allowed
- pattern-specific fields like `delivery`, `task_source`, `evaluation`, or `review_source` define the actual contract surface
- `runtime` is only for advanced execution-budget tuning

3. Plan the handoff.

- decide which published output downstream nodes should consume
- prefer the machine-readable packet when the next step is another pattern or a deterministic primitive
- use a downstream primitive node only when something concrete still needs to happen afterward

4. Validate the authored graph.

- make sure the pattern fits the task lifecycle
- make sure any `approval_policy` is intentional, not decorative
- make sure downstream nodes consume real named outputs from the final publish node
- validate and compile before handoff

## Selection

Use:

- `pattern_deep_research` for multi-track research and synthesis
- `pattern_spec_design` for repo-grounded design work
- `pattern_generate_evaluate_fix` for narrow generate/evaluate/fix implementation loops against a prepared task packet
- `pattern_review_change` for structured review with reviewer fan-out and calibrated findings

## Guardrails

- Do not reintroduce removed legacy fields like `spec_source`, `validation`, `single_writer`, or repair-log delivery toggles.
- Do not add `approval_policy` or `delivery` to `pattern_generate_evaluate_fix`.
- Do not collapse everything into `brief` or free-form prose.
- Prefer explicit downstream handoffs over vague “write a report” instructions.
- Keep the pattern aligned with the shipped builder, not with ad hoc custom subgraphs.
- If a primitive graph is clearer, use primitives instead of forcing a managed pattern.
