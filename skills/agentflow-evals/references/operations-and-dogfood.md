# Operations And Dogfood

Use evals to measure workflow behavior before relying on prompt, runtime, or supervisor changes.

## CLI

```bash
agentflow eval validate evals/agentflow-workflow-quality
agentflow eval run evals/agentflow-workflow-quality --variant current --scenario all --trials 3 --eval-root .agentflow/evals/workflow-quality --concurrency 4
agentflow eval report .agentflow/evals/workflow-quality --format markdown
agentflow eval inspect .agentflow/evals/workflow-quality --scenario missing-dependency-docs --variant current --trial 1
agentflow eval compare .agentflow/evals/workflow-quality --baseline current --candidate terse
```

For the larger local-repo capability suite:

```bash
npm run setup:eval-repos
agentflow eval validate evals/agentflow-capability-workflows
agentflow eval run evals/agentflow-capability-workflows --variant current --scenario all --trials 1 --eval-root .agentflow/evals/capability-workflows --concurrency 2
```

`--concurrency` controls trial-level parallelism, not the scheduler behavior inside one graph run.

For the pinned real-world GitHub issue suite:

```bash
npm run setup:realworld-evals
agentflow eval validate evals/agentflow-realworld-issues
agentflow eval run evals/agentflow-realworld-issues --variant current --scenario all --trials 1 --eval-root .agentflow/evals/realworld-issues --concurrency 1
```

Use `--trials 5` after a single-trial pass is stable. This suite clones MIT upstream repos into ignored `eval-repos/agentflow-realworld-issues/`, applies local regression patches, and should not depend on live GitHub during normal eval runs after setup.

## Review Order

Start with:

1. `<eval-root>/report.md`
2. `<eval-root>/benchmark.json`
3. failing trial `scorecard.json`
4. failing trial `criteria-results.json`
5. quality criterion `ai-check-result.json` and `judge-packet.json`
6. `trace-packet.json`
7. the underlying run root named in `run-root.txt`

For prompt changes, inspect `scorecard.prompt_feedback`, quality rationales, and concrete failed assertions before changing prompts or context surfaces.

## Iteration Loop

Use evals as an engineering loop:

1. Run a baseline on a small scenario set.
2. Inspect report, failing scorecards, trace packets, prompt feedback, and run roots.
3. Change one thing: graph shape, prompt pack, context pointer packaging, tool exposure, supervisor behavior, or criteria.
4. Rerun the same scenarios and trial count with the same fixtures.
5. Compare baseline and candidate.
6. Promote stable, important scenarios to a regression gate.

Do not tune against only one lucky trial. If results vary, increase trials or narrow the scenario before drawing conclusions.

## Prompt And Context Iteration

When tuning prompts or context:

- inspect what the node actually received;
- identify missing signal and noisy sections;
- remove context that does not affect decisions;
- prefer concise artifacts over raw logs;
- rerun the same scenario after each change;
- keep a candidate only if hard blockers do not regress.

## Built-In Dogfood Suites

The lightweight committed suite is `evals/agentflow-workflow-quality`.

It contains 20 local fake-workflow scenarios covering:

- declared artifact discipline
- placeholder artifact rejection
- no-tools baseline behavior
- tool discovery and tool-output-driven direction changes
- helper investigation
- missing local context
- ambiguous diagnostics
- missing dependency docs through a local docs fixture
- version-specific dependency docs
- semantic acceptance failure
- artifact repair without node retry
- repeated failure fingerprints
- parallel evidence gathering
- noisy context manifests
- pointer context provenance
- stale local docs
- machine-resolvable conflicts
- human-authority conflicts
- missing credentials or authority

It is a capability eval. It is useful even when the pass rate is below 100%, because failures identify where prompts, supervisor recovery, context surfacing, or delivery evidence should improve.

The larger prompt/context iteration suite is `evals/agentflow-capability-workflows`.

It generates ignored local repo fixtures under `eval-repos/agentflow-capability-workflows/` with `npm run setup:eval-repos`. Use it when you need harder end-to-end coverage across code repair, dependency docs, stale docs, noisy monorepos, local tools, no-repo-edit audit, sequence handoff, worktree backend behavior, supervisor retry envelopes, exhausted-recovery boundaries, pointer-provenance handling, and generated-tree noise control.

The highest-signal issue suite is `evals/agentflow-realworld-issues`.

It materializes pinned MIT GitHub repos with `npm run setup:realworld-evals`. Use it when generated fixtures are too easy and you need to evaluate real repository topology, real issue ambiguity, focused reproduction commands, source-scope discipline, and delivery auditability. The node sees only the local task and regression test; upstream PR/oracle metadata is for grading and reports.

## Real Validation

Run real Codex-backed validation when changing eval plumbing or prompt surfaces:

```bash
node scripts/validate-real-evals.mjs --harness codex-cli
```

The validator builds a temporary v1 suite with local environments and checks:

- real node run
- real eval trace packet
- deterministic criteria scorecard
- at least one quality criterion result
- report generation
- inspect/compare output

It skips only when `codex-cli` is unavailable. Cursor CLI uses the same architecture, but real Cursor validation is not required in this repo; use fake-harness coverage for Cursor compatibility.

## Capability Vs Regression

Capability evals ask what the workflow can do. They should include hard scenarios and can start with lower pass rates.

Regression evals ask whether behavior that used to work still works. They should be stable, local, and close to 100% pass rate.

Keep both when changing prompts or supervisor behavior: capability suites show where to improve, regression suites catch backsliding.

## Troubleshooting

- Validation fails before run: inspect path-specific diagnostics for missing suite, scenario, variant, criterion, rubric, script, environment fixture, simulation response file, or graph template files.
- A scenario has 0% pass rate across many trials: check if the task is ambiguous, impossible, or graded for a fact not in the task.
- Deterministic blockers fail but quality scores are positive: fix the workflow or deterministic criterion first; hard blockers win.
- Quality criteria error: open `judge-results/<id>/ai-check-result.json` and `judge-packet.json`.
- Trial has no trace packet: inspect `rendered-graph.json`, `trial.json`, and launch errors; the graph may not have reached runtime.
- External docs behavior is flaky: replace public network dependencies with local `docs/` environments and `{{environment.docs_url}}`, or use deterministic `environment.simulation` tool calls.
