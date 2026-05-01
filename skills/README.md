# Agentflow Skills

This repository ships installable skills under `skills/`.

Included skills:

- `agentflow`: supervised graph authoring, validation, execution, inspection, resume, supervision, delivery packages, and Codex/Cursor harness behavior.
- `agentflow-evals`: workflow eval suites, scenarios, variants, criteria, environment simulation, trajectory checks, trace packets, scorecards, benchmark reports, prompt-pack comparisons, and dogfood/capability evals.
- `agentflow-plugins`: Git or local plugin workflows, plugin-bundled CLI tools, and secure plugin auth.

The `agentflow` skill routes to compact references:

- `references/graph-authoring.md`
- `references/common-patterns.md`
- `references/github-rollout.md`
- `references/managed-workflows.md`
- `references/run-debugging.md`
- `references/graph-contract.md`
- `references/cli-and-validation.md`
- `references/failure-and-validation.md`
- `references/examples.md`

The `agentflow-plugins` skill owns:

- `references/plugin-workflows.md`

The `agentflow-evals` skill owns:

- `references/eval-patterns.md`
- `references/suite-authoring.md`
- `references/grading-and-reporting.md`
- `references/operations-and-dogfood.md`

The repository `docs/` remain the canonical human-facing docs. The skill references are packaged agent-facing guidance for installed use and mirror the supervised v1 contract.
