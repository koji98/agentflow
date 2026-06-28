# Managed Patterns

Managed patterns are authored shortcuts for common outcome-oriented workflows. They compile into normal Agentflow primitive nodes, preserve one graph-addressable authored node id, and publish named artifacts through the same `artifacts` contract as agent nodes.

Use a managed pattern when the operator wants a known lifecycle with inspectable lowered nodes. Use primitive nodes or common authored patterns when the workflow is one-off or needs exact custom control.

## Shared Contract

Managed nodes use regular node fields:

- `intent`
- `support.context`
- `artifacts`
- `runtime` for repo/profile selection
- normal agent option fields such as `sandbox`, `model`, `reasoning_effort`, and `artifact_repair`
- `support` for node-local context, selected skills, managed tools, capabilities, and CLI hints; managed tools are exposed only to the pattern's agent steps

Every managed pattern publishes graph-addressable artifacts from the authored node id. Default artifacts depend on the pattern:

- `pattern_deep_research`: `research`.
- `pattern_deep_work`: `packet`.
- `pattern_work_list`: `work_items`.

Authored artifacts merge with defaults for patterns that support authored artifacts. Internal artifacts remain readable in the run tree as implementation evidence, but downstream nodes should reference only graph-addressable artifacts such as `my_research.research`, `my_work.packet`, or `my_work_list.work_items`. Human-readable summaries are graph artifacts only when the workflow's product is a report or the graph explicitly authors a summary artifact.

## Canonical Patterns

### `pattern_deep_research`

Use when the job is “go learn enough and report back.”

Add:

```json
{
  "research": {
    "angles": [
      "Investigate whether the implementation follows the repo's established architecture.",
      "Identify correctness, maintainability, and rollout risks in the proposed change."
    ]
  }
}
```

The pattern runs authored angles in parallel, synthesizes Markdown research reports in balanced batches of at most three inputs, then publishes one `research.md`. The research artifact is the complete research handoff, not a high-level abstract. Raw angle and synthesis reports remain internal run evidence for the publisher; they preserve major findings, collapse redundancy, keep source-level provenance attached to claims, and resolve or surface uncertainty and conflicts without becoming downstream context contracts. Deep research is useful for product research, architecture research, implementation research, and multi-axis code review.

The final publisher rewrites the angle and synthesis evidence into one coherent, sufficiently detailed, conflict-resolved research report with citations to original source evidence, not internal report artifacts. Downstream nodes reference `my_research.research`; if a detail matters downstream, it belongs in that report.

Angle and synthesis workers may mention related findings from other reports, but they should not create cross-angle links or companion graph-addressable files.

### `pattern_deep_work`

Use when the job is “work, validate, critique, and fix until done.”

Add:

```json
{
  "completion": {
    "max_cycles": 3,
    "pass_threshold": 0.85,
    "criteria": [
      {
        "id": "focused_tests",
        "kind": "command",
        "command": "npm test -- tests/checkout",
        "weight": 0.4,
        "required": true
      },
      {
        "id": "acceptance_rubric",
        "kind": "rubric",
        "target": "workspace",
        "rubric": "The workspace satisfies the goal and acceptance criteria without violating constraints.",
        "weight": 0.4
      },
      {
        "id": "handoff_quality",
        "kind": "rubric",
        "target": "artifact:summary",
        "rubric": "The summary clearly describes changes, validation evidence, and residual risks.",
        "weight": 0.2
      }
    ]
  }
}
```

Criteria weights must sum to `1`. Required criteria are hard blockers. `pass_threshold` gates both the weighted total score and every required criterion score, so a required criterion below threshold retries even if the evaluator returned `passed: true`. Each cycle plans the next move, generates and validates a candidate, grades completion criteria, writes a completion scorecard, and retries with feedback until the score reaches `pass_threshold` or `max_cycles` is exhausted. Use optional `phases.plan`, `phases.execute`, `phases.verify`, and `phases.publish` overrides when those phases need additive intent, support/context, profile, model, reasoning effort, or sandbox posture. Phase intent appends to the parent contract; it never replaces the goal, weakens constraints, changes criteria, or switches repos.

### `pattern_work_list`

Use when the job is “plan the ordered work items, freeze the list, then work through each item.”

Add:

```json
{
  "work_list": {
    "planning_goal": "Discover the ordered work items needed to satisfy this node contract.",
    "item_guidance": {
        "what_counts_as_one_item": "One coherent reviewable unit of work with its own structured evidence.",
        "done_when": [
          "The item goal is satisfied.",
          "Relevant validation has been run or clearly explained.",
          "The item result records evidence, risks, and downstream implications."
        ]
    },
    "item_worker": {
      "kind": "agent"
    }
  }
}
```

The pattern runs a planner that writes only `work-list.json`, deterministically freezes it, launches one managed item execution per frozen item, verifies each item, then writes the runtime-owned `work_items` artifact. It skips a publisher when `work_items` is the only public artifact. Use `item_worker.kind: "deep_work"` when each item needs plan, execute, verify, scorecard feedback, and bounded retry semantics. Deep-work item phases mirror top-level `pattern_deep_work.phases`: phase intent/support/model/reasoning/sandbox/profile overrides are additive and phase-local. The default item finalization path promotes the accepted `draft-item-result.json` to `item-result.json` without LLM rewriting. `pass_threshold` gates the weighted item score and every required criterion score, so a required criterion below threshold keeps the item in retry even if the evaluator marked that criterion passed. Retries are item-local; accepted earlier items remain ledger evidence unless structured recovery evidence says they are contaminated. If `draft-item-result.json`, `item-result.json`, aggregate item results, or final work-item ledgers violate the runtime contract, Agentflow records a managed contract failure with exact artifact and retry-boundary evidence instead of converting the issue into vague retry guidance.

`pattern_work_list` is generic. It does not know about branches, PRs, migrations, APIs, or UI. Those belong in the node intent, item guidance, and downstream artifacts.

## Supervisor Role

Managed patterns do not have a second supervisor. The normal runtime supervisor still handles internal node failures: context repair, harness failure, artifact repair, malformed grader output, environment issues, workspace cleanup, and recoverable validation strategy failures.

Managed workflows emit `managed.progress` events at their internal boundaries so operators can see whether the pattern is moving, receiving ordinary feedback, or approaching a terminal boundary. These events are monitoring evidence; they do not create a second supervisor loop.

For managed repeats and work-list item retries, failed loop-body attempts without authored failure continuations and failed gate checks are normal managed feedback and do not spend supervisor budget while cycles remain. Runtime failures still go to the normal supervisor after the managed boundary exhausts: context repair, harness failure, artifact repair, malformed evaluator output, environment issues, workspace cleanup, and recoverable validation strategy failures. When a managed boundary exhausts its allowed cycles, Agentflow records `managed.progress` evidence, persists completion evidence with blockers/regressions, and gives the normal supervisor one chance to recover if it can produce a real material delta. If there is no material delta, the managed node fails with evidence and downstream work remains blocked.

## Validation

Use:

```bash
agentflow validate --graph agentflow.graph.json --show-compiled
```

Inspect:

- `lowered_managed_nodes`
- generated primitive node kinds
- graph-addressable artifact declarations
- deep work repeat limits
- deep research balanced synthesis layers
- completion criteria
- supervisor budgets and delivery-compatible artifacts
