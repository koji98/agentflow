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

Validation renders every scenario x variant graph template with a representative trial context and validates the rendered graph against the current graph contract. Stale graph fields fail during `eval validate`, not later during a trial.

## Evaluation Strategy

Agentflow keeps a layered eval system:

- `evals/agentflow-validation`: five broad sentinel scenarios that prove the full product mission end to end.
- `evals/agentflow-engineering-parity`: direct-vs-Agentflow engineering tasks for primitive and managed worker shapes; each trial runs Agentflow and a clean direct Codex baseline against the same fixture, with Codex Goal mode used only as an optional external baseline when available.
- Focused suites such as prompt regression, workflow quality, capability workflows, and real-world issues: smaller regression and capability coverage.
- Repeated trials: stochastic reliability measurement before releases.
- Human QA runs: periodic checks that scenarios remain fair, solvable, and hard to game.

Eval-driven changes must generalize. Do not add prompt text, runtime branches, supervisor routing, grader looseness, or managed-pattern behavior that names or implies a specific fixture repo, file path, package, hidden oracle, scenario id, or expected tactic. Before changing Agentflow because an eval failed, identify the generic failure class, check whether valid alternative success paths are still allowed, and prefer stronger measurement or broader scenarios when the result is fixture-specific.

The sentinel suite intentionally has exactly five scenarios: three pinned real-world repository fixtures and two simulated controls. It covers managed patterns, primitive nodes, plugin workflow lowering, support capabilities, selected skills, managed tools, CLI hints, context pointers with `what`/`why`, checkpoint feedback, supervisor resume, deterministic graders, quality judges, hidden-oracle canaries, and delivery artifacts.

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
- `delivery`: delivery manifest presence plus passing curated delivery verdict.
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
  "measurement": {
    "claim": "Agentflow should recover from missing dependency docs without changing forbidden files.",
    "scenario_type": "capability:supervisor-recovery",
    "metrics": [
      "final outcome",
      "artifact evidence",
      "workspace scope",
      "supervisor recovery",
      "trajectory discipline",
      "delivery auditability"
    ],
    "expected_failure_modes": [
      "final outcome differs from expected status",
      "required artifact is missing or unsupported",
      "workspace changes are forbidden or out of scope",
      "expected supervisor recovery behavior is missing"
    ],
    "tweak_signal": "Inspect context packaging, supervisor classification, recovery learning, retry evidence, and delivery curation before changing prompt text."
  },
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
      ],
      "recovery_diagnoses": [
        "guidance_ignored"
      ],
      "forbidden_apply_actions": [
        "pause_for_authority"
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

`measurement` is required for every scenario. It is not graph context and does not change runtime behavior; it tells reviewers what claim the scenario measures, which metrics matter, which failure modes are meaningful, and what kind of generic Agentflow surface to inspect before changing behavior. A scenario that can fail without pointing to a likely prompt, context, artifact, supervisor, verifier, managed-pattern, graph-shape, or grader adjustment is too vague.

Environment behavior:

- `repo` is copied into an isolated trial workspace.
- `init_git: true` initializes git in the isolated copy when needed.
- `docs` starts a local HTTP docs server and exposes `{{environment.docs_url}}`.
- `tools` is copied, chmodded, and placed on `PATH`.
- `environment.simulation` creates proxy binaries before tools on `PATH` and records calls in `simulation-events.jsonl`.
- `environment.scripted_checkpoints.decisions` supplies deterministic checkpoint decisions for automated repeat/checkpoint evals. A `deny` decision must include feedback.
- `environment.scripted_resume` supplies structured human input for paused supervisor runs with `human_action`, optional `human_note`, and optional `reset_supervisor_budget`.

Template variables:

- `{{scenario.id}}`, `{{scenario.description}}`
- `{{variant.id}}`
- `{{trial.id}}`, `{{trial.index}}`, `{{trial.root}}`
- `{{environment.repo}}`, `{{environment.docs_url}}`, `{{environment.tools}}`, `{{environment.eval_root}}`
- `{{workflow.harness}}`, `{{workflow.workspace_backend}}`
- `{{criteria.<criterion-id>.<field>}}`

## Trajectory Criteria

Trace packets include `trajectory`, a chronological sequence of node attempts, runtime events, completion packets, `af` runtime CLI calls, simulation calls, artifact writes, and delivery events. They also expose supervisor resume decisions under `supervisor.resume_decisions`, intervention decision material-delta counts under `supervisor.intervention_decisions`, recovery-learning records under `supervisor.recovery_learning`, and prompt/context diagnostics summaries under `prompt_diagnostics`. Use these structured fields before inferring behavior from free-text summaries.

Trajectory criteria support:

- `exact_order`: full trajectory must match the listed events.
- `contains_ordered`: listed events must appear in order.
- `contains_any_order`: listed events may appear in any order.
- `forbid`: listed events must not appear.

Exact matching is intentionally opt-in because full trajectories can change when runtime instrumentation improves.

Completion-contract evals should prefer trajectory checks for runtime discipline:

- require `{ "kind": "af_tool_call", "af_command": "orient" }` and `{ "kind": "af_tool_call", "af_command": "complete check" }` when a scenario expects a normal agent to orient and preview completion before finishing,
- forbid debug/orchestration calls such as `{ "kind": "af_tool_call", "af_command": "diagnose failure" }` or `{ "kind": "af_tool_call", "af_command": "spawn" }` in normal-agent scenarios,
- require `{ "kind": "completion_packet", "completion_status": "ready_for_verification" }` for clean passes,
- require `{ "kind": "completion_packet", "completion_status": "incomplete" }` for negative scenarios such as missing artifacts, skipped validation, stale artifacts, live blocking observations, or sandbox blockers.
- require `{ "kind": "completion_packet", "completion_status": "blocked" }` only when the packet also carries trusted typed `authority_requests`.

Managed-pattern scenarios may assert `af spawn --purpose ... --wait` only when runtime orchestration authority is present and the helper artifact appears before the parent completion packet becomes ready. Supervisor recovery scenarios may assert fixed read-only helper roles such as `af spawn --role evidence_mapper ... --wait` only inside supervisor/managed recovery traces, never as ordinary worker behavior.

Supervisor criteria can require or forbid recovery evidence:

- `classifications`, `gatherers`, and `apply_actions` assert observed supervisor decisions.
- `forbidden_apply_actions` asserts actions such as human pause or authority escalation did not happen when the failure should be automated.
- `recovery_diagnoses` asserts recovery-learning labels such as ignored guidance or followed-but-insufficient guidance were recorded.
- `forbidden_recovery_diagnoses` guards against the wrong repeated-failure interpretation.

Expected human pauses should require typed runtime authority, such as missing credentials or an authored checkpoint. Graph-contract, scope, validation, context, workspace, and artifact failures should normally be expected `failed` or automated-recovery outcomes, not untyped human escalation.

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

Variant ids are anonymized in quality packets. Quality judges receive target-specific packets for one criterion and one trial trace; they should cite trace or artifact evidence rather than re-running the workflow. Required deterministic criteria remain authoritative: a candidate cannot win by having better quality scores while adding hard blockers. A quality criterion also fails closed when the trace packet records a non-passing run outcome, even if the LLM judge returns `passed_quality_bar: true`.

Prompt/context diagnostics are human-debug evidence, not worker context. Trace packets and scorecards may summarize diagnostic counts, prompt sizes, context pointer counts, glob counts, read-first counts, and warnings so prompt/context failures can be reviewed without exposing raw debug artifacts to normal workers.

Prompt packs are eval labels, not runtime compatibility modes. Agentflow keeps one active prompt contract; eval variants can label `current` and `candidate` prompt experiments so reports and prompt diff artifacts are auditable.

## CLI

```bash
agentflow eval validate evals/agentflow-workflow-quality
agentflow eval run evals/agentflow-workflow-quality --variant current --scenario all --trials 3 --eval-root .task-runtime/evals/workflow-quality --concurrency 4
agentflow eval report .task-runtime/evals/workflow-quality --format markdown
agentflow eval inspect .task-runtime/evals/workflow-quality --scenario missing-dependency-docs --variant current --trial 1
agentflow eval compare .task-runtime/evals/workflow-quality --baseline current --candidate terse
npm run validate:prompts
```

`eval compare` reports both strict improvement and no-regression fields. Prompt promotion should require `candidate_meets_or_exceeds_baseline: true` and should reject any high-severity scenario regression even when aggregate score is flat.

Run behavior:

1. Load and validate the suite.
2. Expand scenario x variant x trial.
3. Prepare an isolated environment.
4. Render the graph template.
5. Validate the rendered graph contract.
6. Run normal `agentflow run`.
7. If the run pauses and `environment.scripted_resume` is authored, resume with structured human input.
8. Build trace and trace packet when a run root exists.
9. Evaluate criteria.
10. Build scorecards and aggregate the benchmark.
11. Exit nonzero for infrastructure failures or failing benchmark thresholds.

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

Reports should show the scenario measurement claim, deterministic blockers, quality deltas, prompt/context diagnostic warnings, recovery-learning evidence, and whether Agentflow beat direct Codex or only added orchestration around a similar result.

## Built-In Suites

- `evals/agentflow-validation`: flagship five-scenario sentinel suite for full Agentflow mission validation. Run `agentflow eval validate evals/agentflow-validation` before broad eval changes and run the two simulated sentinel scenarios as fast regression gates when practical. Release confidence requires `npm run validate:release-confidence`, which runs all five sentinels with three trials.
- `evals/agentflow-prompt-regression`: strict release gate for solved prompt behavior; use `npm run validate:prompts` before shipping prompt changes. Prompt-regression scenarios that compare prompt text or deterministic trajectories should pin `harness_config.isolation: "isolated"` when native user harness config would make the run non-reproducible.
- `evals/agentflow-workflow-quality`: lightweight dogfood capability suite.
- `evals/agentflow-capability-workflows`: harder local-repo prompt/context suite generated with `npm run setup:eval-repos`.
- `evals/agentflow-realworld-issues`: pinned MIT real-world issue suite generated with `npm run setup:realworld-evals`.

Commit only portable fixture seeds, metadata, regression patches, rubrics, and scripts. Do not commit cloned third-party repos, generated eval repos, dependency installs, or eval output roots.

For engineering parity, direct Codex and Agentflow receive the same neutral task facts and validation expectations. If direct Codex passes deterministic checks and Agentflow fails, treat that as an Agentflow regression regardless of quality-judge preference. If both pass, compare scope control, validation evidence, handoff quality, delivery auditability, attempts, and recovery overhead.
