# Managed Patterns

Managed patterns are authored shortcuts for common outcome-oriented workflows. They compile into normal Agentflow primitive nodes, preserve one public authored node id, and publish named artifacts through the same `artifacts` contract as agent nodes.

Use a managed pattern when the operator wants a known lifecycle with inspectable lowered nodes. Use primitive nodes or common authored patterns when the workflow is one-off or needs exact custom control.

## Shared Contract

Managed nodes use regular node fields:

- `intent`
- `support.context`
- `artifacts`
- `runtime` for repo/profile selection
- normal agent option fields such as `sandbox`, `model`, `reasoning_effort`, and `artifact_repair`
- `support` for node-local context, selected skills, managed tools, capabilities, and CLI hints; managed tools are exposed only to the pattern's agent steps

Every managed pattern publishes public artifacts from the authored node id. Default artifacts depend on the pattern:

- `pattern_deep_research`: `summary`.
- `pattern_deep_work`: `summary` and `packet`.
- `pattern_work_list`: `summary`, `packet`, and `work_items`.

Authored artifacts merge with defaults for patterns that support authored artifacts. Internal artifacts remain readable in the run tree as implementation evidence, but downstream nodes should reference only graph-addressable artifacts such as `my_research.summary`, `my_work.packet`, or `my_work_list.work_items`.

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

The pattern runs authored angles in parallel, synthesizes Markdown research reports in balanced batches of at most three inputs, then publishes one summary. The summary is the complete research handoff, not a high-level abstract. Raw angle reports remain readable in the run tree and are linked from the summary for progressive disclosure. Synthesis reports remain internal run evidence for the publisher; they preserve major findings, collapse redundancy, keep provenance attached to claims, and surface uncertainty or conflicts without becoming downstream evidence links. Deep research is useful for product research, architecture research, implementation research, and multi-axis code review.

The final publisher rewrites the angle evidence into a coherent, sufficiently detailed, conflict-resolved summary. After the publisher writes it, Agentflow deterministically prepends raw angle report paths, so downstream nodes reference `my_research.summary`; if they need raw detail, they follow the summary evidence table to the linked raw angle reports.

Angle and synthesis workers may mention related findings from other reports, but they should not create cross-angle links. The runtime-owned summary evidence table is the only raw angle link surface.

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

Criteria weights must sum to `1`. Required criteria are hard blockers. Each cycle plans the next move, generates and validates a candidate, grades completion criteria, writes a completion scorecard, and retries with feedback until the score reaches `pass_threshold` or `max_cycles` is exhausted.

### `pattern_work_list`

Use when the job is “plan the ordered work items, freeze the list, then work through each item.”

Add:

```json
{
  "work_list": {
    "planning_goal": "Discover the ordered work items needed to satisfy this node contract.",
    "item_guidance": {
      "what_counts_as_one_item": "One coherent reviewable unit of work with its own evidence handoff.",
      "done_when": [
        "The item goal is satisfied.",
        "Relevant validation has been run or clearly explained.",
        "The item handoff records evidence, risks, and downstream implications."
      ]
    },
    "item_worker": {
      "kind": "agent"
    }
  }
}
```

The pattern runs a planner, deterministically freezes `work-list.json`, runs frozen items sequentially, verifies that every frozen item completed, then publishes `summary`, `packet`, and `work_items`. Use `item_worker.kind: "deep_work"` when item execution needs completion criteria and bounded retry semantics over the frozen list.

`pattern_work_list` is generic. It does not know about branches, PRs, migrations, APIs, or UI. Those belong in the node intent, item guidance, and downstream artifacts.

## Supervisor Role

Managed patterns do not have a second supervisor. The normal runtime supervisor still handles internal node failures: context repair, harness failure, artifact repair, malformed grader output, environment issues, workspace cleanup, and recoverable validation strategy failures.

Managed workflows emit `managed.progress` events at their internal boundaries so operators can see whether the pattern is moving, receiving ordinary feedback, or approaching a terminal boundary. These events are monitoring evidence; they do not create a second supervisor loop.

For `pattern_deep_work`, a failed command criterion, low rubric score, or weak artifact is normal loop feedback and does not spend supervisor budget while the managed loop still has cycles available. Runtime failures still go to the normal supervisor: context repair, harness failure, artifact repair, malformed evaluator output, environment issues, workspace cleanup, and recoverable validation strategy failures. When the managed repeat exhausts its allowed cycles, Agentflow records a `managed.progress` exhaustion event, persists the completion packet with scorecard blockers/regressions, and gives the normal supervisor one chance to recover if it can produce a real material delta. If there is no material delta, the managed node fails with scorecard evidence and downstream work remains blocked.

## Validation

Use:

```bash
agentflow validate --graph agentflow.graph.json --show-compiled
```

Inspect:

- `lowered_managed_nodes`
- generated primitive node kinds
- public artifact declarations
- deep work repeat limits
- deep research balanced synthesis layers
- completion criteria
- supervisor budgets and delivery-compatible artifacts
