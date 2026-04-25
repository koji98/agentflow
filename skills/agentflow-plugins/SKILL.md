---
name: agentflow-plugins
description: Use when creating, reviewing, resolving, or consuming Agentflow plugin workflows or plugin-bundled CLI tools, including workflow manifests, lockfiles, tool capability, and tool impact policy.
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
4. Declare tool `capability` and `impact`.
5. Use plugin `credentials` plus `agentflow auth` for secret-impact tools; keep `tool_config` for non-secret options only.
6. Keep tool config schemas string-only and reject secrets such as tokens, passwords, or API keys.
7. Run `agentflow plugin resolve --graph <path>`.
8. Run `agentflow validate --graph <path> --run-ready`.
9. Inspect `validate --show-compiled` for workflow lowering and tool policy.

## Authoring Posture

- Plugins do not create new primitive node kinds.
- Plugin workflows lower into normal graph nodes.
- Plugin tools are ordinary CLIs launched inside the node sandbox.
- Plugin `tool_config` is for non-secret options only; use credential scopes for anything sensitive.
- Secret credential values are resolved only by generated tool launchers and are not exported into Codex or Cursor harness environments.
- Downstream graph nodes consume only public plugin node artifacts.
