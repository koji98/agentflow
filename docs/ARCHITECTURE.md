# Architecture

## System Boundary

Agentflow has six runtime subsystems and one deferred control-plane stub.

### Runtime subsystems

1. `graph`: parse, normalize, validate, resolve profiles, and compile authored graphs
2. `runtime/core`: schedule compiled nodes, track state, and emit events
3. `runtime/context`: resolve node inputs and prior artifacts into a bounded context packet
4. `runtime/harness`: execute `agent` nodes and AI `check` nodes through CLI-backed harness adapters
5. `runtime/checks`: execute deterministic `check` nodes and normalize AI evaluator results
6. `artifacts`: persist run files, append events, and project a stable read model for the UI

### Deferred stub

- `controller`: reserved for future graph planning and graph QA loops; not part of the release execution path

The release does not need a broad service mesh. It needs a small number of hard boundaries that can be tested independently.

## Authored Graph Model

The authored graph is the operator-facing source document. It is nested, readable, and intentionally ergonomic.

### Top-level document

```json
{
  "version": "1",
  "graph_id": "fix-checkout-timeouts",
  "repos": {
    "main": {
      "path": ".",
      "default_branch": "main"
    }
  },
  "defaults": {
    "launch_profile": "default",
    "workspace_backend": "worktree"
  },
  "profiles": {
    "default": {
      "harness": "codex-cli",
      "model": "gpt-5-codex",
      "sandbox": "workspace-write",
      "timeout_sec": 1800,
      "input_rules": {
        "max_files": 64,
        "max_total_bytes": 524288,
        "max_bytes_per_item": 131072
      }
    }
  },
  "graph": {
    "type": "sequence",
    "id": "root",
    "steps": []
  }
}
```

### Top-level rules

- `graph_id` is stable across runs and unique within the operator's working set.
- `repos.<alias>.path` is resolved relative to the authored graph file location.
- `defaults.launch_profile` selects the run launch profile when the operator does not specify one.
- `defaults.workspace_backend` selects the run workspace backend when the operator does not specify one.
- The run root is not authored inside the graph. It is launch-time configuration owned by the CLI or web server and resolved from an absolute `AGENTFLOW_RUNS_ROOT` when set, otherwise from `<launch-cwd>/.agentflow/runs`.

### Multi-repo ownership

- The runs root defaults to `<launch-cwd>/.agentflow/runs/`; each run root lives under `<runs-root>/<run_id>/`.
- The CLI and web monitor use the same rule: prefer an absolute `AGENTFLOW_RUNS_ROOT`, otherwise fall back to the command launch directory.
- For `npm run start --workspace web-app` and `npm run dev --workspace web-app`, the packaged web server preserves the operator shell's launch directory via `INIT_CWD` so the default fallback matches CLI launches from the same shell location.
- The run root is the only owner of run artifacts, events, and projected state.
- Each repo alias resolves to both a source path and an effective workspace path for the current run.
- Cross-repo reads are allowed only through explicit repo-qualified `inputs` or run-artifact references in `context_from`.
- Cross-repo writes happen only by executing a node against that repo's workspace.

### Node kinds

Authoring supports six node kinds:

- `agent`
- `exec`
- `check`
- `sequence`
- `parallel`
- `repeat`

Only `agent`, `exec`, and `check` are executable runtime nodes.

Managed-workflow authoring supports:

- `deep_research`
- `spec_design`
- `execute_spec`
- `review_change`

Those workflows compile into internal primitive subgraphs rather than execute as direct runtime node kinds. Their authored schemas are part of the current release contract.

### Common executable node fields

Every executable node may define:

- `id`
- optional `label`
- optional `repo`
- optional `profile`
- optional `inputs`
- optional `context_from`
- optional `outputs`
- optional `timeout_sec`

Rules:

- `repo` is required when the graph declares more than one repo.
- `profile` references a named profile in the graph document.
- Node inline overrides may only set fields relevant to that node kind.

### `agent`

Required fields:

- `type: "agent"`
- `id`
- `prompt`

Optional node-specific fields:

- `model`
- `sandbox`

`agent` nodes are the only nodes that may modify repository state through a harness.

### `exec`

Required fields:

- `type: "exec"`
- `id`
- `command`

Optional node-specific fields:

- `args`
- `cwd`
- `env`

