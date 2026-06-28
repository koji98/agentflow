# Pattern Work List

`pattern_work_list` plans and executes a bounded list of work items when the graph author knows the outcome, but the correct item count and order are only knowable after discovery.

Use it for “N unknown tasks” inside one authored contract: implementation slices, documentation passes, migration batches, audit findings, cleanup lists, or other ordered work where each item needs structured evidence. Do not use it for unbounded backlog processing or for PR-specific behavior; branches and PRs belong in the item guidance or downstream nodes.

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

- `agent`: one-pass item worker with standard Agentflow orientation, milestones, validation evidence, and one structured item result.
- `deep_work`: deep-work style item execution for each frozen item, with per-item plan, execute, verify, deterministic finalization, per-item criteria, scorecard feedback, semantic verification, and bounded retry semantics described by `completion.max_cycles`, `completion.pass_threshold`, and weighted completion criteria.

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

- `work_items`: verified machine-readable index of frozen items, completed item outcomes, validation evidence, risks, and downstream implications.

Downstream graph nodes reference stable artifacts such as `my_work_list.work_items`. Dynamic item refs such as `my_work_list.w3` are not part of the graph contract. Add a human-readable `summary` artifact only when the graph explicitly needs one.

## Runtime Shape

The pattern lowers into:

1. A planner agent that writes only `work-list.json`.
2. A deterministic freeze step that validates the list and writes `work-list-frozen.json` plus an initial ledger.
3. A runtime-owned item phase that launches one managed execution per frozen item in order.
4. For `item_worker.kind: "agent"`, each item attempt writes `item-result.json` in its own execution directory, then receives item-level semantic verification.
5. For `item_worker.kind: "deep_work"`, each item cycle runs item planning, item execution, and item verification criteria. After the item scorecard passes, the runtime promotes the accepted `draft-item-result.json` to final `item-result.json` without an LLM publisher. Failed criteria retry the current item from the next item plan cycle until the gate passes or `max_cycles` is exhausted.
6. A deterministic finalizer that verifies every frozen item completed and writes `work-items.json`.
7. If the graph declares additional final artifacts, a publisher can write those user-authored artifacts while forwarding the verified `work_items` artifact. If `work_items` is the only public artifact, this publisher is skipped.

The runtime freezes the list before item execution. Workers must not add, remove, split, merge, or reorder items while executing. If the list is wrong, the node fails with evidence instead of silently changing scope. Retries are item-local: a failed `w4` retry preserves accepted `w1` through `w3` unless structured evidence shows earlier work is contaminated. Runtime owns item status and ledger updates; item agents produce structured item results, not checkmarks.

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
      "The final work_items artifact records completed work, risks, and downstream constraints."
    ],
    "constraints": ["Do not add unrelated cleanup."]
  },
  "work_list": {
    "planning_goal": "Discover the ordered work items needed to satisfy this node contract.",
    "item_guidance": {
      "what_counts_as_one_item": "One coherent reviewable unit of work with its own structured evidence.",
      "done_when": [
        "The item goal is satisfied.",
        "Relevant validation has been run or clearly explained.",
        "The item result records changes/results, evidence, risks, and downstream implications."
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
        "id": "item_result_quality",
        "kind": "rubric",
        "target": "item_handoff",
        "rubric": "The structured item result cites concrete evidence, validation, risks, and downstream implications.",
        "weight": 0.4
      }
    ]
  }
}
```

`deep_work` item workers may also use optional `phases.plan`, `phases.execute`, `phases.verify`, and `phases.publish` overrides. This is the same additive phase contract as top-level `pattern_deep_work`: phase intent appends to the parent work-list contract and current frozen item contract, phase support is merged with top-level support for that phase only, and phase `model`, `reasoning_effort`, `sandbox`, and `runtime.profile` affect only the matching item phase. The default item finalization path is deterministic, so `phases.publish` is metadata unless a future user-authored final artifact genuinely requires synthesis. Use item phases only for real phase differences; do not copy the parent goal into every phase.

```json
"item_worker": {
  "kind": "deep_work",
  "phases": {
    "plan": {
      "intent": {
        "goal": "Map the current item to concrete evidence and validation before editing."
      }
    },
    "verify": {
      "runtime": {
        "profile": "reviewer"
      },
      "intent": {
        "acceptance_criteria": [
          "Criterion judgments cite the current structured item result, validation evidence, and prior-item ledger when relevant."
        ]
      }
    }
  },
  "completion": {
    "max_cycles": 3,
    "pass_threshold": 0.85,
    "criteria": [
      {
        "id": "item_contract",
        "kind": "rubric",
        "target": "item_handoff",
        "rubric": "The current structured item result proves the frozen item contract is complete.",
        "weight": 1,
        "required": true
      }
    ]
  }
}
```

Work-list rubric criteria support `target: "workspace"` for the current workspace candidate, `target: "item_handoff"` for canonical structured item result evidence, and `target: "work_list_ledger"` for the frozen-list ledger. The `item_handoff` target name is kept for graph-authoring compatibility, but the runtime evidence is the item result. For `deep_work` item workers, `pass_threshold` gates both the item weighted score and every required criterion score; a required criterion below threshold retries the current item even if the evaluator returned `passed: true`.

Make `what_counts_as_one_item` and `done_when` concrete to the domain. For branch stacks, mention branch/base and PR readiness. For migrations, mention batch boundary, rollback, and data validation. For documentation, mention reader outcome, source evidence, and review path.
