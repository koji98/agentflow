# Architecture

Agentflow has four runtime layers:

1. `src/graph/`: normalize, validate, and compile authored graphs.
2. `src/runtime/`: execute compiled primitive nodes with durable state.
3. `src/supervisor/`: classify failures, spend bounded action budgets, and run policy-bounded interventions.
4. `src/runtime/delivery/`: collect run evidence and write the review package.

The authored graph remains the source of intent. The compiled graph is the executable contract. Runtime artifacts are the audit log. The delivery package is the human review surface.

Agentflow also has an offline eval system in `src/evals/`. It is outside the graph contract: eval suites use version `"1"` files to run normal version `"1"` Agentflow graphs across scenarios, variants, and trials, then grade the resulting run artifacts.

For a more detailed implementation walkthrough with diagrams, see `runtime-lifecycle.md`, `context-and-artifacts.md`, and `runtime-tooling.md`.

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
- `plugins`
- `skill_sources`
- `tools`
- `capabilities`
- `config_schema`
- `config`

`intent` is required because supervision and delivery need a stable human contract:

```json
{
  "goal": "Ship checkout timeout handling.",
  "constraints": [
    "Do not change the public API.",
    "Do not make unrelated refactors."
  ],
  "acceptance_criteria": [
    "Timeouts return a typed error.",
    "Tests cover retry behavior."
  ]
}
```

The normalizer rejects unknown graph fields and invalid enum values. Missing `intent.goal` is a hard schema error.

Repository and profile authority stay explicit outside `intent`. Top-level `repos` bind aliases to local checkouts, top-level `profiles` define harness authority, and executable nodes choose `runtime.repo` and `runtime.profile`. Scope boundaries and out-of-scope notes are authored in graph-level or node-level `intent.constraints`. Constraint strings should be prohibition-style boundaries that start with `Do not`; put positive success requirements in `acceptance_criteria`.

Support surfaces are intentionally non-authoritative. `support.context` points at workspace files, globs, plugin files, or prior artifacts and must explain `what` the pointer is plus `why` this node needs it. `skill_sources` declare installable skill collections, `capabilities` bundle selected skill refs, managed tool grants, and ambient CLI hints, and top-level `tools` is a managed plugin tool registry rather than a global grant.

## Compilation

Compilation lowers the authored graph into primitive runtime structures:

- executable nodes with stable compiled ids
- flow edges for `sequence`, `parallel`, and `repeat`
- scopes for cleanup, repeat, and parallel behavior
- resolved profiles and workspace policy
- resolved plugin workflow expansions
- resolved selected skill metadata
- resolved plugin tool contracts granted to each node
- ambient CLI hints granted to each node
- supervision contract copied into the compiled graph
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

Nodes receive context through a pointer packet under the execution directory:

- `context/packet.json`
- `context/manifest.md`
- `context/provenance.json`

Context sources are:

- `workspace_file`
- `workspace_glob`
- `plugin_file`
- named prior artifacts through `ref`

Authored context lives under node `support.context`; the runtime resolves source pointers and writes a manifest table with each item’s name, kind, pointer, `what`, and `why`.

Artifacts are declared with `artifacts` and produced from either:

- `output_dir`: files under `$AGENTFLOW_OUTPUT_DIR`
- `workspace`: files under the node workspace

Reserved automatic artifacts:

- `agent_response`
- `verification_json`
- `stdout`
- `stderr`

Downstream nodes should consume named artifacts, not rediscover scratch files.

See `context-and-artifacts.md` for the context resolution lifecycle, repeat selectors, and how artifact refs are derived from `ref`.

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

- `af orient` orients the node against the current runtime contract and context pointers.
- `af milestone add/log/complete/block` records macro work state and audit evidence.
- `af artifact write <name>` publishes declared artifact content from stdin.
- `af complete check` builds the mechanical completion packet for the current attempt.
- `af spawn --purpose <investigation|implementation|verification|repair>` creates a helper sub-node with its own runtime metadata, selected plugin tools, output directory, logs, artifact contract, and optional `--wait` behavior.

