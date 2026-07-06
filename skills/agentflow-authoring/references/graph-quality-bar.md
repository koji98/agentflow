# Graph Quality Bar

A good graph is an execution contract, not a prose plan.

Before launch, verify:

- Top-level intent names a concrete goal, acceptance criteria, and `Do not ...` constraints.
- Top-level intent is useful to every executable node because it is injected into every node prompt.
- Top-level intent describes the product/workflow thesis, target user or operator need, and global quality bar when relevant; it does not narrate graph topology.
- Prompt-facing graph fields contain no graph-construction semantics: no authoring rationale, node topology, managed-pattern mechanics, downstream routing, publisher mechanics, or Agentflow vocabulary unless Agentflow itself is the product being changed.
- Each executable node has meaningful `intent.goal` and non-empty `acceptance_criteria`.
- Every graph-level and node-level constraint string starts with `Do not`; move positive success requirements to `acceptance_criteria`.
- Nodes own outcomes, not microscopic operations.
- Context is curated, pointer-only, high-signal, and includes `what` and `why`.
- Reusable support is expressed with skill sources, capabilities, CLI hints, and managed tools instead of ad hoc context files.
- Durable handoffs are declared as artifacts.
- Downstream nodes consume artifact refs, not raw logs or assumed workspace state.
- Deterministic checks validate stable facts.
- Rubrics or review nodes cover semantic quality.
- Unknown item counts use `pattern_work_list` when ordered item completion matters or `pattern_map_reduce` when independent item judgments or owned-path changes should publish aggregate evidence, instead of guessing a fixed stack of nodes.
- Profiles, repos, sandbox, tools, credentials, and supervision are explicit.
- Planned human decisions use checkpoints.
- `agentflow plugin resolve --graph <path>` is planned when plugins exist.
- `agentflow validate --graph <path>` is required before launch.

Closure test before adding a node, check, or constraint:

1. Is this a true requirement or one possible tactic?
2. Does it preserve agent freedom inside the boundary?
3. Would it still be valid if the agent finds a better path?
4. Is it validating the desired outcome or the author's imagined solution?
