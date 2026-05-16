# Agentflow Workflow Quality Eval

This suite is a portable dogfood benchmark for Agentflow workflow quality. It uses only committed seed fixtures:

- `shared/repo/` is a tiny fixture seed, not a cloned repository and not a git repo.
- `shared/docs/` is served by the eval runner as a local HTTP docs fixture.
- `shared/tools/` contains local tool fixtures used by selected scenarios.

Each trial copies the seed repo into an isolated workspace and initializes git there when a scenario sets `init_git: true`. Generated workspaces, run roots, and eval output roots should remain local and ignored by git.

Run:

```bash
agentflow eval validate evals/agentflow-workflow-quality
agentflow eval run evals/agentflow-workflow-quality --variant current --trials 1
```
