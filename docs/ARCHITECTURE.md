# Architecture

Agentflow has four runtime layers:

1. `src/graph/`: normalize, validate, and compile authored graphs.
2. `src/runtime/`: execute compiled primitive nodes with durable state.
3. `src/supervisor/`: classify failures, spend bounded action budgets, and run policy-bounded interventions.
4. `src/runtime/delivery/`: collect run evidence and write the review package.

The authored graph remains the source of intent. The compiled graph is the executable contract. Runtime artifacts are the audit log. The delivery package is the human review surface.

Agentflow also has an offline eval system in `src/evals/`. It is outside the graph contract: eval suites use version `"2"` files to run normal version `"1"` Agentflow graphs across scenarios, variants, and trials, then grade the resulting run artifacts.

For a more detailed implementation walkthrough with diagrams, see `technical-implementation/runtime-lifecycle.md`, `technical-implementation/context-and-artifacts.md`, and `technical-implementation/runtime-tooling.md`.

## Authored Graph

Required top-level fields:

- `version`
- `graph_id`
- `intent`
- `graph`

Common top-level fields:

- `repos`
- `defaults`
- `profiles`
- `supervision`
- `prerequisites`
- `plugins`
- `tools`
- `config_schema`
- `config`

`intent` is required because supervision and delivery need a stable human contract:

```json
{
  "goal": "Ship checkout timeout handling.",
  "constraints": ["Keep the public API stable.", "Avoid unrelated refactors."],
  "acceptance_criteria": ["Timeouts return a typed error.", "Tests cover retry behavior."]
}
```

The normalizer rejects unknown graph fields and invalid enum values. Missing `intent.goal` is a hard schema error.

Repository and profile authority stay explicit outside `intent`. Top-level `repos` bind aliases to local checkouts, top-level `profiles` define harness authority, and executable nodes choose `repo` and `profile`. Scope boundaries and out-of-scope notes are authored as plain `constraints`.

## Compilation

Compilation lowers the authored graph into primitive runtime structures:

- executable nodes with stable compiled ids
- flow edges for `sequence`, `parallel`, and `repeat`
- scopes for cleanup, repeat, and parallel behavior
- resolved profiles and workspace policy
- resolved plugin workflow expansions
- resolved plugin tool contracts
- supervision policy copied into the compiled graph
- graph and node intent copied into executable nodes

Managed patterns compile into generated primitive subgraphs. The public authored node id remains the handoff boundary; generated internal ids are implementation details visible through `validate --show-compiled`.

## Runtime Session

Runtime state tracks:

- run status and outcome
- node statuses and attempts
- repeat scope iteration state
- cleanup state
- repo workspaces
- supervisor status, action budget, pause state, and intervention count
- event sequence

Terminal runs write stable resume and audit state such as `run.json`, `compiled_graph.json`, `execution_manifest.json`, `state.json`, `events.jsonl`, `interventions.jsonl`, `nodes/`, and `workspace-changes/`, plus the human-facing `delivery/` package.

## Context And Artifacts

Nodes receive context through a materialized packet under the execution directory:

- `context/packet.json`
- `context/manifest.md`
- `context/provenance.json`

Context sources are:

- `text`
- `workspace_file`
- `workspace_glob`
- named prior artifacts through `ref`

Artifacts are declared with `artifacts` and produced from either:

- `output_dir`: files under `$AGENTFLOW_OUTPUT_DIR`
- `workspace`: files under the node workspace

Reserved automatic artifacts:

- `agent_response`
- `verification_json`
- `stdout`
- `stderr`

Downstream nodes should consume named artifacts, not rediscover scratch files.

See `technical-implementation/context-and-artifacts.md` for the materialization lifecycle, token budget behavior, repeat selectors, and how artifact refs are derived from `ref`.

## Harness Contract

Codex CLI and Cursor CLI are adapters behind one Agentflow harness contract. Both receive:

- the same rendered prompt envelope
- the same context packet references
- the same generated `af` runtime CLI
- the same artifact contract
- the same plugin tool contract
- the same sandbox and timeout policy
- the same `$AGENTFLOW_OUTPUT_DIR`

