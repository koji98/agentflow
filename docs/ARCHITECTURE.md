# Architecture

Agentflow has four runtime layers:

1. `src/graph/`: normalize, validate, and compile authored graphs.
2. `src/runtime/`: execute compiled primitive nodes with durable state.
3. `src/supervisor/`: classify failures, spend retry budgets, and run policy-bounded interventions.
4. `src/runtime/delivery/`: collect run evidence and write the review package.

The authored graph remains the source of intent. The compiled graph is the executable contract. Runtime artifacts are the audit log. The delivery package is the human review surface.

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
- `delivery`
- `prerequisites`
- `plugins`
- `tools`
- `tool_config`
- `config_schema`
- `config`

`intent` is required because supervision and delivery need a stable human contract:

```json
{
  "goal": "Ship checkout timeout handling.",
  "scope": {
    "paths": ["src/checkout/**", "tests/checkout/**"],
    "out_of_scope": ["billing provider migration"]
  },
  "constraints": ["Keep the public API stable."],
  "acceptance_criteria": ["Timeouts return a typed error.", "Tests cover retry behavior."],
  "approval_boundaries": ["Do not modify payment provider configuration."]
}
```

The normalizer rejects unknown graph fields and invalid enum values. Missing `intent.goal` is a hard schema error.

Repository and profile authority stay explicit outside `intent`. Top-level `repos` bind aliases to local checkouts, top-level `profiles` define harness authority, and executable nodes choose `repo` and `profile`. `intent.scope` is the human governance layer used for review and supervision, not an execution binding.

## Compilation

Compilation lowers the authored graph into primitive runtime structures:

- executable nodes with stable compiled ids
- flow edges for `sequence`, `parallel`, and `repeat`
- scopes for cleanup, repeat, and parallel behavior
- resolved profiles and workspace policy
- resolved plugin workflow expansions
- resolved plugin tool contracts
- delivery and supervision policy copied into the compiled graph
- graph and node intent copied into executable nodes

Managed patterns compile into generated primitive subgraphs. The public authored node id remains the handoff boundary; generated internal ids are implementation details visible through `validate --show-compiled`.

## Runtime Session

Runtime state tracks:

- run status and outcome
- node statuses and attempts
- repeat scope iteration state
- cleanup state
- repo workspaces
- supervisor status, budget, escalations, and intervention count
- event sequence

Terminal runs write `run.json`, `events.jsonl`, `summary.md`, `interventions.jsonl`, and `delivery/manifest.json`.

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

## Harness Contract

Codex CLI and Cursor CLI are adapters behind one Agentflow harness contract. Both receive:

- the same rendered prompt envelope
- the same context packet references
- the same generated `af` runtime CLI
- the same artifact contract
- the same plugin tool contract
- the same sandbox and timeout policy
- the same `$AGENTFLOW_OUTPUT_DIR`

Continuity comes from Agentflow artifacts and resume logic, not from assuming persistent harness chat state.

## Agent Runtime CLI

`af` is Agentflow's in-node runtime CLI. It is generated into the same per-execution `agentflow-tools/bin` directory as plugin tool wrappers, then injected onto the harness `PATH`. The package also exposes `af` as a binary after build, but the primary contract is the generated in-run command.

The runtime metadata file referenced by `$AGENTFLOW_RUNTIME_METADATA` includes run id, graph id, agent id, node id, workspace path, output directory, context paths, declared artifacts, granted plugin tool metadata, and non-secret credential metadata. It does not contain credential values. Secret fields stay in macOS Keychain and are resolved only by plugin tool launchers inside the plugin subprocess.

`af` commands are file-backed against the run root:

- `af status`, `af tools list`, and `af context show` read the node contract.
- `af artifact write|read|list` publish and inspect declared artifacts.
- `af channel post|read` append and read typed run-level messages.
- `af send`, `af parent post`, and `af inbox read` use durable mailboxes.
- `af agents list` reads graph-agent attempts and helper sessions.
- `af spawn` creates a helper session with its own runtime metadata, selected plugin tools, output directory, logs, and artifact contract.
- `af wait` waits for helper completion.
- `af supervisor request` records a supervisor request and mirrors it to the channel.