`exec` does not support `allow_failure` in this release. Soft-failure behavior must be expressed with explicit `check` or `repeat` structure.

### `check`

Required fields:

- `type: "check"`
- `id`
- `check_kind`

Supported release `check_kind` values:

- `deterministic`
- `ai`

Optional shared check fields:

- `inputs`
- `context_from`
- `outputs`

Deterministic check fields:

- `command`
- optional `args`
- optional `cwd`
- optional `pass_if`

Supported release `pass_if` forms:

- `{ "exit_code": 0 }`
- `{ "json_path": "$.passed", "equals": true }`

AI check fields:

- `prompt`
- optional `rubric`
- optional `model`

AI checks must return structured JSON:

```json
{
  "passed": true,
  "score": 0.93,
  "summary": "short operator-facing summary",
  "issues": []
}
```

### `sequence`

Required fields:

- `type: "sequence"`
- `id`
- `steps`

Execution rule: child nodes become ordered dependencies.

### `parallel`

Required fields:

- `type: "parallel"`
- `id`
- `steps`

Optional fields:

- `max_concurrency`

Execution rule: child branches may run concurrently once their shared predecessors are satisfied.

### `repeat`

Required fields:

- `type: "repeat"`
- `id`
- `max_attempts`
- `body`
- `until`

`until` shape:

```json
{
  "node": "run_tests"
}
```

Rules:

- `body` must compile to a single entry region and a single exit region.
- `until.node` must reference a descendant `check` node inside `body`.
- on `until.node -> passed`, the runtime exits the repeat scope.
- on `until.node -> failed` and attempts remain, the runtime follows the explicit repeat back-edge.
- on `until.node -> failed` and attempts are exhausted, the repeat scope produces terminal failure for the run.

There are no free-form conditions in this release.

## Inputs, Context, and Outputs

`inputs`, `context_from`, and `outputs` are the authored contract between graph authoring and runtime context resolution.

### `inputs`

`inputs` is a list of static materials resolved before execution. Supported release item shapes:

```json
{ "kind": "file", "path": "src/server.ts" }
{ "kind": "file", "path": "web:src/App.tsx" }
{ "kind": "glob", "path": "src/**/*.ts", "max_files": 20 }
{ "kind": "text", "name": "acceptance", "text": "Keep the CLI surface unchanged." }
```

Rules:

- Unqualified file and glob paths resolve against the node repo.
- Repo-qualified paths use `<repo_alias>:<relative_path>`.
- `glob.max_files` may not exceed the effective `input_rules.max_files`.
- `text.name` is required and stable inside the materialized context packet.

### `context_from`

`context_from` is a list of upstream references resolved from prior node executions.

```json
{
  "node": "understand_codebase",
  "include": "summary"
}
```

```json
{
  "node": "run_tests",
  "include": "output",
  "output": "junit",
  "iteration": "latest",
  "attempt": "latest_passed",
  "optional": false
}
```

Supported release fields:

- `node`: upstream authored node id
- `include`: `summary` | `result` | `output`
- `output`: required when `include = "output"`
- `iteration`: optional selector for repeated nodes
- `attempt`: optional execution selector
- `optional`: optional boolean, default `false`

Supported selectors:

- `latest`
- `latest_passed`
- `latest_failed`
- positive integer ordinal

Resolution rules:

- `node` always references an authored id. The compiler resolves it to one or more compiled nodes.
- For nodes outside any `repeat`, `iteration` is omitted and treated as `0`.
- For nodes inside a `repeat`, cross-scope references must specify `iteration` when more than one iteration could satisfy the reference.
- `attempt` is evaluated after `iteration` is resolved.
- `summary` resolves to `context_summary.md`.
- `result` resolves to `result.json`.
- `output` resolves to a declared named output inside the selected execution.

### `outputs`

`outputs` declares named artifacts that downstream nodes may reference.

```json
{
  "name": "junit",
  "from": "workspace",
  "path": "reports/junit.xml",
  "required": false
}
```

```json
{
  "name": "summary",
  "from": "attempt",
  "path": "summary.md",
  "required": true
}
```

Supported release fields:

- `name`
- `from`: `workspace` | `attempt`
- `path`
- optional `required`, default `false`

Rules:

