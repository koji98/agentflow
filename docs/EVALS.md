# Evals

`agentflow eval` is the offline workflow evaluation system for Agentflow. It runs complete Agentflow workflows against local scenario fixtures, grades hard facts with deterministic graders, rates qualitative behavior with LLM judges, and writes auditable benchmark artifacts.

This is not the graph contract. Authored graphs remain version `"1"`. Eval suites use their own version `"2"` schema so Agentflow maintainers and workflow authors can test prompts, runtime behavior, supervision, tools, artifacts, and delivery quality without adding fields to graphs.

The design follows Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): define tasks/scenarios with success criteria, run repeated trials because agent behavior is nondeterministic, grade outcomes and traces with multiple graders, and aggregate results into capability and regression reports.

## When To Use Evals

Use `agentflow eval` when the question is about workflow behavior across repeated runs:

- Does this graph reliably produce the intended artifacts?
- Does the supervisor recover from missing context, docs gaps, repeated failures, or semantic rejection?
- Does a prompt-pack variant reduce noise without lowering quality?
- Does a tool-enabled workflow use tools only when helpful?
- Does a candidate runtime or prompt change improve quality without adding deterministic blockers?

Use other evaluation lanes for other jobs:

- Graph `check` nodes are in-run sensors that can gate graph flow.
- Outcome verification grades each passing `agent` attempt against authored graph and node criteria.
- Supervisor `semantic_evaluation` is a recovery intervention after a failed or uncertain runtime attempt.
- Managed pattern evaluation is authored workflow structure inside patterns such as `pattern_generate_evaluate_fix`.
- `agentflow eval` is offline benchmarking over suites, scenarios, variants, and trials.

## Concepts

- `Suite`: benchmark definition for one workflow capability or product surface.
- `Scenario`: a self-contained fake workflow environment with repo/docs/tool fixtures, graph template, expected behavior, and grading config.
- `Variant`: a candidate workflow, runtime environment, or prompt-pack configuration to compare.
- `Trial`: one scenario x variant execution.
- `TracePacket`: normalized grading packet extracted from a run root.
- `Scorecard`: one trial's deterministic blockers, script grader results, LLM judge results, scores, metrics, and prompt feedback.
- `Benchmark`: aggregate pass rates, blocker rates, scores, variance, pass@1/pass@k, and variant summaries.

## Suite Layout

```text
evals/<suite-id>/
  eval.json
  variants/
    current.json
    candidate.json
  judges/
    artifact-quality.md
    contract-adherence.md
  graders/
    deterministic.mjs
  scenarios/
    <scenario-id>/
      scenario.json
      graph.template.json
      repo/
      docs/
      tools/
```

`eval validate` accepts either the suite directory or the `eval.json` file.

## Suite Schema

Suite files must use `version: "2"`.

```json
{
  "version": "2",
  "suite_id": "agentflow-workflow-quality",
  "objective": "Measure workflow quality across local hard scenarios.",
  "default_trials": 3,
  "scenarios": ["scenarios/missing-docs/scenario.json"],
  "variants": ["variants/current.json", "variants/terse.json"],
  "graders": [
    { "id": "workflow-deterministic", "kind": "script", "command": "node graders/workflow-deterministic.mjs" }
  ],
  "judges": [
    { "id": "artifact-quality", "rubric": "judges/artifact-quality.md" }
  ],
  "thresholds": {
    "pass_rate": 0.8,
    "max_blocker_rate": 0.05,
    "min_average_score": 4
  }
}
```

Required fields:

- `suite_id`: stable id used in artifact paths and reports.
- `objective`: what capability this suite measures.
- `default_trials`: default trial count per scenario and variant.
- `scenarios`: paths to scenario JSON files.
- `variants`: paths to variant JSON files.
- `graders`: script graders. Each command runs from the suite directory.
- `judges`: LLM judges with rubric files. Codex CLI is the default judge harness when omitted.
- `thresholds`: optional benchmark gates for pass rate, blocker rate, and average score.

Validation is strict and path-specific. Missing scenario, variant, grader, judge, fixture, or graph template paths fail before any trial runs.

## Scenario Schema

```json
{
  "id": "missing-dependency-docs",
  "bucket": "valid-hard-execution",
  "difficulty": "hard",
  "description": "The node needs version-specific docs from a local fixture to recover.",
  "fixture": {
    "repo": "repo",
    "docs": "docs",
    "tools": "tools",
    "init_git": true
  },
  "workflow": {
    "graph_template": "graph.template.json",
    "harness": "codex-cli",
    "workspace_backend": "inplace"
  },
  "expected": {
    "final_outcome": "passed",
    "required_artifacts": [
      { "name": "handoff", "contains": ["stableMethod"] }
    ],
    "forbidden_edits": ["forbidden.txt"],
    "supervisor": {
      "classifications": ["missing_dependency_docs"],
      "gatherers": ["external_context"],
      "apply_actions": ["retry_node"]
    }
  },
  "grading": {
    "dimensions": ["evidence_use", "supervisor_recovery_quality"]
  }
}
```

