# Graph Authoring

Create Agentflow graphs that are executable, inspectable, and hard to misread.

## Mental Model

An Agentflow graph is local-first orchestration over one or more local git repositories.

- The graph chooses repos, launch profile, workspace backend, executable nodes, control flow, context, artifacts, and validation gates.
- Optional plugin workflows let a graph reuse Git-resolved managed subgraphs without adding runtime node kinds.
- The workspace carries source changes during execution.
- `context` carries authored input material into a node.
- `artifacts` declare durable named handoff files a downstream node may consume.
- Run artifacts explain history after the fact: logs, result JSON, context packets, summaries, state, events, and workspace change patches.

The graph should make responsibility and evidence obvious. If a node fails, the operator should know which boundary failed and which artifact or log to inspect.

## Mandatory Loop

Use this loop before handing back any authored graph:

1. Draft or edit the graph.
2. If the graph declares `plugins`, run `agentflow plugin resolve --graph <path>`.
3. Run `agentflow validate --graph <path>`.
4. Fix every validation diagnostic.
5. Run `agentflow validate --graph <path> --run-ready` when the graph is expected to launch on this machine, especially if it relies on `worktree`, local commands, Codex, Cursor, or plugin-provided scripts.
6. Run `agentflow validate --graph <path> --show-compiled`.
7. Inspect the compiled shape when the graph uses managed patterns, plugin workflows, `parallel`, `repeat`, checkpoints, or artifact handoffs.
8. If the graph is meant to execute now, run `agentflow run --graph <path>`.

If validation cannot be run, state why. If validation or `--show-compiled` fails, do not hand off the graph as ready; report the failing command and the diagnostics.

## Top-Level Choices

Set launch behavior in the graph:

- `defaults.launch_profile` (defaults to `"default"` only when a profile named `default` exists)
- `defaults.workspace_backend` (defaults to `"inplace"` when omitted)

Do not invent CLI profile or workspace-backend overrides. Node-level `profile` is only for a real policy exception, such as one high-reasoning review node or one command profile with `env_files`.

Use `inplace` for the fast local-first authoring loop (this is the default). Use `worktree` when source changes should be isolated and patch delivery matters.

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

Use `plugin` when the graph should drop in a reusable team-owned managed workflow from Git. Plugin nodes use `uses: "alias/workflow"`, validate workflow-specific `config`, and publish only the artifacts declared by the plugin workflow's publish node.

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
{ "ref": "design.design_packet", "attempt": "latest_passed" }
{ "ref": "design" }
```

Artifact context items use a single `ref` field. `"<node>.<artifact>"` selects a declared artifact; bare `"<node>"` resolves to the canonical artifact for that node kind (`agent_response` for `agent`, `stdout` for `exec`, `result_json` for `check`). `name` defaults to the rightmost `.` segment of `ref`, or to the node id when `ref` is bare.

Good artifact examples:

```json
{
  "design_packet": {
    "from": "output_dir",
    "path": "design-packet.json",
    "description": "Structured implementation packet for downstream implementation nodes."
  },
  "junit": {
    "from": "workspace",
    "path": "reports/junit.xml",
    "description": "JUnit XML report copied from the workspace after validation."
  }
}
```

Reserved canonical artifacts (one per node kind):

- `agent_response`: every agent final response, saved as `artifacts/agent-response.md`.
- `stdout`: every exec node's stdout stream, saved as `logs/stdout.log`.
- `result_json`: every check node's normalized result, saved as `artifacts/result.json`.

Declared artifact keys cannot contain `.` because `.` is reserved as the `ref` path separator.

Rules:

- Source edits happen in the workspace.
- Durable handoff files should be written to `AGENTFLOW_OUTPUT_DIR` and declared in `artifacts`.
- Every graph-consumable artifact lives under the execution `artifacts/` directory; root execution files, `context/`, and `logs/` are inspection material.
- Downstream nodes consume only named artifacts or authored workspace/text context.
- Every declared artifact needs `description` and must exist when the node closes after any configured agent artifact repair attempts.
- Do not declare an artifact unless the node is responsible for producing it.
- Use `if_available: true` on consumer artifact context only when the consumer can still do useful work without the material.
- The final agent response is captured as `agent_response`; use it for a concise narrative handoff with outcome, work completed, what was tried, what was not tried, produced artifacts, validation, and next-node notes.
- Agent artifact repair defaults to one same-workspace harness repair when a successful agent misses a declared artifact. Use `artifact_repair.max_attempts: 0` to disable it for a profile or agent node, or up to `3` when handoff repair is a normal part of the graph.
- Repeat loops automatically receive `repeat_history` context after iteration 1. Do not add extra self-artifact references just to remind the next iteration what happened; use explicit prior-iteration artifact context only when the next node needs a full file.
- Do not rely on `agent_response` when downstream work needs a stable machine-readable packet.
- Do not reference `AGENTFLOW_*` paths in `prompt` or `rubric` text. Context is already inlined and declared artifacts already show absolute paths in the harness prompt. Tools that need a path should read it from the shell environment when the agent invokes them. Substitution exists as a forgiveness layer (see `graph-contract.md`), not the recommended pattern.

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
- `if_available: true` artifact context references that are actually required for correctness
- `parallel` branches that mutate the same files
- `repeat` without a clear owner, gate, and maximum useful attempt count
- checkpoints used as generic pauses
- downstream handoff agents that only restate the previous node
- references to plugin-generated internal node ids instead of the public plugin node id

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
- `agentflow plugin resolve --graph <path>` passed when the graph declares `plugins`.
- `agentflow validate --graph <path> --run-ready` passed when the graph is being handed off as locally runnable.
- `agentflow validate --graph <path> --show-compiled` passed.
- Every downstream artifact reference names a reserved or declared artifact.
- Every declared artifact includes a useful `description`.
- Every artifact path is relative and stays inside `AGENTFLOW_OUTPUT_DIR` or the workspace. `AGENTFLOW_OUTPUT_DIR` points at the execution `artifacts/` directory.
- Every broad glob is justified and capped.
- Every command that needs env declares `env_files`.
- Every failure boundary is intentional: hard `check`, soft `exec`, or managed-pattern behavior.
- The compiled graph shape matches the intended topology.
