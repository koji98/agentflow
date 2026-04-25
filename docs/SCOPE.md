# Scope

Agentflow v1 is the supervised runtime for delegating substantial coding work to external agent harnesses without losing intent, evidence, or reviewability.

The product surface is intentionally centered on four layers:

1. Authored intent: a graph that states goal, scope, constraints, acceptance criteria, approval boundaries, repos, tools, and outcome nodes.
2. Compiled contract: normalized primitive runtime nodes with explicit control flow, context dependencies, artifact contracts, harness selection, and tool policy.
3. Supervised execution: local execution through Codex CLI, Cursor CLI, deterministic checks, semantic checks, plugin-bundled tools, durable events, retry budgets, and visible interventions.
4. Delivery package: review artifacts that summarize what happened, what changed, what evidence exists, where risk remains, and what the supervisor did.

## Canonical Surfaces

- Authored graphs use version `"1"`.
- Harness adapters are `codex-cli` and `cursor-cli`.
- Workspace backends are `inplace` and `worktree`.
- Executable node kinds are `agent`, `exec`, `check`, and `checkpoint`.
- Container node kinds are `sequence`, `parallel`, and `repeat`.
- Managed patterns are `pattern_deep_research`, `pattern_spec_design`, `pattern_generate_evaluate_fix`, and `pattern_review_change`.
- Team capabilities enter through plugin-bundled CLI tools with declared `capability`, `impact`, and credential requirements when secrets are needed.

## Graph Authoring Bar

Graphs should express major responsibility boundaries, not micro-managed implementation steps.

A good node owns a meaningful outcome:

- research the decision and publish a sourced package
- design the feature and publish an implementation-ready spec
- implement an accountable slice and publish change evidence
- review a change package and publish calibrated findings

The graph must preserve human control through `intent.approval_boundaries`, checkpoints when human input is required, and explicit tool impact policy.

## Runtime Bar

The runtime must make long-running agent work inspectable while it is happening and reviewable after it ends.

Required behavior:

- validate authored and compiled contracts before launch
- run only compiled primitive nodes
- materialize context packets and preserve provenance
- enforce sandbox, timeout, env, workspace, and tool constraints consistently for Codex CLI and Cursor CLI
- record supervisor decisions and interventions durably
- preserve run state for inspection and resume
- produce a delivery package for terminal runs

## Documentation Bar

Repository docs should describe the supervised v1 system that exists in this repo. Historical migration guidance, reserved controller surfaces, and speculative product boundaries do not belong in the product docs. When a concept matters, it belongs in the smallest active doc that operators and graph authors actually use.
