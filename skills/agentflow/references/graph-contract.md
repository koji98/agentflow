# Agentflow Graph Contract

Use this as the compact syntax reference for the current Agentflow graph surface.

## Document Shape

Required top-level fields:

- `version`: always `"1"`
- `graph_id`
- `repos`
- `defaults`
- `profiles`
- `graph`

Optional top-level field:

- `prerequisites.checks`

Path rules:

- `--graph` resolves from the shell current working directory.
- `repos.<alias>.path` resolves from the graph file directory.
- Node workspace paths must stay inside their workspace root.
- Context workspace paths must stay inside the selected repo root.
- Artifact paths must stay inside their source root.

Launch rules:

- `defaults.launch_profile` selects a named profile.
- `defaults.workspace_backend` is `inplace` or `worktree`.
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

`env_files` applies to `exec` and deterministic `check` nodes. It does not apply to agent harnesses or AI checks.

`input_rules` fields:

- `max_total_tokens`
- `max_tokens_per_item`

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

Only executable nodes run directly. Containers compile into scopes and edges. Managed patterns lower into generated primitive subgraphs.

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
{ "name": "packet", "from": "artifact", "node": "design", "artifact": "design_packet" }
```

Artifact context fields:

- `node`: upstream authored node id
- `artifact`: reserved or declared artifact name
- optional `iteration`: `latest`, `latest_passed`, `latest_failed`, or a positive integer
- optional `attempt`: `latest`, `latest_passed`, `latest_failed`, or a positive integer
- optional `if_available`: boolean

Use `if_available: true` only when the consumer can still do useful work without the material.

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

Reserved automatic artifact names:

- `agent_response`: every agent final response, persisted as `agent-response.md`
- `result_json`: every executable node's normalized `result.json`

Do not declare artifacts with reserved names.

Every declared artifact must exist when the node closes. Missing declared artifacts fail the node. Producer artifact declarations do not have `required` or `optional`; availability belongs on consumer `context.from = "artifact"` items with `if_available: true` when the consumer can still do useful work without that material.

## Runtime Environment

`exec` and deterministic `check` nodes receive:

- `AGENTFLOW_WORKSPACE`
- `AGENTFLOW_OUTPUT_DIR`
- `AGENTFLOW_CONTEXT_PACKET`
- `AGENTFLOW_CONTEXT_MANIFEST`

Agents receive the same environment variables and the same contract through their harness prompt. Source edits happen in `AGENTFLOW_WORKSPACE`. Durable handoff files go in `AGENTFLOW_OUTPUT_DIR` and must be declared in `artifacts`.

Agent harness prompts tell the model it is executing one node in a graph, list declared artifacts with their descriptions, and explain that the final response is captured as reserved `agent_response`. Treat `agent_response` as a concise narrative handoff, not a replacement for a declared structured artifact.

## Primitive Fields

### `agent`

Required:

- `type: "agent"`
- `id`
- `prompt`

Optional:

- `model`
- `reasoning_effort`
- `sandbox`

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
agentflow compile --graph <path>
```

Fix validation first. Use `--run-ready` when the user needs proof that this machine has required runtime tools, repo worktrees, node commands, and harness binaries. Use compile output to inspect lowered managed patterns, profile resolution, dependency edges, repeat scopes, and artifact references.
