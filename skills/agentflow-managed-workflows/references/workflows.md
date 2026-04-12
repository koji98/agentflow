# Managed Patterns Reference

This is the compact reference for the shipped managed patterns.

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

Managed patterns are autonomous by default. Only `pattern_deep_research` and `pattern_spec_design` expose `approval_policy`, and a checkpoint appears only when that field explicitly enables one.

## `pattern_deep_research`

Use for:

- multi-track investigation
- contradiction handling
- sourced reports and research packets

Key authored intent:

- `brief.question`
- `brief.objective`
- optional `brief.audience`
- optional `brief.scope_cues`
- optional `brief.success_bar`
- `context_policy.web`
- `context_policy.files`
- `context_policy.apps`
- optional `approval_policy.require_plan_approval`
- `strategy.depth`
- `strategy.coverage_mode`
- `strategy.followup_passes`
- `strategy.final_critique`
- optional `runtime.max_concurrency`

Core outputs:

- `research-report.md`
- `research-packet.json`
- `source-ledger.json`
- `uncertainties.md`
- `interim-findings.jsonl`

## `pattern_spec_design`

Use for:

- repo-first architecture and design work
- alternatives and tradeoffs
- implementation-ready design packages

Key authored intent:

- `brief.problem`
- `brief.goal`
- optional `brief.constraints`
- optional `brief.decision_drivers`
- optional `brief.scope`
- `context_policy.repo_first`
- `context_policy.allow_web_fallback`
- optional `approval_policy.require_direction_approval`
- `strategy.alternatives`
- `strategy.critique_profiles`
- `strategy.max_revision_cycles`
- optional `runtime.max_concurrency`

Core outputs:

- `design-spec.md`
- `design-packet.json`
- `direction-proposal.md`
- `tradeoff-matrix.md`
- `decision-log.md`
- `implementation-readiness.md`
- `critique-merged.md`
- `quality-review.json`

## `pattern_generate_evaluate_fix`

Use for:

- narrow implementation loops against a prepared task packet
- concrete evaluator-command fan-out
- soft-evidence or hard-gated evaluation

Key authored intent:

- optional `brief.objective`
- optional `brief.scope`
- `task_source`
- `context_policy.allow_official_docs_fallback`
- optional `context_policy.allow_domains`
- `strategy.max_fix_cycles`
- `evaluation.commands`
- optional `evaluation.required`

Core outputs:

- `change-summary.md`
- `change-packet.json`
- `evaluation-ledger.json`
- `fix-log.md`

Notes:

- this pattern does not plan or pause for approval
- `evaluation.required = false` means one non-blocking evaluation pass with soft evidence

## `pattern_review_change`

Use for:

- evidence-based review of a diff or change package
- reviewer fan-out
- calibrated machine-readable findings

Key authored intent:

- optional `brief.review_goal`
- optional `brief.focus`
- optional `brief.scope`
- `review_source`
- `context_policy.include_surrounding_code`
- `context_policy.include_tests`
- `context_policy.include_docs`
- `context_policy.include_validation`
- `strategy.reviewer_profiles`
- `strategy.severity_policy`
- optional `runtime.max_concurrency`

Core outputs:

- `review-summary.md`
- `review-bundle.json`
- `raw-findings.json`
- `merged-findings.json`
- `calibrated-findings.json`

## Common mistakes

- using managed patterns for tiny one-step tasks
- reintroducing removed execute-spec fields on `pattern_generate_evaluate_fix`
- adding `delivery` or `approval_policy` to `pattern_generate_evaluate_fix`
- expecting `delivery` to toggle the core output set
- inserting checkpoints when autonomy would be cleaner
- forgetting to validate the graph after filling the pattern fields