Fixture behavior:

- `repo` is copied into an isolated trial workspace.
- `init_git: true` initializes a git repo in that isolated copy when the copied repo is not already a repo.
- `docs` starts a local HTTP docs fixture and exposes `{{fixture.docs_url}}` to the graph template.
- `tools` is copied, chmodded, and placed on `PATH` for the trial.

Commit only portable fixture seeds. Do not commit cloned third-party repositories, generated eval repos, generated trial workspaces, `.git` directories, package installs, or eval output roots. If a scenario needs a real upstream repository, add a small setup script or documented clone step that creates the fixture locally before `agentflow eval validate` runs.

Template variables available in graph templates:

- `{{scenario.id}}`
- `{{variant.id}}`
- `{{trial.id}}`
- `{{trial.index}}`
- `{{trial.root}}`
- `{{fixture.repo}}`
- `{{fixture.docs_url}}`
- `{{fixture.tools}}`
- `{{fixture.eval_root}}`

Expected outcomes may be `passed`, `failed`, `paused`, or `canceled`. Expected pause/fail scenarios are valid eval passes when the expected state and evidence match.

## Variant Schema

```json
{
  "id": "terse",
  "description": "Prompt pack with shorter context and recovery guidance.",
  "env": {
    "AGENTFLOW_EVAL_PROMPT_PACK": "terse"
  },
  "prompt_pack": "terse"
}
```

Variants can override:

- graph template path
- runtime environment variables
- eval-only prompt pack via `AGENTFLOW_EVAL_PROMPT_PACK`

Variant ids are never shown directly to LLM judges. Judge packets use anonymized labels such as `variant-01` so qualitative grading does not bias toward variant names.

## CLI

```bash
agentflow eval validate evals/agentflow-workflow-quality
agentflow eval run evals/agentflow-workflow-quality --variant current --scenario all --trials 3 --eval-root .agentflow/evals/workflow-quality --concurrency 4
agentflow eval report .agentflow/evals/workflow-quality --format markdown
agentflow eval inspect .agentflow/evals/workflow-quality --scenario missing-dependency-docs --variant current --trial 1
agentflow eval compare .agentflow/evals/workflow-quality --baseline current --candidate terse
```

Run behavior:

1. Load and validate the suite.
2. Expand scenario x variant x trial.
3. Prepare an isolated trial workspace.
4. Render the graph template.
5. Run normal `agentflow run`.
6. Build a trace packet from the run root when one exists.
7. Run deterministic grading even for failed or paused graphs.
8. Run script graders and LLM judges when a trace packet exists.
9. Build scorecards and aggregate the benchmark.
10. Exit nonzero for infrastructure failures or failing benchmark thresholds.

`--concurrency` controls how many trials run at once. It does not change per-graph scheduler concurrency.

## Artifacts

Eval artifacts live under the selected eval root:

```text
<eval-root>/
  eval-run.json
  evaluation-ledger.json
  suite-snapshot.json
  benchmark.json
  report.md
  scenarios/<scenario>/<variant>/trial-001/
    rendered-graph.json
    trial.json
    run-root.txt
    trace.jsonl
    trace-packet.json
    deterministic-results.json
    graders/<grader-id>/stdout.txt
    graders/<grader-id>/stderr.txt
    judge-results/<judge-id>/
      judge-packet.json
      ai-check-result.json
      last_message.txt
      context/
        manifest.md
        packet.json
    scorecard.json
    summary.md
```

The eval root intentionally stores both compact reports and raw audit evidence. Review `report.md` first, then inspect failing trial `scorecard.json`, `deterministic-results.json`, and `judge-results/*/ai-check-result.json`.

## Deterministic Graders

The built-in deterministic grader checks hard facts before optional custom graders:

- final graph status matches `expected.final_outcome`
- required artifacts exist and contain required substrings
- forbidden edits are absent
- delivery manifest exists
- expected supervisor classifications, gatherers, and apply actions occurred

Custom script graders run from the suite directory and receive:

- `AGENTFLOW_EVAL_SCENARIO_ID`
- `AGENTFLOW_EVAL_VARIANT`
- `AGENTFLOW_EVAL_TRIAL_ID`
- `AGENTFLOW_EVAL_RUN_ROOT`
- `AGENTFLOW_EVAL_TRACE_FILE`
- `AGENTFLOW_EVAL_TRACE_PACKET_FILE`
- `AGENTFLOW_EVAL_SCORECARD_FILE`
- `AGENTFLOW_EVAL_OUTPUT_DIR`

They must print JSON:

```json
{
  "passed": true,
  "score": 5,
  "summary": "hard facts pass",
  "assertions": [
    { "id": "artifact", "passed": true, "evidence": "handoff exists" }
  ],
  "metrics": {
    "tool_calls": 2
  }
}
```

