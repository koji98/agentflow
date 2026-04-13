# Agentflow Skill

This repository ships one packaged skill in a [skills.sh](https://skills.sh/) compatible layout under `skills/`.

Once this repo is published on GitHub, agents that support `skills.sh` style installs can add the skill pack with:

```bash
npx skills add <owner/repo>
```

Included skill:

- `agentflow`
  Route Agentflow tasks to focused references for graph authoring, managed workflows, local eval suites, run debugging, graph contracts, CLI validation, failure semantics, and examples.

The skill is intentionally a small table of contents. Agents load only the reference that matches the task:

- `references/graph-authoring.md`
- `references/managed-workflows.md`
- `references/evals.md`
- `references/run-debugging.md`
- `references/graph-contract.md`
- `references/cli-and-validation.md`
- `references/failure-and-validation.md`
- `references/examples.md`

What the skill is optimized for:

- the real `agentflow` CLI surface: `graph-help`, `validate`, `compile`, `run`, `resume`, and `eval`
- explicit graph authoring choices around context, outputs, validation, and failure propagation
- managed-pattern field authoring and downstream handoffs
- local file-backed eval suite authoring and grading
- artifact-first debugging and provenance-aware resume diagnosis

The repository `docs/` remain the canonical human-facing docs. `skills/agentflow/references/` is the packaged, agent-facing guide for installed use.
