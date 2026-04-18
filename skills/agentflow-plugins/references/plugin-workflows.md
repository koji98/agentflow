# Plugin Workflows

Use plugin workflows when a graph should reuse a team-owned managed graph distributed through Git. A plugin is not a runtime extension point: it lowers into normal Agentflow primitives before compile.

## Consumer Shape

Top-level declaration:

```json
"plugins": {
  "team": {
    "source": "git@github.com:acme/team-agentflow-plugin.git",
    "ref": "v0.1.0"
  }
}
```

Node shape:

```json
{
  "type": "plugin",
  "id": "prepare_change",
  "uses": "team/dev-change-prep",
  "config": {
    "test_command": "npm test"
  }
}
```

Before validate, compile, run, or resume:

```bash
agentflow plugin resolve --graph agentflow.graph.json
```

`plugin resolve` clones the Git source, checks out `ref`, pins the commit, and writes `agentflow.plugins.lock.json` next to the graph. Other commands use the lockfile and local cache; they do not clone implicitly.

## Handoffs

The plugin node id is the public handoff boundary. Downstream nodes read declared public artifacts from that id:

```json
{
  "name": "task_packet",
  "from": "artifact",
  "node": "prepare_change",
  "artifact": "task_packet"
}
```

Do not reference generated internal ids. They are inspectable in compile output but private to the plugin workflow.

## Package Layout

Recommended plugin repo:

```text
agentflow.plugin.json
workflows/
  dev-change-prep/
    workflow.json
    config.schema.json
    workflow.graph.json
    context/
      repo-guide.md
    scripts/
      validate.sh
    skills/
      worker-guidance.md
```

`agentflow.plugin.json` exports workflow ids and paths. Each workflow manifest declares:

- `schema: "agentflow.workflow/1"`
- `id`
- optional `config_schema`
- `graph`: path to a workflow graph node/container
- `publish_node`: internal node that becomes the public plugin node id
- `published_artifacts`: artifact declarations exposed to consumers

## Packaged Files

Inside plugin workflow graphs:

- `context.from = "plugin_file"` embeds a plugin file as normal text context.
- strings beginning with `plugin://` become absolute paths inside the resolved workflow directory.
- config strings can use `{{config.key}}` or `{{config.nested.key}}`.

Use explicit `exec` nodes for setup, teardown, validation, or helper scripts. Agentflow does not run hidden plugin lifecycle hooks.

## Skills And MCPs

Plugins may package skill-like guidance as files and inject it through `plugin_file` context. Use this for:

- instructions that teach generated nodes how to use the plugin
- worker guidance for org-specific workflows

Plugins do not automatically install Agent Skills, enable MCP servers, start sidecars, or add harness-specific tools. If an agent needs guidance, pass it as context. If the workflow needs a helper, package a script and call it with `exec`.

## Guardrails

- Keep plugin config small and schema-backed.
- Use aliases and workflow ids with letters, numbers, underscores, or hyphens.
- Resolve plugins after changing `source`, `ref`, or plugin contents.
- Inspect `managed_expansion` after compile to confirm public artifacts and generated shape.
- Prefer a plugin when reuse and org-specific packaging matter; prefer primitives for one-off workflows.
