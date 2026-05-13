---
name: agentflow-evals
description: Use when designing, validating, running, inspecting, or improving Agentflow eval suites, scenarios, variants, criteria, environment simulation, trajectory checks, trace packets, scorecards, benchmark reports, prompt-pack experiments, dogfood workflow-quality evals, capability-workflow local repo evals, or pinned real-world GitHub issue evals.
---

# Agentflow Evals

Agentflow evals are offline workflow benchmarks. They run normal Agentflow graphs through local scenario environments, compare variants across repeated trials, grade hard facts with required criteria, rate qualitative behavior with quality criteria, evaluate trajectories when useful, simulate tools deterministically, and write auditable reports.

Use this skill for `agentflow eval`. Use `agentflow-authoring` for graph authoring, `agentflow-operations` for run debugging, `agentflow-run-review` for completed-run learning, and `agentflow-plugins` for plugin workflows and plugin-bundled tools.

## Must Know

- Evals are workflow tests for graphs, plugin workflows, prompt packs, supervisor recovery, tool behavior, and delivery auditability.
- Evals do not change the graph contract; they run normal graphs in controlled scenario environments.
- Scenarios should be realistic, local, reproducible, hard but solvable, and clear enough for two reviewers to grade the same way.
- Required deterministic criteria own hard blockers. Quality criteria judge behavior and prompt feedback; they never excuse blockers.
- Repeated trials matter when model variance matters.
- Prefer local repos, local docs fixtures, tool fixtures, and deterministic simulation over live public services.
- Capability suites can start below 100% pass rate. Regression gates should be stable and near 100%.
- Do not call a suite ready until validate, a single trial, report, inspect, and compare produce useful artifacts.

## Route By Task

- Need to choose eval shape: read [references/eval-patterns.md](references/eval-patterns.md).
- Need suite/scenario/variant layout or schemas: read [references/suite-authoring.md](references/suite-authoring.md).
- Need criteria, quality judges, trajectory checks, scorecards, trace packets, or benchmark comparison: read [references/grading-and-reporting.md](references/grading-and-reporting.md).
- Need dogfood suite, real validation, capability/regression posture, or troubleshooting: read [references/operations-and-dogfood.md](references/operations-and-dogfood.md).
- Need graph primitives or node contracts: use `agentflow-authoring`.
- Need runtime supervision, run inspection, resume, or delivery package semantics: use `agentflow-operations`.
- Need to extract eval scenarios from completed runs: use `agentflow-run-review`.

## Default Workflow

1. Decide the eval purpose: regression gate, capability benchmark, variant comparison, supervisor recovery benchmark, plugin/tool contract eval, or real-world workflow eval.
2. Choose the eval shape from `eval-patterns.md`.
3. Keep fixtures local and stable. Prefer local repo fixtures, local HTTP docs fixtures, pinned upstream repo SHAs, local tool fixtures, and deterministic simulation over live public network dependencies.
4. Make each scenario hard but solvable, with expected behavior clear enough that two reviewers would grade it the same way.
5. Put hard facts in required deterministic criteria and custom scripts; use quality criteria only for qualitative workflow behavior.
6. Compare variants through anonymized judge packets; never rely on variant names to influence LLM grading.
7. Run `agentflow eval validate <suite-dir-or-eval.json>` before any expensive run.
8. Run one trial for one scenario and inspect artifacts before scaling up.
9. Run repeated trials with `agentflow eval run <suite> --variant <id|all> --scenario <id|all> --trials <n> --eval-root <path> --concurrency <n>`.
10. Start review from `report.md` and `benchmark.json`, then inspect failed trial scorecards and trace packets.
11. For repo validation, run `node scripts/validate-real-evals.mjs --harness codex-cli` when real Codex CLI behavior matters.

## Authoring Posture

- Eval suites use version `"1"` and are separate from graph version `"1"`. Do not add eval concerns to the graph contract.
- A trial is scenario x variant x run number. Use repeated trials when model variance matters.
- Expected `paused` and `failed` outcomes can be correct behavior when authority, credentials, policy, or underspecified intent should stop the workflow.
- Required deterministic criteria override quality scores.
- Capability suites should include difficult tasks and may start below 100%. Regression suites should target near-100% pass rates for behavior that must not drift.
- If a scenario has 0% pass rate across many trials, first check whether the task is ambiguous, impossible, or overfit to brittle grader assumptions.
