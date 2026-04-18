# Agentflow Skills

This repository ships packaged skills in a [skills.sh](https://skills.sh/) compatible layout under `skills/`.

Once this repo is published on GitHub, agents that support `skills.sh` style installs can add the skill pack with:

```bash
npx skills add <owner/repo>
```

Included skills:

- `agentflow`
  Route Agentflow tasks to focused references for graph authoring, managed workflows, local eval suites, run debugging, graph contracts, CLI validation, failure semantics, and examples.
- `agentflow-plugins`
  Package and consume Git-distributed Agentflow plugin workflows.

The `agentflow` skill is intentionally a small table of contents. Agents load only the reference that matches the task:

- `references/graph-authoring.md`
- `references/managed-workflows.md`
- `references/evals.md`
- `references/run-debugging.md`
- `references/graph-contract.md`
- `references/cli-and-validation.md`
- `references/failure-and-validation.md`
- `references/examples.md`

The `agentflow-plugins` skill owns plugin-specific packaging and consumption guidance:

- `references/plugin-workflows.md`

What the skills are optimized for:

- the real `agentflow` CLI surface: `graph-help`, `validate`, `compile`, `plugin resolve`, `run`, `resume`, and `eval`
- explicit graph authoring choices around context, artifacts, validation, and failure propagation
- managed-pattern field authoring and downstream handoffs
- Git-resolved plugin workflow consumption, packaging, lockfiles, and public artifact handoffs
- local file-backed eval suite authoring and grading
- artifact-first debugging and provenance-aware resume diagnosis

The repository `docs/` remain the canonical human-facing docs. `skills/*/references/` contains packaged, agent-facing guidance for installed use.