- Output names are unique per node.
- `from = "workspace"` copies a file from the node workspace into the execution artifact directory when the node closes.
- `from = "attempt"` points at a file already written directly into the execution artifact directory by the executor.
- Downstream `context_from.include = "output"` must reference a declared output name.

### Validation rules

The compiler rejects:

- missing or duplicate node ids
- unknown repo aliases
- unknown profile names
- `context_from` references to nodes that are not guaranteed to execute before the consumer
- ambiguous repeated-node references without an `iteration` selector
- `output` references to undeclared names
- cross-repo direct file reads without explicit repo qualification when the source repo is not the consumer repo

Runtime context resolution fails the node when:

- a required referenced file or output is missing
- an `attempt` selector resolves to no execution
- input material exceeds the effective limits after truncation rules are applied

If `optional: true`, the missing item is omitted and the omission is recorded in `context_packet.json`.

## Profile Model

Profiles are named policy bundles. They avoid repeating execution policy on every node.

### What a profile may contain in this release

- `harness`
- `model`
- `sandbox`
- `timeout_sec`
- `input_rules`
- `deterministic_check_defaults`
- `ai_check_defaults`

Profiles do not own graph structure. They do not set workspace backend in this release.

### Launch resolution

Launch resolution happens before node policy resolution.

| Setting | Resolution order |
| --- | --- |
| `launch_profile` | explicit CLI or UI selection -> graph `defaults.launch_profile` -> `"default"` if present -> validation error |
| `workspace_backend` | explicit CLI or UI selection -> graph `defaults.workspace_backend` -> runtime built-in `worktree` |

`workspace_backend` is run-scoped. The compiler writes the same resolved backend to every node manifest entry.

### Node policy resolution

Effective node policy is resolved in this order:

1. runtime built-ins
2. selected launch profile
3. node-referenced profile
4. node inline overrides

Applicability rules:

- `harness`, `model`, and codex `reasoning_effort` apply to `agent` and AI `check`
- `model` inheritance stops at a harness boundary; if a node profile switches harnesses, it does not inherit a launch-profile model from the previous harness
- AI `check` always executes in `read-only` mode, regardless of profile sandbox defaults, and the release requires `codex-cli` for that strict evaluator contract
- `deterministic_check_defaults` apply only to deterministic `check`
- `ai_check_defaults` apply only to AI `check`
- `timeout_sec` and `input_rules` may apply to any executable node

Inline or profile fields that do not apply to a node kind are rejected at compile time.

### `input_rules`

Supported release `input_rules` fields:

- `max_files`
- `max_total_bytes`
- `max_bytes_per_item`

Built-in defaults:

- `max_files: 64`
- `max_total_bytes: 524288`
- `max_bytes_per_item: 131072`

The runtime enforces these limits during context packet materialization.

## Compiler Contract

The compiler is the hard boundary between authored intent and runtime execution.

### Compiler inputs

- authored graph document
- resolved launch configuration
- runtime capability matrix

### Compiler outputs

- `compiled_graph.json`
- `execution_manifest.json`
- `compile_diagnostics.json`

### What compilation must do

- validate schema and semantics
- resolve repo aliases and launch configuration
- resolve profiles and freeze effective node policy
- flatten nested containers into a directed compiled graph
- assign stable compiled ids
- record authored-to-compiled mappings
- create compiled scopes for authored containers
- emit explicit repeat back-edges and exit edges

### Stable identifiers

The compiler and runtime use four stable identity layers:

- `authored_id`: stable identity from the source graph
- `compiled_id`: runtime identity for one compiled node definition
- `scope_id`: runtime identity for one compiled container scope
- `execution_id`: runtime identity for one execution of one compiled node

Additional repeat identity fields:

- `repeat_scope_id`: `scope_id` of the nearest repeat ancestor, when present
- `iteration_index`: 1-based repeat iteration ordinal inside that repeat scope
- `attempt_index`: 1-based execution ordinal for a compiled node across the run

`execution_id` must encode enough information to recover `compiled_id`, `attempt_index`, and repeat metadata if present.

## Compiled Graph Model

The runtime consumes a flat compiled graph plus explicit scope metadata.

