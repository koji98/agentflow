# Managed Workflows

Managed patterns are compiler-supported `pattern_*` nodes. They are not the same as common authored primitive compositions in `common-patterns.md`.

Use a managed pattern when the operator wants a known lifecycle with standard artifacts and inspectable lowered nodes. Use primitive nodes or common authored patterns when the workflow is one-off or needs exact custom control. Use ordinary repo/device CLIs directly when a command or script already solves the job; do not create a managed pattern just to wrap a mature tool.

## Pattern Selection

### `pattern_deep_research`

Use when an open question needs repo-grounded or external-source research before decisions or implementation.

- Do not use for routine local inspection an implementation agent can do inside its node.
- Common inputs: `brief.question`, `brief.objective`, `brief.audience`, `context`, `context_policy`, `strategy`.
- Public artifacts: `research_report`, `research_packet`, `source_ledger`, `uncertainties`, `interim_findings`.
- Downstream nodes usually consume `research_report` or `research_packet`.

### `pattern_spec_design`

Use when implementation should wait for explicit alternatives, tradeoffs, decisions, file plan, and readiness criteria.

- Do not use when the task packet is already implementation-ready.
- Common inputs: `brief.problem`, `brief.goal`, `brief.constraints`, `brief.decision_drivers`, `brief.scope`, `context`, `strategy`.
- Public artifacts: `design_spec`, `design_packet`, `direction_proposal`, `tradeoff_matrix`, `decision_log`, `implementation_readiness`, `critique_merged`, `quality_review`.
- Downstream implementation should consume `design_spec` or use `task_source.kind: "managed_node"`.

### `pattern_generate_evaluate_fix`

Use when a task source is clear enough to implement and evaluators can judge the result.

- Do not use when the work still needs discovery or product direction first.
- Common inputs: `brief.objective`, `brief.scope`, `task_source`, `context_policy`, `evaluation`, `strategy`.
- Public artifacts: `change_summary`, `change_packet`, `evaluation_ledger`, `fix_log`.
- This pattern's evaluation block is authored workflow structure. It is distinct from graph `check`, supervisor `semantic_evaluation`, and offline `agentflow eval`.

### `pattern_review_change`

Use when a completed change package needs calibrated review across specialized axes.

- Do not use as a generic "think again" step before any concrete change exists.
- Common inputs: `review_source`, `brief.review_goal`, `strategy.reviewer_profiles`, `delivery`.
- Public artifacts: `review_summary`, `review_bundle`, `raw_findings`, `calibrated_findings`, `recommended_actions`.
- Good reviewer profiles include correctness, testing, maintainability, security, release risk, and scope drift.

## Handoff Rules

Downstream nodes should reference artifacts from the public authored pattern id:

```json
{ "ref": "checkout_timeout_impl.evaluation_ledger" }
```

Do not depend on generated internal ids from the compiled graph.

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
        "problem": "Checkout requests can hang without a typed timeout path.",
        "goal": "Design a focused implementation plan that keeps public APIs stable."
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
        "commands": ["npm test -- tests/checkout"]
      }
    },
    {
      "type": "pattern_review_change",
      "id": "checkout_timeout_review",
      "review_source": {
        "kind": "managed_node",
        "node": "checkout_timeout_impl"
      },
      "strategy": {
        "reviewer_profiles": ["correctness", "testing", "maintainability"]
      }
    }
  ]
}
```

## Validation

Run:

```bash
agentflow validate --graph agentflow.graph.json --show-compiled
agentflow validate --graph agentflow.graph.json --diagram-output compiled-graph.mmd
agentflow validate --graph agentflow.graph.json --diagram-image-output compiled-graph.svg
```

Inspect `lowered_managed_nodes`, generated scopes, repeat limits, evaluator commands, public artifacts, and delivery compatibility. Use the diagram when reviewers need to audit expanded repeat or parallel structure.
