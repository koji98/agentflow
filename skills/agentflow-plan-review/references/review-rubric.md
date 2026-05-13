# Plan Review Rubric

Use findings-first review. Suggested severities:

- P0: graph likely cannot run or violates authority/safety.
- P1: graph likely runs poorly or blocks valid solutions.
- P2: quality issue that weakens evidence, reviewability, or maintainability.

Review axes:

1. Contract: intent, acceptance criteria, constraints, repos, profiles, supervision. Every constraint must start with `Do not`; positive requirements belong in acceptance criteria.
2. Composition: assurance profile, managed patterns, primitive nodes, checkpoints.
3. Agent freedom: outcome-sized nodes, no unnecessary file-by-file prescription.
4. Checks: deterministic checks validate stable facts; rubrics handle semantic quality.
5. Artifacts: durable handoffs exist and downstream refs target public artifacts.
6. Context: focused, high-signal, token-aware, no broad dumps.
7. Authority: sandbox, tools, credentials, profile isolation, human gates.
8. Operations: plugin resolve, validate, show-compiled, diagram or output package when useful.

Approve only when the graph is launch-ready or remaining issues are explicit operator tradeoffs.