```json
{
  "graph_id": "fix-checkout-timeouts",
  "entry_node_ids": ["root__understand"],
  "nodes": [
    {
      "compiled_id": "root__understand",
      "authored_id": "understand",
      "kind": "agent",
      "repo": "main",
      "deps": [],
      "scope_stack": ["scope__root"],
      "effective_policy": {
        "profile_name": "default",
        "harness": "codex-cli",
        "sandbox": "workspace-write",
        "timeout_sec": 1800
      },
      "declared_outputs": []
    }
  ],
  "edges": [
    {
      "edge_id": "edge__1",
      "from": "root__understand",
      "to": "root__typecheck",
      "on": "passed"
    }
  ],
  "scopes": [
    {
      "scope_id": "scope__root",
      "authored_id": "root",
      "kind": "sequence",
      "parent_scope_id": null,
      "scope_stack": ["scope__root"],
      "entry_node_ids": ["root__understand"],
      "exit_node_ids": ["root__typecheck"],
      "compiled_node_ids": ["root__understand", "root__typecheck"]
    }
  ]
}
```

### Compiled node rules

- compiled nodes are executable only
- authored containers never appear as executable nodes
- every compiled node has a full `scope_stack` from root scope to nearest container scope
- edge conditions are `passed` or `failed` only
- repeat behavior is represented by explicit edges plus repeat scope metadata

### Compiled scope rules

All authored containers become compiled scopes.

- `sequence` scopes preserve authored ancestry and ordered child grouping
- `parallel` scopes preserve authored ancestry and concurrency limits
- `repeat` scopes preserve ancestry plus repeat metadata

Repeat scopes additionally record:

- `max_attempts`
- `until_compiled_id`
- `body_entry_node_ids`
- `body_exit_node_ids`

## Runtime Core

The runtime core is a scheduler plus a state store. It knows nothing about React components or harness-specific CLI flags.

Implementation notes for this release:

- `runtime/session` owns the run-level snapshot, manifest, node-status map, and repeat-scope state.
- `runtime/attempts` owns execution identity and per-node attempt history separately from authored graph identity.
- `runtime/events` owns the append-only event envelope shared by runtime, artifacts, and the monitor.

### Scheduler responsibilities

- load the compiled graph and execution manifest
- determine node readiness from dependency state and edge conditions
- dispatch ready nodes to the correct executor
- enforce concurrency limits from parallel scopes
- create `execution_id` values
- open and close repeat iterations
- stop cleanly on terminal failure or cancellation
- emit events for every durable state transition

### Canonical outcomes

Every executable node terminates with exactly one runtime outcome:

- `passed`
- `failed`

UI-only non-running states:

- `pending`
- `ready`
- `running`
- `blocked`
- `canceled`
- `skipped`

Rules:

- `agent`: `passed` when the harness reports success; otherwise `failed`
- `exec`: `passed` on zero exit code; otherwise `failed`
- `check`: `passed` when the deterministic predicate or AI evaluator returns `passed: true`; otherwise `failed`

### Edge and failure rules

- A compiled edge fires when its `on` value matches the upstream node outcome.
- If a node ends `failed` and no outgoing `failed` edge exists, the run enters terminal failure.
- Nodes that become unreachable because of terminal failure are marked `blocked`.
- Running sibling executions are canceled before the run finishes terminal failure.
- When a repeat `until` node ends `failed` and attempts remain, the matching `failed` edge is treated as normal control flow.
- When the operator cancels the run:
  - currently running executions become `canceled`
  - not-yet-started nodes become `skipped`
  - the run status becomes `canceled`
  - in this release, cancellation enters through the CLI launch process or a caller-provided `AbortSignal`; the web monitor only reflects the durable canceled state

### State projection rules

The state store must be able to answer:

- current run status
- current node status by `compiled_id`
- active executions
- attempt history per compiled node
- active repeat iteration per repeat scope
- aggregate counts used by CLI summaries and the web monitor

## Context Boundary

`runtime/context` resolves the invocation packet for a node. It is intentionally narrow.

### Inputs accepted by context resolution

- static `inputs`
- upstream `context_from` references
- repo instruction files discovered from the workspace root
- repo metadata and workspace paths
- effective `input_rules`

### Materialization behavior

Context resolution produces:

- `context_packet.json`
- `context_summary.md`

`context_packet.json` must include:

- `execution_id`
- target repo alias and workspace path
- one entry per materialized input
- one entry per attached repo rule file
- original source descriptor for each entry
- materialized file path inside the execution directory
- byte counts and truncation flags
- omitted optional items

Repo rule-file discovery is intentionally lean in this release:

