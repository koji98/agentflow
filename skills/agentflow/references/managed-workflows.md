# Managed Workflows

Use the shipped managed patterns as fixed strategy contracts, not as loose prompt buckets.

## Choose by lifecycle

- `pattern_deep_research`: multi-track investigation, source policy, contradiction handling, sourced report, research packet
- `pattern_spec_design`: repo-grounded design, alternatives, tradeoffs, implementation-ready design package
- `pattern_generate_evaluate_fix`: prepared task packet, evaluator-command fan-out, bounded fix retries, hard or soft evaluation evidence
- `pattern_review_change`: diff or change-package review, reviewer specialization, merged and calibrated findings

Do not use a managed pattern when the task is only one or two primitive steps, needs a custom graph shape the pattern does not model, or would leave the authored pattern contract mostly empty.

## Shared model

Every managed pattern uses:

- `brief`
- `context_policy`
- `strategy`
- optional `runtime`

Pattern-specific fields:

- `pattern_deep_research`: optional `approval_policy`, `delivery`
- `pattern_spec_design`: optional `approval_policy`, `delivery`
- `pattern_generate_evaluate_fix`: `task_source`, `evaluation`
- `pattern_review_change`: `review_source`, `delivery`

Common executable fields still apply:

- `label`
- `repo`
- `profile`
- `inputs`
- `context_from`
- `timeout_sec`

## Handoffs

Always decide what the next node actually needs:

- final report
- machine-readable packet
- review bundle
- short operator handoff

Good handoff:

1. managed pattern publishes named outputs
2. downstream primitive node consumes the exact artifact it needs

Avoid adding a downstream `agent` node that only restates the managed pattern result with no new responsibility.

## Guardrails

- managed patterns are autonomous by default
- use `approval_policy` only on `pattern_deep_research` and `pattern_spec_design`
- do not add `approval_policy` or `delivery` to `pattern_generate_evaluate_fix`
- keep concurrency tuning in `runtime`, not `strategy`
- use eval suites when you need to measure workflow quality across multiple cases
