# Agentflow Docs

Agentflow docs are split by audience so readers do not have to infer whether a page is product guidance or implementation mechanics.

## Product Docs

Use `product/` when authoring, operating, or evaluating Agentflow workflows:

1. `product/scope.md`: active product boundary and release bar.
2. `product/loop-model.md`: worker, verifier, supervisor, managed, and eval loops.
3. `product/operations.md`: validation, launch, resume, inspection, and delivery workflows.
4. `product/evals.md`: eval suite authoring and operation.
5. `product/plugins.md`: plugin workflow and tool contracts.
6. `product/managed-patterns.md`: reusable managed workflow patterns.
7. `product/patterns/`: pattern-specific authoring guides.

## Technical Docs

Use `technical/` when debugging runtime behavior or changing Agentflow internals:

1. `technical/architecture.md`: implementation architecture and major subsystems.
2. `technical/runtime-lifecycle.md`: launch-to-delivery execution flow.
3. `technical/context-and-artifacts.md`: context pointers and artifact refs.
4. `technical/runtime-tooling.md`: generated `af` and plugin tool wrappers.
5. `technical/outcome-verification.md`: verifier behavior for agent attempts.
6. `technical/node-workspace-snapshots.md`: per-attempt workspace baselines and diffs.
7. `technical/prompt-surfaces.md`: prompt renderer inventory and authority boundaries.
8. `technical/prompt-cruft-rubric.md`: prompt text rejection rubric.

## Examples

Use `examples/` for runnable graph, eval, and plugin examples. Example files should point back to product docs for concepts and technical docs for implementation mechanics.
