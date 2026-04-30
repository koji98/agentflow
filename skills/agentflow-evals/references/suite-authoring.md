# Suite Authoring

Eval suites are local file-backed benchmarks. They run normal Agentflow graphs and grade the resulting run artifacts.

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

Use `version: "2"`.

Required fields:

- `suite_id`: stable benchmark id.
- `objective`: capability or regression purpose.
- `default_trials`: default trial count per selected scenario and variant.
- `scenarios`: paths to scenario JSON files.
- `variants`: paths to variant JSON files.
- `graders`: script graders, each with `id`, `kind: "script"`, and `command`.
- `judges`: LLM judge rubrics. `codex-cli` is the default judge harness when omitted.
- `thresholds`: optional `pass_rate`, `max_blocker_rate`, and `min_average_score` gates.

Validation fails before run when any referenced scenario, variant, grader, judge, fixture, or graph template path is missing.

## Scenario Schema

Required fields:

- `id`: stable scenario id.
- `bucket`: capability grouping, such as `valid-hard-execution` or `noisy-evidence`.
- `difficulty`: human-facing difficulty label.
- `description`: what behavior the scenario probes.
- `fixture.repo`: local repo fixture copied into the trial workspace.
- `fixture.init_git`: whether to initialize git after copying the repo fixture.
- `fixture.docs`: optional local docs fixture served over HTTP.
- `fixture.tools`: optional local tools directory copied, chmodded, and placed on `PATH`.
- `workflow.graph_template`: graph template path.
- `workflow.harness`: `codex-cli` or `cursor-cli`.
- `workflow.workspace_backend`: `inplace` or `worktree`.
- `expected.final_outcome`: `passed`, `failed`, `paused`, or `canceled`.
- `expected.required_artifacts`: artifact names and optional content substrings.
- `expected.forbidden_edits`: paths that must remain absent after the trial. Use a custom grader for unchanged-existing-file checks.
- `expected.supervisor`: optional expected classifications, gatherers, and apply actions.
- `grading.dimensions`: qualitative dimensions for judges.

Expected pause or fail outcomes are valid when the scenario is designed to test authority, credentials, policy, or underspecified-intent boundaries.

## Portable Fixtures

Commit only small seed fixtures that are required to run the suite on a fresh checkout. Do not commit cloned third-party repos, `.git` directories, dependency installs, generated trial workspaces, prompt iteration outputs, generated eval repos, or eval output roots.

If a scenario needs a real upstream repository, provide a documented setup script or clone command that creates the fixture locally before validation. The checked-in scenario should reference the local fixture path produced by that setup step.

## Graph Templates

Graph templates are normal Agentflow graphs with placeholder substitution:

- `{{scenario.id}}`
- `{{variant.id}}`
- `{{trial.id}}`
- `{{trial.index}}`
- `{{trial.root}}`
- `{{fixture.repo}}`
- `{{fixture.docs_url}}`
- `{{fixture.tools}}`
- `{{fixture.eval_root}}`

Use placeholders to bind repo paths, docs URLs, and stable per-trial ids. Do not use eval schema fields to alter the graph contract.

## Variants

Variants compare candidate prompt/runtime behavior.

Supported fields:

- `id`
- `description`
- optional graph template override
- `env` runtime environment overrides
- `prompt_pack` or `AGENTFLOW_EVAL_PROMPT_PACK` for eval-only prompt rendering experiments

Variant ids are hidden from LLM judges. Judge packets use anonymized labels such as `variant-01`.

## Scenario Quality Bar

Good scenarios are:

- local and reproducible
- hard enough to reveal differences
- unambiguous enough for deterministic grading
- solvable by a reference implementation
- balanced across behavior that should and should not happen
- explicit about expected artifacts, forbidden edits, and expected supervisor behavior

Avoid scenarios that rely on public web stability, hidden human judgment, or graders that check facts the task never told the agent to satisfy.
