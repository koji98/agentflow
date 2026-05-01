# Eval Patterns

Choose the eval shape before writing schema. Good suites measure a team decision: whether to trust a workflow, compare variants, improve prompts/context, validate recovery, or guard against regression.

## Regression Gate

Use when behavior already works and should not drift.

- Scenarios: small, stable, local, deterministic.
- Trials: usually 1-3 unless model variance is known.
- Criteria: required `outcome`, `artifact`, `workspace`, `delivery`, and focused custom scripts.
- Thresholds: near-100% pass rate.
- Avoid when the workflow is still exploratory or expected to fail often.

## Capability Benchmark

Use to learn what a workflow can handle.

- Scenarios: hard, varied, realistic, and solvable.
- Trials: enough to reveal variance.
- Criteria: deterministic blockers plus quality criteria for behavior differences.
- Thresholds: may start below 100%; failures are improvement signals.
- Avoid using capability pass rates as release gates until stable scenarios are promoted.

## Variant Comparison

Use to compare prompt packs, context strategy, graph shape, tool exposure, supervisor behavior, or runtime settings.

- Scenarios: same scenario set across baseline and candidate.
- Variants: `current`, `candidate`, or focused alternatives.
- Criteria: hard blockers plus quality dimensions that explain the tradeoff.
- Trials: repeated trials matter; compare variance and pass@k.
- Rule: candidate cannot beat baseline if it adds deterministic blockers.

## Supervisor Recovery Benchmark

Use to validate machine-first recovery.

- Scenarios: missing docs, context overflow, noisy generated trees, artifact repair, validation timeout, workspace pollution, repeated failure fingerprints, expected authority pauses.
- Criteria: `supervisor` classifications/gatherers/apply actions, `trajectory`, recovery artifacts, final status, and delivery.
- Simulation: useful for deterministic tool or external-service failures.
- Avoid if the scenario does not force a recoverable failure.

## Plugin And Tool Contract Eval

Use to validate plugin workflows, plugin-bundled tools, native-vs-plugin tradeoffs, auth boundaries, output contracts, and tool discipline.

- Scenarios: tool help contract, stable stdout JSON, stderr diagnostics, auth failure, simulated remote outage, node-level tool scoping.
- Criteria: custom script assertions, trajectory events, tool invocation records, forbidden secret exposure, artifact quality.
- Simulation: proxy external CLIs or inject service failures.
- Avoid live public service dependencies unless explicitly testing a real harness path.

## Real-World Workflow Eval

Use when fake repos are too easy.

- Scenarios: pinned upstream repos, internal repo snapshots, real issue text, local regression patches, focused validation commands.
- Fixtures: generated or cloned into ignored local dirs by setup scripts.
- Criteria: focused tests, allowed/forbidden changed files, delivery evidence, hidden oracle metadata for graders only.
- Trials: start with one; increase after setup is stable.
- Avoid exposing upstream PR patches or hidden oracle details to graph context.

## Techniques Used Across Patterns

- Deterministic criteria: hard facts and blockers.
- Quality criteria: qualitative behavior and prompt feedback.
- Trajectory checks: tool/recovery/order behavior when order matters.
- Environment simulation: deterministic tool responses, outages, latency, and seeded probability.
- Repeated trials: variance measurement.
- Hidden oracle metadata: grader/report-only facts, never graph context.

## Promotion Path

Start with capability scenarios. When a scenario becomes stable, cheap, and important, promote it to a regression gate with thresholds. Keep hard exploratory scenarios in capability suites so prompt/context/runtime work has room to improve.