The default `af --help` surface is intentionally small because it is part of agent correctness. It shows the normal completion loop commands and omits debug/orchestration commands such as `diagnose`, `learn`, `tools list`, and `spawn`. `af <command> --help` remains the authoritative in-node runtime API reference for commands the runtime exposes to the current authority. Help output is credential-free and includes usage, arguments/options, defaults, output shape, examples, exit codes, and safety notes.

Agentflow-provided `af` and plugin tool calls append per-execution `tool-invocations.jsonl` records when invoked through the generated wrappers. The records include command identity, redacted argv, exit code, duration, and stdout/stderr sidecar paths when output is captured.

Agents do not rely on synchronous coordination with other graph nodes. Durable work moves through declared artifacts, worker evidence is recorded in milestone state, helper sub-node coordination stays under the parent node's runtime contract, and completion state moves through `completion-packet.json` rather than final-response claims.

See `runtime-tooling.md` for the generated `af` wrapper, plugin launcher, credential isolation, harness environment, and tool invocation ledger flow.

## Supervision

The supervisor is engine-side runtime logic, not a second always-running agent. Every executable node is a supervised checkpoint: `agent`, `exec`, `check`, `checkpoint`, and managed-pattern internals all carry an `intent` block with `goal`, `acceptance_criteria`, and normalized `constraints`. The supervisor observes each attempt, records health evidence, and stays out of the way when the checkpoint is healthy.

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

The graph contract exposes one required supervisor profile, `supervision.profile`, plus one recovery budget, `supervision.max_total_interventions`. Evidence gathering, artifact repair, outcome verification, and supervisor helper work use the supervisor profile while still respecting the selected target node's repo, sandbox, credential, and tool authority. This keeps supervisor work explicit even when the failed checkpoint is a deterministic `check`, `exec`, or `checkpoint` with no authored worker profile. Internal recovery can apply a runtime operation such as current-node repair, upstream-node repair, artifact repair, context repair, validation-strategy repair, workspace repair, environment repair, causal-cone investigation, or authority pause without adding graph fields.

Supervisor decisions are stored in `supervisor-timeline.jsonl` and mirrored into `state.json`. Budget-spending recovery chains attach artifacts under the symptom attempt's `interventions/` directory, while any repaired upstream target writes normal attempt folders that are linked from the chain. Durable human pauses set run status to `paused` and include resume options plus the recovery plan that explains the precise unblock request.

On a failed or rejected executable attempt, the symptom is not automatically treated as the cause. The runtime persists the exact rendered prompt, builds a causal case file, constructs an upstream cone from graph edges, artifact producers, context provenance, prior attempts, workspace diffs, repeat/managed state, and verification evidence, then ranks likely recovery targets. The supervisor repairs the nearest intent-aligned cause first, reruns the failed gate, and continues only when each retry records a material delta: target changed, context changed, evidence added, validation guidance changed, workspace repaired, environment repaired, or an artifact was repaired. Budget is spent once per recovery chain, not once per helper, gatherer, target attempt, or rerun gate.

Context contract failures are deterministic recovery cases. If authored context cannot be packaged because a pointer is unsafe or unresolved, a required artifact is missing, a source is non-text, or a broad glob needs operator attention, the supervisor writes `context-analysis.{json,md}`, writes `context-repair-patch.json`, and retries with a compact repair packet before the authored context. The repair packet contains a bounded file index, sample matches, largest files, default ignored roots, omitted-entry provenance, and live workspace paths for manual inspection. It does not change graph intent, node intent, repo authority, sandbox, or declared artifacts.

Workspace and environment repair are also runtime overlays, not graph contract features. Workspace repair consumes the node snapshot artifacts for the failed attempt and restores only that attempt's tracked/untracked diff before retry. Environment repair is limited to safe local substrate refresh, such as regenerating Agentflow tool wrappers and PATH/runtime metadata for the next attempt.

