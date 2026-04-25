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
- `delivery`
- `prerequisites`
- `plugins`
- `tools`
- `tool_config`
- `config_schema`
- `config`

## Intent

```json
{
  "goal": "Ship checkout timeout handling.",
  "scope": {
    "paths": ["src/checkout/**", "tests/checkout/**"],
    "out_of_scope": ["provider migration"]
  },
  "constraints": ["Keep public APIs stable."],
  "acceptance_criteria": ["Timeouts return typed errors.", "Tests cover retry behavior."],
  "approval_boundaries": ["Do not modify payment provider configuration."]
}
```

`intent.goal` is required. Approval boundaries are required when the graph exposes external-impact tools. Use top-level `repos` for local checkout bindings and top-level `profiles` for harness authority; `intent.scope` is governance, not a replacement for executable `repo` or `profile` settings.

Executable nodes can also carry intent:

```json
{
  "type": "agent",
  "id": "implement_timeout",
  "repo": "main",
  "profile": "coder",
  "goal": "Implement timeout handling and publish reviewer evidence.",
  "acceptance_criteria": ["Tests pass.", "The handoff names changed files and risks."]
}
```

Agent nodes require either `prompt` or `goal`. When `prompt` is omitted, `goal` becomes the executable task prompt. Node goals and acceptance criteria are rendered to Codex CLI and Cursor CLI prompts, supervisor repair prompts, and resume fingerprints.

## Supervision

Allowed action kinds:

- `retry_node`
- `repair_artifact`
- `rebuild_context`
- `refresh_workspace`
- `run_diagnostic`
- `semantic_evaluation`
- `escalate`

Retry budget fields:

- `max_total_interventions`
- `max_node_retries`
- `max_artifact_repairs`
- `max_context_rebuilds`
- `max_workspace_refreshes`
- `max_diagnostic_runs`
- `max_semantic_evaluations`

Escalation fields:

- `require_human_on_policy_breach`
- `require_human_on_scope_drift`

## Delivery

```json
{
  "required_sections": [
    "task_brief",
    "implementation_summary",
    "grouped_change_map",
    "decision_log",
    "evaluation_ledger",
    "reviewer_guide",
    "risk_notes",
    "follow_up_items",
    "intervention_trace"
  ]
}
```

## Nodes

Executable node kinds:

- `agent`
- `exec`
- `check`
- `checkpoint`

Container node kinds:

- `sequence`
- `parallel`
- `repeat`

Managed pattern node kinds:

- `pattern_deep_research`
- `pattern_spec_design`
- `pattern_generate_evaluate_fix`
- `pattern_review_change`

## Context

Context item sources:

- `text`
- `workspace_file`
- `workspace_glob`
- artifact references with `ref`, `node`, and `artifact`

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

Tool exports declare `capability` and `impact`.

Capabilities: `context`, `verification`, `mutation`, `reporting`.

Impacts: `read`, `write`, `external`, `secret`.

Validation enforces:

- mutation tools and write-impact tools are withheld from read-only agents
- secret-impact tools require plugin-declared `credentials`
- external-impact tools require exact tokens in `intent.approval_boundaries`, such as `tool:<callable>` or `external:<plugin>/<tool>`
- `tool_config` is for non-secret string options and is resolved only inside the plugin tool subprocess
