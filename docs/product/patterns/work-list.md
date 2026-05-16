# Pattern Work List

`pattern_work_list` plans and executes a bounded list of work items when the graph author knows the outcome, but the correct item count and order are only knowable after discovery.

Use it for “N unknown tasks” inside one authored contract: implementation slices, documentation passes, migration batches, audit findings, cleanup lists, or other ordered work where each item needs evidence and a handoff. Do not use it for unbounded backlog processing or for PR-specific behavior; branches and PRs belong in the item guidance or downstream nodes.

## Contract

Required fields:

- `type`: `"pattern_work_list"`
- `id`
- `intent.goal`
- `intent.acceptance_criteria`
- `work_list.planning_goal`
- `work_list.item_guidance.what_counts_as_one_item`
- `work_list.item_guidance.done_when`
- `work_list.item_worker.kind`

Supported item workers:

- `agent`: one-pass item worker with standard Agentflow orientation, milestones, validation evidence, and item handoff.
- `deep_work`: deep-work style item execution with a frozen-list criteria gate, scorecard feedback, and bounded retry semantics described by `completion.max_cycles`, `completion.pass_threshold`, and weighted completion criteria.

Common fields:

- `intent.constraints`
- `runtime`
- `support`
- `artifacts`
- `model`
- `reasoning_effort`
- `sandbox`
- `artifact_repair`

## Public Artifacts

Default public artifacts:

- `summary`: final human-readable handoff.
- `packet`: final machine-readable packet.
- `work_items`: verified machine-readable index of frozen items, completed item outcomes, validation evidence, risks, and downstream implications.

Downstream graph nodes reference stable artifacts such as `my_work_list.work_items`. Dynamic item refs such as `my_work_list.w3` are not part of the graph contract.

## Runtime Shape

The pattern lowers into:

1. A planner agent that writes `work-list.md` and `work-list.json`.
2. A deterministic freeze step that validates the list and writes `work-list-frozen.json` plus an initial ledger.
3. An item worker agent that executes every frozen item sequentially and writes item handoffs/results.
4. For `item_worker.kind: "deep_work"`, a completion loop runs weighted criteria, writes a scorecard, and retries item execution over the frozen list until the gate passes or `max_cycles` is exhausted.
5. A deterministic finalizer that verifies every frozen item completed and writes `work-items.json`.
6. A publisher agent that writes final public artifacts and forwards the verified `work_items` artifact.

The runtime freezes the list before item execution. Workers must not add, remove, split, merge, or reorder items while executing. If the list is wrong, the node fails with evidence instead of silently changing scope. In `deep_work` mode, retries happen against the frozen list; the runtime does not allow later cycles to mutate item ids or order.

## Example

```json
{
  "type": "pattern_work_list",
  "id": "bounded_delivery",
  "runtime": {
    "repo": "main",
    "profile": "default"
  },
  "intent": {
    "goal": "Deliver the bounded work needed for the feature.",
    "acceptance_criteria": [
      "The work list is frozen before execution starts.",
      "Every item is completed with validation evidence.",
      "The final handoff summarizes completed work, risks, and downstream constraints."
    ],
    "constraints": ["Do not add unrelated cleanup."]
  },
  "work_list": {
    "planning_goal": "Discover the ordered work items needed to satisfy this node contract.",
    "item_guidance": {
      "what_counts_as_one_item": "One coherent reviewable unit of work with its own evidence handoff.",
      "done_when": [
        "The item goal is satisfied.",
        "Relevant validation has been run or clearly explained.",
        "The item handoff records changes/results, evidence, risks, and downstream implications."
      ]
    },
    "item_worker": {
      "kind": "agent"
    }
  }
}
```

For higher-risk work lists, use `deep_work` when the frozen list needs rubric or command criteria before it can publish:

```json
"item_worker": {
  "kind": "deep_work",
  "completion": {
    "max_cycles": 3,
    "pass_threshold": 0.85,
    "criteria": [
      {
        "id": "item_contract",
        "kind": "rubric",
        "target": "workspace",
        "rubric": "The current item satisfies its frozen item contract without violating the parent node contract.",
        "weight": 0.6,
        "required": true
      },
      {
        "id": "handoff_quality",
        "kind": "rubric",
        "target": "item_handoff",
        "rubric": "The item handoff cites concrete evidence, validation, risks, and downstream implications.",
        "weight": 0.4
      }
    ]
  }
}
```

Work-list rubric criteria support `target: "workspace"` for the current workspace candidate, `target: "item_handoff"` for the item handoff evidence, and `target: "work_list_ledger"` for the frozen-list ledger.
