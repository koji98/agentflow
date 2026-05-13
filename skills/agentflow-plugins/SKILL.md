---
name: agentflow-plugins
description: Use when creating, reviewing, resolving, or consuming Agentflow plugin workflows or plugin-bundled CLI tools, including workflow manifests, lockfiles, tool config, and credential policy.
---

# Agentflow Plugins

Plugins package reusable team workflows and CLI tools for supervised Agentflow runs. They resolve from Git or local folders, pin through `agentflow.plugins.lock.json`, and compile into normal Agentflow runtime behavior.

## Must Know

- Prefer native repo/device CLIs for simple one-tool work that agents can discover with `--help`.
- Prefer a plugin when the capability composes multiple CLIs, normalizes fragile sequences, needs credential isolation, needs stable JSON I/O, or should be reused across graphs.
- Tool `--help` is the agent-facing API contract.
- Tool implementation can be shell-native or language-backed; choose based on complexity, parsing needs, tests, dependencies, and portability.
- Name plugins by domain/capability, and name exports narrowly enough to avoid collisions with native CLIs, reserved runtime commands, and other plugin tools.
- Secrets belong in plugin credential scopes and `agentflow auth`, never inline graph config.
- Plugin workflows publish stable public artifacts from one `publish_node`; consumers should not depend on generated internal node ids.
- A plugin is not complete until it resolves and validates from a consumer graph.

## Route By Task

- Need workflow plugin layout, manifests, `plugin_file`, `plugin://`, config, lockfiles, or public artifacts: read [references/plugin-workflows.md](references/plugin-workflows.md).
- Need graph primitives or node contracts: use `agentflow-authoring`.
- Need validation, launch, supervision, delivery, or run behavior: use `agentflow-operations`.
- Need to decide whether a completed run should become a plugin: use `agentflow-run-review`.

## Default Workflow

1. Decide native CLI, primitive graph, workflow plugin, tool plugin, or combined package.
2. Use native CLIs for simple single-command behavior; use plugins for reusable behavior, multi-CLI composition, auth isolation, stable I/O, policy, or auditability.
3. Keep workflow config small and schema-backed.
4. Expose public artifacts from one `publish_node`.
5. Declare a clear tool `description`; put detailed CLI usage in the executable's `--help`.
6. Use plugin `credentials` plus `agentflow auth` for tools that need auth; keep inline `tools[].config` for non-secret graph-provided defaults only.
7. Keep tool config schemas string-only and reject secrets such as tokens, passwords, or API keys.
8. Implement credential-free, side-effect-free executable `--help` for every plugin tool.
9. Run `agentflow plugin resolve --graph <path>`.
10. Run `agentflow validate --graph <path>`.
11. Run `agentflow validate --graph <path> --strict` when the plugin graph is team-owned or release-bound.
12. Use `agentflow validate --graph <path> --show-compiled` when the compiled graph needs inspection.
13. Inspect `validate --show-compiled` for workflow lowering and tool policy; use `--diagram-output` or `--diagram-image-output` when reviewing nontrivial workflow expansion.

## Authoring Posture

- Plugins do not create new primitive node kinds.
- Plugin workflows lower into normal graph nodes.
- Plugin tools are ordinary CLIs launched inside the node sandbox.
- A plugin tool may wrap one CLI, but it is often most valuable when it composes several CLIs into one stable capability that agents should not reimplement every run.
- Plugin ids, workflow ids, and tool aliases should be stable, domain-based, and descriptive; avoid generic names like `run`, `check`, `deploy`, `poll`, or `sync` unless the plugin domain makes the generated callable unambiguous.
- Plugin `tools[].config` is for non-secret graph-provided defaults only; use credential scopes for anything sensitive.
- Tool launchers expose graph config to the plugin subprocess as `AGENTFLOW_TOOL_<CALLABLE_NAME>_<KEY>` environment variables.
- Tool `config_schema` validates those graph config defaults; it is not the tool's CLI argument schema.
- Plugin manifests do not declare default CLI arguments; agents pass CLI arguments when invoking the generated callable tool.
- Secret credential values are resolved only by generated tool launchers and are not exported into Codex or Cursor harness environments.
- Tool `--help` is the detailed API contract agents should read before first use.
- Shell tools are good for thin orchestration; language-backed tools are better for parsing, validation, structured output, and nontrivial logic.
- Downstream graph nodes consume only public plugin node artifacts.
