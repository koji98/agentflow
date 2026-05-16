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
- `packet`: machine-readable answer, findings, evidence, sources, uncertainty, confidence, and next actions.

Authors cannot add arbitrary `artifacts` to `pattern_deep_research`. Use a downstream `agent` node when a workflow needs a custom synthesized deliverable.

Deep research collapses graph-addressable output by default into `summary` and `packet`. Angle and synthesis artifacts remain readable in the run tree as evidence packets; use `as_artifact: true` when a downstream graph node needs to reference a raw angle report directly. Downstream nodes should reference the authored pattern id, for example `storage_research.summary` or `storage_research.storage_options`, not generated internal angle ids.

## Runtime Shape

The pattern lowers into:

1. Parallel research angle workers.
2. Balanced synthesis layers when there are more than three research packets.
3. Final public artifact publisher.

Each synthesis node consumes at most three research packets. Groups are split as evenly as possible, so seven angles become synthesis groups of `2`, `2`, and `3`, not `3`, `3`, and `1`. Synthesis preserves major findings, collapses duplicate claims, keeps provenance, and carries conflicts or uncertainty forward.

Angle and synthesis artifacts are internal evidence packets in the run tree. They support the final contract but do not need to match final graph-addressable formatting. The final publisher resolves contradictions, cites evidence, captures uncertainty, and writes `summary` and `packet`. Exposed angle artifacts are raw angle reports forwarded by the runtime, not rewritten final-publisher output.

Angles can be authored as strings or objects. Object angles support:

- `id`: stable axis id matching `/^[a-z][a-z0-9_]*$/`
- `prompt`: sentence-style research prompt
- `as_artifact`: optional `true` value that exposes the raw angle report as `<pattern_id>.<angle_id>`

If `as_artifact` is omitted, the angle remains run-tree evidence only and is not addressable by downstream graph nodes. The `packet` includes an angle index with evidence refs and artifact paths for selective inspection.

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
      "The packet preserves evidence, uncertainty, and next actions."
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
