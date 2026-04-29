# Eval Examples

Eval examples use suite schema version `"2"` and are separate from graph schema version `"1"`.

Start with the tiny local suite:

```bash
agentflow eval validate docs/examples/evals/basic
agentflow eval run docs/examples/evals/basic --eval-root .agentflow/evals/basic --trials 1
agentflow eval report .agentflow/evals/basic --format markdown
```

Example repos are committed as tiny seed fixtures only. They do not include `.git`, dependency installs, generated workspaces, or eval output. The eval runner copies each seed into an isolated trial workspace and initializes git there when the scenario requests it.

For the full dogfood capability suite, use:

```bash
agentflow eval validate evals/agentflow-workflow-quality
agentflow eval run evals/agentflow-workflow-quality --variant current --trials 1
```

See `../../EVALS.md` for suite layout, scenario fixtures, variants, deterministic graders, LLM judges, trace packets, scorecards, and benchmark reports.
