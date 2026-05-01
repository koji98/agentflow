# Pattern Review Change

`pattern_review_change` reviews a change package with specialized reviewer roles, merges duplicate findings, calibrates severity, and publishes a low-noise review package.

Use it when review quality matters more than a single generic critique.

## Contract

Required fields:

- `type`: `"pattern_review_change"`
- `id`
- `review_source`
- `brief.review_goal`

Review source options:

- `review_source.kind: "managed_node"` with `node`
- `review_source.kind: "artifact_bundle"` with file or artifact entries

Common fields:

- `repo`
- `profile`
- `context`
- `context_policy`
- `strategy.reviewer_profiles`
- `strategy.severity_policy`
- `strategy.false_positive_challenge`
- `strategy.require_file_references`
- `delivery.sections`
- `runtime.max_concurrency`

## Published Artifacts

- `review_summary`: human-readable review result.
- `review_bundle`: machine-readable review packet.
- `raw_findings`: unmerged reviewer findings.
- `calibrated_findings`: deduplicated and severity-calibrated findings.
- `recommended_actions`: next actions for the operator.

## Runtime Shape

The pattern lowers into a sequence that:

1. Prepares the review packet.
2. Plans reviewer focus.
3. Fans out reviewer profiles.
4. Aggregates raw findings.
5. Merges duplicates.
6. Calibrates severity and confidence.
7. Publishes the review package.

## Example

```json
{
  "type": "pattern_review_change",
  "id": "checkout_timeout_review",
  "repo": "main",
  "profile": "review",
  "review_source": {
    "kind": "managed_node",
    "node": "checkout_timeout_impl"
  },
  "brief": {
    "review_goal": "Find correctness, test, and maintainability risks before handoff.",
    "focus": ["correctness", "tests", "maintainability"],
    "audience": "engineering",
    "scope": {
      "paths": ["src/checkout/**", "tests/checkout/**"],
      "areas": ["timeout behavior", "retry behavior"]
    }
  },
  "strategy": {
    "reviewer_profiles": ["correctness", "testing", "maintainability"],
    "severity_policy": "balanced",
    "false_positive_challenge": true,
    "require_file_references": true
  },
  "delivery": {
    "format": "review_summary",
    "sections": ["findings", "severity_summary", "recommended_actions"]
  }
}
```

Review findings should include precise file references when the source material supports them.
