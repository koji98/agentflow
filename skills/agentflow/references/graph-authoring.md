# Graph Authoring

Create graphs that match the shipped Agentflow runtime and docs, not stale internal patterns.

## Workflow

1. Identify the execution surface.

- decide whether the graph should use primitives, managed patterns, evals, or a mix
- decide which repos it operates on
- decide which artifacts later nodes need
- decide where validation should happen
- decide which failures should stop the graph versus be documented for later review

2. Keep launch settings in the graph.

- `defaults.launch_profile` and `defaults.workspace_backend` are authored in the graph
- do not invent CLI launch overrides
- use node-level `profile` only when a specific executable node needs a different runtime policy

3. Choose the right abstraction.

- use primitives for small explicit flows
- use managed patterns when the shipped lifecycle matches the task
- use eval suites when the goal is to measure workflow quality across cases

4. Design context flow intentionally.

- use `inputs` for static files, globs, or inline text
- use `context_from` for prior summaries, results, or named outputs
- publish downstream dependencies explicitly with `outputs`
- pass only what the next node actually needs

5. Put validation near the boundary that matters.

- deterministic `check` when a concrete pass/fail command exists
- AI `check` when the question is semantic quality
- `exec` when a command should run and publish evidence, but non-zero exit should not itself be the control-flow gate
- `repeat` only when a descendant `check` or `checkpoint` should drive convergence
- `checkpoint` only when operator review is an intentional part of the workflow

## Brittleness Review

Before handing off a graph, check:

- each executable node has a narrow purpose and obvious failure mode
- every `parallel` branch is truly independent and has a clear fan-in
- every `repeat` is bounded and justified
- `inputs` are specific and intentional
- broad globs are actually needed
- every `context_from` includes only the next node's real needs
- downstream artifacts are published explicitly through `outputs`
- launch settings are authored in the graph
- env-sensitive command nodes declare `env_files` when needed
- ids are stable and readable
- the graph reads like intentional control flow, not a prose task list in JSON form
