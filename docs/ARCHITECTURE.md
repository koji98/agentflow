# Architecture

## System Boundary

Agentflow has six runtime subsystems and one deferred control-plane stub.

### Runtime subsystems

1. `graph`: parse, resolve plugin workflows, normalize, validate, resolve profiles, and compile authored graphs
2. `runtime/core`: schedule compiled nodes, track state, and emit events
3. `runtime/context`: resolve node context material and prior artifacts into a bounded context packet
4. `runtime/harness`: execute `agent` nodes and AI `check` nodes through CLI-backed harness adapters
5. `runtime/checks`: execute deterministic `check` nodes and normalize AI evaluator results
6. `artifacts`: persist run files, append events, and project a stable read model for inspection tooling

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
  "plugins": {
    "team": {
      "source": "git@github.com:acme/team-agentflow-plugin.git",
      "ref": "v0.1.0"
    }
  },
  "profiles": {
    "default": {
      "harness": "cursor-cli",
      "sandbox": "workspace-write",
      "timeout_sec": 1800,
      "input_rules": {
        "max_total_tokens": 128000,
        "max_tokens_per_item": 32000
      },
      "artifact_repair": {
        "max_attempts": 1
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
- `repos.<alias>.path` is resolved relative to the authored graph file location. When `repos` is omitted, normalization injects a single `main` repo whose path is the directory containing the resolved `--graph` file.
- optional `plugins.<alias>` declares a Git source and ref for reusable managed workflows. The declaration is resolved by `agentflow plugin resolve --graph` into `agentflow.plugins.lock.json`.
- optional `defaults.launch_profile` selects the run launch profile. When omitted, normalization defaults it to `"default"` only when a profile named `default` exists; if it does not, the graph must reference a profile explicitly per node and `launch_profile` stays unset.
- optional `defaults.workspace_backend` selects the run workspace backend. When omitted, normalization defaults it to `"inplace"`.
- optional `prerequisites.checks` declares launch-time file, command, env, or repo checks shared by `validate`, `run`, and `resume`.
- optional `config` declares default values for graph parameters. Strings anywhere in the document can interpolate values with `{{config.key}}` or `{{config.nested.key}}`.
- optional `config_schema` validates the merged config (declared `config` plus CLI overrides via `--config key=value` / `--config-file <path>`). The supported subset matches the plugin workflow `config_schema`. See `docs/PARAMETERIZED_GRAPHS.md` for full semantics, merge order, and JSON-vs-string parsing rules.
- optional `tools` declares plugin-bundled CLI commands that should appear on every agent's `PATH` in this graph. Each entry is a plugin reference (`from_plugin`, `tool`, optional `alias`). There is no built-in tool surface and no inline tool declarations: tools must come from a resolved plugin. See `docs/PLUGINS.md` for the full contract.
- optional `tool_config` maps a tool name to a flat string-only object whose entries are exported per agent as `AGENTFLOW_TOOL_<UPPER_NAME>_<UPPER_KEY>`. Agent-level `tool_config` shallowly overrides graph-level `tool_config` for that tool on that agent.
- The run root is not authored inside the graph. It is launch-time configuration owned by the CLI and resolved from `--runs-root <path>` when passed, else from an absolute `AGENTFLOW_RUNS_ROOT` when set, else from `<graph-dir>/.agentflow/runs` where `<graph-dir>` is the directory containing the resolved `--graph` file.

### Multi-repo ownership

- The runs root defaults to `<graph-dir>/.agentflow/runs/`; each run root lives under `<runs-root>/<run_id>/`.
- CLI commands use the same rule: prefer `--runs-root <path>` when passed, then an absolute `AGENTFLOW_RUNS_ROOT`, otherwise fall back to the resolved graph directory.
- The run root is the only owner of run artifacts, events, and projected state.
- Each repo alias resolves to both a source path and an effective workspace path for the current run.
- Cross-repo reads are allowed only through explicit repo-qualified workspace context paths or run-artifact references in `context`.
- Cross-repo writes happen only by executing a node against that repo's workspace.

### Node kinds

Primitive authoring supports seven node kinds:

- `agent`
- `exec`
- `check`
- `checkpoint`
- `sequence`
- `parallel`
- `repeat`

Only `agent`, `exec`, `check`, and `checkpoint` are executable runtime nodes.

Managed-workflow authoring supports built-in patterns and Git-resolved plugins:

- `pattern_deep_research`
- `pattern_spec_design`
- `pattern_generate_evaluate_fix`
- `pattern_review_change`
- `plugin`

Those workflows compile into internal primitive subgraphs rather than execute as direct runtime node kinds. Their authored schemas are part of the current release contract.

### Common executable node fields

Every executable node may define:

- `id`
- optional `label`
- optional `repo`
- optional `profile`
- optional `context`
- optional `artifacts`
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
- `reasoning_effort`
- `sandbox`
- `artifact_repair`
- `tools`
- `tool_config`

`agent` nodes are the only nodes that may modify repository state through a harness. `harness` is required (resolved through profiles) and is environment-dependent: validation fails if a node cannot resolve a harness through its profile chain.

`tools` declares plugin-bundled CLI commands that should appear on this agent's `PATH` in addition to any graph-level tools. Each entry is a plugin reference (`from_plugin`, `tool`, optional `alias`). There is no built-in or inline tool surface. Tool name collisions inside the effective agent toolkit are hard validation errors. `tool_config` maps a tool name to a flat string-only object whose entries are exported as `AGENTFLOW_TOOL_<UPPER_NAME>_<UPPER_KEY>` for that node. See `docs/PLUGINS.md` for the full contract.

### `exec`

Required fields:

- `type: "exec"`
- `id`
- `command`

Optional node-specific fields:

- `args`
- `cwd`
- `env_files`
- `env`
- `on_failure`

`cwd`, when present, resolves relative to the node workspace and must stay within that workspace root.

`env_files`, when present, is a list of dotenv-style files resolved relative to the node workspace root. The files must stay within that workspace root, load in order, and are applied before inline `env` overrides.

`on_failure` defaults to `"fail"`. With `"continue"`, non-zero verifier exits are recorded as soft verification evidence in `result.json` and `verification.recorded`, but control flow continues. Spawn errors, timeouts, cancellation, context failures, and output materialization failures still fail the node hard.

### `check`

Required fields:

- `type: "check"`
- `id`
- `check_kind`

Supported release `check_kind` values:

- `deterministic`
- `ai`

Optional shared check fields:

- `context`
- `artifacts`
- `on_failure`

Deterministic check fields:

- `command`
- optional `args`
- optional `cwd`
- optional `env_files`
- optional `env`
- optional `pass_if`

Supported release `pass_if` forms:

- `{ "exit_code": 0 }`
- `{ "json_path": "$.passed", "equals": true }`

AI check fields:

- `prompt`
- optional `rubric`
- optional `model`

`on_failure` defaults to `"fail"`. With `"continue"`, a failed deterministic or AI evaluation records its true pass/fail result as soft verification evidence while the graph continues. Managed internal hard gates remain hard unless the workflow contract lowers them explicitly as soft evidence.

AI checks must return structured JSON:

```json
{
  "passed": true,
  "score": 0.93,
  "summary": "short operator-facing summary",
  "issues": []
}
```

### `checkpoint`

Required fields:

- `type: "checkpoint"`
- `id`
- `prompt`
- `review_from`

Optional shared fields:

- `label`
- `repo`
- `profile`
- `context`
- `artifacts`
- `timeout_sec`

Rules:

- `checkpoint` is only valid inside a `repeat.body` in this release.
- `review_from` must reference an upstream named artifact.
- the runtime exposes one automatic checkpoint output named `operator_feedback` from `operator-feedback.md`.
- checkpoint execution requires an interactive terminal because the operator must choose `pass`, `deny`, or `abort`.

### `sequence`

Required fields:

- `type: "sequence"`
- `id`
- `steps`

Optional fields:

- `cleanup`

Execution rule: child nodes become ordered dependencies.

Cleanup rules:

- `cleanup` is an ordered list of authored nodes that always run after the sequence body finishes, regardless of whether the body passed, failed, was blocked, was skipped, or was canceled by the operator.
- Cleanup steps run serially. Each step waits for the prior cleanup step to finish before starting.
- A failure inside a cleanup step is recorded as that step's outcome but does not change the run-level outcome that the body produced. Subsequent cleanup steps continue to run so resource hygiene is preserved.
- Operator cancellation during cleanup cancels the in-flight cleanup step, marks remaining cleanup nodes as `skipped`, and finalizes the run as `canceled`.
- For nested sequences, cleanup chains run deepest-first so inner cleanup completes before the outer cleanup. Within a single sequence, cleanup steps run in their authored order.
- Cleanup nodes are validated like normal nodes (id, repo, profile, context, artifacts, etc.) but a cleanup step cannot itself declare a `cleanup` array. Use a nested `sequence` with its own `cleanup` if a cleanup step needs its own teardown.

Example:

```json
{
  "type": "sequence",
  "id": "with_local_env",
  "steps": [
    { "type": "exec", "id": "build_features", "command": "scripts/ship.sh" }
  ],
  "cleanup": [
    { "type": "exec", "id": "stop_dev_server", "command": "scripts/stop-dev.sh" },
    { "type": "exec", "id": "drop_local_db", "command": "scripts/drop-db.sh" }
  ]
}
```

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
- `until.node` must reference a descendant `check` or `checkpoint` node inside `body`.
- on `until.node -> passed`, the runtime exits the repeat scope.
- on `until.node -> failed` and attempts remain, the runtime follows the explicit repeat back-edge.
- on `until.node -> failed` and attempts are exhausted, the repeat scope produces terminal failure for the run.

There are no free-form conditions in this release.

## Context and Artifacts

`context` and `artifacts` are the authored contract between graph authoring and runtime context resolution. Old public data-flow fields `inputs`, `context_from`, and `outputs` are invalid graph syntax.

The runtime keeps two channels separate:

- Workspace state is mutable repo state. Agents and commands read and edit it through their selected workspace backend.
- Artifacts are durable named handoff files. They are the only execution-produced material that downstream nodes can consume through artifact `ref` context items.

This separation is intentional. A graph may modify source files in a worktree, but a later node should not depend on guessing which execution directory or scratch file mattered. If a later node needs material, the producer must publish a named artifact or rely on the reserved canonical artifacts.

### `context`

`context` is a list of named materials resolved before execution. Supported release item shapes:

```json
{ "name": "server", "from": "workspace_file", "path": "src/server.ts" }
{ "name": "web_app", "from": "workspace_file", "path": "web:src/App.tsx" }
{ "name": "sources", "from": "workspace_glob", "path": "src/**/*.ts", "max_files": 20 }
{ "name": "acceptance", "from": "text", "text": "Keep the CLI surface unchanged." }
```

Artifact context resolves named artifacts from prior node executions through a path-style `ref`:

```json
{ "ref": "understand_codebase" }
```

```json
{
  "ref": "run_tests.junit",
  "iteration": "latest",
  "attempt": "latest_passed",
  "if_available": false
}
```

Supported artifact context fields:

- `ref`: required path-style string. `"<node>.<artifact>"` selects a declared artifact; bare `"<node>"` resolves to the node's canonical artifact (`agent_response` for `agent`, `stdout` for `exec`, `result_json` for both deterministic and AI `check`).
- optional `name`: defaults to the rightmost `.` segment of `ref`, or to the node id when `ref` is bare. Explicit `name` always wins. Conflicting names across `ref` items inside a single node fail validation.
- `iteration`: optional selector for repeated nodes
- `attempt`: optional execution selector
- `if_available`: optional boolean, default `false`

The `.` character is reserved as the `ref` path separator: declared artifact keys cannot contain `.`.

Supported selectors:

- `latest`
- `latest_passed`
- `latest_failed`
- `previous`
- positive integer ordinal

`previous` is intended for cross-iteration comparisons (diff-based checks, regression detection). When applied to `iteration`, it resolves to the consumer's current iteration index minus one, so an `exec` or `check` inside iteration `N` of a `repeat` body can pull the matching upstream artifact from iteration `N - 1`. Pair it with `if_available: true` so the first iteration omits the reference cleanly. When applied to `attempt`, it selects the second-most-recent attempt for the resolved iteration.

Resolution rules:

- Unqualified workspace file and glob paths resolve against the node repo.
- Repo-qualified paths use `<repo_alias>:<relative_path>`.
- Workspace file and glob paths must stay within the selected repo root.
- `workspace_glob` enumeration uses a deterministic sorted recursive filesystem walk with root `.gitignore` and `.ignore` filtering plus hard exclusions for `.git`, `.agentflow`, and `node_modules`.
- `workspace_glob.max_files` is a local cap for that glob only.
- `name` is required and stable inside the materialized context packet. For artifact `ref` items, `name` is derived from `ref` when omitted as described above.
- The node id parsed from `ref` always references an authored id. The compiler resolves it to one or more compiled nodes.
- For nodes outside any `repeat`, `iteration` is omitted and treated as `0`.
- For nodes inside a `repeat`, cross-scope references must specify `iteration` when more than one iteration could satisfy the reference.
- `attempt` is evaluated after `iteration` is resolved.
- `agent_response` resolves to `artifacts/agent-response.md` for agent nodes.
- `stdout` resolves to `logs/stdout.log` for exec nodes.
- `result_json` resolves to `artifacts/result.json` for check nodes.
- other artifact names resolve to declared artifacts on the selected execution.
- declared artifact descriptions are carried from the producer into the consumer's context packet and manifest.
- Executable nodes inside a `repeat.body` receive automatic runtime `repeat_history` context. It is omitted on iteration 1 and materialized on later iterations from completed prior iterations in the same repeat scope.
- For `exec` and deterministic `check` nodes, every materialized context item also exports an `AGENTFLOW_CONTEXT_<UPPER_NAME>` environment variable that points at the materialized file inside the run root.

`repeat_history` is not authored graph syntax. It is a reserved runtime context material that summarizes repeat metadata, the retry cause, prior node outcomes, prior agent responses, checkpoint feedback, failed check output excerpts, and prior artifact inventories. It is deterministic and bounded by the same context token limits as authored context.

`repeat_history` follows a most-recent-N truncation policy. The packet always includes:

- a header listing the repeat authored id, current iteration, and configured `max_attempts`
- the explicit retry cause derived from the previous iteration's gate node
- detailed sections for the most recent five completed prior iterations only
- a `Earlier iterations omitted from this history: <count>` line whenever older iterations exist

This makes the packet bounded and predictable even at iteration 100, 1000, or higher: only the last five iterations are materialized in detail, and per-section excerpts are themselves capped (4000 chars for agent responses and operator feedback, 8000 chars for failed exec/check stdout and stderr tails). The total packet still respects the effective `input_rules` token budget; repeat history does not bypass `max_total_tokens` enforcement.

### `artifacts`

`artifacts` declares named artifacts that downstream nodes may reference.

```json
{
  "junit": {
    "from": "workspace",
    "path": "reports/junit.xml",
    "description": "JUnit XML test report produced by the validation command."
  }
}
```

```json
{
  "design_packet": {
    "from": "output_dir",
    "path": "design-packet.json",
    "description": "Structured JSON implementation packet for downstream implementation nodes."
  }
}
```

Supported release fields:

- map key: artifact name
- `from`: `workspace` | `output_dir`
- `path`
- `description`: a one-sentence description of the expected file contents

Rules:

- Artifact names are unique per node.
- Artifact names cannot contain `.` because `.` is reserved as the `ref` path separator.
- User-declared artifact names must not collide with reserved canonical artifacts: `agent_response`, `stdout`, and `result_json`.
- `from = "workspace"` copies a file from the node workspace into the execution `artifacts/` directory when the node closes.
- `from = "output_dir"` reads a file from `AGENTFLOW_OUTPUT_DIR`, which is the execution `artifacts/` directory.
- Every declared artifact must exist when the node closes. Missing declared artifacts fail the node after any configured agent artifact repair attempts are exhausted.
- Both path forms must remain inside their source root.
- Downstream artifact context must reference either a declared artifact or a reserved automatic artifact.
- Agent harness prompts explain that the model is executing one node in a graph, list declared artifacts with descriptions, and state that the final response is captured as `agent_response`.
- Harness subprocesses receive `AGENTFLOW_WORKSPACE`, `AGENTFLOW_OUTPUT_DIR`, `AGENTFLOW_CONTEXT_PACKET`, and `AGENTFLOW_CONTEXT_MANIFEST`, matching command nodes.
- `exec` and deterministic `check` subprocesses also receive one `AGENTFLOW_CONTEXT_<UPPER_NAME>` environment variable per resolved context item, pointing at the materialized file path inside the run root.
- When tools are in scope on the node, harness subprocesses also receive `AGENTFLOW_TOOL_STATE`, optional `AGENTFLOW_PLUGIN_ROOT_<UPPER_ALIAS>` and `AGENTFLOW_PLUGIN_ROOT` variables, plus one `AGENTFLOW_TOOL_<UPPER_NAME>_<UPPER_KEY>` variable per `tool_config` entry. See `docs/PLUGINS.md` for the env table and prompt rendering contract.
- Source edits happen in the workspace, durable handoff artifacts go in `AGENTFLOW_OUTPUT_DIR`, and downstream nodes consume only named artifacts.

Artifact repair rules:

- Repair applies only to `agent` nodes whose primary execution returned `passed`.
- Repair reuses the same workspace, context packet, context manifest, declared artifact contract, and `AGENTFLOW_OUTPUT_DIR`.
- Repair is a new harness invocation, not a harness-specific session resume.
- Each repair prompt, stdout, stderr, and result JSON is written under `artifact-repairs/<attempt>/` inside the original execution directory.
- A successful repair must make every missing declared artifact exist at its exact declared path before the node can close as passed.
- If repair is unavailable, canceled, or exhausts `max_attempts`, the node fails but reserved automatic artifacts such as `agent_response` and `result_json` remain available for inspection.

Authoring guidance:

- Use `agent_response` for short narrative handoffs where the final model response is the artifact. It should summarize outcome, work completed, artifacts produced, validation, and handoff notes.
- Declare `output_dir` artifacts for machine-readable packets, summaries, ledgers, and reports the agent or command intentionally writes.
- Declare `workspace` artifacts when the important output is produced in the repo workspace, such as a test report under `reports/`.
- Do not declare a producer artifact unless the node is responsible for producing it. For supplementary evidence, either require a concise artifact or rely on `agent_response`.
- Descriptions should tell the producer what to write and tell consumers what the material means.
- Keep artifact names semantic: `design_packet`, `evaluation_ledger`, `review_summary`, not `output1`.

### Validation rules

The compiler rejects:

- missing or duplicate node ids
- unknown repo aliases
- unknown profile names
- profile and node `env_files` paths that are absolute, repo-qualified, or escape the node workspace root
- artifact context references to nodes that are not guaranteed to execute before the consumer
- ambiguous repeated-node references without an `iteration` selector
- artifact references to undeclared names
- cross-repo direct file reads without explicit repo qualification when the source repo is not the consumer repo
- `repeat.until.node` targets that use `on_failure = "continue"`
- `sequence.cleanup` arrays nested inside another `sequence.cleanup` (cleanup steps cannot themselves declare `cleanup`)
- `agent` or AI `check` nodes that cannot resolve a `harness` through the profile chain
- declared artifact keys that contain `.`
- two artifact `ref` context items on a single node that resolve to the same `name`
- inline tool declarations or built-in tool references; only plugin-bundled tools are allowed

Runtime context resolution fails the node when:

- a required referenced file or artifact is missing
- an `attempt` selector resolves to no execution
- context material exceeds the effective limits after truncation rules are applied

If `if_available: true`, the missing item is omitted and the omission is recorded in `context/packet.json`.

CLI validation runs in three phases:

1. authored validation
2. compiled validation after lowering managed patterns and plugin workflows
3. readiness validation for declared prerequisites and resolved repo sources

Plain readiness validation blocks launch only for required declared checks. Optional prerequisite failures remain visible as warnings. `agentflow validate --graph <path> --run-ready` adds local machine checks for `git`, repo worktree status, executable node commands, and harness binaries so an operator can prove the graph is runnable on the current host before starting a run.

## Profile Model

Profiles are named policy bundles. They avoid repeating execution policy on every node.

### What a profile may contain in this release

- `harness`
- `model`
- `sandbox`
- `skip_git_repo_check`
- `env_files`
- `timeout_sec`
- `input_rules`
- `deterministic_check_defaults`
- `ai_check_defaults`
- `artifact_repair`

Profiles do not own graph structure. They do not set workspace backend in this release.

### Launch resolution

Launch resolution happens before node policy resolution.

| Setting | Resolution order |
| --- | --- |
| `launch_profile` | graph `defaults.launch_profile` -> `"default"` only when a profile named `default` exists -> validation error |
| `workspace_backend` | graph `defaults.workspace_backend` -> runtime built-in `inplace` |

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
- `skip_git_repo_check` applies only to `codex-cli` `agent` and AI `check` nodes, and maps to Codex CLI `--skip-git-repo-check`
- `env_files` apply only to `exec` and deterministic `check`; node-level `env_files` replaces the profile list, paths resolve inside the node workspace root, files load in order, and inline node `env` wins last
- AI `check` always executes in `read-only` mode, regardless of profile sandbox defaults, and the release requires `codex-cli` for that strict evaluator contract
- `deterministic_check_defaults` apply only to deterministic `check`
- `ai_check_defaults` apply only to AI `check`
- `artifact_repair` applies only to `agent` nodes
- `timeout_sec` and `input_rules` may apply to any executable node

Inline or profile fields that do not apply to a node kind are rejected at compile time.

#### `timeout_sec`

`timeout_sec` is an integer count of seconds. The runtime accepts any value `>= 1` and the schema does not enforce an upper bound, so long-running polling or wait-loop nodes may set values up to a full day (`86400`) or longer when the operator deliberately wants the run to keep waiting. The built-in default is `1800` (30 minutes); without an explicit override every executable node terminates after 30 minutes whether it is making progress or not.

Recommended values for long-running graphs:

- short verifiers (build, lint, unit tests): `300` to `1800`
- agent steps that may iterate or call models: `1800` to `7200`
- polling `exec` loops (CI watchers, PR babysitters, integration suites): `7200` to `86400`
- bespoke local environment setup that must wait on slow downstream services: choose a budget you would accept as a failure if it elapsed and set `timeout_sec` to that value

Cleanup steps inherit the same `timeout_sec` resolution. Set a generous bound on cleanup `exec` nodes that need to drain queues, stop containers, or return databases to a clean state.

Agentflow does not run a silent-process watchdog. Long-running `exec` and `check` nodes that emit no output for minutes or hours are not killed for being quiet. The only conditions that terminate a child process are:

- the configured `timeout_sec` deadline elapses
- the operator cancels the run (Ctrl-C or caller-provided `AbortSignal`)
- the parent run finalizes and the runtime tears workspaces down

Termination always sends `SIGTERM` first and escalates to `SIGKILL` after a short grace window. This makes it safe to author polling `exec` loops that sleep between iterations without worrying that idle stdout periods will trigger a kill.

`exec`, `agent`, and `check` nodes stream stdout and stderr to `logs/stdout.log` and `logs/stderr.log` inside the execution directory as the child process emits data. The runtime queues append writes per stream so chunks land in `logs/*.log` in source order without blocking the child. This means an operator can `tail -f` the log file of a long-running polling exec and see live progress instead of waiting for the node to terminate.

### `artifact_repair`

Agent artifact repair is a bounded recovery path for successful agent runs that miss declared artifacts.

Supported release fields:

- `max_attempts`: integer from `0` through `3`

Resolution follows normal node policy order:

1. built-in agent default: `1`
2. selected launch profile
3. node-referenced profile
4. agent node inline override

Set `max_attempts` to `0` to disable repair for a profile or node.

### `input_rules`

Supported release `input_rules` fields:

- `max_total_tokens`
- `max_tokens_per_item`

Built-in defaults:

- `max_total_tokens: 128000`
- `max_tokens_per_item: 32000`

The runtime enforces these token limits during context packet materialization. If you need to bound a broad file pattern, use `glob.max_files` on that specific input instead of relying on a graph-wide file-count budget.

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
      "context": [],
      "declared_artifacts": {}
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

The runtime core is a scheduler plus a state store. It knows nothing about presentation layers or harness-specific CLI flags.

Implementation notes for this release:

- `runtime/session` owns the run-level snapshot, manifest, node-status map, and repeat-scope state.
- `runtime/attempts` owns execution identity and per-node attempt history separately from authored graph identity.
- `runtime/events` owns the append-only event envelope shared by runtime, artifacts, and inspection tooling.

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

Non-running states visible in projected state:

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
  - in this release, cancellation enters through the CLI launch process or a caller-provided `AbortSignal`; durable artifacts capture the canceled state

### State projection rules

The state store must be able to answer:

- current run status
- current node status by `compiled_id`
- active executions
- attempt history per compiled node
- active repeat iteration per repeat scope
- aggregate counts used by CLI summaries and projected inspection output

## Context Boundary

`runtime/context` resolves the invocation packet for a node. It is intentionally narrow.

### Inputs accepted by context resolution

- static `context` items
- upstream artifact references
- repo metadata and workspace paths
- effective `input_rules`

Authored workspace context resolves live when each node starts. Agentflow does not snapshot all authored context up front for the whole run.

### Materialization behavior

Context resolution produces:

- `context/packet.json`
- `context/manifest.md`
- `context/provenance.json`

`context/packet.json` must include:

- `execution_id`
- target repo alias and workspace path
- tokenizer identifier used for materialized text
- one entry per materialized context item
- original source descriptor for each entry
- materialized file path inside the execution directory
- live-workspace binding metadata when the material came from a resolved workspace file or glob context item
- token counts and truncation flags
- omitted unavailable workspace items, first-iteration repeat history, and artifact context items marked `if_available: true`

`context/provenance.json` must include:

- digests for resolved explicit workspace file context
- sorted live glob match sets plus per-file digests
- harness instruction digests for `agent`, AI `check`, and `checkpoint` nodes

Agentflow does not duplicate repository instruction files into the context packet. Harness-native instruction discovery stays with the harness itself.

Context materialization is incremental. The runtime enforces `max_total_tokens` while it materializes items and fails as soon as the next item would overflow the token budget.

Packet items reflect what Agentflow could resolve from the live workspace when the node started. Missing workspace files, empty globs, first-iteration repeat history, and artifact context references marked `if_available: true` are recorded explicitly as omitted context instead of crashing the whole run during preflight. Resolved artifact materials include the producer's description. Resolved material that is not valid UTF-8 text is also omitted because context packets are tokenized text.

The release does not implement retrieval, embeddings, ranking, or semantic search. Context resolution is explicit file and artifact materialization only.

## Resume Preservation

`resume` preserves durable passed work when the recompiled executable contract still matches.

Preservation rules in this release:

- workspace file changes do not invalidate preserved passed nodes
- harness instruction file changes do not invalidate preserved passed nodes
- nodes restart when their compiled contract changes
- repeat scopes restart from iteration 1 when they were unfinished or their compiled contract changed

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
  contextManifestPath: string;
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
- no plugin-provided runtime sidecars or hidden harness extensions
- no built-in CLI tools and no inline graph- or agent-defined tools

Tool capabilities are added exclusively through plugin-bundled CLIs described in `docs/PLUGINS.md`, not through harness-specific extensions. Tools run in the agent's sandbox as ordinary CLIs on `PATH` and share the agent node's `timeout_sec`.

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
- legal `context` and `artifacts`
- repeat semantics
- `env_files` path boundaries
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

- required repos exist for the repo aliases the compiled graph actually references
- workspace backend can initialize
- run artifact directory is writable

Run-time node-specific readiness is lazy in this release. Missing harness binaries, missing checkpoint executors, and missing interactive TTY support fail the node that reaches that boundary instead of failing the whole graph before execution starts. Operators who want upfront local proof should run `validate --run-ready` before launch.

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
  workspace-changes/
    <repo_alias>/
      status.txt
      diff.patch
      changed-files.json
  workspaces/
    <repo_alias>/
  nodes/
    001-<node-label>-<hash>/
      executions/
        001-exec-<hash>/
          execution.json
          context/
          logs/
        i001-a001-exec-<hash>/
          execution.json
          context/
            packet.json
            manifest.md
            provenance.json
            materialized/
          logs/
            stdout.log
            stderr.log
          result.json
          artifacts/
            result.json
            agent-response.md
            <declared-artifacts>
```

`<runs-root>` resolves from `--runs-root <path>` when passed, else from an absolute `AGENTFLOW_RUNS_ROOT` when set, otherwise from `<graph-dir>/.agentflow/runs` where `<graph-dir>` is the directory containing the resolved `--graph` file.

### Artifact rules

- run-root records and execution-root records are runtime bookkeeping; `artifacts/` is reserved for produced outputs
- `authored_graph.json` is the exact launched graph snapshot
- `compiled_graph.json` is the runtime truth
- `execution_manifest.json` freezes effective policy and workspace mapping
- `run.json` is the operator-facing run record and must reflect the latest terminal status plus `ended_at` when the run closes
- `run.json` carries a live-owner fingerprint only while a run is still active: the local process pid plus host and start-time metadata when available. Artifact readers use that fingerprint to detect and repair stale `pending` or `running` snapshots after an unclean process exit without trusting pid reuse alone
- `state.json` is the latest projected read model
- `events.jsonl` is append-only and authoritative for history
- `summary.md` is written for every terminal run, including preflight failure with zero node executions
- `workspace-changes/` captures per-repo `git status --porcelain=v1`, `git diff --binary`, and changed-file metadata before terminal worktree cleanup when the repository is inspectable
- node directories are prefixed with stable compiled-order numbers and readable labels, then a hash suffix
- execution directories are prefixed with append-only runtime ordinals, then a hash suffix; repeated nodes include both iteration and attempt ordinals, such as `i001-a002-exec-<hash>`
- execution directories are immutable once closed except for final summary writes
- execution-root files stay small: `execution.json` and root `result.json` are runtime bookkeeping; `logs/stdout.log` and `logs/stderr.log` hold durable process output; `context/packet.json`, `context/manifest.md`, and `context/provenance.json` appear only when context resolution succeeds
- `artifacts/agent-response.md` appears for agent nodes and is published as the reserved `agent_response` artifact
- `artifacts/result.json` is published as the reserved `result_json` artifact for every executable node
- `artifacts/` is always created for executable nodes and is the only graph-consumable handoff directory
- `workspaces/` is durable only for an active `worktree` run. Once the run reaches a terminal state or workspace init rolls back, the manifest still records the historical path, but the worktree directory itself may already be gone
- projection reads may repair stale `pending` or `running` artifacts into a terminal failed state when the recorded runtime owner fingerprint no longer matches a live local process or when a terminal run record or terminal event proves the durable state drifted
- authored workspace context resolves from the live workspace when the node starts; missing files or empty globs are recorded in `context/manifest.md` and `context/packet.json` as omitted items

### Failure and partial-output rules

- `validate` (including `validate --show-compiled`) outside `run` does not create a run directory
- validation failure returns diagnostics only
- compile failure during `validate --show-compiled` returns diagnostics plus optional partial compiled payload to the caller, but does not create a run directory
- once `run` passes validation and compilation, the run directory is created before preflight
- preflight failure writes `run.json`, `authored_graph.json`, `compiled_graph.json`, `execution_manifest.json`, `compile_diagnostics.json`, `state.json`, `events.jsonl`, and `summary.md`
- canceled runs keep all completed execution directories and final state
- failed executions never point at nonexistent context artifacts; if context resolution fails before packet materialization, `execution.json` omits those paths

## Event Model

Events are the contract between runtime, artifacts, and inspection tooling.

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
| `artifact_repair.started` | `repair_attempt`, `max_attempts`, `missing_artifacts` |
| `artifact_repair.completed` | `repair_attempt`, `max_attempts`, `repaired_artifacts` |
| `artifact_repair.failed` | `repair_attempt`, `max_attempts`, `missing_artifacts`, `summary` |
| `check.evaluated` | `check_kind`, `passed`, optional `score`, `summary` |
| `node.completed` | `outcome`, `duration_ms` |
| `node.blocked` | `reason`, `upstream_compiled_id` |
| `node.skipped` | `reason` |
| `node.canceled` | `reason` |
| `repeat.iteration.completed` | `outcome`, `iteration_index` |
| `sequence.cleanup.started` | `sequence_authored_id`, `cleanup_step_count`, `body_outcome` |
| `sequence.cleanup.step_failed` | `compiled_id`, `message` |
| `sequence.cleanup.completed` | `sequence_authored_id`, `steps_attempted`, `steps_passed`, `steps_failed`, `steps_skipped` |
| `sequence.cleanup.canceled` | `sequence_authored_id`, `reason` |
| `run.canceled` | `reason` |
| `run.completed` | `outcome`, `duration_ms` |

Log lines are not required to be replayable through the event stream in this release. Inspection tooling reads logs from `logs/stdout.log` and `logs/stderr.log`.

## Artifact Read Model Boundary

Inspection tooling must not parse raw run directories ad hoc. `artifacts/projection` owns the derived read model.

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
- artifact index with clear node and execution directory records plus directory lookup

### Incremental-read contract

The release backend supports:

- snapshot reads from `state.json`
- incremental event reads with `after_seq`

Inspection tooling should start from `state.json`, then read new events after `snapshot_seq`.

## Minimal Controller Stub

`src/controller` exists only to prevent architecture drift. In release it may contain:

- a README describing the future controller role
- shared type definitions only if strictly necessary

It must not own execution logic in the first implementation.
