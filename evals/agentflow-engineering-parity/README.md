# Agentflow Engineering Parity Eval

This suite compares Agentflow worker shapes against direct Codex on the same local engineering task. The `current` variant uses one primitive `agent` node; managed variants cover `pattern_deep_work` and `pattern_work_list`. Agentflow should match or beat direct Codex implementation quality while adding durable artifacts, verification, traceability, and delivery.

Codex Goal mode is an external baseline only. Agentflow does not activate it for normal workers; the node contract plus `af orient` are Agentflow's goal mechanism.

Each scenario owns:

- `repo/task.md`: neutral task prompt visible to both direct Codex and Agentflow.
- `oracle.json`: grader-only expected behavior, validation commands, allowed/forbidden paths, and quality anchors.
- `repo/`: clean local fixture repo copied independently for Agentflow and direct Codex.

Run validation:

```bash
agentflow eval validate evals/agentflow-engineering-parity
```

Run one scenario for inspection:

```bash
agentflow eval run evals/agentflow-engineering-parity --variant current --scenario cart-total-bugfix --trials 1 --concurrency 1
```

Run the full primitive comparison:

```bash
agentflow eval run evals/agentflow-engineering-parity --variant current --scenario all --trials 3 --concurrency 1
```

Run the full primitive plus managed comparison:

```bash
agentflow eval run evals/agentflow-engineering-parity --variant all --scenario all --trials 3 --concurrency 1
```

Start review from each trial's `criteria/engineering-parity/` directory. It contains direct Codex outputs, prompt diagnostics, `comparison-packet.json`, `pairwise-judge-packet.json`, and `parity-verdict.json`.
