# Managed Patterns

Managed patterns are authored shortcuts for common outcome-oriented workflows. They compile into normal Agentflow primitive nodes, preserve a public authored node id, and publish named artifacts that fit the delivery package.

Use a managed pattern when the operator wants a known lifecycle rather than hand-authoring every phase. Use primitive nodes when the workflow is one-off or needs very specific control.

## Pattern Principles

- Patterns publish reviewable artifacts, not just final text.
- Patterns lower to inspectable primitive subgraphs.
- The public pattern node id remains the downstream handoff boundary.
- Generated internal node ids are private to the compiled shape.
- Pattern nodes should remain large enough to represent real engineering outcomes.

## Canonical Patterns

### `pattern_deep_research`

Research an open question and publish a sourced package.

Primary artifacts:

- `research_report`
- `research_packet`
- `source_ledger`
- `uncertainties`
- `interim_findings`

Use for strategy, technical discovery, comparison, risk mapping, and recommendation work.

### `pattern_spec_design`

Turn a problem into an implementation-ready design package.

Primary artifacts:

- `design_spec`
- `design_packet`
- `direction_proposal`
- `tradeoff_matrix`
- `decision_log`
- `implementation_readiness`
- `critique_merged`
- `quality_review`

Use for architecture and product design that should feed a later implementation node or generate/evaluate/fix pattern.

### `pattern_generate_evaluate_fix`

Implement an accountable slice, run independent evaluators, and iterate within a bounded repair loop.

This pattern's `evaluation` block is authored workflow structure. It lowers into normal nodes and artifacts inside the compiled graph; it is not the same lane as a standalone graph `check`, a supervisor `semantic_evaluation` intervention, or an offline `agentflow eval` suite. Use `evals.md` for offline workflow benchmarks.

Primary artifacts:

- `change_summary`
- `change_packet`
- `evaluation_ledger`
- `fix_log`

Use when the task source is already clear enough to implement and the evaluation criteria can be expressed as commands or structured review checks.

### `pattern_review_change`

Review a change package with specialized reviewer roles and publish calibrated findings.

Primary artifacts:

- `review_summary`
- `review_bundle`
- `raw_findings`
- `calibrated_findings`
- `recommended_actions`

Use when the goal is review quality: correctness, tests, regressions, maintainability, security, or release risk.

## Example Chain

```json
{
  "type": "sequence",
  "id": "root",
  "steps": [
    {
      "type": "pattern_spec_design",
      "id": "checkout_timeout_design",
      "brief": {
        "problem": "Checkout requests can hang without a clear timeout path.",
        "goal": "Design a typed timeout flow that keeps public APIs stable."
      }
    },
    {
      "type": "pattern_generate_evaluate_fix",
      "id": "checkout_timeout_impl",
      "task_source": {
        "kind": "managed_node",
        "node": "checkout_timeout_design"
      },
      "evaluation": {
        "commands": ["npm test -- tests/checkout"],
        "required": true
      }
    },
    {
      "type": "pattern_review_change",
      "id": "checkout_timeout_review",
      "review_source": {
        "kind": "managed_node",
        "node": "checkout_timeout_impl"
      }
    }
  ]
}
```

Downstream context should reference public artifacts from `checkout_timeout_design`, `checkout_timeout_impl`, or `checkout_timeout_review`, not generated internal ids.

## Validation

Use:

```bash
agentflow validate --graph agentflow.graph.json --show-compiled
```

Inspect:

- `lowered_managed_nodes`
- generated primitive node kinds
- public artifact declarations
- repeat limits
- evaluator commands
- checkpoint placement
- delivery-compatible artifacts
