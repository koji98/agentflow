# Agentflow Graph Contract

Use this as the compact reference for the shipped graph surface.

## Top-level document

Required shape:

- `version`
- `graph_id`
- `repos`
- `defaults`
- `profiles`
- `graph`

Important defaults:

- `defaults.launch_profile` chooses the run launch profile
- `defaults.workspace_backend` chooses `inplace` or `worktree`

Repo rules:

- `--graph` resolves from the shell current working directory
- `repos.<alias>.path` resolves from the graph file directory

Run settings:

- `defaults.launch_profile`
- `defaults.workspace_backend`

The graph owns launch settings. They are not expected to come from CLI overrides.

## Node model

Primitive executable nodes:

- `agent`
- `exec`
- `check`
- `checkpoint`

Authoring containers:

- `sequence`
- `parallel`
- `repeat`

Managed workflows:

- `deep_research`
- `spec_design`
- `execute_spec`
- `review_change`

## Profiles

Profiles hold runtime policy, not control flow.

Typical fields:

- `harness`
- `model`
- `reasoning_effort`
- `sandbox`
- `timeout_sec`
- `input_rules`

Keep graph structure out of profiles.

Important `input_rules` fields:

- `max_total_bytes`
- `max_bytes_per_item`

There is no global `max_files` budget anymore. Keep contexts small by authoring narrower inputs, not by relying on a file-count stop.

## Common executable fields

Executable nodes may define:

- `id`
- optional `label`
- optional `repo`
- optional `profile`
- optional `inputs`
- optional `context_from`
- optional `outputs`
- optional `timeout_sec`

Use node-level `profile` only when one executable node genuinely needs a different runtime policy than the graph default.

## Context

Supported `inputs` kinds:

- `file`
- `glob`
- `text`

Supported `context_from.include` values:

- `summary`
- `result`
- `output`

Guidelines:

- prefer summaries by default
- publish named outputs when downstream nodes need concrete artifacts
- use repo-qualified paths like `ui:src/App.tsx` only when cross-repo reads are intentional
- `glob` inputs are resolved deterministically with root `.gitignore` and `.ignore` filtering plus hard exclusions for `.git`, `.agentflow`, and `node_modules`, but broad globs are still a common source of brittle graphs

`outputs` are the explicit downstream artifact contract. Prefer named outputs over hoping a later node will rediscover files from workspace state.

## Primitive node semantics

- `agent`
  Model-driven work: planning, coding, synthesis, critique, or review.
- `exec`
  Concrete command execution with logs, result, and optional outputs.
- `check`
  Concrete gate. Use deterministic `check` when pass/fail is command-based; use AI `check` when the gate is semantic.
- `checkpoint`
  Operator decision point. This is for intentional human review, not general pause behavior.

## Primitive node fields

### `agent`

Required:

- `type: "agent"`
- `prompt`

Optional node-specific fields:

- `model`
- `sandbox`

### `exec`

Required:

- `type: "exec"`
- `command`

Optional node-specific fields:

- `args`
- `cwd`
- `env`

`exec` does not have an `allow_failure` flag. Soft-failure behavior must be modeled structurally.

### `check`

Required:

- `type: "check"`
- `check_kind`

Deterministic checks use:

- `command`
- optional `args`
- optional `cwd`
- optional `env`
- optional `pass_if`

AI checks use:

- `prompt`
- optional `rubric`
- optional `model`

Supported release `check_kind` values:

- `deterministic`
- `ai`

Supported release `pass_if` forms:

- `{ "exit_code": 0 }`
- `{ "json_path": "$.passed", "equals": true }`

### `checkpoint`

Required:

- `type: "checkpoint"`
- `prompt`
- `review_from`

Release rule:

- `checkpoint` is only valid inside `repeat.body`
- `review_from` must target an upstream output artifact
- checkpoints are interactive operator gates, not passive pauses

## Topology guidance

Default to `sequence`.

Use `parallel` only when branches are genuinely independent and fan-in is explicit.

Use `repeat` only when:

- a descendant `check` or `checkpoint` decides convergence
- bounded repair or revision is actually useful

Every fan-out should have a clear fan-in. Avoid parallel branches that never reconcile into one explicit next step.

Managed workflows are authored shortcuts, not a second runtime model. Use the dedicated managed-workflow skill or docs when the graph includes `deep_research`, `spec_design`, `execute_spec`, or `review_change`.

## Validation

Every meaningful implementation or synthesis boundary should end with:

- a deterministic `check`
- an AI `check`
- or a managed workflow phase that already includes validation

Use `exec` plus a downstream review node instead of a hard `check` when command failure should be investigated and documented rather than immediately terminate the graph.
