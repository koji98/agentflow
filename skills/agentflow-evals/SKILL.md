---
name: agentflow-evals
description: Use when designing, validating, running, inspecting, or improving Agentflow eval suites, scenarios, variants, deterministic graders, LLM judges, trace packets, scorecards, benchmark reports, prompt-pack experiments, or dogfood workflow-quality evals.
---

# Agentflow Evals

Agentflow evals are offline workflow benchmarks. They run normal Agentflow graphs through local scenario fixtures, compare variants across repeated trials, grade hard facts with deterministic graders, rate qualitative behavior with LLM judges, and write auditable reports.

Use this skill for `agentflow eval`. Use `agentflow` for graph authoring and run debugging. Use `agentflow-plugins` for plugin workflows and plugin-bundled tools.

## Route By Task

- Need suite/scenario/variant layout or schemas: read [references/suite-authoring.md](references/suite-authoring.md).
- Need deterministic graders, LLM judges, scorecards, trace packets, or benchmark comparison: read [references/grading-and-reporting.md](references/grading-and-reporting.md).
- Need dogfood suite, real validation, capability/regression posture, or troubleshooting: read [references/operations-and-dogfood.md](references/operations-and-dogfood.md).
- Need graph primitives, node contracts, runtime supervision, or delivery package semantics: use `agentflow`.

## Default Workflow

1. Decide the eval purpose: capability hill-climb, regression gate, prompt-pack comparison, supervisor recovery validation, tool discipline, or delivery auditability.
2. Keep fixtures local and stable. Prefer local repo fixtures, local HTTP docs fixtures, and local tool fixtures over public network dependencies.
3. Make each scenario hard but solvable, with expected behavior clear enough that two reviewers would grade it the same way.
4. Put hard facts in deterministic expectations and script graders; use LLM judges only for qualitative workflow behavior.
5. Compare variants through anonymized judge packets; never rely on variant names to influence LLM grading.
6. Run `agentflow eval validate <suite-dir-or-eval.json>` before any expensive run.
7. Run `agentflow eval run <suite> --variant <id|all> --scenario <id|all> --trials <n> --eval-root <path> --concurrency <n>`.
8. Start review from `report.md` and `benchmark.json`, then inspect failed trial scorecards and trace packets.
9. For repo validation, run `node scripts/validate-real-evals.mjs --harness codex-cli` when real Codex CLI behavior matters.

## Authoring Posture

- Eval suites use version `"2"` and are separate from graph version `"1"`. Do not add eval concerns to the graph contract.
- A trial is scenario x variant x run number. Use repeated trials when model variance matters.
- Expected `paused` and `failed` outcomes can be correct behavior when authority, credentials, policy, or underspecified intent should stop the workflow.
- Deterministic blockers override LLM judge scores.
- Capability suites should include difficult tasks and may start below 100%. Regression suites should target near-100% pass rates for behavior that must not drift.
- If a scenario has 0% pass rate across many trials, first check whether the task is ambiguous, impossible, or overfit to brittle grader assumptions.
