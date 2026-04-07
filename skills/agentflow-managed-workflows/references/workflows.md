# Managed Workflows Reference

This is the compact reference for the shipped managed workflows.

## Shared contract

Every managed workflow uses:

- `brief`
- `context_policy`
- `approval_policy`
- `strategy`
- `delivery`
- optional `runtime`

Common executable fields still apply:

- `label`
- `repo`
- `profile`
- `inputs`
- `context_from`
- `outputs`
- `timeout_sec`

Managed workflows are autonomous by default. A checkpoint appears only when the authored `approval_policy` explicitly enables one.

## `deep_research`

Use for:

- multi-track investigation
- contradiction handling
- sourced final reports

Key authored intent:

- `brief.question`
- `brief.objective`
- optional `brief.audience`
- optional `brief.scope_cues`
- optional `brief.success_bar`
- `context_policy.web`
- `context_policy.files`
- `context_policy.apps`
- optional `context_policy.allow_domains`
- optional `context_policy.deny_domains`
- optional `context_policy.preferred_sources`
- optional `approval_policy.require_plan_approval`
- `strategy.depth`
- `strategy.coverage_mode`
- `strategy.followup_passes`
- `strategy.final_critique`
- `delivery.format`
- `delivery.citation_style`
- optional `delivery.sections`
- optional `runtime.max_concurrency`

Think through:

- whether the question is actually research-grade rather than simple lookup
- which sources are allowed or required
- how much breadth versus depth the final report needs
- what the downstream consumer needs from the final report

Defaults and behavior:

- plan approval is off by default
- final critique is off by default
- research breadth is derived from `strategy.depth`
- `runtime.max_concurrency` caps execution concurrency only

Typical artifacts:

- `research-brief.md`
- `research-plan.md`
- `research-plan.json`
- `interim-findings.jsonl`
- `source-ledger.json`
- `uncertainties.md`
- `final-report.md`

## `spec_design`

Use for:

- repo-first architecture and design work
- alternatives and tradeoffs
- implementation-ready specs

Key authored intent:

- `brief.problem`
- `brief.goal`
- optional `brief.audience`
- optional `brief.constraints`
- optional `brief.decision_drivers`
- optional `brief.scope`
- `context_policy.repo_first`
- `context_policy.allow_web_fallback`
- optional `context_policy.web_triggers`
- optional `context_policy.allow_domains`
- optional `approval_policy.require_direction_approval`
- `strategy.alternatives`
- `strategy.critique_profiles`
- `strategy.max_revision_cycles`
- `delivery.format`
- optional `delivery.sections`
- optional `runtime.max_concurrency`

Think through:

- whether the problem is sufficiently grounded in the current repo
- which constraints and decision drivers actually matter
- what makes the output implementation-ready rather than just descriptive
- whether a downstream execution workflow will consume the resulting design package

Defaults and behavior:

- direction approval is off by default
- repo-first inspection is on by default
- external research only appears when `allow_web_fallback` is enabled
- revision stays autonomous unless approval is explicitly authored

Typical artifacts:

- `design-brief.md`
- `current-state.md`
- `information-gaps.md`
- `direction-proposal.md`
- `tradeoff-matrix.md`
- `design-spec.md`
- `decision-log.md`
- `implementation-readiness.md`

## `execute_spec`

Use for:

- executing an existing spec
- planning before mutation
- validation-led implementation

Key authored intent:

- optional `brief.objective`
- optional `brief.scope`
- `spec_source`
- `context_policy.allow_official_docs_fallback`
- optional `context_policy.allow_domains`
- optional `approval_policy.require_execution_plan_approval`
- `strategy.single_writer`
- `strategy.allow_readonly_recon`
- `strategy.max_repair_cycles`
- `validation.commands`
- optional `validation.required`
- `delivery.write_handoff`
- `delivery.write_validation_ledger`
- `delivery.write_repair_log`

Think through:

- whether the spec source is complete enough to execute
- whether the validation plan is concrete and local to the mutation boundary
- whether a checkpoint is truly desired before mutation
- what final handoff artifacts later nodes or operators will need

Defaults and behavior:

- execution-plan approval is off by default
- read-only recon is on by default
- repair is bounded by `strategy.max_repair_cycles`
- `single_writer` must remain `true` in this release

Typical artifacts:

- `spec-packet.json`
- `execution-plan.md`
- `file-plan.md`
- `mutation-boundary.md`
- `validation-plan.md`
- `handoff.md`
- `validation-ledger.json`
- `repair-log.md`

## `review_change`

Use for:

- evidence-based review of a diff or change packet
- specialized reviewer fan-out
- calibrated findings

Key authored intent:

- optional `brief.review_goal`
- optional `brief.focus`
- optional `brief.audience`
- optional `brief.scope`
- `review_source`
- `context_policy.include_surrounding_code`
- `context_policy.include_tests`
- `context_policy.include_docs`
- `context_policy.include_validation`
- `strategy.reviewer_profiles`
- `strategy.severity_policy`
- `strategy.include_surrounding_context`
- `strategy.false_positive_challenge`
- `strategy.require_file_references`
- `delivery.write_review_summary`
- `delivery.write_raw_findings`
- `delivery.write_calibrated_findings`
- optional `runtime.max_concurrency`

Think through:

- whether the review source is rich enough to support strong findings
- which reviewer profiles matter for this change
- how strict severity calibration should be
- whether the final consumer needs machine-readable findings, prose summary, or both

Defaults and behavior:

- review is read-only
- there are no approval checkpoints by default
- reviewer fan-out is derived from `strategy.reviewer_profiles`
- publication always includes merged findings

Typical artifacts:

- `review-packet.json`
- `raw-findings.json`
- `merged-findings.json`
- `calibrated-findings.json`
- `review-summary.md`

## Common mistakes

- putting runtime concurrency or scheduler math in `strategy`
- using managed workflows for tiny one-step tasks
- omitting `delivery` details and expecting the workflow to guess the final artifact shape
- inserting approval checkpoints when the workflow should run autonomously
- forgetting to validate the graph after filling the workflow fields
