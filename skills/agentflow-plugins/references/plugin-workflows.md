# Plugin Workflows And Tools

Plugins provide reusable workflows and supervised CLI tool capabilities.

## Consumer Declaration

```json
{
  "plugins": {
    "team": {
      "source": "git@github.com:acme/agentflow-plugin.git",
      "ref": "v1.0.0"
    }
  }
}
```

Local folders are also first-class:

```json
{
  "plugins": {
    "team": {
      "path": "../agentflow-plugin"
    }
  }
}
```

Resolve:

```bash
agentflow plugin resolve --graph agentflow.graph.json
```

## Workflow Node

```json
{
  "type": "plugin",
  "id": "prepare_release",
  "uses": "team/release-prep",
  "config": {
    "test_command": "npm test"
  }
}
```

The plugin node id is the public handoff boundary. Downstream nodes reference `prepare_release.<artifact>`.

## Package Layout

```text
agentflow.plugin.json
workflows/
  release-prep/
    workflow.json
    config.schema.json
    workflow.graph.json
    context/
      worker-guide.md
    scripts/
      verify.sh
```

Minimal `agentflow.plugin.json`:

```json
{
  "schema": "agentflow.plugin/1",
  "id": "team-tools",
  "version": "1.0.0",
  "credentials": {
    "github": {
      "description": "GitHub API access.",
      "fields": {
        "token": {
          "secret": true,
          "description": "Token resolved only inside plugin tool subprocesses."
        }
      }
    }
  },
  "workflows": {
    "release-prep": {
      "path": "workflows/release-prep/workflow.json",
      "description": "Prepare a release readiness package."
    }
  },
  "tools": {
    "poll": {
      "executable": "tools/poll-pr.sh",
      "description": "Poll a pull request and print a JSON status object.",
      "credentials": ["github"],
      "config_schema": {
        "type": "object",
        "properties": {
          "poll_interval_ms": { "type": "string" }
        },
        "additionalProperties": false
      }
    }
  }
}
```

Workflow manifest fields:

- `schema: "agentflow.workflow/1"`
- `id`
- optional `config_schema`
- `graph`
- `publish_node`
- `published_artifacts`

Minimal `workflow.json`:

```json
{
  "schema": "agentflow.workflow/1",
  "id": "release-prep",
  "config_schema": "./config.schema.json",
  "graph": "./workflow.graph.json",
  "publish_node": "package_release",
  "published_artifacts": {
    "release_handoff": {
      "from": "output_dir",
      "path": "release-handoff.md",
      "description": "Release readiness handoff produced by the workflow."
    }
  }
}
```

## Packaged Files

- `context.from = "plugin_file"` injects plugin-owned text context.
- Plain relative paths such as `./context/guidance.md` resolve inside the workflow directory.
- `plugin://...` resolves from the plugin package root, which lets workflow graphs reuse package-level scripts and shared context files directly.
- `{{config.key}}` interpolates workflow config.

## Tool Exports

Tools are CLIs. Each export declares:

- `executable`
- `description`
- optional `config_schema` for non-secret graph `tools[].config` defaults
- optional `credentials`

The graph-visible callable name is derived from the declaration alias or `plugin-tool`.

Policy:

- declaring a tool in the graph or agent node is the operator approval to expose that CLI to the agent
- tools share the node sandbox and timeout
- credential values are configured through `agentflow auth`, stored in macOS Keychain for secret fields, and injected only into the plugin tool subprocess
- inline `tools[].config` values are not exported into the agent harness environment; the generated launcher resolves them only for the plugin tool subprocess
- inline `tools[].config` accepts non-secret graph-provided defaults only; secret-looking keys such as `token`, `secret`, `password`, or `api_key` belong in plugin `credentials`
- `config_schema` validates graph config defaults; it is not the tool's CLI argument schema
- graph config values are exposed to the tool subprocess as `AGENTFLOW_TOOL_<CALLABLE_NAME>_<KEY>` environment variables, with non-alphanumeric characters converted to `_`
- default CLI arguments are not declared in the manifest; the executable defines its own interface, and agents pass arguments when invoking the callable tool
- every plugin tool executable must support credential-free, side-effect-free `--help` that exits `0` and includes purpose, usage, options, defaults, output, exit codes, and examples
- `agentflow validate --graph <path> --run-ready` executes resolved plugin tools with `--help` and blocks launch if the help contract fails

For the generated wrapper, launcher, credential isolation, harness prompt, and tool invocation ledger mechanics, see `docs/technical-implementation/runtime-tooling.md` in the repository.

## Validate

```bash
agentflow plugin resolve --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json --run-ready
agentflow validate --graph agentflow.graph.json --show-compiled
```
