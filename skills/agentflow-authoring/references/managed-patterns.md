# Managed Patterns

Use managed patterns when the lifecycle is standard and the operator wants inspectable lowered nodes with public artifacts. For how parent fields lower into the actual AI prompts, see `prompt-translation.md`.

## `pattern_deep_research`

Use when the task is "go learn enough and report back."

Good for:

- planning before implementation
- understanding an unfamiliar area
- comparing approaches
- reviewing a work product
- run postmortems

Angles should be controlling axes, not generic subtopics. Good angles name the assigned lens and evidence boundary, such as product contract, privacy/access contract, API convention fit, UI workflow rehearsal, correctness findings, code-quality findings, or risk register.

Graph-addressable output is `summary` by default. Use object-form angles with `id`, `prompt`, and `as_artifact: true` when downstream nodes need a selected, publisher-curated public artifact for that angle. Raw angle reports remain run-tree evidence and may conflict; the final publisher owns the graph-addressable contract. There is no public `packet` artifact for deep research.

## `pattern_deep_work`

Use when the task is "work, validate, critique, and fix until done."

Good for:

- implementation
- migration
- focused repair
- docs plus code changes
- bounded cleanup

Completion criteria should mix hard commands when stable and rubric criteria when correctness is semantic. Required criteria are blockers. Weights should reflect the evidence that matters, not equal distribution by habit. For code work, include convention fit, no AI slop, validation evidence, and handoff quality when those are material to success.

## `pattern_work_list`

Use when the task is "discover the finite list, freeze it, then work the list to a stable handoff."

Good for:

- reviewable implementation slices when the exact slice count is unknown upfront
- migration batches
- documentation passes
- audit findings
- cleanup lists with bounded scope

Author `what_counts_as_one_item` and `done_when` in domain terms. If items are PR branches, say branch/base/PR readiness; if migrations, say batch boundary, rollback, and validation; if docs, say reader outcome and review evidence. Do not hard-code the item count when discovery owns it.

The planner writes `work-list.md` and `work-list.json`; runtime validates sequential `w1`, `w2`, `w3` ids and freezes the list before execution. Agents do not check off items manually. Runtime records item status in the ledger and publishes stable public artifacts: `summary`, `packet`, and `work_items`.

Use `item_worker.kind: "agent"` for one-pass item execution. Use `item_worker.kind: "deep_work"` when the frozen list needs criteria, scorecard feedback, and bounded retries before publishing. Work-list rubric criteria can target `workspace`, `item_handoff`, or `work_list_ledger`.

Downstream nodes should reference stable artifacts such as `my_work_list.work_items`; do not depend on dynamic item ids like `my_work_list.w3`.

## Avoid

- Using managed patterns to hide vague requirements.
- Depending on generated internal ids.
- Adding deterministic command criteria for speculative scripts.
- Using deep research where the implementation agent can cheaply discover local context inside its node boundary.
