# Graph Authoring

Author graphs as supervised execution contracts. The graph should say what the team wants, what is in scope, which outcomes matter, which tools are allowed, and what evidence must come back.

## Checklist

- Add `intent.goal`.
- Add `repos` and `profiles` explicitly; use per-node `repo` and `profile` when work spans authority boundaries.
- Add `intent.acceptance_criteria`.
- Add `intent.constraints` for scope boundaries, out-of-scope areas, and high-impact limits.
- Keep nodes outcome-sized and give substantial agent nodes `goal` plus `acceptance_criteria`.
- Give every downstream handoff a named artifact.
- Set `supervision.retry_budget` to match risk.
- Use `workspace_backend: "worktree"` for code-writing work unless the operator intentionally wants in-place execution.

## Authoring Loop

1. Draft the graph from the top-level intent down to nodes.
2. Keep each agent node accountable for an outcome and a small set of named artifacts.
3. Add checks after the work they validate.
4. Resolve plugins when `plugins` is present.
5. Run `agentflow validate --graph <path>`.
6. Run `agentflow validate --graph <path> --run-ready` before launch on this machine.
7. Run `agentflow validate --graph <path> --show-compiled` and inspect profiles, tools, context, artifacts, managed expansions, and supervision.

## Node Sizing

Prefer:

- "Implement checkout timeout handling and publish a change summary."
- "Review the change package for correctness, tests, and maintainability."
- "Design the runtime delivery package contract."

Avoid graphs where every small edit is a separate agent node. Strong harnesses should inspect, plan, implement, run targeted checks, and repair inside the node's accountable boundary.

## Context And Artifacts

Use `context` to provide:

- operator text
- workspace files
- workspace globs
- upstream named artifacts

Use `artifacts` for durable handoffs that later nodes or reviewers need.

Example:

```json
{
  "type": "agent",
  "id": "implement_slice",
  "goal": "Implement the scoped change and leave a reviewable handoff.",
  "acceptance_criteria": [
    "The changed files are summarized.",
    "Validation and residual risks are named."
  ],
  "constraints": ["Write $AGENTFLOW_OUTPUT_DIR/change-summary.md before finishing."],
  "context": [
    { "name": "task", "from": "text", "text": "Keep the change focused." }
  ],
  "artifacts": {
    "change_summary": {
      "from": "output_dir",
      "path": "change-summary.md",
      "description": "Implementation summary for downstream review."
    }
  }
}
```

## Checks

Use deterministic checks for hard facts:

```json
{
  "type": "check",
  "id": "test",
  "check_kind": "deterministic",
  "command": "npm",
  "args": ["test"]
}
```

Use AI checks for semantic review when architecture fit, scope drift, or risk needs judgment. AI checks require a resolved harness profile.

## Tool Authority

Plugin tools should match the node's job.

- Use read/context tools for discovery nodes.
- Use verification/reporting tools for evaluator nodes.
- Use mutation/write tools only on write-capable agents.
- Use approval boundaries before external-impact tools.
- Use plugin-declared `credentials` plus `agentflow auth` for secret-impact tools.

## Final Review

At terminal state, start with the human entrypoints named by `delivery/manifest.json`: `delivery/reviewer-guide.md`, `delivery/task-brief.md`, `delivery/implementation-summary.md`, `delivery/risk-notes.md`, and `delivery/follow-up-items.md`. Use evidence files next. Read raw runtime files such as `events.jsonl`, `state.json`, `interventions.jsonl`, and node attempt directories only for resume/debugging or low-level audit.
