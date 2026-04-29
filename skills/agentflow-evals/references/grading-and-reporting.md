# Grading And Reporting

Agentflow evals grade complete workflow traces. Deterministic graders own hard blockers; LLM judges own qualitative dimensions and prompt feedback.

## Trial Artifacts

Each trial writes:

- `rendered-graph.json`: graph after template substitution.
- `trial.json`: scenario, variant, trial id, and fixture bindings.
- `run-root.txt`: underlying Agentflow run root, when launch reached runtime.
- `trace.jsonl`: normalized event trace.
- `trace-packet.json`: compact grading packet.
- `deterministic-results.json`: built-in hard-fact assertions and blockers.
- `graders/<id>/stdout.txt` and `stderr.txt`: script grader IO.
- `judge-results/<id>/judge-packet.json`: anonymized judge packet.
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
- supervisor classifications, gatherers, apply actions, intervention count, and recovery count
- delivery manifest summary
- metrics such as attempts, artifacts, events, recovery cycles, and duration

Use trace packets for grader input. Use the full run root only when diagnosing a concrete failure.

## Deterministic Grading

Built-in deterministic assertions check:

- final graph status matches expected outcome
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

Script graders must print structured JSON:

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

Use deterministic graders for facts that can be checked objectively: file existence, content substrings, command results, forbidden edits, supervisor events, trace shape, tool invocation records, and delivery package evidence.

## LLM Judges

Use focused judges. Common dimensions:

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

LLM judges must not excuse deterministic blockers. A candidate variant with more hard blockers cannot beat the baseline even if judge scores are higher.

## Scorecards

`scorecard.json` contains:

- deterministic result and blockers
- script grader results
- LLM judge results
- average score
- dimension scores
- attempts, recovery cycles, duration, and blocker count
- merged prompt feedback
- final pass/fail/error status

Trial pass requires no deterministic blockers, required graders passing, required judges passing, and no infrastructure error.

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
- threshold result

Use:

```bash
agentflow eval report <eval-root> --format markdown
agentflow eval compare <eval-root> --baseline current --candidate candidate
agentflow eval inspect <eval-root> --scenario <id> --variant <id> --trial 1
```

Review deltas per scenario and dimension. Treat score improvements as meaningful only when deterministic blocker count does not regress.
