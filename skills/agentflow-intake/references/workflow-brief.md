# Workflow Brief

Use this as the handoff from `agentflow-intake` to `agentflow-authoring`.

```markdown
# Agentflow Workflow Brief

## Outcome
What should be true when the run is done?

## Why Agentflow
Why this needs supervised execution, durable artifacts, multi-node work, or reusable workflow value.

## Product / User Context
Who uses the result, what decision or workflow it supports, which vocabulary or UX expectations matter, and what existing product patterns must stay familiar.

## Scope
Repos, systems, docs, services, or workflow areas in scope.

## Non-Goals
What the run must not do. These should become `Do not ...` graph or node constraints during authoring.

## Authority
What agents may read, mutate, call, or publish. Name tools, credentials, external services, planned checkpoints, external side-effect approvals, and typed authority boundaries.

## Autonomy
Where agents should inspect and decide the implementation path themselves.

## Quality Bar
Repo conventions, architecture boundaries, simplicity expectations, no-AI-slop requirements, test/review expectations, and design standards.

## Evidence
Required checks, artifacts, rubrics, reports, PRs, delivery files, or eval outputs.

## Review Surface
What a human should review at the end.

## Risk Profile
What could go wrong and where stricter assurance, checkpoints, or review are needed.

## Assurance Profile
Fast, balanced, high-assurance, exploration, or learning loop.

## Open Questions
Anything unresolved before graph authoring.
```

Good briefs specify outcomes, users, quality bars, and boundaries without dictating node internals. Weak briefs prescribe files, scripts, or commands before the desired evidence is stable.
