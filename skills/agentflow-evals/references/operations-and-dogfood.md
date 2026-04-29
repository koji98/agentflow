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

`--concurrency` controls trial-level parallelism, not the scheduler behavior inside one graph run.

## Review Order

Start with:

1. `<eval-root>/report.md`
2. `<eval-root>/benchmark.json`
3. failing trial `scorecard.json`
4. failing trial `deterministic-results.json`
5. judge `ai-check-result.json` and `last_message.txt`
6. `trace-packet.json`
7. the underlying run root named in `run-root.txt`

For prompt iteration, inspect `scorecard.prompt_feedback`, judge rationales, and concrete failed assertions before changing prompts or context surfaces.

## Built-In Dogfood Suite

The built-in suite is `evals/agentflow-workflow-quality`.

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
- truncated context provenance
- stale local docs
- machine-resolvable conflicts
- human-authority conflicts
- missing credentials or authority

It is a capability eval. It is useful even when the pass rate is below 100%, because failures identify where prompts, supervisor recovery, context surfacing, or delivery evidence should improve.

## Real Validation

Run real Codex-backed validation when changing eval plumbing or prompt surfaces:

```bash
node scripts/validate-real-evals.mjs --harness codex-cli
```

The validator builds a temporary v2 suite with local fixtures and checks:

- real node run
- real eval trace packet
- deterministic scorecard
- at least one LLM judge result
- report generation
- inspect/compare output

It skips only when `codex-cli` is unavailable. Cursor CLI uses the same architecture, but real Cursor validation is not required in this repo; use fake-harness coverage for Cursor compatibility.

## Capability Vs Regression

Capability evals ask what the workflow can do. They should include hard scenarios and can start with lower pass rates.

Regression evals ask whether behavior that used to work still works. They should be stable, local, and close to 100% pass rate.

Keep both when changing prompts or supervisor behavior: capability suites show where to improve, regression suites catch backsliding.

## Troubleshooting

- Validation fails before run: inspect path-specific diagnostics for missing suite, scenario, variant, judge, grader, fixture, or graph template files.
- A scenario has 0% pass rate across many trials: check if the task is ambiguous, impossible, or graded for a fact not in the task.
- Deterministic blockers fail but judges are positive: fix the workflow or grader first; hard blockers win.
- Judges error: open `judge-results/<id>/ai-check-result.json`, `last_message.txt`, and `judge-packet.json`.
- Trial has no trace packet: inspect `rendered-graph.json`, `trial.json`, and launch errors; the graph may not have reached runtime.
- External docs behavior is flaky: replace public network dependencies with local `docs/` fixtures and `{{fixture.docs_url}}`.
