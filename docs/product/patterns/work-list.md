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
- `deep_work`: deep-work style item execution for each frozen item, with per-item criteria, scorecard feedback, semantic verification, and bounded retry semantics described by `completion.max_cycles`, `completion.pass_threshold`, and weighted completion criteria.

Common fields:

- `intent.constraints`
- `runtime`
- `support`
- `artifacts`
- `model`
- `reasoning_effort`
- `sandbox`
- `artifact_repair`

The author does not provide the item schema. The runtime owns item ids, status, and ledger shape. Authors provide the planning goal plus domain-specific item guidance so the planner can decide a finite reviewable list.

## Graph-Addressable Artifacts

Default graph-addressable artifacts:

- `summary`: final human-readable handoff.
- `work_items`: verified machine-readable index of frozen items, completed item outcomes, validation evidence, risks, and downstream implications.

Downstream graph nodes reference stable artifacts such as `my_work_list.work_items`. Dynamic item refs such as `my_work_list.w3` are not part of the graph contract.

## Runtime Shape

The pattern lowers into:

1. A planner agent that writes only `work-list.json`.
2. A deterministic freeze step that validates the list and writes `work-list-frozen.json` plus an initial ledger.
3. A runtime-owned item phase that launches one managed agent execution per frozen item in order.
4. Each item attempt writes `item-handoff.md`, `item-result.json`, and `item-validation.md` in its own execution directory, then receives item-level semantic verification.
5. For `item_worker.kind: "deep_work"`, each item also runs weighted criteria in bounded parallelism, writes a per-item scorecard in stable criterion order, and retries that same item until its gate passes or `max_cycles` is exhausted.
6. A deterministic finalizer that verifies every frozen item completed and writes `work-items.json`.
7. A publisher agent that writes final graph-addressable artifacts and forwards the verified `work_items` artifact.

The runtime freezes the list before item execution. Workers must not add, remove, split, merge, or reorder items while executing. If the list is wrong, the node fails with evidence instead of silently changing scope. Retries are item-local: a failed `w4` retry preserves accepted `w1` through `w3` unless structured evidence shows earlier work is contaminated. Runtime owns item status and ledger updates; item agents produce evidence and handoffs, not checkmarks.

During `agentflow run` and `agentflow resume`, the CLI shows item-lifecycle progress from the managed runtime: item id, retry attempt, status, and title/summary. These are runtime progress events, not authored graph nodes.

On parent `run_items` retry or resume, Agentflow first reuses verified aggregate item results when they exist. If a prior attempt did not reach aggregate publication but did update the runtime ledger with completed item attempts, Agentflow can reconstruct the completed prefix from the ledger and item artifact directories. It still executes items sequentially and never mutates the frozen list.

`work-list.json` must include:

- `planning_summary`
- `ordering_rationale`
- `items[]` with sequential ids, title, goal, acceptance criteria, constraints, validation expectations, handoff focus, and rationale

Each item worker writes `item-result.json` with this shape:

```json
{
  "id": "w1",
  "status": "completed",
  "summary": "Concrete summary of the completed item outcome.",
  "validation": {
    "passed": ["Exact command/check/manual result evidence that passed."],
    "failed_then_fixed": [],
    "unavailable": [],
    "blocked": []
  },
  "risks": [],
  "downstream_implications": []
}
```

`passed`, `failed_then_fixed`, or `unavailable` must include concrete evidence for a completed item. `blocked` is allowed for context, but it is not completion evidence by itself.

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

Make `what_counts_as_one_item` and `done_when` concrete to the domain. For branch stacks, mention branch/base and PR readiness. For migrations, mention batch boundary, rollback, and data validation. For documentation, mention reader outcome, source evidence, and review path.
