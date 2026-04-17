# Local Evals

Agentflow evals are local, file-backed suites for evaluating agentic workflows built with Agentflow. They are not hosted evals and are not a replacement for Agentflow's own unit tests.

## Commands

- `agentflow eval validate --suite <suite.json>`
- `agentflow eval run --suite <suite.json> [--case <id>] [--variant <id>] [--label <label>] [--evals-root <abs path>]`
- `agentflow eval report --eval-root <path>`

## Mental model

- suite: manifest, cases, variants, graders, thresholds
- case: one realistic task/scenario
- variant: candidate or optional baseline graph template
- graph run: normal Agentflow run root for one case and variant
- grader: local script or optional local AI rubric judge
- ledger: normalized aggregate result under the eval root

## Suite shape

Suites are JSON files. Paths resolve from the suite file directory.

```json
{
  "version": "1",
  "suite_id": "receipt-agent",
  "target": {
    "graph_template": "graphs/receipt-agent.graph.json"
  },
  "cases": "cases.jsonl",
  "variants": {
    "candidate": {},
    "baseline": {
      "graph_template": "graphs/receipt-agent-baseline.graph.json",
      "optional": true
    }
  },
  "graders": [
    {
      "id": "schema",
      "kind": "script",
      "command": "node graders/schema.mjs"
    }
  ],
  "thresholds": {
    "pass_rate": 0.9,
    "critical_failures": 0
  }
}
```

Cases are JSONL. Each row requires `id` and `task`, and may include `fixtures`, `repos`, `expected`, and `tags`.

## Graph templates

Graph templates are ordinary Agentflow graph JSON files with string placeholders.

Supported placeholders:

- `{{case.id}}`
- `{{case.task}}`
- `{{case.fixtures.root}}`
- `{{case.fixtures.<name-or-index>}}`
- `{{case.repos.<alias>.path}}`
- `{{case.<field>}}` for scalar case fields
- `{{suite.dir}}`

Use repo placeholders for `repos.*.path`. Rendered graphs live under the eval artifact root, so relative repo paths inside a template otherwise resolve from that artifact directory.

## Graders

Script graders run from the suite directory and receive:

- `AGENTFLOW_EVAL_CASE_FILE`
- `AGENTFLOW_EVAL_RUN_ROOT`
- `AGENTFLOW_EVAL_TRACE_FILE`
- `AGENTFLOW_EVAL_VARIANT`
- `AGENTFLOW_EVAL_OUTPUT_DIR`

Graders must print normalized JSON:

```json
{
  "passed": true,
  "score": 1,
  "summary": "short result",
  "assertions": [
    {
      "id": "schema_valid",
      "passed": true,
      "evidence": "output matched schema"
    }
  ],
  "metrics": {}
}
```

Grade both output and agentic process where possible:

- final artifacts
- graph run status
- check outcomes
- retry behavior
- forbidden path touches
- evaluator evidence

## Artifacts

Default eval roots:

```text
<launch-cwd>/.agentflow/evals/<timestamp>-<suite-id>[-label]/
```

Each case and variant writes:

- `rendered_graph.json`
- `run-root.txt`
- `trace.jsonl`
- `grading.json`
- `summary.md`

The suite writes:

- `eval-run.json`
- `evaluation-ledger.json`
- `benchmark.json`
- `summary.md`
