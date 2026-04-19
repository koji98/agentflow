---

## name: agentflow-plugins
description: Use when creating, packaging, reviewing, resolving, or consuming Agentflow Git plugin workflows, including plugin nodes, workflow manifests, plugin scripts, plugin_file context, lockfiles, and public artifact handoffs.

# Agentflow Plugins

Use this for Agentflow plugin workflow work. Plugins are Git-distributed reusable managed workflows: they package graph nodes, context files, scripts, templates, and skill-like guidance, then lower into normal Agentflow primitives during validation/compile.

Do not treat plugins as runtime extensions. They do not add new primitive node kinds, hidden lifecycle hooks, MCP sidecars, or auto-installed Agent Skills.

## Route By Task

- Need the plugin graph contract, package layout, `agentflow.plugin.json`, workflow manifests, `plugin_file`, `plugin://`, config schemas, lockfiles, or handoff rules: read [references/plugin-workflows.md](references/plugin-workflows.md).
- Need base graph syntax, primitive nodes, contexts, artifacts, or run behavior: use `agentflow`.

## Default Workflow

1. Decide whether the work needs a reusable team-owned workflow. Prefer primitives for one-off flows.
2. Keep plugin config small, schema-backed, and directly tied to workflow choices.
3. Package guidance as context files and helpers as explicit scripts called by `exec`.
4. Expose only stable public artifacts from the workflow `publish_node`.
5. In consuming graphs, run `agentflow plugin resolve --graph <path>` before `validate`, `run`, or `resume`.
6. Inspect `managed_expansion` after `validate --show-compiled` and never depend on generated internal node ids.

## Authoring Posture

- Use plugins for reusable org-specific workflows, not vague prompt bundles.
- Model setup, teardown, and validation as explicit nodes.
- Put worker instructions in plugin-owned files and inject them with `plugin_file`.
- Use `plugin://` only for files inside the resolved workflow directory.
- Keep downstream handoffs on the public plugin node id.