- `AGENTS.md`
- `CLAUDE.md`
- `.cursorrules`
- files under `.cursor/rules/`

The release does not implement retrieval, embeddings, ranking, or semantic search. Input resolution is explicit file and artifact materialization only.

## Harness Abstraction

The harness layer exists only for `agent` nodes and AI `check` nodes.

### Canonical adapter interface

```ts
type HarnessKind = 'codex-cli' | 'cursor-cli';

interface AgentInvocation {
  runId: string;
  executionId: string;
  repoAlias: string;
  repoPath: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  model?: string;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  prompt: string;
  contextPacketPath: string;
  outputDir: string;
  timeoutSec: number;
}

interface HarnessAdapter {
  readonly kind: HarnessKind;
  run(invocation: AgentInvocation): Promise<HarnessResult>;
  cancel(executionId: string): Promise<void>;
}
```

### Harness result contract

Every harness returns:

- final status
- raw exit code
- captured stdout
- captured stderr
- structured adapter metadata
- optional parsed transcript metadata

Harness adapters execute normalized invocations. They do not reinterpret graph structure, workspace policy, or context selection.

Timeouts and operator cancellations are hard-bounded in this release: the runtime sends `SIGTERM` first and escalates to `SIGKILL` after a short grace window if the child does not exit.

### Harness restrictions in this release

- no interactive tool sidecars
- no MCP transport
- no harness-specific custom tool surface
- no harness-specific graph semantics

## Check Execution Model

Checks are a runtime subsystem, not a special case of `exec`.

### Deterministic checks

Executor behavior:

- run local commands in the node workspace
- capture stdout, stderr, exit code, and normalized result
- evaluate `pass_if`
- write structured `result.json`

### AI checks

Executor behavior:

- resolve a read-only context packet
- invoke `codex-cli` with evaluator prompts only
- require structured JSON output
- fail closed on malformed evaluator output, cursor-backed evaluator selection, or harness launch/runtime failure

AI checks may score or summarize, but the canonical pass/fail signal is still `passed: boolean`.

## Workspace Boundary

The release supports two workspace backends only:

- `inplace`
- `worktree`

### Run-scoped workspace rules

- One workspace backend is selected for the entire run.
- Every repo alias receives its own effective workspace path under that backend.
- `inplace` uses the source repo path directly.
- `worktree` creates one git worktree per participating repo under `<run_root>/workspaces/<repo_alias>/`.
- `worktree` initialization is all-or-nothing for the run. If one repo fails to initialize, the runtime removes any worktrees it already created for that run before surfacing preflight failure.
- `worktree` paths are transient runtime state, not durable operator artifacts. On `passed`, `failed`, and `canceled` terminal outcomes, the runtime removes the git worktree registrations and the worktree directories after execution artifacts have been materialized.
- Nodes always execute against the workspace path for their own repo alias.

The compiled manifest records the repo alias to workspace path mapping used by the run.

## Validation Model

Validation happens in three layers.

### 1. Graph validation

Runs before compilation. It checks:

- schema shape
- unique ids
- valid repo references
- valid profile references
- legal `inputs`, `context_from`, and `outputs`
- repeat semantics
- unsupported deferred features

### 2. Compile validation

Runs during compilation. It checks:

- profile resolution completeness
- authored-to-compiled mapping correctness
- edge consistency
- repeat scope construction
- scope ancestry correctness
- concurrency constraints

### 3. Run preflight

Runs after successful compilation and before execution. It checks:

- required repos exist
- required harness binary exists on `PATH` or is provided through `AGENTFLOW_CODEX_CLI_BIN` / `AGENTFLOW_CURSOR_CLI_BIN`
- workspace backend can initialize
- run artifact directory is writable

The release does not attempt deep remote auth diagnostics. It fails fast when the harness invocation itself proves unavailable.

## Artifact Model

Run artifacts live under the run root:

```text
<runs-root>/<run_id>/
  run.json
  authored_graph.json
  compiled_graph.json
  execution_manifest.json
  compile_diagnostics.json
  state.json
  events.jsonl
  summary.md
  repos/
    <repo_alias>.json
  workspaces/
    <repo_alias>/
  nodes/
    <compiled_id>/
      executions/
        <execution_id>/
          execution.json
          context_packet.json
          context_summary.md
          stdout.log
          stderr.log
          result.json
          artifacts/
```

