# Managed Pattern Selection And Handoffs

Use this reference when choosing a managed pattern or deciding what should consume its outputs.

## Choose by lifecycle, not by label

Use `pattern_deep_research` when the task needs:

- multi-track investigation
- source policy and citation discipline
- contradiction handling
- a synthesized research package

Use `pattern_spec_design` when the task needs:

- repo-grounded design work
- current-state analysis
- alternatives and tradeoffs
- an implementation-ready design package

Use `pattern_generate_evaluate_fix` when the task needs:

- implementing against a prepared design or task packet
- concrete evaluator-command fan-out
- bounded fix retries driven by a hard evaluation gate

Use `pattern_review_change` when the task needs:

- structured review of a diff or change package
- reviewer specialization
- merged and calibrated findings

## When not to use them

Do not use a managed pattern when:

- the task is only one or two primitive steps
- the task needs a custom graph shape that the pattern does not model well
- the authored contract would mostly be empty because the pattern is overkill

## Approval policy

Managed patterns are autonomous by default.

Only `pattern_deep_research` and `pattern_spec_design` support `approval_policy`. Use it only when the pattern should intentionally stop for operator review. Do not add checkpoints just to simulate caution.

## Delivery and downstream nodes

Always decide what the next node actually needs:

- a final report
- a machine-readable packet
- a review bundle
- a short operator handoff

Good handoff pattern:

1. managed pattern publishes named outputs
2. one downstream primitive node consumes the exact artifact it needs

Bad handoff pattern:

1. managed pattern publishes a full result
2. one more `agent` node restates the same result with no new responsibility

## Common mistakes

- using `runtime` to express pattern intent
- expecting `delivery` to add or remove the core output set
- adding `delivery` or `approval_policy` to `pattern_generate_evaluate_fix`
- enabling checkpoints when autonomy would be cleaner
- forgetting to design the downstream consumer of the pattern’s published artifact
