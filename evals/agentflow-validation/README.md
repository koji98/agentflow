# Agentflow Validation Sentinel Suite

This suite is the flagship end-to-end confidence suite for Agentflow. It intentionally contains exactly five broad sentinel scenarios:

- three pinned real-world repository scenarios materialized as local fixtures
- two simulated control scenarios

The suite is not the entire confidence story. Smaller focused suites should continue to catch localized regressions, while these sentinels prove that graph authoring, managed patterns, plugin lowering, support metadata, checkpoint flow, supervisor recovery, artifacts, and delivery evidence still work together.

Run validation:

```sh
agentflow eval validate evals/agentflow-validation
```

Run one scenario:

```sh
agentflow eval run evals/agentflow-validation --scenario all-primitives-checkpoint-loop --variant current --trials 1
```

Run the full release-confidence sweep:

```sh
npm run validate:release-confidence
```

This is intentionally expensive. It runs the standard checks, validates the sentinel suite, then runs all five sentinel scenarios with `--trials 3`. Do not claim release confidence from unit tests, build output, or the two simulated sentinels alone.
