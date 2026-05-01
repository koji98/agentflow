# Suite Authoring

Eval suites are local file-backed benchmarks. They run normal Agentflow graphs and grade the resulting run artifacts.

## Scenario Quality Bar

Start with what the team needs to learn. A good scenario is:

- realistic enough to exercise the workflow rather than just the schema;
- local and reproducible on a fresh checkout;
- hard enough to separate weak and strong variants;
- solvable by a capable run;
- explicit about required artifacts, forbidden edits, validation evidence, supervisor behavior, and expected pause/fail cases;
- graded by deterministic facts first and quality criteria second.

Avoid toy scenarios that always score 1.0, brittle scenarios that only one exact patch can pass, and tasks whose expected behavior is not visible in the trace packet or run artifacts.

## Scenario Pattern Examples

- Bug-fix workflow: local repo fixture, failing reproduction, implementation graph, focused regression command, forbidden broad edits.
- PR review workflow: seeded diff or change package, review graph, required finding format, quality criteria for severity and evidence.
- Plugin/tool workflow: local tool fixture or plugin, node-level tool access, trajectory criterion for help/use, output contract assertions.
- Supervisor recovery workflow: intentionally missing docs/context/artifact/validation strategy, expected classification and recovery overlay.
- Prompt/context noise eval: noisy repo fixture, broad possible context, quality criteria for context handling and noise efficiency.
- Real-world issue workflow: pinned upstream SHA, local regression patch, focused test command, hidden oracle metadata for graders only.

## Layout

```text
evals/<suite-id>/
  eval.json
  variants/
    current.json
    candidate.json
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

`agentflow eval validate` accepts either the suite directory or the `eval.json` path.

## Suite Schema

Use `version: "1"`.

Required fields:

- `suite_id`: stable benchmark id.
- `objective`: capability or regression purpose.
- `default_trials`: default trial count per selected scenario and variant.
- `scenarios`: paths to scenario JSON files.
- `variants`: paths to variant JSON files.
- `criteria`: required and optional evaluation criteria.
- `thresholds`: optional `pass_rate`, `max_blocker_rate`, and `min_average_score` gates.

Supported criterion kinds are `outcome`, `artifact`, `workspace`, `supervisor`, `trajectory`, `delivery`, `custom_script`, and `quality`.

Validation fails before run when any referenced scenario, variant, criterion rubric, simulation response file, environment fixture, or graph template path is missing. Legacy `fixture`, `expected`, `grading`, top-level `graders`, and top-level `judges` fields are invalid.

## Scenario Schema

Required fields:

- `id`: stable scenario id.
- `bucket`: capability grouping, such as `valid-hard-execution` or `noisy-evidence`.
- `difficulty`: human-facing difficulty label.
- `description`: what behavior the scenario probes.
- `environment.repo`: local repo seed copied into the trial workspace.
- `environment.init_git`: whether to initialize git after copying the repo seed.
- `environment.docs`: optional local docs directory served over HTTP.
- `environment.tools`: optional local tools directory copied, chmodded, and placed on `PATH`.
- `environment.simulation`: optional deterministic tool-call proxy rules.
- `workflow.graph_template`: graph template path.
- `workflow.harness`: `codex-cli` or `cursor-cli`.
- `workflow.workspace_backend`: `inplace` or `worktree`.
- `criteria`: scenario-specific config keyed by suite criterion id.
- `metadata.realworld`: optional pinned upstream issue metadata for real-world suites.

Expected pause or fail outcomes are valid when the `outcome` criterion expects them and the other required criteria match the scenario design.

## Criteria Config

Common scenario criteria:

```json
{
  "criteria": {
    "outcome": { "status": "passed" },
    "artifact": { "required": [{ "name": "handoff", "contains": ["Validation:"] }] },
    "workspace": { "forbidden_edits": ["forbidden.txt"] },
    "supervisor": {
      "classifications": ["missing_dependency_docs"],
      "gatherers": ["external_context"],
      "apply_actions": ["retry_node"]
    },
    "trajectory": {
      "match": "contains_ordered",
      "events": [
        { "kind": "simulation_tool_call", "rule_id": "docs-ok", "matched": true },
        { "kind": "artifact_write", "artifact": "handoff" }
      ]
    },
    "delivery": { "required": true },
    "workflow-deterministic": {},
    "artifact-quality": { "dimensions": ["artifact_quality"] }
  }
}
```

Trajectory matching modes are `exact_order`, `contains_ordered`, `contains_any_order`, and `forbid`. Prefer `contains_ordered` unless the exact runtime event sequence is the behavior being tested.

## Environment Simulation

Use `environment.simulation` to test tool outages, fixed API responses, latency, and deterministic probability without live services.

```json
{
  "environment": {
    "repo": "repo",
    "simulation": {
      "seed": "stable",
      "tool_calls": [
        {
          "id": "github-503",
          "command": "gh",
          "match": { "argv_contains": ["pr", "checks"] },
          "error": { "stderr": "GitHub maintenance", "exit_code": 503 },
          "latency_ms": 100,
          "probability": 1
        }
      ]
    }
  }
}
```

Simulation proxy binaries are generated before tool fixtures on `PATH`. Calls are recorded in `simulation-events.jsonl` and included in `TracePacket.trajectory`.

## Portable Fixtures

Commit only small seed fixtures required to run the suite on a fresh checkout. Do not commit cloned third-party repos, `.git` directories, dependency installs, generated trial workspaces, prompt iteration outputs, generated eval repos, or eval output roots.

If a scenario needs a real upstream repository, provide a documented setup script or clone command that creates the fixture locally before validation. Real-world issue scenarios should commit only metadata plus local regression patches. Hidden oracle fields are for graders and reports; do not expose upstream PR patches in graph context.

## Graph Templates

Graph templates are normal Agentflow graphs with placeholder substitution:

- `{{scenario.id}}`
- `{{variant.id}}`
- `{{trial.id}}`
- `{{trial.index}}`
- `{{trial.root}}`
- `{{environment.repo}}`
- `{{environment.docs_url}}`
- `{{environment.tools}}`
- `{{environment.eval_root}}`
- `{{criteria.<criterion-id>.<field>}}`

Use placeholders to bind repo paths, docs URLs, tools, and stable per-trial ids. Do not use eval schema fields to alter the graph contract.

## Variants

Variants compare candidate prompt/runtime behavior.

Supported fields:

- `id`
- `description`
- optional graph template override
- `env` runtime environment overrides
- `prompt_pack` or `AGENTFLOW_EVAL_PROMPT_PACK` for eval-only prompt rendering experiments

Variant ids are hidden from quality criteria. Judge packets use anonymized labels such as `variant-01`.

## Anti-Patterns

- Scenarios that only check final status and never inspect artifacts or workspace effects.
- Live public network dependencies for ordinary regression/capability runs.
- Quality-only grading for hard facts that can be checked deterministically.
- Exposing hidden oracle patches or upstream PR solutions in graph context.
- Exact trajectory matching when ordered containment is enough.
