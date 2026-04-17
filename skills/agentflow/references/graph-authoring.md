# Graph Authoring

Create Agentflow graphs that are executable, inspectable, and hard to misread.

## Mental Model

An Agentflow graph is local-first orchestration over one or more local git repositories.

- The graph chooses repos, launch profile, workspace backend, executable nodes, control flow, context, artifacts, and validation gates.
- The workspace carries source changes during execution.
- `context` carries authored input material into a node.
- `artifacts` declare durable named handoff files a downstream node may consume.
- Run artifacts explain history after the fact: logs, result JSON, context packets, summaries, state, events, and workspace change patches.

The graph should make responsibility and evidence obvious. If a node fails, the operator should know which boundary failed and which artifact or log to inspect.

## Mandatory Loop

Use this loop before handing back any authored graph:

1. Draft or edit the graph.
2. Run `agentflow validate --graph <path>`.
3. Fix every validation diagnostic.
4. Run `agentflow validate --graph <path> --run-ready` when the graph is expected to launch on this machine, especially if it relies on `worktree`, local commands, Codex, or Cursor.
5. Run `agentflow compile --graph <path>`.
6. Inspect the compiled shape when the graph uses managed patterns, `parallel`, `repeat`, checkpoints, or artifact handoffs.
7. If the graph is meant to execute now, run `agentflow run --graph <path>`.

If validation or compile cannot be run, state why. If either fails, do not hand off the graph as ready; report the failing command and the diagnostics.

## Top-Level Choices

Set launch behavior in the graph:

- `defaults.launch_profile`
- `defaults.workspace_backend`

Do not invent CLI profile or workspace-backend overrides. Node-level `profile` is only for a real policy exception, such as one high-reasoning review node or one command profile with `env_files`.

Use `worktree` when source changes should be isolated and patch delivery matters. Use `inplace` only when the user intentionally wants the source checkout used directly.

## Node Choice

Use primitives for explicit workflows:

- `agent`: model-driven work such as coding, synthesis, design, or review.
- `exec`: run a command and collect evidence.
- deterministic `check`: hard command-based gate.
- AI `check`: hard semantic gate.
- `checkpoint`: intentional human decision inside a bounded `repeat`.
- `sequence`: default control flow.
- `parallel`: independent fan-out with a clear fan-in.
- `repeat`: bounded repair or revision loop driven by a descendant `check` or `checkpoint`.

Use managed patterns when the full lifecycle matches:

- `pattern_deep_research`
- `pattern_spec_design`
- `pattern_generate_evaluate_fix`
- `pattern_review_change`

Do not use a managed pattern as a vague prompt bucket. If only one or two primitive nodes are needed, primitives are clearer.

## Context And Artifacts

Use current data-flow fields only:

- `context`: material passed into the node.
- `artifacts`: named files the node publishes for later nodes.

Never author `inputs`, `context_from`, or `outputs`; those are invalid graph syntax.

Good context examples:

```json
{ "name": "goal", "from": "text", "text": "Keep the CLI contract stable." }
{ "name": "readme", "from": "workspace_file", "path": "README.md" }
{ "name": "sources", "from": "workspace_glob", "path": "src/**/*.ts", "max_files": 20 }
{ "name": "packet", "from": "artifact", "node": "design", "artifact": "design_packet", "attempt": "latest_passed" }
```

Good artifact examples:

```json
{
  "design_packet": {
    "from": "output_dir",
    "path": "design-packet.json",
    "required": true
  },
  "junit": {
    "from": "workspace",
    "path": "reports/junit.xml",
    "required": false
  }
}
```

Reserved artifacts:

- `agent_response`: every agent final response, saved as `agent-response.md`.
- `result_json`: every executable node's `result.json`.

Rules:

- Source edits happen in the workspace.
- Durable handoff files should be written to `AGENTFLOW_OUTPUT_DIR` and declared in `artifacts`.
- Downstream nodes consume only named artifacts or authored workspace/text context.
- Use `required: true` when the graph cannot proceed coherently without that artifact.
- Use optional artifacts for supplementary evidence only.
- The final agent response is captured as `agent_response`; use it for a concise narrative handoff with outcome, work completed, produced artifacts, validation, and next-node notes.
- Do not rely on `agent_response` when downstream work needs a stable machine-readable packet.

## Non-Brittle Graph Conventions

Prefer:

- small nodes with one responsibility
- stable, readable ids like `inspect_repo`, `implement_change`, `run_tests`
- narrow `workspace_file` context over broad globs
- `workspace_glob.max_files` when a glob is truly needed
- named artifacts with semantic names like `design_packet`, `evaluation_ledger`, `review_summary`
- deterministic checks for commands that must pass
- `exec` plus downstream review for commands whose failure needs interpretation
- explicit fan-in after every `parallel`
- bounded `repeat` with a real convergence gate

Avoid:

- one giant agent that discovers, edits, validates, and summarizes everything
- broad `src/**/*` context when a smaller surface is known
- relying on `agent_response` when a machine-readable packet is needed
- optional artifacts that are actually required for correctness
- `parallel` branches that mutate the same files
- `repeat` without a clear owner, gate, and maximum useful attempt count
- checkpoints used as generic pauses
- downstream handoff agents that only restate the previous node

## Validation Placement

Put validation where it changes control flow or confidence:

- after mutation
- after producing a handoff packet
- after setup that everything else depends on
- before a final operator handoff

Use deterministic `check` for objective pass/fail. Use AI `check` for semantic quality. Use `exec` with `on_failure: "continue"` only when failure should be captured as evidence while the graph continues.

## Final Review Checklist

Before handoff:

- `agentflow validate --graph <path>` passed.
- `agentflow validate --graph <path> --run-ready` passed when the graph is being handed off as locally runnable.
- `agentflow compile --graph <path>` passed.
- Every downstream artifact reference names a reserved or declared artifact.
- Every artifact path is relative and stays inside `AGENTFLOW_OUTPUT_DIR` or the workspace.
- Every broad glob is justified and capped.
- Every command that needs env declares `env_files`.
- Every failure boundary is intentional: hard `check`, soft `exec`, or managed-pattern behavior.
- The compiled graph shape matches the intended topology.
