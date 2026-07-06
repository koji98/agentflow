# Managed Patterns

Use managed patterns when the lifecycle is standard and the pattern fit improves the final product outcome. The prompts should still read like native-quality worker briefs: task contract first, phase or item focus second, and Agentflow mechanics behind runtime state, `af orient`, and verification.

## `pattern_deep_research`

Use when the task is "go learn enough and report back."

Good for:

- planning before implementation
- understanding an unfamiliar area
- comparing approaches
- reviewing a work product
- run postmortems

Angles should be controlling axes, not generic subtopics. Good angles name the assigned lens and evidence boundary, such as product contract, privacy/access contract, API convention fit, UI workflow rehearsal, correctness findings, code-quality findings, or risk register.

The stable output is always `research`, written at `research.md`. That report is the complete research handoff, not a high-level abstract. Raw angle reports remain run evidence and may conflict; the final publisher rewrites them into one coherent, sufficiently detailed answer. Synthesis reports are working evidence for the publisher, not downstream evidence links. There is no final `packet` artifact for deep research.

Angle and synthesis workers may reference related findings in prose, but they should not create cross-angle links or companion public files. If a detail matters downstream, it belongs in `research.md`.

Deep-research helpers should be authored as evidence gatherers, not implementation workers. They run in disposable investigation workspaces, so they may use temporary exploratory edits only when useful for investigation. Those edits are discarded and must not be presented as delivered implementation changes.

## `pattern_deep_work`

Use when the task is "work, validate, critique, and fix until done" for one coherent work product.

Good for:

- implementation
- migration
- focused repair
- docs plus code changes
- bounded cleanup

Completion criteria should mix hard commands when stable and rubric criteria when correctness is semantic. Required criteria are blockers. Weights should reflect the evidence that matters, not equal distribution by habit. For code work, include convention fit, no AI slop, validation evidence, and handoff quality when those are material to success.

Use `phases.plan`, `phases.execute`, `phases.verify`, and `phases.publish` only when those phases need additive intent, context/support, model, reasoning effort, or sandbox posture that differs from the parent. Phase overrides inherit the parent contract; they should sharpen a phase, not redefine the task.

## `pattern_work_list`

Use when the task is "discover the finite list, freeze it, then work the list to a stable handoff" and the item boundaries have independent product value.

Good for:

- reviewable implementation slices only when each slice can be completed, judged, and reused independently
- migration batches
- documentation passes
- audit findings
- cleanup lists with bounded scope

Author `what_counts_as_one_item` and `done_when` in domain terms. If items are PR branches, say branch/base/PR readiness; if migrations, say batch boundary, rollback, and validation; if docs, say reader outcome and review evidence. Do not hard-code the item count when discovery owns it.

The planner writes only `work-list.json`; runtime validates sequential `w1`, `w2`, `w3` ids and freezes the list before execution. Runtime then launches one managed item execution per frozen item. Agents do not check off items manually. Runtime records item status in the ledger and publishes the stable `work_items` artifact.

Use `item_worker.kind: "agent"` for one-pass item execution. Use `item_worker.kind: "deep_work"` when each item needs plan/execute/verify/publish phases, criteria, scorecard feedback, item-level semantic verification, and bounded retries before publishing. Deep-work item workers may set optional `item_worker.phases.plan/execute/verify/publish` with the same additive semantics as top-level `pattern_deep_work.phases`: phase intent appends to the parent/item contract, phase support merges only for that phase, and phase model/reasoning/sandbox/profile applies only to that phase. Work-list rubric criteria can target `workspace`, `item_handoff`, or `work_list_ledger`.

Downstream nodes should reference stable artifacts such as `my_work_list.work_items`; do not depend on dynamic item ids like `my_work_list.w3`.

## `pattern_map_reduce`

Use when the task is "find the finite independent item set, judge or process each item the same way, and publish aggregate evidence."

Good for:

- read-only or read-mostly audits
- classifications
- inventory checks
- documentation or API surface review sweeps
- policy checks where every item can be judged independently
- write-partitioned refactors where each frozen item owns exact disjoint files or file sets

Author three additive sub-intents:

- `map_reduce.items.intent`: what finite units are in scope.
- `map_reduce.map.intent`: what one worker must determine for exactly one current item.
- `map_reduce.reduce.intent`: what the aggregate must prove and what coverage it must not overclaim.

Use `map_reduce.items.max_items` to bound discovery and `map_reduce.map.max_concurrency` to bound fan-out. Do not invent item worker modes, reducer modes, dynamic item refs, custom public artifacts, or implicit shared mutation. The stable output is `aggregate`.

For write-partitioned refactors, put owned paths in each item input, constrain map workers to the current item's owned paths, require changed-path and validation evidence in the item result, and add downstream checks for out-of-scope edits plus global correctness. V1 does not automatically enforce owned-path write boundaries.

Use `pattern_work_list` instead when order, prior item evidence, shared or cumulative workspace mutation, item-local retries, or item-level deep-work criteria matter. Use `pattern_deep_work` when the task is one coherent feature or repair.

## Avoid

- Using managed patterns to hide vague requirements.
- Using `pattern_work_list` for a coherent implementation task where item splitting makes local compliance easier but final completion less likely.
- Using `pattern_map_reduce` when items need to build on earlier item results, edit shared files, or mutate cumulative shared state.
- Depending on generated internal ids.
- Adding deterministic command criteria for speculative scripts.
- Using deep research where the implementation agent can cheaply discover local context inside its node boundary.
