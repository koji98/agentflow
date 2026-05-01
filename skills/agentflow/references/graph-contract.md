# Graph Contract

Use graph version `"1"`.

## Top-Level Fields

Required:

- `version`
- `graph_id`
- `intent`
- `graph`

Common:

- `repos`
- `defaults`
- `profiles`
- `supervision`
- `prerequisites`
- `plugins`
- `tools`
- `config_schema`
- `config`

## Intent

```json
{
  "goal": "Ship checkout timeout handling.",
  "constraints": ["Keep public APIs stable.", "Do not modify payment provider configuration."],
  "acceptance_criteria": ["Timeouts return typed errors.", "Tests cover retry behavior."]
}
```

`intent.goal` is required. Use top-level `repos` for local checkout bindings and top-level `profiles` for harness authority; scope boundaries and high-impact limits belong in plain `constraints`.

Executable nodes can also carry intent:

```json
{
  "type": "agent",
  "id": "implement_timeout",
  "repo": "main",
  "profile": "default",
  "goal": "Implement timeout handling and publish reviewer evidence.",
  "acceptance_criteria": ["Tests pass.", "The handoff names changed files and risks."]
}
```

Executable nodes require `goal` and a non-empty `acceptance_criteria` array. This includes `agent`, `exec`, `check`, and `checkpoint`. `constraints` are optional in authored graphs and normalize to `[]`. Node goals, acceptance criteria, and constraints are rendered to Codex CLI and Cursor CLI prompts, deterministic checkpoint diagnostics, supervisor repair prompts, and resume fingerprints.

## Supervision

Fields:

- `max_total_interventions`: total machine-recovery budget for the run.
- `profile`: optional profile name for supervisor evidence gathering, repair, and outcome verification.

When `profile` is omitted, supervisor work inherits the failed node's effective profile. Use a read-only supervisor profile when you only want evidence gathering and verification isolated from worker settings; use a write-capable supervisor profile when artifact or workspace repair should be available. `pause_for_human` is a runtime safety decision, not an authored budget field, and remains distinct from authored `checkpoint` nodes.

## Nodes

Executable node kinds:

- `agent`
- `exec`
- `check`
- `checkpoint`

`checkpoint` is a planned human gate. In this release it belongs inside a `repeat` body so pass, deny, or abort decisions can drive loop control and operator feedback.

Container node kinds:

- `sequence`
- `parallel`
- `repeat`

Managed pattern node kinds:

- `pattern_deep_research`
- `pattern_deep_work`

## Context

Context item sources:

- `text`
- `workspace_file`
- `workspace_glob`
- artifact references with `ref`; Agentflow derives the target node and artifact from `node.artifact`

Artifact references may use `iteration` or `attempt` selectors: `latest`, `latest_passed`, `latest_failed`, `previous`, or a positive integer. Use `if_available: true` when omission is acceptable.

## Artifacts

Artifact sources:

- `output_dir`: file under `$AGENTFLOW_OUTPUT_DIR`
- `workspace`: file under the node workspace

Every artifact declaration needs `description`.

Reserved automatic artifacts:

- `agent_response`
- `verification_json`
- `stdout`
- `stderr`

## Harness Profiles

Supported harnesses:

- `codex-cli`
- `cursor-cli`

Common profile fields:

- `harness`
- `model`
- `reasoning_effort`
- `sandbox`
- `timeout_sec`
- `input_rules`
- `env_files`
- `artifact_repair`
- `deterministic_check_defaults`
- `ai_check_defaults`

Set `model` to a concrete harness-supported model only when the team needs that exact model. Omit it, or use `"auto"`, to let the installed Codex CLI or Cursor CLI choose its default.

Sandboxes: `read-only`, `workspace-write`, `danger-full-access`.

Agents that declare artifacts need a write-capable sandbox.

## Plugin Tools

Tool exports declare `executable` and a clear `description`. Tools that need auth declare `credentials`; optional `config_schema` validates non-secret graph `tools[].config` defaults.

Validation enforces:

- plugin tool callable names do not collide with reserved runtime commands
- credential references point at plugin-declared credential scopes
- inline `tools[].config` is for non-secret graph-provided defaults and is resolved only inside the plugin tool subprocess
- graph config values are exposed to the tool subprocess as `AGENTFLOW_TOOL_<CALLABLE_NAME>_<KEY>` environment variables, with non-alphanumeric characters converted to `_`
- manifests do not declare default CLI arguments; exact CLI usage belongs in the executable's `--help`, and agents pass arguments when invoking the callable tool
- `config_schema` is not the tool's CLI argument schema
