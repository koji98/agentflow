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
- `runtime`
- `support`

## Public Artifacts

Fixed public artifacts:

- `summary`: human-readable research answer.

Authors cannot add arbitrary `artifacts` to `pattern_deep_research`. Use a downstream `agent` node when a workflow needs a custom synthesized deliverable.

Deep research collapses graph-addressable output by default into `summary`. Angle and synthesis artifacts remain readable in the run tree as raw Markdown evidence. Use `as_artifact: true` when a downstream graph node needs a publisher-curated public artifact for that angle. Downstream nodes should reference the authored pattern id, for example `storage_research.summary` or `storage_research.storage_options`, not generated internal angle ids.

Each angle is controlling for its worker. Write angles as specific lenses with evidence boundaries, not broad restatements of the parent goal. The parent goal gives context; the assigned angle decides what the worker optimizes for.

## Runtime Shape

The pattern lowers into:

1. Parallel research angle workers.
2. Balanced synthesis layers when there are more than three research reports.
3. Final public artifact publisher.

Each synthesis node consumes at most three research reports. Groups are split as evenly as possible, so seven angles become synthesis groups of `2`, `2`, and `3`, not `3`, `3`, and `1`. Synthesis preserves major findings, collapses duplicate claims, keeps provenance, and carries conflicts or uncertainty forward.

Angle and synthesis artifacts are internal Markdown evidence in the run tree. They support the final contract but do not need to match final graph-addressable formatting. The final publisher resolves contradictions, cites evidence, captures uncertainty, and writes `summary`. Selected angle artifacts are public outputs owned by the final publisher: they preserve the useful angle evidence, mark superseded raw claims when needed, and must agree with the summary on controlling decisions.

Angles can be authored as strings or objects. Object angles support:

- `id`: stable axis id matching `/^[a-z][a-z0-9_]*$/`
- `prompt`: sentence-style research prompt
- `as_artifact`: optional `true` value that asks the final publisher to create `<pattern_id>.<angle_id>` as a curated public artifact for that angle

If `as_artifact` is omitted, the angle remains run-tree evidence only and is not addressable by downstream graph nodes. Runtime audit indexes link the internal reports for selective inspection. If a downstream node truly needs raw angle evidence, pass it as explicit `support.context` with `what` and `why` that state it is evidence, not the controlling synthesis.

## Example

```json
{
  "type": "pattern_deep_research",
  "id": "storage_research",
  "runtime": {
    "repo": "main",
    "profile": "research"
  },
  "intent": {
    "goal": "Recommend the storage design that best supports resumable supervised runs.",
    "acceptance_criteria": [
      "The recommendation compares viable alternatives.",
      "The summary preserves evidence, uncertainty, and next actions."
    ],
    "constraints": [
      "Do not treat sources outside repository conventions as primary authority."
    ]
  },
  "support": {
    "context": [
      {
        "name": "runtime_docs",
        "kind": "workspace_glob",
        "path": "docs/technical/*.md",
        "max_files": 8,
        "what": "Technical runtime documentation.",
        "why": "It is primary evidence for resumable supervised run design."
      }
    ]
  },
  "research": {
    "angles": [
      "Investigate how current runtime artifacts support resume and auditability.",
      {
        "id": "storage_options",
        "prompt": "Compare storage alternatives against local-first operation and repository simplicity.",
        "as_artifact": true
      },
      "Identify migration, validation, and supervisor recovery risks for the recommended direction."
    ]
  }
}
```

Validate with `agentflow validate --graph <path> --show-compiled` and inspect the lowered research fanout before launch.
