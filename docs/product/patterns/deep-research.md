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

## Graph-Addressable Artifacts

Fixed graph-addressable artifact:

- `research`: complete, human-readable research report at `research.md`.

Authors cannot add arbitrary `artifacts` to `pattern_deep_research`. Use a downstream `agent` node when a workflow needs a custom synthesized deliverable.

Deep research always collapses graph-addressable output into `research`. This is not a shallow abstract; it is the canonical, holistic research report that downstream work should be able to use directly. Angle and synthesis artifacts are internal run evidence for the managed pattern, not downstream context contracts. Downstream nodes should reference the authored pattern id, for example `storage_research.research`, not generated internal angle or synthesis ids.

Each angle is controlling for its worker. Write angles as specific lenses with evidence boundaries, not broad restatements of the parent goal. The parent goal gives context; the assigned angle decides what the worker optimizes for.

## Runtime Shape

The pattern lowers into:

1. Parallel research angle workers.
2. Balanced synthesis layers when there are more than three research reports.
3. Final graph-addressable artifact publisher.

Each synthesis node consumes at most three research reports. Groups are split as evenly as possible, so seven angles become synthesis groups of `2`, `2`, and `3`, not `3`, `3`, and `1`. Synthesis preserves major findings, collapses duplicate claims, keeps provenance, and carries conflicts or uncertainty forward.

Angle and synthesis artifacts are internal Markdown evidence in the run tree. They support the final contract but do not need to match final graph-addressable formatting. Research helpers treat the repo workspace as read-only evidence: they may inspect files and run local validation, but they must not create scratch report files or source edits in the repo. The runtime treats workspace mutations from deep-research helpers as workspace pollution.

The final publisher resolves contradictions, cites evidence, captures uncertainty, and writes exactly one graph-addressable file: `research.md`. That file is the full research report. It should rewrite the angle and synthesis findings into one coherent, sufficiently detailed, conflict-resolved answer without relying on linked raw reports.

Angle and synthesis workers may reference related angle findings in prose, but they should not create links to other angle reports or produce companion graph-addressable files.

Angles can be authored as strings or objects. Object angles support:

- `id`: stable axis id matching `/^[a-z][a-z0-9_]*$/`
- `prompt`: sentence-style research prompt

Every angle should be represented in the final `research.md` content. If detail is important for downstream work, include it in `research.md`; do not rely on internal angle artifacts as the handoff.

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
      "The research report preserves evidence, uncertainty, and next actions."
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
