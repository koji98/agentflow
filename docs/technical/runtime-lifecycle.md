# Runtime Lifecycle

This document explains the implementation path from an authored graph to a terminal run. For operator commands, use `docs/product/operations.md`; this page focuses on how those commands work internally.

## High-Level Flow

```mermaid
sequenceDiagram
  participant Human
  participant CLI as agentflow CLI
  participant Graph as graph loader
  participant Runtime
  participant Harness as Codex/Cursor
  participant Supervisor
  participant Delivery

  Human->>CLI: validate --graph
  CLI->>Graph: load, normalize, validate, compile
  Graph-->>CLI: diagnostics, compiled summary, Mermaid
  Human->>CLI: run --graph
  CLI->>Graph: compile same contract for execution
  CLI->>Runtime: runCompiledGraph(compiled_graph)
  Runtime->>Runtime: write run root and preflight readiness
  Runtime->>Runtime: initialize workspace backend
  Runtime->>Harness: execute reachable node attempt
  Harness-->>Runtime: result, stdout/stderr, final response
  Runtime->>Supervisor: observe checkpoint health
  Supervisor-->>Runtime: continue, repair causal target, or request authority
  Runtime->>Delivery: write terminal delivery package
  Delivery-->>Human: review brief, run learnings, audit index
```

## Validate

Validation follows the same front half as a run, but stops before execution:

1. Load the graph file and resolve paths relative to the graph directory where appropriate.
2. Normalize authored fields into the v1 graph contract.
3. Expand managed patterns and plugin workflow nodes into authored primitive graph nodes.
4. Resolve launch settings from `defaults` and `profiles`.
5. Compile the graph into primitive runtime nodes, edges, scopes, resolved tools, credential specs, and artifact references.
6. Run full authoring review diagnostics.
7. Run local readiness checks for repos, commands, ambient CLI hints, harnesses, plugin tool help, credentials, and context pointers.
8. Optionally emit compiled JSON, a validation package, Mermaid text, or a rendered Mermaid image.

`validate --show-compiled` is the most direct way to inspect the contract the runtime will execute. `validate --output-dir` writes a reusable validation package. `validate --diagram-output` is for reviewing graph shape, dependencies, scopes, and artifact handoffs visually.

## Compile

Compilation is the boundary between human-authored structure and the runtime scheduler.

```mermaid
flowchart TD
  authored["Authored graph"] --> managed["Lower managed patterns and plugin workflows"]
  managed --> tools["Resolve graph and node tool declarations"]
  tools --> nodes["Create executable compiled nodes"]
  nodes --> scopes["Create sequence, parallel, repeat, and cleanup scopes"]
  scopes --> edges["Create dependency edges"]
  edges --> refs["Validate artifact refs and repeat selectors"]
  refs --> compiled["Compiled graph"]
```

Compiled nodes carry the effective policy needed to launch them: repo alias, profile name, workspace backend, harness, model, sandbox, artifact repair policy, context list, declared artifacts, selected skills, ambient CLI hints, and granted managed tools.

Authored ids remain visible for humans. Compiled ids are stable runtime ids that include scope context, especially inside managed patterns and repeat bodies. The `authored_to_compiled` map preserves that relationship for inspection, delivery, and resume.

## Run

`runCompiledGraph` creates the run root and writes the first durable artifacts before doing substantial work. The runtime then:

1. Writes `run.json`, `compiled_graph.json`, `execution_manifest.json`, `state.json`, and initial event files.
2. Evaluates readiness that must block execution, such as missing repos, commands, env vars, plugin tool help, credentials, or harness binaries for reachable nodes.
3. Initializes the workspace backend:
   - `inplace` binds repo aliases to the configured checkout paths.
   - `worktree` creates isolated Git worktrees under the run root and cleans them up at terminal state.
4. Starts the scheduler loop with the compiled topology.
5. Opens an attempt directory for each runnable node.
6. Materializes context and prepares runtime tooling for harnessed agent nodes.
7. Executes the node through an agent harness, local `exec`, deterministic check, AI check, or checkpoint executor.
8. Records result files, logs, artifacts, events, state, and supervisor decisions.

## Node Attempt Boundary