Both adapters also support `check_kind: "ai"`. AI checks run in the read-only sandbox and must return structured evaluation JSON. Cursor runs with JSON output enabled and uses Cursor model ids directly; graphs must not set `reasoning_effort` on Cursor profiles or Cursor agent/check nodes.

Continuity comes from Agentflow artifacts and resume logic, not from assuming persistent harness chat state.

## Agent Runtime CLI

`af` is Agentflow's in-node runtime CLI. It is generated into the same per-execution `agentflow-tools/bin` directory as plugin tool wrappers, then injected onto the harness `PATH`. The package also exposes `af` as a binary after build, but the primary contract is the generated in-run command.

The runtime metadata file referenced by `$AGENTFLOW_RUNTIME_METADATA` includes run id, graph id, agent id, node id, workspace path, output directory, context paths, declared artifacts, granted plugin tool metadata, and non-secret credential metadata. It does not contain credential values. Secret fields stay in macOS Keychain and are resolved only by plugin tool launchers inside the plugin subprocess.

`af` commands are file-backed against the run root:

- `af status`, `af tools list`, and `af context show` read the node contract.
- `af artifact write|list` publish and inspect declared artifacts.
- `af log --type <progress|finding|blocker|risk|question|handoff_note|decision>` appends structured worker evidence to `runtime/log.jsonl`; decision entries carry `decision`, `rationale`, and `evidence[]`.
- `af spawn` creates a helper sub-node with its own runtime metadata, selected plugin tools, output directory, logs, and artifact contract.
- `af wait` waits for helper completion.

`af --help` and `af <command> --help` are the authoritative in-node runtime API reference. Help output is credential-free and includes usage, arguments/options, defaults, output shape, examples, exit codes, and safety notes.

Agentflow-provided `af` and plugin tool calls append per-execution `tool-invocations.jsonl` records when invoked through the generated wrappers. The records include command identity, redacted argv, exit code, duration, and stdout/stderr sidecar paths when output is captured.

Agents do not rely on synchronous coordination with other graph nodes. Durable work moves through declared artifacts, worker notes are recorded with `af log`, and helper sub-node coordination stays under the parent node's runtime contract.

See `technical-implementation/runtime-tooling.md` for the generated `af` wrapper, plugin launcher, credential isolation, harness environment, and tool invocation ledger flow.

## Supervision

The supervisor is engine-side runtime logic, not a second always-running agent. It observes worker evidence while a node attempt runs, then evaluates the completed attempt against graph goal, node goal, constraints, acceptance criteria, declared artifacts, tool usage, and workspace changes at a scheduler boundary.

Action kinds:

- `accept`
- `accept_with_warnings`
- `retry_with_guidance`
- `repair_artifact`
- `rebuild_context`
- `run_diagnostic`
- `pause_for_human`
- `semantic_evaluation`
- `fail`

The graph contract configures bounded intervention actions with `supervision.actions.<action>.max_uses`, plus `max_total_interventions` and `policy` settings such as `pause_on_policy_risk`, `pause_on_repeated_recovery`, and `drift_score_threshold`.

Supervisor decisions are stored in `supervisor-timeline.jsonl` and mirrored into `state.json`. Bounded intervention workers attach artifacts under the target attempt's `interventions/` directory. Durable human pauses set run status to `paused` and include resume options plus the recovery plan that explains the precise unblock request.

On a failed executable node attempt, retry-oriented actions enter the supervisor recovery loop. The runtime persists the exact rendered node prompt, builds an immutable case file, runs classifier-selected evidence gatherers with an internal concurrency cap, merges the evidence into one recovery plan, and applies exactly one action: retry the node, repair an artifact, pause for human authority, or fail terminally. Parallel evidence gathers are an internal detail; budget is spent once per recovery cycle on the selected graph action.

Evidence gatherers can inspect local context, mine local patterns, read dependency metadata, gather read-only external context, run diagnostic probes, rejudge semantic failures, or investigate the failed attempt. External context is allowed by default for evidence gathering, but it cannot change graph intent, acceptance criteria, repo authority, sandbox authority, or declared artifacts.

Current artifact repair behavior:

