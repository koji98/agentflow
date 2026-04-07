---
name: agentflow-managed-workflows
description: Author and review Agentflow managed workflows. Use when choosing between deep_research, spec_design, execute_spec, and review_change, or when filling their brief, context_policy, approval_policy, strategy, delivery, and runtime fields.
---

# Agentflow Managed Workflows

Use the shipped managed workflows as structured contracts, not as loose prompt buckets.

## Use when

Use this skill when the graph should contain:

- `deep_research`
- `spec_design`
- `execute_spec`
- `review_change`

Typical requests:

- "Should this be `deep_research` or a custom primitive graph?"
- "Fill the fields for this `execute_spec` node."
- "What should `delivery` contain for `review_change`?"
- "Should this managed workflow pause for approval or run autonomously?"

## Start here

Author or review the managed node first, then validate the whole graph with:

1. `agentflow validate --graph <path>`
2. `agentflow compile --graph <path>` when you need to inspect the lowered shape

Read [references/workflows.md](references/workflows.md) before authoring or reviewing any managed node.

Read [references/selection-and-handoffs.md](references/selection-and-handoffs.md) when choosing between a managed workflow and primitives, or when deciding what should happen after the workflow publishes its outputs.

## Shared contract

All managed workflows use the same top-level shape:

- `brief`
- `context_policy`
- `approval_policy`
- `strategy`
- `delivery`
- optional `runtime`

Rules:

- put user intent and scope in `brief`
- put allowed sources and repo/web policy in `context_policy`
- use `approval_policy` only when the workflow should intentionally insert checkpoints
- keep workflow-specific intent knobs in `strategy`
- keep requested artifacts and report shape in `delivery`
- keep execution-budget tuning in `runtime`, not in `strategy`

Managed workflows are autonomous by default. Do not add checkpoint-style pauses unless the workflow explicitly needs them.

## Workflow

1. Choose the workflow that matches the real task.

- do not use managed workflows for tiny one-step tasks
- do not use the wrong workflow just because it sounds close enough

2. Author intent, not scheduler math.

- `brief` should say what the workflow is trying to achieve
- `context_policy` should say what sources and repo surfaces are allowed
- `delivery` should say what the workflow must publish
- `runtime` is only for advanced execution-budget tuning

3. Decide whether the workflow should run autonomously.

- default to no checkpoints
- only enable `approval_policy` when an operator review point is intentionally part of the workflow design

4. Plan the handoff.

- decide which published workflow artifact downstream nodes will consume
- use a downstream primitive node only when something concrete still needs to happen afterward
- do not tack on extra nodes that merely restate the workflow's own final output

5. Validate the authored graph.

- make sure the managed node is being used for the right lifecycle
- make sure `delivery` names the artifacts the downstream graph actually needs
- make sure `approval_policy` is intentional, not decorative
- validate and compile the graph before handoff

## Selection

Use:

- `deep_research` for multi-track research and synthesis
- `spec_design` for repo-grounded design work
- `execute_spec` for implementing an existing spec through planning, mutation, validation, and bounded repair
- `review_change` for structured change review with a reviewer panel

## Guardrails

- Do not reintroduce old orchestration knobs as authored workflow semantics.
- Do not collapse everything into `brief` or free-form prose.
- Prefer explicit delivery artifacts over vague “write a report” instructions.
- Keep the managed node aligned with the shipped workflow, not with ad hoc custom subgraphs.
- If a primitive graph is clearer, use primitives instead of forcing a managed workflow.