Each attempt is the unit of execution and audit. A typical agent attempt includes:

- `agent/context.md`, `runtime/context.json`, and `human-debug/context-provenance.json`
- `agent/attempt-memory.md` and `runtime/attempt-memory.json` on retry attempts
- `runtime/tools/runtime.json`, `state.json`, generated `bin/af`, and generated plugin wrappers
- stdout/stderr logs from the harness or local command under `human-debug/harness/`
- `human-debug/tools/index.jsonl` and paired tool input/output payloads when generated wrappers are used
- declared output artifacts under the attempt artifact directory or workspace paths
- reserved artifacts such as `agent_response`, `stdout`, `stderr`, and `verification_json`
- `workspace-changes/` snapshots for agent and exec attempts that reach the execution boundary
- `runtime/verifier.json` and `human-debug/verifier/verdict.md` for passing agent attempts after declared artifacts materialize

Normal agents read `agent/`, declared `artifacts/`, and explicit context pointers. Files under `human-debug/` are audit-only unless a diagnostic supervisor helper is explicitly asked to inspect them.

The attempt boundary matters because supervisor interventions attach to a specific attempt, downstream refs select from attempts, and resume decides whether completed attempts remain compatible with the current compiled contract.

Retries are continuations, not blank reruns. When the supervisor schedules a retry, the runtime writes structured attempt memory with the prior outcome, selected resume point, workspace decision, completed milestones, unfinished work, artifact state, validation evidence, preserved/reset files, and explicit do-not-redo guidance. `af orient` is the retry front door: it starts with retry orientation and attempt memory, then shows the unchanged success contract, artifacts, milestones, context, and support. Raw logs, provenance, case files, recovery plans, and debug tool payloads stay out of normal retry prompts.

Managed pattern internals also emit `managed.progress` events at meaningful boundaries such as internal node completion, ordinary deep-work completion feedback, repeated no-delta stalls, and managed repeat exhaustion. Ordinary managed feedback stays inside the pattern while the pattern can still make progress. When deep work repeats the same blocker without material delta, or when a managed repeat exhausts its authored cycles, the runtime records managed progress evidence and routes the failed boundary through the normal supervisor path. The supervisor may retry only when it can attach a material delta such as a requirement evidence map, repaired context, changed validation strategy, workspace cleanup, safe environment repair, target rerank with evidence, or accepted artifact repair.

## Supervision

The supervisor is engine-side control logic. It is not a separate always-running agent. It observes every executable checkpoint at scheduler boundaries and stays out of the way when the node is healthy. A failed or rejected checkpoint is treated as a symptom, not automatically as the root cause.

```mermaid
flowchart TD
  checkpointResult["Checkpoint result"] --> healthy{"Healthy?"}
  healthy -- yes --> continueGraph["Continue graph"]
  healthy -- no --> caseFile["Write causal case file"]
  caseFile --> cone["Build upstream causal cone"]
  cone --> target["Rank recovery targets"]
  target --> budget{"Recovery budget and typed authority state available?"}
  budget -- no --> authority["Typed authority pause or contractual failure"]
  budget -- yes --> repair["Repair nearest intent-aligned target"]
  repair --> delta{"Material delta recorded?"}
  delta -- no --> investigate["Widen causal search or change tactic"]
  investigate --> cone
  delta -- yes --> rerun["Rerun failed gate"]
  rerun --> healthy
```

Supervisor decisions are written to event streams, `supervisor-timeline.jsonl`, `interventions.jsonl`, and state. Budget-spending recovery chains attach machine state under the symptom attempt's `runtime/supervisor/` directory and raw diagnostic evidence under `human-debug/interventions/`. If the selected recovery target is upstream, the target writes normal attempt folders and the chain links the symptom, target, material delta, and rerun gate.

Failure routing is structured-control-plane only. The classifier reads trusted typed `AuthorityRequest` records, runtime-owned `failure_code` metadata, structured completion packets, outcome-verifier categories, repeated failure fingerprints, and node kind. Stdout, stderr, agent responses, verifier summaries, helper prose, and debug tool files can explain evidence, but they do not choose recovery class or pause a run.