Deterministic blockers are authoritative. A candidate cannot win by receiving better judge scores when it has more hard blockers.

## LLM Judges

Judges rate qualitative workflow behavior, not hard facts that deterministic graders can check. Prefer focused judges over one giant judge. Common dimensions:

- `outcome_correctness`
- `graph_contract_adherence`
- `artifact_quality`
- `evidence_use`
- `context_handling`
- `tool_discipline`
- `supervisor_recovery_quality`
- `retry_behavior`
- `noise_efficiency`
- `delivery_auditability`

Judge output must be strict JSON:

```json
{
  "passed_quality_bar": true,
  "score": 4,
  "dimension_scores": {
    "artifact_quality": 4
  },
  "blockers": [],
  "rationale": "short evidence-backed explanation",
  "prompt_feedback": {
    "helpful_sections": [],
    "noisy_sections": [],
    "missing_guidance": []
  }
}
```

Store every judge packet, raw harness result, parsed output, model/harness metadata, and last message. Judge failures are audit evidence, not something to hide.

## Benchmark Reports

`benchmark.json` and `report.md` include:

- total trials
- pass rate
- blocker rate
- average score
- score variance
- pass@1
- pass@k
- per-variant pass/fail/error counts
- threshold result

Use `eval compare` to review baseline vs candidate deltas. Capability suites should include hard scenarios with room to improve; regression suites should target near-100% pass rates for behavior that must not drift.

## Dogfood Suites

The minimal example suite is:

```bash
agentflow eval validate docs/examples/evals/basic
agentflow eval run docs/examples/evals/basic --eval-root .agentflow/evals/basic --trials 1
```

The lightweight built-in supervisor/runtime suite is:

```bash
agentflow eval validate evals/agentflow-workflow-quality
agentflow eval run evals/agentflow-workflow-quality --variant current --trials 1
```

It contains 20 committed local fake-workflow scenarios covering declared artifact discipline, tool use, helper investigation, missing local context, missing dependency docs, semantic acceptance failure, artifact repair, repeated fingerprints, parallel evidence gathering, noisy evidence, stale docs, machine-resolvable conflicts, and authority-boundary pauses.

The suite is a capability eval, not a release gate that must start at 100%. Its job is to expose prompt/runtime/supervisor opportunities and regressions.

The heavier real-repo-fixture suite is:

```bash
npm run setup:eval-repos
agentflow eval validate evals/agentflow-capability-workflows
agentflow eval run evals/agentflow-capability-workflows --variant current --scenario all --trials 1 --concurrency 2
```

It writes portable local fixture repositories under ignored `eval-repos/agentflow-capability-workflows/` and should be used for prompt/context iteration. The scenarios cover code repair, docs-backed migration, stale docs conflicts, scoped edits, noisy monorepo targeting, local tool use, no-repo-edit audit, sequence handoff, worktree backend behavior, supervisor retry envelopes, and expected terminal failure.

The pinned real-world issue suite is:

```bash
npm run setup:realworld-evals
agentflow eval validate evals/agentflow-realworld-issues
agentflow eval run evals/agentflow-realworld-issues --variant current --scenario all --trials 1 --concurrency 1
```

It clones MIT-licensed upstream repositories at committed base SHAs into ignored `eval-repos/agentflow-realworld-issues/`, applies Agentflow-owned regression patches, and grades whether workflows fix real issues without seeing upstream PR patches. Use it for high-signal prompt/context iteration once the generated suite is too easy. It currently covers validator.js URL parsing, validator.js slug validation, date-fns UTC date-extension helpers, date-fns French ordinal formatting architecture, and execa escaped-newline template parsing.

## Real Validation

Use the real eval validator when the local Codex CLI binary is available:

```bash
node scripts/validate-real-evals.mjs --harness codex-cli
```

The validator creates a temporary v2 eval suite with local repo/docs fixtures, runs real `codex-cli` node attempts and LLM judges, then verifies trace packets, deterministic scorecards, judge output, reports, and inspect/compare plumbing. Cursor CLI uses the same eval architecture, but this repository only requires fake-harness Cursor coverage because real Cursor CLI is not available in normal validation.

## Authoring Good Scenarios

Good eval scenarios are hard, local, and solvable:

- Make the expected outcome unambiguous enough that two reviewers would grade it the same way.
- Ensure a reference solution could pass all deterministic graders.
- Test both positive and negative behavior so the suite is not one-sided.
- Include repeated trials when model variance matters.
- Keep fixtures local and stable. Use local HTTP docs fixtures instead of public web dependencies.
- Put hard facts in deterministic graders. Use LLM judges for quality, discipline, evidence use, and prompt feedback.
- Include scenarios that should pause or fail when the correct behavior is to avoid unauthorized work.
- Track both capability and regression suites. Capability evals can begin below 100%; regression evals should be tight gates.

When a scenario has 0% pass rate across many trials, first suspect an ambiguous or impossible task, missing fixture, or brittle grader before treating it as a model/runtime failure.
