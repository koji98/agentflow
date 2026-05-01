# Pattern Deep Research

`pattern_deep_research` turns explicit investigation angles into a sourced, reviewable research package.

Use it when the team needs grounded discovery before a decision, design, implementation, rollout, or review. It is also appropriate for code review across multiple authored angles, such as correctness, maintainability, security, and release risk.

## Contract

Required fields:

- `type`: `"pattern_deep_research"`
- `id`
- `intent.goal`
- `intent.acceptance_criteria`
- `research.angles`

Common fields:

- `intent.constraints`
- `repo`
- `profile`
- `context`
- `artifacts`

## Public Artifacts

Default public artifacts:

- `summary`: human-readable research answer.
- `packet`: machine-readable answer, findings, evidence, sources, uncertainty, confidence, and next actions.

Authors can add or override artifacts with the normal `artifacts` field. Downstream nodes should reference the authored pattern id, for example `storage_research.summary`, not generated internal angle ids.

## Runtime Shape

The pattern lowers into:

1. Parallel research angle workers.
2. Balanced synthesis layers when there are more than three research packets.
3. Final public artifact publisher.

Each synthesis node consumes at most three research packets. Groups are split as evenly as possible, so seven angles become synthesis groups of `2`, `2`, and `3`, not `3`, `3`, and `1`. Synthesis preserves major findings, collapses duplicate claims, keeps provenance, and carries conflicts or uncertainty forward.

Angle and synthesis artifacts are private evidence packets. They support the final contract but do not need to match final public handoff formatting. The final publisher resolves contradictions, cites evidence, captures uncertainty, honors authored artifact descriptions and required field labels, and writes the declared public artifacts. Downstream nodes should not need to inspect private angle or synthesis artifacts.

## Example

```json
{
  "type": "pattern_deep_research",
  "id": "storage_research",
  "repo": "main",
  "profile": "research",
  "intent": {
    "goal": "Recommend the storage design that best supports resumable supervised runs.",
    "acceptance_criteria": [
      "The recommendation compares viable alternatives.",
      "The packet preserves evidence, uncertainty, and next actions."
    ],
    "constraints": [
      "Repository conventions remain primary authority."
    ]
  },
  "context": [
    {
      "name": "runtime_docs",
      "from": "workspace_glob",
      "path": "docs/technical/*.md",
      "max_files": 8
    }
  ],
  "research": {
    "angles": [
      "Investigate how current runtime artifacts support resume and auditability.",
      "Compare storage alternatives against local-first operation and repository simplicity.",
      "Identify migration, validation, and supervisor recovery risks for the recommended direction."
    ]
  },
  "artifacts": {
    "decision_matrix": {
      "from": "output_dir",
      "path": "decision-matrix.md",
      "description": "Comparison matrix for the storage alternatives."
    }
  }
}
```

Validate with `agentflow validate --graph <path> --show-compiled` and inspect the lowered research fanout before launch.
