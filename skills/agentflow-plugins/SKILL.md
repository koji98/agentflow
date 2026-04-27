---
name: agentflow-plugins
description: Use when creating, reviewing, resolving, or consuming Agentflow plugin workflows or plugin-bundled CLI tools, including workflow manifests, lockfiles, tool config, and credential policy.
---

# Agentflow Plugins

Plugins package reusable team workflows and CLI tools for supervised Agentflow runs. They resolve from Git or local folders, pin through `agentflow.plugins.lock.json`, and compile into normal Agentflow runtime behavior.

## Route By Task

- Need workflow plugin layout, manifests, `plugin_file`, `plugin://`, config, lockfiles, or public artifacts: read [references/plugin-workflows.md](references/plugin-workflows.md).
- Need graph primitives, supervision, delivery, or run behavior: use `agentflow`.

## Default Workflow

1. Decide whether this is reusable team behavior. Use primitives for one-off graphs.
2. Keep workflow config small and schema-backed.
3. Expose public artifacts from one `publish_node`.
4. Declare a clear tool `description`; put detailed CLI usage in the executable's `--help`.
5. Use plugin `credentials` plus `agentflow auth` for tools that need auth; keep inline `tools[].config` for non-secret graph-provided defaults only.
6. Keep tool config schemas string-only and reject secrets such as tokens, passwords, or API keys.
7. Implement credential-free, side-effect-free executable `--help` for every plugin tool.
8. Run `agentflow plugin resolve --graph <path>`.
9. Run `agentflow validate --graph <path> --run-ready`.
10. Run `agentflow validate --graph <path> --review` or `--strict-review` when the plugin graph is team-owned or release-bound.
11. Inspect `validate --show-compiled` for workflow lowering and tool policy; use `--diagram-output` or `--diagram-image-output` when reviewing nontrivial workflow expansion.

## Authoring Posture

- Plugins do not create new primitive node kinds.
- Plugin workflows lower into normal graph nodes.
- Plugin tools are ordinary CLIs launched inside the node sandbox.
- Plugin `tools[].config` is for non-secret graph-provided defaults only; use credential scopes for anything sensitive.
- Tool launchers expose graph config to the plugin subprocess as `AGENTFLOW_TOOL_<CALLABLE_NAME>_<KEY>` environment variables.
- Tool `config_schema` validates those graph config defaults; it is not the tool's CLI argument schema.
- Plugin manifests do not declare default CLI arguments; agents pass CLI arguments when invoking the generated callable tool.
- Secret credential values are resolved only by generated tool launchers and are not exported into Codex or Cursor harness environments.
- Tool `--help` is the detailed API contract agents should read before first use.
- Downstream graph nodes consume only public plugin node artifacts.
