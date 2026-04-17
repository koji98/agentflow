# Agentflow Evals

Agentflow evals are local, file-backed suites for evaluating agentic workflows built with Agentflow.

They are not hosted evals, and they are not a replacement for Agentflow's own unit tests. An eval suite runs one or more cases through an Agentflow graph, grades the local run artifacts, and writes a durable eval ledger under `.agentflow/evals/`.

## Commands

```bash
agentflow eval validate --suite evals/example/suite.json
agentflow eval run --suite evals/example/suite.json
agentflow eval report --eval-root .agentflow/evals/<eval-run-id>
```

`agentflow eval run` executes cases sequentially in this release.

## Suite Contract

Suites are JSON files. Paths resolve relative to the suite file directory.

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
    },
    {
      "id": "quality",
      "kind": "ai_rubric",
      "rubric": "rubrics/quality.md",
      "required": false
    }
  ],
  "thresholds": {
    "pass_rate": 0.9,
    "critical_failures": 0
  }
}
```

Cases are JSONL. Each row requires `id` and `task`, and may include `fixtures`, `repos`, `expected`, and `tags`.

```jsonl
{"id":"case-001","task":"Inspect the receipt and write normalized expense JSON.","fixtures":["fixtures/case-001/receipt.txt"],"repos":{"main":{"path":"../repo"}},"expected":{"merchant":"Acme Market"},"tags":["schema","happy_path"]}
```

## Graph Templates

Graph templates are ordinary Agentflow graph JSON files with string placeholders. The eval runner renders one graph per case and variant before launching the normal graph runtime.

Supported placeholders:

- `{{case.id}}`
- `{{case.task}}`
- `{{case.fixtures.root}}`
- `{{case.fixtures.<name-or-index>}}`
- `{{case.repos.<alias>.path}}`
- `{{case.<field>}}` for scalar case fields
- `{{suite.dir}}`

Use repo placeholders for graph `repos.*.path` values when possible. Rendered graphs are written under the eval artifact root, so relative repo paths in a template would otherwise resolve from that artifact directory.

## Graders

Script graders run locally from the suite directory and receive:

- `AGENTFLOW_EVAL_CASE_FILE`
- `AGENTFLOW_EVAL_RUN_ROOT`
- `AGENTFLOW_EVAL_TRACE_FILE`
- `AGENTFLOW_EVAL_VARIANT`
- `AGENTFLOW_EVAL_OUTPUT_DIR`

Graders must print normalized JSON to stdout:

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

AI rubric graders are optional local Codex-backed graders. They read the same local files through a generated context packet and produce the same normalized result shape. No hosted eval storage or hosted eval API is used.

## Artifacts

Default eval roots are created at:

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