1. The runtime detects a required declared artifact missing after a successful agent attempt.
2. The supervisor classifies the failure and checks policy and budget.
3. If allowed, it starts an intent-aware repair intervention using graph intent, node task, constraints, acceptance criteria, the same harness authority, and the same sandbox boundary as the node.
4. If no harness is available and exactly one missing artifact is a human-readable text handoff, it may synthesize that handoff from `agent_response`; JSON, other machine-readable contracts, and multi-artifact contracts still require real artifacts.
5. It writes intervention prompt, stdout, stderr, result, and ledger records under the node attempt.
6. It accepts the repaired artifact only if the declared artifact now exists.
7. It records the decision and result in events and `interventions.jsonl`.

Failed harness attempts do not publish declared artifacts, even if they wrote files in the output directory before failing. Those files can be surfaced as prior-attempt evidence for later repair or retry prompts, but downstream refs and delivery handoffs only consume artifacts materialized from successful attempts or accepted repairs.

`retry_with_guidance`, `rebuild_context`, `run_diagnostic`, and `semantic_evaluation` all feed the same recovery loop. A retried node receives a `SupervisorRecoveryEnvelope` before the original authored task, and the same envelope is materialized into runtime context as `supervisor_recovery_envelope`. The envelope states that the original goal, acceptance criteria, constraints, repo authority, sandbox, and declared artifacts are unchanged. Retry attempts are scheduled with an exponential delay: 10 seconds by default, capped at 2 minutes, and overridable with `AGENTFLOW_RETRY_BASE_DELAY_MS` and `AGENTFLOW_RETRY_MAX_DELAY_MS`.

Supervisor events:

- `supervisor.decision`
- `supervisor.intervention.started`
- `supervisor.intervention.completed`
- `supervisor.intervention.failed`
- `supervisor.retry_scheduled`
- `supervisor.paused`

## Human Gates And Pauses

Agentflow has two human-in-the-loop mechanisms, and they are intentionally different.

`checkpoint` is authored workflow structure. It is a planned human gate that reviews a declared artifact at a known point in the graph. In this release, checkpoints are valid only inside `repeat` bodies so a deny decision can feed the next iteration with operator feedback. A checkpoint used as the repeat `until` node behaves like the loop's human approval sensor: pass exits the loop, deny can drive another iteration, and abort cancels the run.

`pause_for_human` is supervisor safety behavior. It is not an authored node. The supervisor chooses it when a failure or policy classification needs a human decision outside the planned graph path, such as a policy breach, repeated recovery, or scope drift. A pause writes durable run state, records `supervisor.paused`, sets the run status to `paused`, and waits for `agentflow resume --human-action ...`.

This mirrors the durable interrupt/resume shape used by production agent runtimes: the run state is persisted before asking a human, resources are released, and resume input is recorded as part of the audit trail. Agentflow implements that locally through run-root artifacts rather than a remote checkpoint database.

## Checks And Evaluation

Checks are sensors. They produce evidence for the run, not hidden control-plane behavior.

`check_kind: "deterministic"` runs a local command and can use `pass_if` with an exit code or JSON path.

`check_kind: "ai"` invokes the configured harness and normalizes semantic evaluation JSON into a structured record.

`on_failure: "continue"` keeps soft verification evidence visible while allowing control flow to continue. Operational failures such as spawn errors, timeouts, cancellation, invalid context, missing env files, and missing required artifacts remain hard failures.

Evaluation has five lanes:

- Graph `check` nodes are in-run sensors. They are authored into the graph and can gate flow, repeat loops, or evidence collection.
- Outcome verification is runtime enforcement for passing `agent` attempts. It runs after declared artifacts materialize, writes `verify-outcome.json` and `verify-outcome.md`, and can turn a claimed pass into an `outcome_verification` failure routed through supervision.
- Supervisor `semantic_evaluation` is an intervention. It is chosen by the supervisor after a failed AI check or semantic uncertainty, spends intervention budget, and writes supervisor evidence.
- Managed pattern evaluation is authored workflow structure. For example, `pattern_generate_evaluate_fix.evaluation` expands into evaluator and repair-loop nodes as part of the compiled graph.
- `agentflow eval` is offline workflow evaluation. It runs file-backed suites of scenarios, variants, and repeated trials against Agentflow workflows, grades hard facts with deterministic graders, rates qualitative behavior with LLM judges, and writes eval artifacts under `.agentflow/evals`; it does not replace in-run checks. Its design follows Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## Offline Eval System

