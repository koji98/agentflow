# Managed Patterns

Use managed patterns when the lifecycle is standard and the operator wants inspectable lowered nodes with stable declared artifacts. For how parent fields lower into the actual AI prompts, see `prompt-translation.md`.

## `pattern_deep_research`

Use when the task is "go learn enough and report back."

Good for:

- planning before implementation
- understanding an unfamiliar area
- comparing approaches
- reviewing a work product
- run postmortems

Angles should be controlling axes, not generic subtopics. Good angles name the assigned lens and evidence boundary, such as product contract, privacy/access contract, API convention fit, UI workflow rehearsal, correctness findings, code-quality findings, or risk register.

The stable output is always `research`, written at `research.md`. That report is the complete research handoff, not a high-level abstract. Raw angle reports remain internal run evidence and may conflict; the final publisher owns the downstream contract by rewriting them into one coherent, sufficiently detailed answer. Synthesis reports are internal working notes for the publisher, not downstream evidence links. There is no public `packet` artifact for deep research.

Angle and synthesis workers may reference related findings in prose, but they should not create cross-angle links or companion public files. If a detail matters downstream, it belongs in `research.md`.

Deep-research helpers should be authored as evidence gatherers, not implementation workers. They run in disposable investigation workspaces, so they may use temporary exploratory edits only when useful for investigation. Those edits are discarded and must not be presented as delivered implementation changes.

## `pattern_deep_work`

Use when the task is "work, validate, critique, and fix until done."

Good for:

- implementation
- migration
- focused repair
- docs plus code changes
- bounded cleanup

Completion criteria should mix hard commands when stable and rubric criteria when correctness is semantic. Required criteria are blockers. Weights should reflect the evidence that matters, not equal distribution by habit. For code work, include convention fit, no AI slop, validation evidence, and handoff quality when those are material to success.

Use `phases.plan`, `phases.execute`, `phases.verify`, and `phases.publish` only when those phases need additive intent, context/support, model, reasoning effort, or sandbox posture that differs from the parent. Phase overrides inherit the parent contract; they should sharpen a phase, not redefine the task.

## `pattern_work_list`

Use when the task is "discover the finite list, freeze it, then work the list to a stable handoff."

Good for:

- reviewable implementation slices when the exact slice count is unknown upfront
- migration batches
- documentation passes
- audit findings
- cleanup lists with bounded scope

Author `what_counts_as_one_item` and `done_when` in domain terms. If items are PR branches, say branch/base/PR readiness; if migrations, say batch boundary, rollback, and validation; if docs, say reader outcome and review evidence. Do not hard-code the item count when discovery owns it.

The planner writes only `work-list.json`; runtime validates sequential `w1`, `w2`, `w3` ids and freezes the list before execution. Runtime then launches one managed item execution per frozen item. Agents do not check off items manually. Runtime records item status in the ledger and publishes stable artifacts: `summary` and `work_items`.

Use `item_worker.kind: "agent"` for one-pass item execution. Use `item_worker.kind: "deep_work"` when each item needs plan/execute/verify/publish phases, criteria, scorecard feedback, item-level semantic verification, and bounded retries before publishing. Deep-work item workers may set optional `item_worker.phases.plan/execute/verify/publish` with the same additive semantics as top-level `pattern_deep_work.phases`: phase intent appends to the parent/item contract, phase support merges only for that phase, and phase model/reasoning/sandbox/profile applies only to that phase. Work-list rubric criteria can target `workspace`, `item_handoff`, or `work_list_ledger`.

Downstream nodes should reference stable artifacts such as `my_work_list.work_items`; do not depend on dynamic item ids like `my_work_list.w3`.

## Avoid

- Using managed patterns to hide vague requirements.
- Depending on generated internal ids.
- Adding deterministic command criteria for speculative scripts.
- Using deep research where the implementation agent can cheaply discover local context inside its node boundary.