`<runs-root>` resolves from an absolute `AGENTFLOW_RUNS_ROOT` when set, otherwise from `<launch-cwd>/.agentflow/runs`.

### Artifact rules

- `authored_graph.json` is the exact launched graph snapshot
- `compiled_graph.json` is the runtime truth
- `execution_manifest.json` freezes effective policy and workspace mapping
- `run.json` is the operator-facing run record and must reflect the latest terminal status plus `ended_at` when the run closes
- `run.json` carries a live-owner fingerprint only while a run is still active: the local process pid plus host and start-time metadata when available. Artifact readers use that fingerprint to detect and repair stale `pending` or `running` snapshots after an unclean process exit without trusting pid reuse alone
- `state.json` is the latest projected read model
- `events.jsonl` is append-only and authoritative for history
- `summary.md` is written for every terminal run, including preflight failure with zero node executions
- execution directories are immutable once closed except for final summary writes
- `workspaces/` is durable only for an active `worktree` run. Once the run reaches a terminal state or workspace init rolls back, the manifest still records the historical path, but the worktree directory itself may already be gone
- projection reads may repair stale `pending` or `running` artifacts into a terminal failed state when the recorded runtime owner fingerprint no longer matches a live local process or when a terminal run record or terminal event proves the durable state drifted

### Failure and partial-output rules

- `validate` and `compile` actions outside `run` do not create a run directory
- validation failure returns diagnostics only
- compile failure returns diagnostics plus optional partial compiled payload to the caller, but does not create a run directory
- once `run` passes validation and compilation, the run directory is created before preflight
- preflight failure writes `run.json`, `authored_graph.json`, `compiled_graph.json`, `execution_manifest.json`, `compile_diagnostics.json`, `state.json`, `events.jsonl`, and `summary.md`
- canceled runs keep all completed execution directories and final state

## Event Model

Events are the contract between runtime, artifacts, and the monitor.

### Event envelope

Every event record contains:

- `seq`
- `ts`
- `run_id`
- `type`
- optional `compiled_id`
- optional `execution_id`
- optional `repeat_scope_id`
- optional `iteration_index`
- optional `attempt_index`
- `payload`

### Required release event types

| Event type | Required payload fields |
| --- | --- |
| `graph.compiled` | `graph_id`, `compiled_node_count`, `scope_count` |
| `run.preflight_failed` | `reason`, `message` |
| `run.started` | `workspace_backend`, `repo_workspaces` |
| `node.ready` | `deps_satisfied` |
| `repeat.iteration.started` | `max_attempts` |
| `node.started` | `kind`, `repo_alias`, `profile_name` |
| `check.evaluated` | `check_kind`, `passed`, optional `score`, `summary` |
| `node.completed` | `outcome`, `duration_ms` |
| `node.blocked` | `reason`, `upstream_compiled_id` |
| `node.skipped` | `reason` |
| `node.canceled` | `reason` |
| `repeat.iteration.completed` | `outcome`, `iteration_index` |
| `run.canceled` | `reason` |
| `run.completed` | `outcome`, `duration_ms` |

Log lines are not required to be replayable through the event stream in this release. The monitor reads logs from `stdout.log` and `stderr.log`.

## UI Read Model Boundary

The web server must not parse raw run directories ad hoc on every request. `artifacts/projection` owns the derived read model.

### Read-model contract

The projected state must answer:

- run summary
- compiled graph with runtime overlay
- node detail by `compiled_id`
- execution history per compiled node
- recent events after `seq`
- repo workspace mapping
- artifact metadata for a selected execution

`state.json` must include:

- `run_id`
- `snapshot_seq`
- run-level status and counts
- node status map
- active executions
- latest execution summary per compiled node
- repeat scope iteration state

### Live-update contract

The release backend supports:

- snapshot reads from `state.json`
- incremental event reads with `after_seq`
- optional SSE transport for the same append-only event stream
- polling fallback when SSE is unavailable

The UI boots from `state.json`, then tails events after `snapshot_seq`. If live transport is unavailable, the UI labels the monitor as non-live and continues with polling.

## Minimal Controller Stub

`src/controller` exists only to prevent architecture drift. In release it may contain:

- a README describing the future controller role
- shared type definitions only if strictly necessary

It must not own execution logic in the first implementation.