Agents never talk directly to another process. Delivery is explicit: a message is stored, and if the recipient is not running the response reports that it was not live-delivered. Durable work should move through artifacts, with messages used to notify or coordinate.

## Supervision

The supervisor is a governor, not a planner. It operates against the compiled contract and authored intent.

Allowed action kinds:

- `retry_node`
- `repair_artifact`
- `rebuild_context`
- `refresh_workspace`
- `run_diagnostic`
- `semantic_evaluation`
- `escalate`

Budget fields:

- `max_total_interventions`
- `max_node_retries`
- `max_artifact_repairs`
- `max_context_rebuilds`
- `max_workspace_refreshes`
- `max_diagnostic_runs`
- `max_semantic_evaluations`

Current artifact repair behavior:

1. The runtime detects a required declared artifact missing after an agent attempt.
2. The supervisor classifies the failure and checks policy and budget.
3. If allowed, it starts an intent-aware repair intervention using graph intent, node intent, the original prompt, the same harness authority, and the same sandbox boundary as the node.
4. If no harness is available and exactly one missing artifact is a human-readable text handoff, it may synthesize that handoff from `agent_response`; JSON, other machine-readable contracts, and multi-artifact contracts still require real artifacts.
5. It writes intervention prompt, stdout, stderr, result, and ledger records under the node attempt.
6. It accepts the repaired artifact only if the declared artifact now exists.
7. It records the decision and result in events and `interventions.jsonl`.

Supervisor events:

- `supervisor.decision`
- `supervisor.intervention.started`
- `supervisor.intervention.completed`
- `supervisor.intervention.failed`
- `supervisor.escalated`

## Checks And Evaluation

Checks are sensors. They produce evidence for the run, not hidden control-plane behavior.

`check_kind: "deterministic"` runs a local command and can use `pass_if` with an exit code or JSON path.

`check_kind: "ai"` invokes the configured harness and normalizes semantic evaluation JSON into a structured record.

`on_failure: "continue"` keeps soft verification evidence visible while allowing control flow to continue. Operational failures such as spawn errors, timeouts, cancellation, invalid context, missing env files, and missing required artifacts remain hard failures.

## Plugin Tools

Plugin-bundled tools are runtime-visible CLI capabilities. Tool exports declare:

- callable name, derived from graph declaration alias or `plugin-tool`
- `executable`
- `usage`
- `capability`
- `impact`
- optional config schema
- optional credential scopes

Policy rules:

- read-only agents can receive read or external-impact tools, but never mutation tools or write-impact tools
- `impact: "secret"` requires plugin-declared `credentials`
- `impact: "external"` requires exact approval tokens in `intent.approval_boundaries`
- tool wrappers run inside the same node sandbox and timeout
- credential values and non-secret `tool_config` values are resolved by the generated tool launcher for the plugin subprocess and are not exported into the Codex or Cursor harness environment

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

The manifest separates three audiences:

- human entrypoints: reviewer guide, task brief, implementation summary, risk notes, and follow-up items
- evidence files: grouped change map, evaluation ledger, decision log, and intervention trace
- internal runtime artifacts: run record, state, events, interventions ledger, node attempts, and workspace-change captures

If delivery package creation fails, the run is marked failed with a `delivery_package_failed` reason. This keeps the promise that a terminal run returns reviewable evidence, not just a raw diff.

## Resume

Resume compares the prior compiled contract with the current compiled contract. Changes to `intent`, `supervision`, or `delivery` invalidate completed work because they change the human contract, policy contract, or terminal review contract.

When the contract is compatible, resume preserves completed attempts and continues from the durable run state. When it is not compatible, affected nodes restart under the new compiled contract.
