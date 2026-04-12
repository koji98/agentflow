# Agentflow Skills

This repository ships packaged skills in a [skills.sh](https://skills.sh/) compatible layout under `skills/`.

Once this repo is published on GitHub, agents that support `skills.sh` style installs can add the skill pack with:

```bash
npx skills add <owner/repo>
```

Included skills:

- `agentflow-graph-authoring`
  Design, review, and refine shipped Agentflow graphs, with explicit guidance on topology, validation boundaries, and brittleness.
- `agentflow-managed-workflows`
  Choose and author the shipped managed patterns, including selection and downstream handoffs.
- `agentflow-run-debugging`
  Inspect, explain, and debug Agentflow runs, artifacts, resume behavior, and authoring mistakes revealed by failures.

Suggested usage:

1. Use `agentflow-graph-authoring` when turning a task into a graph or reviewing a graph for control-flow quality.
2. Add `agentflow-managed-workflows` when the graph should use `pattern_deep_research`, `pattern_spec_design`, `pattern_generate_evaluate_fix`, or `pattern_review_change`.
3. Use `agentflow-run-debugging` when a real run failed or when you need to reason about preservation, artifacts, or failure propagation.

What these skills are optimized for:

- the real `agentflow` CLI surface: `graph-help`, `validate`, `compile`, `run`, `resume`
- explicit graph authoring choices around context, outputs, validation, and failure propagation
- managed-pattern field authoring and downstream handoffs
- artifact-first debugging and provenance-aware resume diagnosis

Each skill is self-contained:

- `SKILL.md` for trigger metadata and workflow guidance
- `references/` for bundled supporting material
- `agents/openai.yaml` for UI metadata where supported