Evidence gatherers can inspect local context, mine local patterns, read dependency metadata, gather read-only external context, run diagnostic probes, rejudge semantic failures, or investigate the failed attempt. External context is allowed by default for evidence gathering, but it cannot change graph intent, acceptance criteria, repo authority, sandbox authority, or declared artifacts.

Artifact repair is part of the same causal recovery chain. A downstream failed check can target the upstream artifact producer; a missing or bad artifact can target the node that owned that artifact contract; a malformed final publish can target the public managed node's publish phase. Repair prompts receive the responsible node contract, downstream failed evidence, prior attempts, relevant artifacts and context, and the exact authority boundary they may use. The repaired artifact is accepted only if it satisfies the declared artifact contract.

Failed harness attempts do not publish declared artifacts, even if they wrote files in the output directory before failing. Those files can be surfaced as prior-attempt evidence for later repair or retry prompts, but downstream refs and delivery handoffs only consume artifacts materialized from successful attempts or accepted repairs.

`retry_with_guidance`, `rebuild_context`, `run_diagnostic`, and `semantic_evaluation` all feed the same causal recovery loop. A retried or repaired target receives a supervisor recovery case before the original authored task, and the same case is resolved into runtime context as `supervisor_recovery_envelope`. When context repair is active, `af orient` surfaces the active recovery and context pointers. The case names the symptom node, selected recovery target, material delta, forbidden actions, and unchanged graph/node authority. Retry attempts are scheduled with an exponential delay: 10 seconds by default, capped at 2 minutes, and overridable with `AGENTFLOW_RETRY_BASE_DELAY_MS` and `AGENTFLOW_RETRY_MAX_DELAY_MS`.

Supervisor helpers can use read-only diagnostics through `af diagnose failure`, `af diagnose graph-cone`, `af diagnose attempt`, `af diagnose context`, `af diagnose artifacts`, `af diagnose workspace`, and `af diagnose validation`. `af learn <failure-kind>` returns focused recovery playbooks for common failure classes. `af spawn --purpose investigation` creates read-only causal-analysis helpers; `af spawn --purpose implementation`, `--purpose verification`, and `--purpose repair` create bounded helper sessions for managed or supervisor-authorized work. There is no standalone `af wait`; use `af spawn ... --wait` when the parent needs a terminal helper result before continuing.

Managed monitoring and supervisor events:

- `managed.progress`
- `supervisor.decision`
- `supervisor.intervention.started`
- `supervisor.intervention.completed`
- `supervisor.intervention.failed`
- `supervisor.gate_rerun_scheduled`
- `supervisor.retry_scheduled`
- `supervisor.paused`

## Human Gates And Pauses

Agentflow has two human-in-the-loop mechanisms, and they are intentionally different.

`checkpoint` is authored workflow structure. It is a planned human gate that reviews a declared artifact at a known point in the graph. In this release, checkpoints are valid only inside `repeat` bodies so a deny decision can feed the next iteration with operator feedback. A checkpoint used as the repeat `until` node behaves like the loop's human approval sensor: pass exits the loop, deny can drive another iteration, and abort cancels the run.

`pause_for_human` is supervisor authority behavior. It is not an authored node, and internally it is treated as `pause_for_authority`. The supervisor chooses it only when recovery needs authority the runtime must not infer: missing credentials, explicit human checkpoint boundaries, product or intent ambiguity, security or compliance judgment, repo/sandbox/scope expansion, or graph contract amendment. Ordinary local context, validation, artifact, workspace, and recoverable environment failures should attempt machine repair first. A pause writes durable run state, records `supervisor.paused`, sets the run status to `paused`, and waits for `agentflow resume --human-action ...`.

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
- Managed pattern evaluation is authored workflow structure. `pattern_deep_work.completion` expands into command criteria, targeted rubric criteria, a deterministic scorecard gate, and a bounded repair loop as part of the compiled graph.
- `agentflow eval` is offline workflow evaluation. It runs file-backed suites of scenarios, variants, and repeated trials against Agentflow workflows, grades hard facts with required criteria, rates qualitative behavior with quality criteria, and writes eval artifacts under `.agentflow/evals`; it does not replace in-run checks. Its design follows Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) and adopts ADK-style criteria, trajectory evaluation, and deterministic environment simulation.

