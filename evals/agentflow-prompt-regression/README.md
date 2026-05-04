# Agentflow Prompt Regression

This suite is the release gate for prompt and context behavior that should already be solved. It is separate from capability and workflow-quality suites so exploratory failures do not lower prompt-regression standards.

Run:

```bash
agentflow eval validate evals/agentflow-prompt-regression
agentflow eval run evals/agentflow-prompt-regression --variant current --trials 1 --concurrency 1
```

Use `current` for the active prompt contract and `candidate` only as an eval label for proposed prompt changes. Prompt packs are not runtime compatibility surfaces.
