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

Angles should be sentence-style prompts. Public outputs should be `summary`, `packet`, and any authored extras. Downstream nodes should reference public artifacts from the authored pattern id.

## `pattern_deep_work`

Use when the task is "work, validate, critique, and fix until done."

Good for:

- implementation
- migration
- focused repair
- docs plus code changes
- bounded cleanup

Completion criteria should mix hard commands when stable and rubric criteria when correctness is semantic. Required criteria are blockers. Weights should reflect the evidence that matters, not equal distribution by habit.

## Avoid

- Using managed patterns to hide vague requirements.
- Depending on generated internal ids.
- Adding deterministic command criteria for speculative scripts.
- Using deep research where the implementation agent can cheaply discover local context inside its node boundary.
