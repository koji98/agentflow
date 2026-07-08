# Composition Model

Compose Agentflow graphs from a small set of verbs. Choose the verb by product fit, not orchestration style.

| Verb | Meaning | Use For |
| --- | --- | --- |
| `pattern_deep_research` | Gather context deeply, compare, synthesize, preserve uncertainty. | Planning, understanding, architecture research, review, postmortems. |
| `pattern_candidate_selection` | Compare authored candidate strategies against shared criteria and publish deterministic selection evidence. | Choosing among known implementation or architecture strategies before downstream work. |
| `pattern_deep_work` | Work, validate, critique, and fix within a bounded loop. | Implementation, migrations, docs plus code, repairs. |
| `pattern_work_list` | Plan a finite ordered list, freeze it, execute each item, and publish a stable handoff. | Outcomes where the item count is only knowable after discovery and each item has independent product value, such as migration batches, documentation passes, audit findings, or genuinely reviewable implementation slices. |
| `pattern_map_reduce` | Plan a finite independent item set, freeze it, judge or process each item with the same contract, and publish aggregate evidence. | Read-mostly audits, classifications, inventories, policy checks, review sweeps, or write-partitioned refactors where each item owns exact disjoint paths and prior item state does not matter. |
| Deterministic `check` | Prove a stable fact. | Existing tests, build, typecheck, lint, smoke, schema validation. |
| `checkpoint` | Planned human judgment. | Scope, product, release, credential, or authority choices. |
| Plugin | Reusable capability. | Repeated workflow/tool behavior, auth isolation, stable I/O, policy. |

Default ladder:

- Fast: `deep_work -> existing deterministic checks`
- Balanced: `deep_research plan -> deep_work -> checks`
- Strategy choice: `deep_research discover candidates -> pattern_candidate_selection -> deep_work -> checks`
- High-assurance: `deep_research plan -> deep_work -> deep_research review -> deep_work fix -> checks`
- Variable item count with independent item value: `deep_research scope -> pattern_work_list -> review/checks`
- Independent item audit or disjoint-file refactor: `pattern_map_reduce -> review/checks`
- Exploration: `deep_research investigate -> checkpoint or decision artifact`
- Learning loop: `run -> run-review -> plugin/eval/docs/skill extraction`

Collapse the ladder when cost matters and risk is low. Expand it when ambiguity, trust, or correctness risk is high.

Do not split one coherent implementation into a work list just because it has multiple steps. Prefer `agent` or `pattern_deep_work` when one worker needs the whole current state and final user intent in view to finish the product.

Do not use candidate selection to invent the candidate set. Use deep research first when options need discovery, then author candidate intents for the strategies worth comparing. Downstream work should consume `selection`, not internal candidate or scorecard artifacts.

Do not use map-reduce when item order, shared-file edits, cumulative workspace mutation, or prior item evidence is part of correctness. Disjoint owned-path writes are acceptable only with explicit item ownership and downstream checks for out-of-scope edits. Prefer `pattern_work_list` for ordered item completion and `pattern_deep_work` for one coherent product.