For recovery-oriented actions, the supervisor records a failure fingerprint, writes requirement evidence maps, causal case files, target rankings, recovery chains, recovery plans, runtime overlays, and material deltas as machine state, emits `supervisor.retry_scheduled`, sleeps before re-queueing, and injects a compact `agent/supervisor-recovery.md` brief into the selected target's next attempt prompt and context. A retry without a material delta is blocked so the supervisor does not spend budget repeating the same failed tactic. Generic retry advice and target changes without evidence are not material deltas. The default retry delay is 10 seconds with exponential backoff capped at 2 minutes; `AGENTFLOW_RETRY_BASE_DELAY_MS` and `AGENTFLOW_RETRY_MAX_DELAY_MS` override the values.

Recovery envelopes include a runtime-owned resume point: `continue_from_prior_progress`, `continue_from_milestone`, `repair_artifacts`, `rerun_verification`, `repair_validation_strategy`, `repair_workspace`, `fresh_retry`, or `fail_contract_gap`. `fresh_retry` is reserved for cases where prior progress is absent, unsafe, or irrelevant. Verification substrate failures are local: they use `rerun_verification` and do not rerun the worker unless structured verifier findings show an actual work defect.

Context pointer packaging can fail before the harness runs. Those failures are classified as `context_contract_failure`, analyzed with the shared run-ready context analyzer, and retried with a compact `supervisor_context_repair` packet when the supervisor can safely repair the packaging without changing graph authority.

Workspace repair uses the node-level baseline and after snapshots captured around every agent/exec attempt. If a failed attempt is classified as a forbidden or unrelated workspace edit, the overlay restores tracked files from the pre-attempt snapshot and removes untracked files introduced by that failed attempt before the retry is scheduled. Environment repair is intentionally narrower: it refreshes per-execution Agentflow tool wrappers and PATH/runtime metadata on the retry without mutating global machine state.

Authority pauses are last resort. The runtime pauses only when a trusted component emits a typed `AuthorityRequest`: missing credentials, missing harness authentication, planned checkpoints, external side-effect approval, or operator-authored pause. Product ambiguity, graph contract gaps, repo/sandbox/scope expansion, local context, artifact, workspace, validation strategy, and recoverable environment issues recover autonomously or fail contractually with evidence.

## Resume

Resume is contract-aware. It does not blindly continue old state.

1. Load the prior run root and run state.
2. Re-load and recompile the current graph.
3. Compare the prior compiled graph and current compiled graph.
4. Preserve completed attempts only when the graph intent, supervision contract, and node contracts remain compatible.
5. Invalidate affected nodes and dependent work when contracts changed.
6. Continue the scheduler loop from the reconstructed session.

Node compatibility includes prompt-affecting support and execution contract fields: repo, dependencies, intent, effective policy, context pointers, selected skills, CLI hints, managed tool grants/config, declared artifacts, commands/checks, and managed lowering metadata. Raw pointed file contents, glob matches, instruction files, and debug/provenance files do not by themselves invalidate completed nodes unless the compiled graph contract changes.

`agentflow resume --dry-run` stops after reconstruction and reports what would be preserved, restarted, and initially startable without reconciling artifacts or creating workspaces. `--reset-supervisor-budget` keeps compatible completed work but restores the supervisor budget from the current graph, which is useful after fixing an exhausted run's graph or environment.

Paused supervisor runs additionally require explicit `--human-action` and optional `--human-note` when execution actually resumes; dry-run previews do not require human input. Planned checkpoint decisions are different: they happen during the original TTY run and are represented as checkpoint outcomes and operator feedback artifacts.

## Delivery

Terminal runs always attempt to write the delivery package. The collector reads state, attempts, events, checks, interventions, workspace changes, milestones, and declared artifacts, then writes `delivery/01-review-brief.md`, `delivery/02-run-learnings.md`, `delivery/03-audit-index.md`, and semantic evidence files under `delivery/evidence/`.

Delivery is derived from final runtime state. Final accepted attempts and artifacts are the review surface; failed prior attempts that were later repaired or retried are listed as recovered issues, not active follow-ups. Active failures are reserved for unresolved terminal failures or active blocking observations.

If delivery creation fails, the run is marked failed. This keeps the runtime contract honest: a successful terminal run must be reviewable, not merely complete.