`src/evals/` owns the workflow benchmark path:

- `types.ts`: v2 suite, scenario, variant, trace packet, scorecard, and benchmark contracts.
- `suite.ts`: suite loading, path-specific validation diagnostics, graph-template rendering, and strict judge JSON parsing.
- `runner.ts`: trial workspace setup, local docs/tool fixture wiring, normal `agentflow run` execution, trace packet writing, scorecard aggregation, reports, inspect, and compare.
- `trace.ts`: normalized packet extraction from run roots.
- `graders.ts`: script grader execution and LLM judge invocation through the same Codex/Cursor-compatible harness interface as AI checks.

Eval runner inputs are local files. A trial copies the scenario repo fixture, optionally initializes git, optionally starts a local docs fixture, optionally places copied tool fixtures on `PATH`, renders a graph template with scenario/variant/fixture placeholders, and runs the rendered graph through the normal runtime. When a run root exists, grading always proceeds even if the graph failed or paused so expected failure and expected pause cases can be scored.

Eval artifacts are rooted at `<eval-root>` and include `eval-run.json`, `evaluation-ledger.json`, `suite-snapshot.json`, `benchmark.json`, `report.md`, and per-trial directories containing `rendered-graph.json`, `trial.json`, `trace.jsonl`, `trace-packet.json`, `deterministic-results.json`, `judge-results/`, `scorecard.json`, and `summary.md`.

Deterministic grading is authoritative for hard facts: final graph status, required artifacts, forbidden edits, delivery evidence, and expected supervisor classifications/gatherers/actions. LLM judges are for qualitative dimensions such as artifact quality, evidence use, context handling, supervisor recovery quality, tool discipline, noise efficiency, and delivery auditability. Variant ids are anonymized in judge packets.

See `EVALS.md` for authoring guidance, CLI usage, artifact layout, and the built-in dogfood suite.

## Plugin Tools

Plugin-bundled tools are runtime-visible CLI capabilities. Tool exports declare:

- callable name, derived from graph declaration alias or `plugin-tool`
- `executable`
- `description`
- optional config schema for non-secret graph `tools[].config` values
- optional credential scopes

Policy rules:

- declaring a tool in the graph or agent node is the operator approval to expose that CLI to the agent
- tool wrappers run inside the same node sandbox and timeout
- credential values and non-secret inline `tools[].config` values are resolved by the generated tool launcher for the plugin subprocess and are not exported into the Codex or Cursor harness environment
- plugin manifests do not declare default CLI arguments; exact tool CLI arguments belong in the tool's `--help` and are passed by the agent when invoking the callable tool
- `config_schema` only validates graph-provided default config values
- executable `--help` is required for every plugin tool, must run without credentials or side effects, and is checked by `agentflow validate --graph ... --run-ready`

## Delivery Package

Terminal delivery is part of the runtime contract. The package collector reads run state, events, attempts, checks, interventions, git metadata, and artifacts, then writes:

- task brief
- implementation summary
- grouped change map
- decision log
- evaluation ledger
- reviewer guide
- risk notes
- follow-up items
- intervention trace
- manifest
- run map

The manifest keeps the legacy entrypoint maps and adds an explicit `artifact_taxonomy` object:

- `human_entrypoints`: reviewer guide, task brief, implementation summary, risk notes, follow-up items, and run map
- `declared_artifacts`: graph outcome artifacts grouped by node/artifact name
- `resume_required`: stable files needed for resume and replay
- `audit_trail`: events, attempts, tool invocation ledgers, and workspace-change captures
- `debug_only`: raw logs, context packets/provenance, tool sidecars, and runtime coordination files
- `empty_or_noop`: empty ledgers/logs or no-change captures that should not look important

If delivery package creation fails, the run is marked failed with a `delivery_package_failed` reason. This keeps the promise that a terminal run returns reviewable evidence, not just a raw diff.

## Resume

Resume compares the prior compiled contract with the current compiled contract. Changes to `intent` or `supervision` invalidate completed work because they change the human contract or policy contract.

When the contract is compatible, resume preserves completed attempts and continues from the durable run state. When it is not compatible, affected nodes restart under the new compiled contract.
