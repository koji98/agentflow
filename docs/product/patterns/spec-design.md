# Pattern Spec Design

`pattern_spec_design` turns a problem statement into an implementation-ready design package.

Use it when the implementation should not start until the current system, constraints, alternatives, tradeoffs, and readiness criteria are explicit.

## Contract

Required fields:

- `type`: `"pattern_spec_design"`
- `id`
- `brief.problem`
- `brief.goal`

Common fields:

- `repo`
- `profile`
- `context`
- `context_policy.repo_first`
- `context_policy.allow_web_fallback`
- `approval_policy.require_direction_approval`
- `strategy.alternatives`
- `strategy.critique_profiles`
- `strategy.max_revision_cycles`
- `delivery.sections`
- `runtime.max_concurrency`

## Published Artifacts

- `design_spec`: final human-readable design.
- `design_packet`: machine-readable design summary.
- `direction_proposal`: selected direction and rationale.
- `tradeoff_matrix`: alternatives and tradeoffs.
- `decision_log`: decisions made during design.
- `implementation_readiness`: concrete readiness checklist.
- `critique_merged`: merged critique evidence.
- `quality_review`: final quality gate result.

## Runtime Shape

The pattern lowers into a sequence that:

1. Clarifies the brief.
2. Inspects the repository first.
3. Runs targeted research when the policy allows it.
4. Fans out design options.
5. Chooses a direction.
6. Optionally pauses for direction approval.
7. Drafts the spec.
8. Runs critique and revision cycles.
9. Publishes the design package.

## Example

```json
{
  "type": "pattern_spec_design",
  "id": "supervisor_design",
  "repo": "main",
  "profile": "design",
  "brief": {
    "problem": "Agent runs can fail without enough structured recovery evidence.",
    "goal": "Design supervisor intervention records and delivery package integration.",
    "constraints": ["Keep the authored graph readable."],
    "decision_drivers": ["traceability", "operator control", "maintainability"],
    "scope": {
      "paths": ["src/runtime/**", "src/supervisor/**", "docs/**"],
      "areas": ["runtime", "supervision", "delivery"]
    }
  },
  "context_policy": {
    "repo_first": true,
    "allow_web_fallback": false
  },
  "strategy": {
    "alternatives": 2,
    "critique_profiles": ["architecture", "implementation"],
    "max_revision_cycles": 2
  },
  "delivery": {
    "sections": ["problem", "architecture", "implementation_readiness"]
  }
}
```

Use the published `design_packet` or `implementation_readiness` artifact as the task source for implementation.
