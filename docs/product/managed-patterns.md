# Managed Patterns

Managed patterns are authored shortcuts for common outcome-oriented workflows. They compile into normal Agentflow primitive nodes, preserve one public authored node id, and publish named artifacts through the same `artifacts` contract as agent nodes.

Use a managed pattern when the operator wants a known lifecycle with inspectable lowered nodes. Use primitive nodes or common authored patterns when the workflow is one-off or needs exact custom control.

## Shared Contract

Managed nodes use regular node fields:

- `goal`
- `acceptance_criteria`
- `constraints`
- `context`
- `artifacts`
- normal runtime fields such as `repo`, `profile`, `timeout_sec`, `sandbox`, `model`, `reasoning_effort`, `artifact_repair`, and `tools`

Every managed pattern publishes public artifacts from the authored node id. If `artifacts` is omitted, Agentflow provides:

- `summary`: `summary.md`
- `packet`: `packet.json`

Authored artifacts merge with these defaults. Internal artifacts are private implementation evidence; downstream nodes should reference only public artifacts such as `my_research.summary` or `my_work.packet`.

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

The pattern runs authored angles in parallel, synthesizes research packets in balanced batches of at most three inputs, then publishes the public summary, packet, and any authored artifacts. Angle and synthesis artifacts are private evidence packets; the final publisher owns the public artifact shape and required field labels. Synthesis preserves major findings, collapses redundancy, keeps provenance attached to claims, and surfaces uncertainty or conflicts. It is useful for product research, architecture research, implementation research, and multi-axis code review.

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
        "rubric": "The workspace satisfies the goal and acceptance criteria without violating constraints.",
        "weight": 0.4
      },
      {
        "id": "handoff_quality",
        "kind": "artifact_rubric",
        "artifact": "summary",
        "rubric": "The summary clearly describes changes, validation evidence, and residual risks.",
        "weight": 0.2
      }
    ]
  }
}
```

Criteria weights must sum to `1`. Required criteria are hard blockers. Each cycle plans the next move, generates and validates a candidate, grades completion criteria, writes a completion scorecard, and retries with feedback until the score reaches `pass_threshold` or `max_cycles` is exhausted.

## Supervisor Role

Managed patterns do not have a second supervisor. The normal runtime supervisor still handles internal node failures: context repair, harness failure, artifact repair, malformed grader output, environment issues, workspace cleanup, and recoverable validation strategy failures.

For `pattern_deep_work`, a failed command criterion, low rubric score, or weak artifact is normal loop feedback and does not spend supervisor budget. Runtime failures still go to the normal supervisor: context repair, harness failure, artifact repair, malformed evaluator output, environment issues, workspace cleanup, and recoverable validation strategy failures. Max-cycle exhaustion fails the managed node with scorecard evidence unless the supervisor can produce a real material delta.

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
