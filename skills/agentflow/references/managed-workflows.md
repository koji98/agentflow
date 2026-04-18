# Managed Workflows

Use managed patterns when the built-in lifecycle matches the work. They are fixed strategy contracts that lower into primitive subgraphs; they are not aliases for arbitrary prompts.

For team-owned reusable workflows distributed through Git, use `agentflow-plugins` instead of forcing the built-in managed patterns to fit.

## Selection

Choose by lifecycle:

- `pattern_deep_research`: multi-track investigation with source policy, contradictions, synthesis, sourced report, and research packet.
- `pattern_spec_design`: repo-grounded design with alternatives, critique, revision, implementation-ready design spec, and design packet.
- `pattern_generate_evaluate_fix`: narrow implementation loop from a prepared task packet, evaluator-command fan-out, and bounded fix retries.
- `pattern_review_change`: structured review of a diff or change package with specialized reviewers and calibrated findings.

Do not use a managed pattern when:

- the task is one or two primitive steps
- the lifecycle needs custom topology the pattern does not model
- the pattern contract would be mostly empty
- the user needs a one-off command gate or simple handoff
- the workflow is organization-specific and should be packaged as a reusable plugin

## Shared Authored Model

Every managed pattern uses:

- `brief`
- `context_policy`
- `strategy`
- optional `runtime`

Pattern-specific fields:

- `pattern_deep_research`: optional `approval_policy`, `delivery`
- `pattern_spec_design`: optional `approval_policy`, `delivery`
- `pattern_generate_evaluate_fix`: `task_source`, `evaluation`
- `pattern_review_change`: `review_source`, `delivery`

Common executable fields still apply:

- `label`
- `repo`
- `profile`
- `context`
- `timeout_sec`

Managed patterns do not accept `artifacts` on the authored pattern node. Their generated publish nodes own the core artifact set.

## Pattern Handoffs

Plan the handoff before authoring the pattern.

Prefer machine-readable artifacts when another pattern or deterministic primitive consumes the result:

- research: `research_packet`
- spec design: `design_packet`
- generate/evaluate/fix: `change_packet`, `evaluation_ledger`
- review: `review_bundle`, `calibrated_findings`

Prefer human-readable artifacts when the next step is operator review:

- `research_report`
- `design_spec`
- `change_summary`
- `review_summary`

Good downstream primitive shape:

```json
{
  "type": "agent",
  "id": "handoff",
  "prompt": "Summarize the implementation risks for the operator.",
  "context": [
    {
      "name": "change_summary",
      "from": "artifact",
      "node": "implement",
      "artifact": "change_summary"
    },
    {
      "name": "evaluation_ledger",
      "from": "artifact",
      "node": "implement",
      "artifact": "evaluation_ledger"
    }
  ]
}
```

Avoid a downstream node that only repeats the managed pattern result. Add one only when it has a distinct responsibility.

## Source References

`pattern_generate_evaluate_fix.task_source`:

- `managed_node`: consume a prior `pattern_spec_design`
- `artifact_bundle`: consume explicit files or prior artifacts

Artifact bundle references use:

```json
{ "kind": "file", "path": "docs/design-packet.json" }
{ "kind": "artifact", "node": "managed_nodes_spec", "artifact": "design_packet" }
```

`pattern_review_change.review_source`:

- `managed_node`: consume a prior `pattern_generate_evaluate_fix`
- `artifact_bundle`: consume explicit diff, summary, ledger, touched-file list, or additional context

Do not use removed names such as `managed_output`, `output`, `spec_source`, `validation`, or `single_writer`.

## Strategy Guidelines

Use `brief` for user intent and scope. Keep it specific:

- objective or question
- repo paths or areas
- success bar
- constraints
- audience when relevant

Use `context_policy` for allowed lookup behavior:

- repo-first or files allowed
- web fallback policy
- allowed domains when web is enabled
- apps policy if supported by the pattern

Use `strategy` for lifecycle knobs only:

- depth or coverage mode
- alternatives count
- critique profiles
- max revision/fix cycles
- reviewer profiles

Use `runtime` only for execution-budget tuning such as `max_concurrency`.

## Validation Discipline

For every graph with managed patterns:

1. Run `agentflow validate --graph <path>`.
2. Fix authored diagnostics first.
3. Run `agentflow validate --graph <path> --run-ready` when the pattern graph is expected to launch on this machine.
4. Run `agentflow compile --graph <path>`.
5. Inspect generated subgraph phases, publish nodes, artifact names, repeat loops, and checkpoint placement.
6. Confirm downstream primitive nodes reference artifacts published by the managed pattern's final publish node.

If compile output surprises you, change the authored pattern contract rather than trying to depend on internal generated node ids.

For plugin workflows, use the same rule: downstream nodes consume artifacts from the public plugin node id and must not depend on generated internal ids.

## Guardrails

- Managed patterns are autonomous by default.
- Use `approval_policy` only on `pattern_deep_research` and `pattern_spec_design`.
- Do not add `approval_policy` or `delivery` to `pattern_generate_evaluate_fix`.
- Do not use `delivery` to toggle core artifacts.
- Keep concurrency tuning in `runtime`, not `strategy`.
- Use eval suites when comparing pattern quality across multiple cases.
- Use primitives when a custom graph is clearer than a managed lifecycle.
