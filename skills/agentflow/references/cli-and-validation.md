# CLI And Validation

Core commands:

```bash
agentflow graph-help
agentflow plugin resolve --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json --strict
agentflow validate --graph agentflow.graph.json --show-compiled
agentflow validate --graph agentflow.graph.json --output-dir .agentflow/validation/latest
agentflow validate --graph agentflow.graph.json --diagram-output graph.mmd
agentflow validate --graph agentflow.graph.json --diagram-image-output graph.svg
agentflow validate --graph agentflow.graph.json --diagram-image-output graph.svg --diagram-image-package @mermaid-js/mermaid-cli@latest
agentflow run --graph agentflow.graph.json
agentflow inspect <run-root>
agentflow resume --run-root <run-root>
agentflow runs list --graph agentflow.graph.json
agentflow eval validate evals/<suite-id>
```

Agent-facing runtime commands are available as `af` inside agent nodes only. Agentflow injects the generated `af` wrapper on `PATH` with `$AGENTFLOW_RUNTIME_METADATA` pointing at the node contract.
Use `af --help` and `af <command> --help` inside a node for exact runtime CLI arguments, defaults, output shape, examples, and safety notes.

Useful in-node commands:

```bash
af --help
af artifact write --help
af status
af tools list
af context show
af artifact list
af artifact write <name> --file <path>
af log --type finding --summary "..."
af log --type decision --decision "..." --rationale "..." --evidence "..."
af spawn --brief "..." --artifact helper-report.md --wait
af wait --agent <helper-id> --artifact helper-report.md
```

## Validation Contract

- `validate`: authored graph, normalization, launch profile resolution, compilation, full authoring review, local repos, command availability, env files, plugin executables, plugin tool `--help` contracts, harness readiness, credential reference diagnostics, and real context token analysis.
- `--strict`: fail validation when serious authoring findings are present; use for release gates, reusable templates, and CI-owned graphs.
- `--show-compiled`: include the full compiled primitive graph, managed expansions, tool contracts, profile resolution, delivery, and supervision contracts in JSON output.
- `--output-dir`: write a validation package with JSON and Markdown reports for authored/compiled summaries, managed expansion, review, readiness, context analysis, and Mermaid.
- `--diagram-output`: write a Mermaid view of compiled nodes, scopes, artifacts, supervision, and delivery.
- `--diagram-image-output`: rendered image from the compiled Mermaid diagram. Defaults to `npx -y @mermaid-js/mermaid-cli`; use `--diagram-image-package` to pin or replace the npx package, or `--diagram-image-renderer mmdc` for an installed binary.

Plain `validate` is the launch preflight. It should be the command humans and agents trust before a run.

Default validation tokenizes the current matched context with the runtime tokenizer. It reports sample glob matches, largest files, truncation risk, default ignored roots, explicit ignored-root opt-ins, and projected `max_total_tokens` failures before launch. Broad globs skip dependency and generated roots such as `.git`, `.agentflow`, `node_modules`, `.venv`, build output, coverage, `generated`, `gen`, and `__generated__` unless the authored context path explicitly starts inside that root.

## Completion Gate

Do not consider an authored graph complete until the relevant validation commands pass:

```bash
agentflow plugin resolve --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json --show-compiled
```

Use `plugin resolve` only when the graph declares plugins. Use `--strict` for release gates, reusable templates, and CI-owned graphs. Use `--output-dir`, `--diagram-output`, or `--diagram-image-output` when reviewers need to understand managed pattern expansion, repeat loops, or parallel handoffs.

## Before Launch

Confirm:

- `intent.goal` and acceptance criteria match the requested work.
- scope boundaries and high-impact limits are explicit in `constraints` and each non-empty constraint starts with `Do not`.
- write-capable nodes use a write-capable sandbox.
- plugin tools have clear descriptions, expected credential scopes, valid non-secret config, and passing `--help` output.
- managed patterns publish the artifacts downstream nodes reference.
- `supervision.profile` points at a real profile, and `supervision.max_total_interventions` is intentionally bounded.
- terminal delivery is automatic and reviewer-facing.

## Evaluation Lanes

- Graph `check` nodes are in-run sensors and can gate control flow.
- Outcome verification is the always-on runtime contract for passing `agent` attempts; it produces `verify-outcome.{json,md}` and an `outcome.verified` event when a passed attempt is verified.
- Supervisor `semantic_evaluation` is an intervention selected after runtime evidence and bounded by supervisor budget.
- Managed pattern evaluation is authored workflow structure, especially the completion scorecard loop in `pattern_deep_work`.
- `agentflow eval` is offline product/workflow grading with file-backed suites and `.agentflow/evals` artifacts. Use `agentflow-evals` for suite authoring, criteria, environment simulation, trajectory checks, scorecards, benchmark reports, and prompt-pack comparisons.

## Command Results

Run and resume output include:

- run root
- status and outcome
- supervisor status
- intervention count
- remaining supervisor budget
- delivery package manifest
- reviewer guide
- interventions ledger
- outcome verification counts (`outcome_verification_counts.passed`, `failed`, and per-failed-attempt summaries)
- per-node workspace change counts (`node_workspace_change_counts.attempts_with_changes`, `diff_paths`)

Inspect output also includes recent events, failed node summaries, stderr tails, delivery paths, and delivery artifact taxonomy counts when `delivery/manifest.json` is present.

## Per-Attempt Artifacts

`agent` and `exec` attempts that reach the execution boundary contain a `workspace-changes/` folder with `baseline.json`, `after.json`, `status.txt`, `diff.patch`, and `changed-files.json` capturing the per-attempt git diff. Passing `agent` attempts that materialize declared artifacts also contain `verify-outcome.json` and `verify-outcome.md` with the outcome verifier's verdict, summary, findings, and verifier metadata.

The runtime emits an `outcome.verified` event for each verified `agent` attempt with `passed`, `findings_count`, `blockers_count`, `verifier_harness`, `parse_status`, `duration_ms`, and the on-disk `verify_outcome_path`.
