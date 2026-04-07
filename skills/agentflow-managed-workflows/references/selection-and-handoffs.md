# Managed Workflow Selection And Handoffs

Use this reference when choosing a managed workflow or deciding what should consume its outputs.

## Choose by lifecycle, not by label

Use `deep_research` when the task needs:

- multi-track investigation
- source policy and citation discipline
- contradiction handling
- a synthesized final report

Use `spec_design` when the task needs:

- repo-grounded design work
- current-state analysis
- alternatives and tradeoffs
- an implementation-ready design package

Use `execute_spec` when the task needs:

- implementing an existing spec source
- planning before mutation
- validation-led execution
- bounded repair and a final handoff

Use `review_change` when the task needs:

- structured review of a diff or change packet
- reviewer specialization
- merged, calibrated findings

## When not to use them

Do not use a managed workflow when:

- the task is only one or two primitive steps
- the task needs a custom graph shape that the workflow does not model well
- the authored contract would mostly be empty because the workflow is overkill

## Approval policy

Managed workflows are autonomous by default.

Only add `approval_policy` when the workflow should intentionally stop for operator review. Do not add checkpoints just to slow the workflow down or simulate caution.

## Delivery and downstream nodes

Always decide what the next node actually needs:

- a final report
- a design spec
- an implementation handoff
- calibrated review findings

Good handoff pattern:

1. managed workflow publishes named outputs
2. one downstream primitive node consumes the exact published artifact it needs

Bad handoff pattern:

1. managed workflow publishes a full result
2. one more `agent` node restates the same result with no new responsibility

## Common mistakes

- using `runtime` to express workflow intent
- moving key output requirements out of `delivery`
- enabling checkpoints when autonomy would be cleaner
- forgetting to design the downstream consumer of the workflow's published artifact
