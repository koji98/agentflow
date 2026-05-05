# Evals

`agentflow eval` is Agentflow's offline workflow evaluation system. It runs complete Agentflow workflows against local scenario environments, grades hard facts with required criteria, rates qualitative behavior with LLM quality criteria, and writes auditable benchmark artifacts.

Eval schema version is `"1"`. This is separate from the graph contract, which is also version `"1"` but has its own schema. Evals do not add fields to graphs.

The methodology follows Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): scenarios, repeated trials, traces, deterministic grading, qualitative judgment, outcomes, and aggregate reports. Agentflow also adopts useful ADK mechanics from [ADK evaluation](https://adk.dev/evaluate/): first-class criteria, explicit trajectory evaluation, and deterministic environment simulation.

## Concepts

- `Suite`: benchmark definition for a workflow capability or regression surface.
- `Scenario`: self-contained local environment, graph template, and criteria config.
- `Variant`: candidate prompt pack, runtime env, or graph-template override.
- `Trial`: one scenario x variant run.
- `TracePacket`: normalized packet extracted from run artifacts, including trajectory.
- `Scorecard`: per-trial criteria results, scores, blockers, metrics, and prompt feedback.
- `Benchmark`: aggregate pass rates, blocker rates, scores, variance, pass@1/pass@k, and variant comparisons.

## Layout

```text
evals/<suite-id>/
  eval.json
  variants/
    current.json
  judges/
    artifact-quality.md
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

```json
{
  "version": "1",
  "suite_id": "agentflow-workflow-quality",
  "objective": "Measure workflow quality across local hard scenarios.",
  "default_trials": 3,
  "scenarios": [
    "scenarios/missing-docs/scenario.json"
  ],
  "variants": [
    "variants/current.json",
    "variants/terse.json"
  ],
  "criteria": [
    {
      "id": "outcome",
      "kind": "outcome",
      "required": true
    },
    {
      "id": "artifact",
      "kind": "artifact",
      "required": true
    },
    {
      "id": "workspace",
      "kind": "workspace",
      "required": true
    },
    {
      "id": "supervisor",
      "kind": "supervisor",
      "required": true
    },
    {
      "id": "trajectory",
      "kind": "trajectory",
      "required": false
    },
    {
      "id": "delivery",
      "kind": "delivery",
      "required": true
    },
    {
      "id": "workflow-deterministic",
      "kind": "custom_script",
      "command": "node graders/workflow-deterministic.mjs"
    },
    {
      "id": "artifact-quality",
      "kind": "quality",
      "rubric": "judges/artifact-quality.md",
      "required": false
    }
  ],
  "thresholds": {
    "pass_rate": 0.8,
    "max_blocker_rate": 0.05,
    "min_average_score": 4
  }
}
```

Supported criterion kinds:

- `outcome`: final graph status.
- `artifact`: declared artifact existence and required substrings.
- `workspace`: forbidden path checks.
- `supervisor`: expected classifications, gatherers, and apply actions.
- `trajectory`: ordered or forbidden trace events.
- `delivery`: delivery manifest presence.
- `custom_script`: deterministic script criterion.
- `quality`: LLM-backed quality criterion with a rubric file.

Legacy `expected`, `grading`, top-level `graders`, top-level `judges`, and `fixture` fields are invalid.

## Scenario Schema

```json
{
  "id": "missing-dependency-docs",
  "bucket": "valid-hard-execution",
  "difficulty": "hard",
  "description": "The node needs version-specific docs from a local fixture to recover.",
  "environment": {
    "repo": "repo",
    "docs": "docs",
    "tools": "tools",
    "init_git": true,
    "simulation": {
      "seed": "stable",
      "tool_calls": [
        {
          "id": "docs-503",
          "command": "docs-fetch",
          "match": {
            "argv_contains": [
              "--url"
            ]
          },
          "error": {
            "stderr": "maintenance",
            "exit_code": 503
          },
          "latency_ms": 50,
          "probability": 1
        }
      ]
    }
  },
  "workflow": {
    "graph_template": "graph.template.json",
    "harness": "codex-cli",
    "workspace_backend": "inplace"
  },
  "criteria": {
    "outcome": {
      "status": "passed"
    },
    "artifact": {
      "required": [
        {
          "name": "handoff",
          "contains": [
            "stableMethod"
          ]
        }
      ]
    },
    "workspace": {
      "forbidden_edits": [
        "forbidden.txt"
      ]
    },
    "supervisor": {
      "classifications": [
        "missing_dependency_docs"
      ],
      "gatherers": [
        "external_context"
      ],
      "apply_actions": [
        "retry_node"
      ]
    },
    "trajectory": {
      "match": "contains_ordered",
      "events": [
        {
          "kind": "simulation_tool_call",
          "rule_id": "docs-503",
          "matched": true
        },
        {
          "kind": "artifact_write",
          "artifact": "handoff"
        }
      ]
    },
    "delivery": {
      "required": true
    }
  }
}
```

Environment behavior:

- `repo` is copied into an isolated trial workspace.
- `init_git: true` initializes git in the isolated copy when needed.
- `docs` starts a local HTTP docs server and exposes `{{environment.docs_url}}`.
- `tools` is copied, chmodded, and placed on `PATH`.
- `environment.simulation` creates proxy binaries before tools on `PATH` and records calls in `simulation-events.jsonl`.

Template variables:

- `{{scenario.id}}`, `{{scenario.description}}`
- `{{variant.id}}`
- `{{trial.id}}`, `{{trial.index}}`, `{{trial.root}}`
- `{{environment.repo}}`, `{{environment.docs_url}}`, `{{environment.tools}}`, `{{environment.eval_root}}`
- `{{workflow.harness}}`, `{{workflow.workspace_backend}}`
- `{{criteria.<criterion-id>.<field>}}`

## Trajectory Criteria

Trace packets include `trajectory`, a chronological sequence of node attempts, runtime events, completion packets, `af` runtime CLI calls, simulation calls, artifact writes, and delivery events. Trajectory criteria support:

- `exact_order`: full trajectory must match the listed events.
- `contains_ordered`: listed events must appear in order.
- `contains_any_order`: listed events may appear in any order.
- `forbid`: listed events must not appear.

Exact matching is intentionally opt-in because full trajectories can change when runtime instrumentation improves.

Completion-contract evals should prefer trajectory checks for runtime discipline:

- require `{ "kind": "af_tool_call", "af_command": "complete check" }` when a scenario expects a normal agent to preview completion before finishing,
- forbid debug/orchestration calls such as `{ "kind": "af_tool_call", "af_command": "diagnose failure" }` or `{ "kind": "af_tool_call", "af_command": "spawn" }` in normal-agent scenarios,
- require `{ "kind": "completion_packet", "completion_status": "ready_for_verification" }` for clean passes,
- require `{ "kind": "completion_packet", "completion_status": "incomplete" }` or `"blocked"` for negative scenarios such as missing artifacts, skipped validation, stale artifacts, live blocking observations, or sandbox blockers.

Managed-pattern scenarios may assert `af spawn ... --wait` only when the graph grants orchestration authority and the helper artifact appears before the parent completion packet becomes ready.

## Custom Script Criteria

`custom_script` criteria run from the suite directory and receive:

- `AGENTFLOW_EVAL_SCENARIO_ID`
- `AGENTFLOW_EVAL_VARIANT`
- `AGENTFLOW_EVAL_TRIAL_ID`
- `AGENTFLOW_EVAL_CRITERION_ID`
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
    {
      "id": "artifact",
      "passed": true,
      "evidence": "handoff exists"
    }
  ],
  "metrics": {
    "tool_calls": 2
  }
}
```

## Quality Criteria

`quality` criteria are focused LLM-backed judges. They use rubric files and return strict JSON:

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

Variant ids are anonymized in quality packets. Required deterministic criteria remain authoritative: a candidate cannot win by having better quality scores while adding hard blockers.

Prompt packs are eval labels, not runtime compatibility modes. Agentflow keeps one active prompt contract; eval variants can label `current` and `candidate` prompt experiments so reports and prompt diff artifacts are auditable.

## CLI

```bash
agentflow eval validate evals/agentflow-workflow-quality
agentflow eval run evals/agentflow-workflow-quality --variant current --scenario all --trials 3 --eval-root .agentflow/evals/workflow-quality --concurrency 4
agentflow eval report .agentflow/evals/workflow-quality --format markdown
agentflow eval inspect .agentflow/evals/workflow-quality --scenario missing-dependency-docs --variant current --trial 1
agentflow eval compare .agentflow/evals/workflow-quality --baseline current --candidate terse
npm run validate:prompts
```

`eval compare` reports both strict improvement and no-regression fields. Prompt promotion should require `candidate_meets_or_exceeds_baseline: true` and should reject any high-severity scenario regression even when aggregate score is flat.

Run behavior:

1. Load and validate the suite.
2. Expand scenario x variant x trial.
3. Prepare an isolated environment.
4. Render the graph template.
5. Run normal `agentflow run`.
6. Build trace and trace packet when a run root exists.
7. Evaluate criteria.
8. Build scorecards and aggregate the benchmark.
9. Exit nonzero for infrastructure failures or failing benchmark thresholds.

## Artifacts

```text
<eval-root>/
  eval-run.json
  evaluation-ledger.json
  suite-snapshot.json
  benchmark.json
  prompt-pack-diff.json
  prompt-pack-diff.md
  report.md
  scenarios/<scenario>/<variant>/trial-001/
    rendered-graph.json
    trial.json
    run-root.txt
    simulation-events.jsonl
    trace.jsonl
    trace-packet.json
    criteria-results.json
    criteria/<custom-script-id>/stdout.txt
    criteria/<custom-script-id>/stderr.txt
    judge-results/<quality-id>/
      judge-packet.json
      ai-check-result.json
      context/
        manifest.md
        packet.json
    scorecard.json
    summary.md
```

Review `report.md` first, then failing `scorecard.json`, `criteria-results.json`, `trace-packet.json`, criterion output directories, and the underlying run root named in `run-root.txt`.

## Built-In Suites

- `evals/agentflow-prompt-regression`: strict release gate for solved prompt behavior; use `npm run validate:prompts` before shipping prompt changes. Prompt-regression gates use default isolated harness config; profiles with `harness_config.isolation: "inherit_user"` are intentionally non-reproducible and do not belong in this release gate.
- `evals/agentflow-workflow-quality`: lightweight dogfood capability suite.
- `evals/agentflow-capability-workflows`: harder local-repo prompt/context suite generated with `npm run setup:eval-repos`.
- `evals/agentflow-realworld-issues`: pinned MIT real-world issue suite generated with `npm run setup:realworld-evals`.

Commit only portable fixture seeds, metadata, regression patches, rubrics, and scripts. Do not commit cloned third-party repos, generated eval repos, dependency installs, or eval output roots.
