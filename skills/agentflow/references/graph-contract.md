# Agentflow Graph Contract

Use this as the compact syntax reference for the current Agentflow graph surface.

## Document Shape

Required top-level fields:

- `version`: always `"1"`
- `graph_id`
- `profiles`
- `graph`

Optional top-level fields:

- `repos` (defaults to a single `main` repo whose path is the graph file directory)
- `defaults` (`launch_profile` defaults to `"default"` only when a profile named `default` exists; `workspace_backend` defaults to `"inplace"`)
- `plugins`
- `prerequisites.checks`
- `tools` (plugin-bundled CLI tools only)
- `tool_config`

Path rules:

- `--graph` resolves from the shell current working directory.
- `repos.<alias>.path` resolves from the graph file directory.
- `plugins.<alias>` resolves through `agentflow plugin resolve --graph`, which writes `agentflow.plugins.lock.json` next to the graph.
- Node workspace paths must stay inside their workspace root.
- Context workspace paths must stay inside the selected repo root.
- Artifact paths must stay inside their source root.

Launch rules:

- `defaults.launch_profile` selects a named profile. When omitted, normalization defaults to `"default"` only when such a profile exists; otherwise every node must reference a profile explicitly.
- `defaults.workspace_backend` is `inplace` (default when omitted) or `worktree`.
- `harness` is environment-dependent and required on every `agent` and AI `check` node through the profile chain. Validation fails if a node cannot resolve a harness.
- The graph owns launch settings. Do not expect CLI overrides for profile or workspace backend.

## Profiles

Profiles hold runtime policy, not graph structure.

Common fields:

- `harness`: `codex-cli` or `cursor-cli`
- `model`
- `reasoning_effort`: `none`, `low`, `medium`, `high`, `xhigh`
- `sandbox`: `read-only`, `workspace-write`, `danger-full-access`
- `skip_git_repo_check`
- `env_files`
- `timeout_sec`
- `input_rules`
- `deterministic_check_defaults`
- `ai_check_defaults`
- `artifact_repair`

`env_files` applies to `exec` and deterministic `check` nodes. It does not apply to agent harnesses or AI checks.

`input_rules` fields:

- `max_total_tokens`
- `max_tokens_per_item`

`artifact_repair.max_attempts` applies only to agent nodes. It defaults to `1`, accepts integers from `0` through `3`, and `0` disables repair.

## Node Kinds

Primitive executable nodes:

- `agent`
- `exec`
- `check`
- `checkpoint`

Authoring containers:

- `sequence`
- `parallel`
- `repeat`

Managed patterns:

- `pattern_deep_research`
- `pattern_spec_design`
- `pattern_generate_evaluate_fix`
- `pattern_review_change`

Plugin workflows:

- `plugin`

Only executable nodes run directly. Containers compile into scopes and edges. Managed patterns and plugin workflows lower into generated primitive subgraphs.

## Common Executable Fields

Executable nodes may define:

- `id`
- optional `label`
- optional `repo`
- optional `profile`
- optional `context`
- optional `artifacts`
- optional `timeout_sec`

When multiple repos are declared, executable nodes must declare `repo`.

## Context

`context` is a node array. Every item needs a stable `name`.

Supported context sources:

```json
{ "name": "goal", "from": "text", "text": "..." }
{ "name": "readme", "from": "workspace_file", "path": "README.md" }
{ "name": "sources", "from": "workspace_glob", "path": "src/**/*.ts", "max_files": 20 }
{ "ref": "design.design_packet" }
{ "ref": "design" }
```

Artifact context fields:

- `ref`: required path-style string. `"<node>.<artifact>"` selects a declared artifact; bare `"<node>"` resolves to the canonical artifact for that node kind (`agent_response` for `agent`, `stdout` for `exec`, `result_json` for `check`).
- optional `name`: defaults to the rightmost `.` segment of `ref`, or to the node id when `ref` is bare. Conflicting names across `ref` items inside a single node fail validation.
- optional `iteration`: `latest`, `latest_passed`, `latest_failed`, `previous`, or a positive integer
- optional `attempt`: `latest`, `latest_passed`, `latest_failed`, `previous`, or a positive integer
- optional `if_available`: boolean

Use `if_available: true` only when the consumer can still do useful work without the material. The `.` character is reserved as the `ref` path separator; declared artifact keys cannot contain `.`.

Runtime also injects reserved `repeat_history` context for executable nodes inside `repeat.body`. It is omitted on iteration 1 and materialized on later iterations from completed prior iterations, including the retry cause, prior node outcomes, prior agent responses, failed check excerpts, checkpoint feedback, and prior artifact inventory. Do not author `repeat_history`; it is runtime context.

## Artifacts

`artifacts` is a node map keyed by artifact name.

```json
{
  "design_packet": {
    "from": "output_dir",
    "path": "design-packet.json",
    "description": "Structured implementation packet for downstream implementation nodes."
  },
  "junit": {
    "from": "workspace",
    "path": "reports/junit.xml",
    "description": "JUnit XML report copied from the workspace after validation."
  }
}
```

Artifact sources:

- `output_dir`: file written under `AGENTFLOW_OUTPUT_DIR`
- `workspace`: file copied from the node repo workspace
- `description`: required one-sentence description of the expected file contents

Reserved canonical artifact names (one per node kind):

- `agent_response`: every agent final response, persisted as `artifacts/agent-response.md`
- `stdout`: every exec node's stdout stream, persisted as `logs/stdout.log`
- `result_json`: every check node's normalized result, persisted as `artifacts/result.json`

