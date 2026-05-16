# Eval Examples

Eval examples use suite schema version `"1"` and are separate from graph schema version `"1"`.

Start with the tiny local suite:

```bash
agentflow eval validate docs/examples/evals/basic
agentflow eval run docs/examples/evals/basic --eval-root .agentflow/evals/basic --trials 1
agentflow eval report .agentflow/evals/basic --format markdown
```

Example repos are committed as tiny seed fixtures only. They do not include `.git`, dependency installs, generated workspaces, or eval output. The eval runner copies each seed into an isolated trial workspace and initializes git there when the scenario requests it.

For the committed fake-workflow dogfood suite, use:

```bash
agentflow eval validate evals/agentflow-workflow-quality
agentflow eval run evals/agentflow-workflow-quality --variant current --trials 1
```

For the five-scenario sentinel suite that exercises Agentflow end to end, use:

```bash
agentflow eval validate evals/agentflow-validation
agentflow eval run evals/agentflow-validation --variant current --scenario all-primitives-checkpoint-loop --trials 1
```

For the larger local-repo capability suite used for prompt and context iteration, generate ignored fixtures first:

```bash
npm run setup:eval-repos
agentflow eval validate evals/agentflow-capability-workflows
agentflow eval run evals/agentflow-capability-workflows --variant current --scenario all --trials 1
```

See `../../product/evals.md` for suite layout, scenario environments, variants, criteria, environment simulation, trajectory checks, trace packets, scorecards, and benchmark reports.
