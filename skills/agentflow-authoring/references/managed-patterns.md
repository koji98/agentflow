# Managed Patterns

Use managed patterns when the lifecycle is standard and the operator wants inspectable lowered nodes with public artifacts.

## `pattern_deep_research`

Use when the task is "go learn enough and report back."

Good for:

- planning before implementation
- understanding an unfamiliar area
- comparing approaches
- reviewing a work product
- run postmortems

Angles should be sentence-style prompts. Graph-addressable outputs are `summary`, `packet`, and any angle reports selected with `as_artifact: true`. Downstream nodes should reference artifacts from the authored pattern id.

## `pattern_deep_work`

Use when the task is "work, validate, critique, and fix until done."

Good for:

- implementation
- migration
- focused repair
- docs plus code changes
- bounded cleanup

Completion criteria should mix hard commands when stable and rubric criteria when correctness is semantic. Required criteria are blockers. Weights should reflect the evidence that matters, not equal distribution by habit.

## `pattern_work_list`

Use when the task is "discover the finite list, freeze it, then work the list to a stable handoff."

Good for:

- reviewable implementation slices when the exact slice count is unknown upfront
- migration batches
- documentation passes
- audit findings
- cleanup lists with bounded scope

The planner writes `work-list.md` and `work-list.json`; runtime validates sequential `w1`, `w2`, `w3` ids and freezes the list before execution. Agents do not check off items manually. Runtime records item status in the ledger and publishes stable public artifacts: `summary`, `packet`, and `work_items`.

Use `item_worker.kind: "agent"` for one-pass item execution. Use `item_worker.kind: "deep_work"` when the frozen list needs criteria, scorecard feedback, and bounded retries before publishing. Work-list rubric criteria can target `workspace`, `item_handoff`, or `work_list_ledger`.

Downstream nodes should reference stable artifacts such as `my_work_list.work_items`; do not depend on dynamic item ids like `my_work_list.w3`.

## Avoid

- Using managed patterns to hide vague requirements.
- Depending on generated internal ids.
- Adding deterministic command criteria for speculative scripts.
- Using deep research where the implementation agent can cheaply discover local context inside its node boundary.
