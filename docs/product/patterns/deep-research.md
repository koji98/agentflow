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

Fixed public artifact:

- `summary`: complete, human-readable research handoff.

Authors cannot add arbitrary `artifacts` to `pattern_deep_research`. Use a downstream `agent` node when a workflow needs a custom synthesized deliverable.

Deep research always collapses graph-addressable output into `summary`. This is not a shallow abstract; it is the canonical, holistic research handoff that downstream work should be able to use first. Angle and synthesis artifacts remain readable in the run tree as raw Markdown evidence, and Agentflow prepends raw angle report links to the summary so downstream readers can progressively disclose detail when needed. Downstream nodes should reference the authored pattern id, for example `storage_research.summary`, not generated internal angle ids.

Each angle is controlling for its worker. Write angles as specific lenses with evidence boundaries, not broad restatements of the parent goal. The parent goal gives context; the assigned angle decides what the worker optimizes for.

## Runtime Shape

The pattern lowers into:

1. Parallel research angle workers.
2. Balanced synthesis layers when there are more than three research reports.
3. Final public artifact publisher.

Each synthesis node consumes at most three research reports. Groups are split as evenly as possible, so seven angles become synthesis groups of `2`, `2`, and `3`, not `3`, `3`, and `1`. Synthesis preserves major findings, collapses duplicate claims, keeps provenance, and carries conflicts or uncertainty forward.

Angle and synthesis artifacts are internal Markdown evidence in the run tree. They support the final contract but do not need to match final graph-addressable formatting. Research helpers treat the repo workspace as read-only evidence: they may inspect files and run local validation, but they must not create scratch report files or source edits in the repo. The runtime treats workspace mutations from deep-research helpers as workspace pollution.

The final publisher resolves contradictions, cites evidence, captures uncertainty, and writes `summary`. The summary is the public front door and the full research handoff: after the publisher writes it, Agentflow deterministically prepends an evidence table mapping every authored angle to its raw report path. The publisher's content should rewrite the angle findings into one coherent, sufficiently detailed, conflict-resolved answer.

Angle and synthesis workers may reference related angle findings in prose, but they should not create links to other angle reports. The runtime-owned summary evidence table is the only raw angle link surface.

Angles can be authored as strings or objects. Object angles support:

- `id`: stable axis id matching `/^[a-z][a-z0-9_]*$/`
- `prompt`: sentence-style research prompt

Every angle is always included in the summary evidence table. If a downstream node needs raw angle detail, it follows the linked path from `summary`; the stable graph contract remains the summary artifact.

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
        "prompt": "Compare storage alternatives against local-first operation and repository simplicity."
      },
      "Identify migration, validation, and supervisor recovery risks for the recommended direction."
    ]
  }
}
```

Validate with `agentflow validate --graph <path> --show-compiled` and inspect the lowered research fanout before launch.
