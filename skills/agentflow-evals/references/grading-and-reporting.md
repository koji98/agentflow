# Grading And Reporting

Agentflow evals grade complete workflow traces. Required deterministic criteria own hard blockers; quality criteria own qualitative dimensions and prompt feedback.

## Trial Artifacts

Each trial writes:

- `rendered-graph.json`: graph after template substitution.
- `trial.json`: scenario, variant, trial id, and environment bindings.
- `run-root.txt`: underlying Agentflow run root, when launch reached runtime.
- `simulation-events.jsonl`: deterministic environment simulation calls, when configured.
- `trace.jsonl`: normalized event trace.
- `trace-packet.json`: compact grading packet with `trajectory`.
- `criteria-results.json`: every criterion result.
- `criteria/<id>/stdout.txt` and `stderr.txt`: custom script criterion IO.
- `judge-results/<id>/judge-packet.json`: anonymized quality criterion packet.
- `judge-results/<id>/ai-check-result.json`: raw/parsed LLM judge harness result.
- `scorecard.json`: final trial result.
- `summary.md`: human-readable trial summary.

The eval root also writes `eval-run.json`, `evaluation-ledger.json`, `suite-snapshot.json`, `benchmark.json`, and `report.md`.

## Trace Packet

The trace packet summarizes:

- run outcome and node counts
- attempts and statuses
- declared artifacts and compact contents
- runtime events
- `trajectory` events for attempts, simulation calls, artifact writes, supervisor events, and delivery
- simulation events
- supervisor classifications, gatherers, apply actions, intervention count, and recovery count
- delivery manifest summary
- metrics such as attempts, artifacts, events, recovery cycles, trajectory length, and duration

Use trace packets for criterion input. Use the full run root only when diagnosing a concrete failure.

## Built-In Deterministic Criteria

Built-in criteria check:

- `outcome`: final graph status.
- `artifact`: required artifacts and substrings.
- `workspace`: forbidden paths.
- `supervisor`: expected classifications, gatherers, and apply actions.
- `trajectory`: ordered, unordered, exact, or forbidden trajectory events.
- `delivery`: delivery manifest presence.

## Custom Script Criteria

Custom script criteria run from the suite directory and receive:

- `AGENTFLOW_EVAL_SCENARIO_ID`
- `AGENTFLOW_EVAL_VARIANT`
- `AGENTFLOW_EVAL_TRIAL_ID`
- `AGENTFLOW_EVAL_CRITERION_ID`
- `AGENTFLOW_EVAL_RUN_ROOT`
- `AGENTFLOW_EVAL_TRACE_FILE`
- `AGENTFLOW_EVAL_TRACE_PACKET_FILE`
- `AGENTFLOW_EVAL_SCORECARD_FILE`
- `AGENTFLOW_EVAL_OUTPUT_DIR`

They must print structured JSON:

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

Use custom scripts for facts that can be checked objectively but are too suite-specific for built-ins: changed-file scopes, focused commands, hidden oracle metadata, tool invocation records, delivery package details, and real-world regression commands.

## Quality Criteria

Use focused quality criteria. Common dimensions:

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

Quality output must be strict JSON:

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

Quality criteria must not excuse deterministic blockers. A candidate variant with more hard blockers cannot beat the baseline even if quality scores are higher.

## Rubric Writing

Write anchored rubrics so judges grade evidence, not vibes.

- Score 1: unusable, violates graph/scenario contract, misses core evidence, or creates serious risk.
- Score 2: partially relevant but important requirements, evidence, or artifacts are missing.
- Score 3: usable with notable gaps, weak evidence, excess noise, or incomplete risk handling.
- Score 4: correct and well-supported with minor issues.
- Score 5: strong, concise, evidence-backed, low-noise, and directly aligned with scenario intent.

Rubrics should tell the judge:

- which trace/artifact fields matter;
- what counts as a blocker;
- what evidence must be cited in `rationale`;
- which prompt/context sections were helpful, noisy, or missing;
- that deterministic failures cannot be waived by quality scores.

Prefer multiple focused quality criteria over one giant judge. For example, use separate criteria for `artifact_quality`, `context_handling`, `tool_discipline`, and `supervisor_recovery_quality` when those dimensions matter.

## Scorecards

`scorecard.json` contains:

- `criteria_results`
- average score
- dimension scores
- attempts, recovery cycles, duration, and blocker count
- merged prompt feedback
- final pass/fail/error status

Trial pass requires all required criteria to pass and no infrastructure error. Optional quality criteria can fail without failing the trial, but their scores and prompt feedback remain visible.

## Benchmark Comparison

`benchmark.json` aggregates:

- total trials
- passed/failed/errored/skipped
- pass rate
- blocker rate
- average score
- score variance
- pass@1
- pass@k
- per-variant summaries
- per-criterion summaries
- threshold result

Use:

```bash
agentflow eval report <eval-root> --format markdown
agentflow eval compare <eval-root> --baseline current --candidate candidate
agentflow eval inspect <eval-root> --scenario <id> --variant <id> --trial 1
```

Review deltas by criterion and variant. Treat score improvements as meaningful only when hard blockers do not regress.