## Offline Eval System

`src/evals/` owns the workflow benchmark path:

- `types.ts`: v1 suite, scenario, variant, criteria, environment, trace packet, scorecard, and benchmark contracts.
- `suite.ts`: suite loading, path-specific validation diagnostics, graph-template rendering, and strict judge JSON parsing.
- `runner.ts`: trial environment setup, local docs/tool fixture wiring, deterministic simulation proxy wiring, normal `agentflow run` execution, trace packet writing, criteria evaluation, scorecard aggregation, reports, inspect, and compare.
- `trace.ts`: normalized packet extraction from run roots.
- `graders.ts`: custom script criterion execution and quality criterion invocation through the same Codex/Cursor-compatible harness interface as AI checks.

Eval runner inputs are local files. A trial copies the scenario repo environment, optionally initializes git, optionally starts a local docs environment, optionally places copied tool fixtures on `PATH`, optionally creates deterministic simulation proxy tools, renders a graph template with scenario/variant/environment placeholders, and runs the rendered graph through the normal runtime. When a run root exists, grading proceeds even if the graph failed or paused so expected failure and expected pause cases can be scored.

Eval artifacts are rooted at `<eval-root>` and include `eval-run.json`, `evaluation-ledger.json`, `suite-snapshot.json`, `benchmark.json`, `report.md`, and per-trial directories containing `rendered-graph.json`, `trial.json`, `trace.jsonl`, `trace-packet.json`, `criteria-results.json`, `criteria/`, `judge-results/`, `scorecard.json`, and `summary.md`.

Required deterministic criteria are authoritative for hard facts: final graph status, required artifacts, forbidden edits, delivery evidence, expected trajectory, and expected supervisor classifications/gatherers/actions. Quality criteria are for qualitative dimensions such as artifact quality, evidence use, context handling, supervisor recovery quality, tool discipline, noise efficiency, and delivery auditability. Variant ids are anonymized in quality packets.

See `../product/evals.md` for authoring guidance, CLI usage, artifact layout, and the built-in dogfood suites.

## Plugin Tools

Plugin-bundled tools are runtime-visible CLI capabilities. Tool exports declare:

- callable name, derived from graph declaration alias or `plugin-tool`
- `executable`
- `description`
- optional config schema for non-secret managed tool `config` values
- optional credential scopes

Policy rules:

- declaring a tool in the graph or agent node is the operator approval to expose that CLI to the agent
- tool wrappers run inside the same node sandbox and timeout
- credential values and non-secret managed tool `config` values are resolved by the generated tool launcher for the plugin subprocess and are not exported into the Codex or Cursor harness environment
- plugin manifests do not declare default CLI arguments; exact tool CLI arguments belong in the tool's `--help` and are passed by the agent when invoking the callable tool
- `config_schema` only validates graph-provided default config values
- executable `--help` is required for every plugin tool, must run without credentials or side effects, and is checked by `agentflow validate --graph ...`

## Delivery Package

Terminal delivery is part of the runtime contract. The package collector reads run state, events, attempts, checks, interventions, git metadata, and artifacts, then writes:

- task brief
- implementation summary
- grouped change map
- milestone evidence
- evaluation ledger
- reviewer guide
- risk notes
- follow-up items
- intervention trace
- manifest
- run map

The manifest keeps the entrypoint maps and adds an explicit `artifact_taxonomy` object:

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
