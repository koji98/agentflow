---
name: agentflow-graph-authoring
description: Design, review, and refine Agentflow execution graphs. Use when authoring or editing Agentflow graph JSON, choosing between primitive nodes and managed workflows, or checking topology, profiles, context flow, outputs, and validation against the shipped runtime contract.
---

# Agentflow Graph Authoring

Create graphs that match the shipped Agentflow runtime and docs, not stale internal patterns.

## Use when

Use this skill when the task is any of:

- turn a coding, research, or review request into an Agentflow graph
- review an existing graph for topology, validation, or brittleness issues
- decide between primitive nodes and managed workflows
- decide how failures should propagate through the graph
- choose graph outputs, context flow, and run-time validation boundaries

Typical requests:

- "Turn this implementation plan into an Agentflow graph."
- "Review this graph before I run it."
- "Should this verifier be an `exec` or a `check`?"
- "Why does this graph feel brittle?"

## Start here

If you are unsure about the authored contract, use the CLI and docs in this order:

1. `agentflow graph-help`
2. `agentflow validate --graph <path>`
3. `agentflow compile --graph <path>`
4. `agentflow run --graph <path>`
5. `agentflow resume --run-root <run-root>` when a failed or canceled run should continue

Read [references/graph-contract.md](references/graph-contract.md) before authoring or reviewing a graph.

Read [references/cli-and-validation.md](references/cli-and-validation.md) before finalizing a graph or when you need the exact CLI surface.

Read [references/failure-and-validation.md](references/failure-and-validation.md) when the graph contains `exec`, `check`, `checkpoint`, `repeat`, or any command whose failure semantics matter.

Read [references/brittleness-review.md](references/brittleness-review.md) before finalizing a graph.

Read [references/examples.md](references/examples.md) when choosing topology or output patterns.

If the graph uses managed workflows, also use the `agentflow-managed-workflows` skill when available.

## Workflow

1. Identify the execution surface.

Decide:

- whether the graph should use primitives, managed workflows, or both
- which repos it operates on
- which artifacts later nodes need
- where validation should happen
- which failures should stop the graph versus be documented for later review

2. Keep launch settings in the graph.

- `defaults.launch_profile` and `defaults.workspace_backend` are authored in the graph
- do not invent CLI launch overrides
- use node-level `profile` only when a specific executable node needs a different runtime policy

3. Choose the right abstraction.

Use primitives for small, explicit flows:

- `agent`
- `exec`
- `check`
- `checkpoint`
- `sequence`
- `parallel`
- `repeat`

Use managed workflows when the task clearly matches the shipped semantics:

- `deep_research`
- `spec_design`
- `execute_spec`
- `review_change`

4. Slice the graph by responsibility and failure boundary.

- keep each executable node narrow enough that its success or failure is interpretable
- do not mix repo discovery, implementation, and final synthesis in one giant agent
- use `parallel` only when branches are truly independent and a later node can fan them back in cleanly
- reserve `repeat` for bounded revision or repair loops with a real convergence signal

5. Design context flow intentionally.

- use `inputs` for static files, globs, or inline text
- use `context_from` for prior summaries, results, or named outputs
- publish downstream dependencies explicitly with `outputs`

Pass only what the next node actually needs.

6. Put validation near the boundary that matters.

- deterministic `check` when a concrete pass/fail command exists
- AI `check` when the question is semantic quality
- `exec` when a command should run and publish evidence, but non-zero exit should not itself be the control-flow gate
- `repeat` only when a descendant `check` or `checkpoint` should drive convergence
- `checkpoint` only when operator review is an intentional part of the workflow

7. Review the graph like the compiler and runtime will.

Check for:

- wrong node kind or wrong managed workflow choice
- oversized nodes with mixed responsibilities
- missing outputs that later nodes need
- noisy `context_from`
- profile misuse
- unnecessary `parallel` or `repeat`
- prompts that restate too much ambient context instead of defining a sharp task
- avoidable brittleness from overly broad globs, env-sensitive commands, or hard gates in the wrong place
- missing evidence outputs for later diagnosis when an `exec` can fail

8. Finish with the actual CLI contract.

- use `agentflow validate --graph ...` before handing off a graph
- use `agentflow compile --graph ...` when you need to inspect the lowered contract or confirm what will really run
- do not invent launch-setting CLI overrides; `defaults.launch_profile` and `defaults.workspace_backend` live in the graph
- if the graph will be run, make sure its failure and resume behavior are intentional rather than accidental

## Guardrails

- Prefer smaller executable slices over giant monolithic agents.
- Keep ids stable and readable.
- `glob.max_files` is a local cap on that one input only.
- Global context budgeting is byte-based; keep inputs narrow even when file count is no longer a hard runtime budget.
- Design explicit hard-stop versus soft-review semantics. A failed deterministic `check` stops the graph. A failed `exec` should only be used as a hard boundary when that is truly desired.
- `checkpoint` only belongs where operator review is genuinely part of the workflow.
- Write graphs as executable artifacts, not prose plans disguised as JSON.