Do not declare artifacts with reserved names. Declared artifact keys also cannot contain `.`.

Every declared artifact must exist when the node closes. Missing declared artifacts fail the node after any configured agent artifact repair attempts are exhausted. Producer artifact declarations do not have `required` or `optional`; availability belongs on consumer `context.from = "artifact"` items with `if_available: true` when the consumer can still do useful work without that material.

## Runtime Environment

`exec` and deterministic `check` nodes receive:

- `AGENTFLOW_WORKSPACE`
- `AGENTFLOW_OUTPUT_DIR`
- `AGENTFLOW_CONTEXT_PACKET`
- `AGENTFLOW_CONTEXT_MANIFEST`
- one `AGENTFLOW_CONTEXT_<UPPER_NAME>` per resolved context item, pointing at the materialized file

Agents receive the same environment variables (except `AGENTFLOW_CONTEXT_<UPPER_NAME>`) and the same contract through their harness prompt. Source edits happen in `AGENTFLOW_WORKSPACE`. Durable handoff files go in `AGENTFLOW_OUTPUT_DIR` and must be declared in `artifacts`.

When plugin tools are in scope on an agent node, the agent also receives `AGENTFLOW_TOOL_STATE`, optional `AGENTFLOW_PLUGIN_ROOT_<UPPER_ALIAS>` and `AGENTFLOW_PLUGIN_ROOT` variables, plus one `AGENTFLOW_TOOL_<UPPER_NAME>_<UPPER_KEY>` per `tool_config` entry.

`AGENTFLOW_OUTPUT_DIR` points at the current execution's `artifacts/` directory. Runtime bookkeeping such as root `execution.json`, root `result.json`, `context/`, and `logs/` is inspectable but is not the graph handoff surface.

Agent harness prompts tell the model it is executing one node in a graph, list declared artifacts with their descriptions, and explain that the final response is captured as reserved `agent_response`. Treat `agent_response` as a concise narrative handoff, not a replacement for a declared structured artifact.

If an agent reports success but misses declared artifacts, Agentflow can run artifact repair: a new invocation of the same harness in the same workspace, same context, and same `AGENTFLOW_OUTPUT_DIR`, with a focused prompt to create or move the missing files. Repair prompts and logs live under `artifact-repairs/<attempt>/` in the original execution directory.

## Node Fields

### `plugin`

Required:

- `type: "plugin"`
- `id`
- `uses`: `plugin_alias/workflow_id`

Optional:

- `label`
- `config`
- `context`
- `repo`
- `profile`
- `timeout_sec`

Rules:

- plugin aliases and workflow ids use letters, numbers, underscores, or hyphens
- top-level `plugins` must declare each alias with `source` and `ref`
- run `agentflow plugin resolve --graph <path>` before validate/compile/run
- downstream nodes consume public artifacts from the plugin node id, not generated internal ids
- plugin workflows may inject `plugin_file` context and `plugin://` script paths, but the lowered graph still uses normal runtime primitives

### `agent`

Required:

- `type: "agent"`
- `id`
- `prompt`

Optional:

- `model`
- `reasoning_effort`
- `sandbox`
- `artifact_repair`

Use agents for model-driven work. Prefer declared artifacts for structured handoffs; use reserved `agent_response` for concise narrative handoffs that include outcome, work completed, artifacts produced, validation, and handoff notes.

### `exec`

Required:

- `type: "exec"`
- `id`
- `command`

Optional:

- `args`
- `cwd`
- `env_files`
- `env`
- `on_failure`

`on_failure` defaults to `"fail"`. Use `"continue"` for soft evidence collection. Spawn errors, timeouts, missing env files, cancellation, context failures, and missing declared artifacts still fail hard.

### `check`

Required:

- `type: "check"`
- `id`
- `check_kind`

Deterministic checks use:

- `command`
- optional `args`
- optional `cwd`
- optional `env_files`
- optional `env`
- optional `pass_if`

AI checks use:

- `prompt`
- optional `rubric`
- optional `model`
- optional `reasoning_effort`

Supported `pass_if`:

```json
{ "exit_code": 0 }
{ "json_path": "$.passed", "equals": true }
```

### `checkpoint`

Required:

- `type: "checkpoint"`
- `id`
- `prompt`
- `review_from`

Rules:

- valid only inside `repeat.body`
- `review_from` must target an upstream named artifact
- interactive operator gate, not a passive pause

## Containers

`sequence`:

- ordered child dependencies
- default topology

`parallel`:

- independent branches
- optional `max_concurrency`
- should have explicit fan-in after branches

`repeat`:

- `max_attempts`
- `body`
- `until.node`
- `until.node` must be a descendant `check` or `checkpoint`

Use `repeat` only for bounded repair or revision where the gate genuinely decides convergence.

## Removed Fields

These are invalid graph syntax:

- `inputs`
- `context_from`
- `outputs`

Use the current graph contract directly: `context` for node inputs and `artifacts` for named durable outputs.

## Validation

Always run:

```bash
agentflow validate --graph <path>
agentflow validate --graph <path> --run-ready
agentflow validate --graph <path> --show-compiled
```

Fix validation first. Use `--run-ready` when the user needs proof that this machine has required runtime tools, repo worktrees, node commands, and harness binaries. Use `--show-compiled` to inspect lowered managed patterns, profile resolution, dependency edges, repeat scopes, and artifact references.
