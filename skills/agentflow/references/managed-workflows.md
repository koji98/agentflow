# Managed Workflows

Managed patterns compile into primitive Agentflow nodes while keeping the authored pattern id as the public handoff boundary.

Use them for common outcome lifecycles:

- `pattern_deep_research`: publish a sourced research package.
- `pattern_spec_design`: publish an implementation-ready design package.
- `pattern_generate_evaluate_fix`: implement, evaluate, and repair a change package.
- `pattern_review_change`: publish calibrated review findings.

## Selection

Use `pattern_deep_research` when the next action depends on external or repo-grounded discovery.

Use `pattern_spec_design` when implementation should wait for explicit alternatives, tradeoffs, decisions, and readiness criteria.

Use `pattern_generate_evaluate_fix` when a task packet is ready and evaluators can judge the implementation.

Use `pattern_review_change` when a change package needs structured review before handoff.

## Handoffs

Downstream nodes should reference artifacts from the public pattern id:

```json
{ "ref": "checkout_timeout_impl.evaluation_ledger" }
```

Do not depend on generated internal ids from the compiled graph.

## Validation

Run:

```bash
agentflow validate --graph agentflow.graph.json --show-compiled
```

Inspect the `lowered_managed_nodes` list, generated scopes, repeat limits, evaluator commands, public artifacts, and delivery compatibility.
