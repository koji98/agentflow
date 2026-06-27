# Plan Anti-Patterns

- Prose plan disguised as graph: many nodes, no durable artifacts.
- Implementation script graph: exact edit steps instead of outcome contracts.
- Graph-semantics leak: prompt-facing fields explain graph topology, node choice, managed-pattern lifecycle, downstream routing, publisher mechanics, or authoring rationale instead of the runtime reader's outcome, evidence, and boundaries.
- Constraint drift: graph or node constraints that do not start with `Do not`, or positive requirements placed in constraints instead of acceptance criteria.
- Brittle check: command expects a file or script the agent may never need.
- Context flood: broad globs instead of curated source, docs, or artifacts.
- Review theater: AI check after every agent node with no control-flow purpose.
- Hidden handoff: downstream node relies on previous workspace state or raw logs.
- Managed-pattern overuse: managed patterns everywhere even when one accountable node plus checks is enough.
- Managed-pattern underuse: open-ended high-risk work forced into a single node with vague acceptance criteria.
- Plugin premature abstraction: wrapper around a mature CLI without auth, stable I/O, reuse, or policy value.
- Human gate confusion: checkpoint used for runtime recovery instead of planned product or authority judgment.
