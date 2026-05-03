# Plugins

Agentflow plugins package reusable team workflows and CLI tool capabilities. They resolve from Git or local folders, pin through `agentflow.plugins.lock.json`, and compile into normal Agentflow runtime behavior.

Plugins provide two surfaces:

- workflow nodes that lower into primitive graph subgraphs
- tool exports that place vetted CLIs on an agent node `PATH`

## Plugin Resolution

Consumer graph:

```json
{
  "plugins": {
    "team": {
      "source": "git@github.com:acme/agentflow-team-plugin.git",
      "ref": "v1.2.0"
    }
  }
}
```

Local plugin folder:

```json
{
  "plugins": {
    "team": {
      "path": "../agentflow-team-plugin"
    }
  }
}
```

Resolve before validate, run, or resume:

```bash
agentflow plugin resolve --graph agentflow.graph.json
```

Resolution clones Git plugins into `.agentflow/plugins`, checks out the requested ref, pins the commit, and writes `agentflow.plugins.lock.json` next to the graph. Local plugins keep their local path in the lockfile and store content digests so validation can detect changed local files.

## Authoring Checklist

1. Create `agentflow.plugin.json` with `schema`, `id`, `version`, and explicit `workflows`, `tools`, and `credentials` objects.
2. Add workflow exports for reusable graph templates and tool exports for executable team capabilities.
3. Keep workflow config small and schema-backed.
4. Publish workflow handoff artifacts from one `publish_node`.
5. Give every tool a clear `description` and executable `--help` output with arguments, defaults, output format, exit codes, examples, and safety notes.
6. Declare `credentials` for tools that need auth.
7. Keep inline `tools[].config` values non-secret and schema-backed; generated launchers expose them to tool subprocesses as environment strings.
8. Resolve the plugin from a consumer graph and inspect `validate --show-compiled`.

Minimal package:

```text
agentflow.plugin.json
tools/
  poll-pr.sh
workflows/
  release-prep/
    workflow.json
    workflow.graph.json
    config.schema.json
    context/
      release-guide.md
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
          "required": true,
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
      "credentials": [
        "github"
      ],
      "config_schema": {
        "type": "object",
        "properties": {
          "poll_interval_ms": {
            "type": "string"
          }
        },
        "additionalProperties": false
      }
    }
  }
}
```

## Workflow Plugins

Workflow node:

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

The plugin node id is the public handoff boundary. Downstream nodes consume artifacts from `prepare_release.<artifact>`, not generated internal ids.

Recommended workflow package layout:

```text
agentflow.plugin.json
workflows/
  release-prep/
    workflow.json
    config.schema.json
    workflow.graph.json
    context/
      repo-guide.md
    scripts/
      verify.sh
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

Inside workflow graphs:

- `context.from = "plugin_file"` embeds plugin-owned text.
- Plain relative paths such as `./context/guidance.md` resolve inside the workflow directory.
- `plugin://...` strings resolve from the plugin package root, which lets workflows reuse package-level scripts and shared context without wrapper files.
- config placeholders use `{{config.key}}`.

## Tool Plugins

Tool exports let teams expose stable CLI capabilities to agent nodes.

Each tool declares:

- `executable`
- `description`
- optional `config_schema` for non-secret graph `tools[].config` values
- optional `credentials` for secure auth scopes

Plugin tools do not declare default CLI arguments in the manifest. The executable owns its interface, documents it in `--help`, and receives the arguments the agent passes when invoking the generated callable tool.

Example:

```json
{
  "credentials": {
    "github": {
      "description": "GitHub API access.",
      "fields": {
        "token": {
          "secret": true,
          "required": true,
          "description": "GitHub token used only by the plugin tool subprocess."
        },
        "host": {
          "secret": false,
          "required": false,
          "default": "api.github.com"
        }
      }
    }
  },
  "tools": {
    "poll": {
      "executable": "bin/babysit-poll.js",
      "description": "Poll a pull request and print a JSON status object.",
      "credentials": [
        "github"
      ],
      "config_schema": {
        "type": "object",
        "properties": {
          "poll_interval_ms": {
            "type": "string"
          }
        },
        "additionalProperties": false
      }
    }
  }
}
```

Consumer graph:

```json
{
  "tools": [
    {
      "from_plugin": "babysit",
      "tool": "poll",
      "config": {
        "poll_interval_ms": "15000"
      }
    }
  ]
}
```

Runtime behavior:

- Agentflow generates per-execution tool launchers under the node runtime directory.
- The launcher directory is prepended to `PATH` and also contains Agentflow's reserved `af` runtime CLI wrapper. `af` is the completion/runtime contract for the node, not a plugin extension point.
- Agents receive short tool summaries in the prompt and should run `<tool> --help` for authoritative arguments, defaults, output shape, exit codes, examples, and safety notes.
- Tool `--help` must be fast, read-only, credential-free, side-effect-free, and exit `0`.
- Tool help output must include purpose, `Usage:`, arguments/options, defaults, configured defaults with secret-looking values redacted, `Output:`, `Exit codes:`, and `Examples:`.
- `AGENTFLOW_TOOL_<NAME>_<KEY>` env vars carry non-secret tool config only inside the plugin tool subprocess.
- Credential values are not exported to the Codex CLI or Cursor CLI harness environment.
- Generated tool launchers resolve credentials just before starting the plugin tool subprocess and inject `AGENTFLOW_CREDENTIAL_<SCOPE>_<FIELD>` only into that child process.
- Generated tool launchers do not resolve credentials for `--help`; they pass non-secret config defaults and append an `Agentflow configured defaults` section with secret-looking keys redacted.
- The harness prompt includes each tool's description, origin, credential scope names, and configured default keys, but never configured values.
- Tools share the node sandbox and timeout.

For the full implementation flow from compiled tool declaration to generated wrapper, launcher, credential resolution, harness prompt, and invocation ledger, see `../technical/runtime-tooling.md`.

## Auth

Configure credential fields with `agentflow auth`:

```bash
printf %s "$GITHUB_TOKEN" | agentflow auth set --scope github --key token --secret --value-stdin
agentflow auth set --scope github --key host --value api.github.com
agentflow auth list
```

Secret fields are stored in macOS Keychain. Secret values must be supplied through `--value-stdin`, not `--value`, so they do not appear in the CLI argv. The local index at `~/.agentflow/credentials.index.json` stores metadata and non-secret fields only. Auth command output never prints credential values.

## Tool Policy

Tool risk is described in the tool `description` and bounded by graph or node `intent.constraints`.

- Declaring a tool in the graph or agent node is the operator approval to expose that CLI to the agent.
- Tools share the node sandbox and timeout.
- Tools that need auth declare `credentials`; configure those values with `agentflow auth`.
- `af` is a reserved callable name for Agentflow's runtime CLI and cannot be used as a plugin tool alias.
- `tools[].config` is for non-secret graph-provided config values only. It is not a CLI argument schema; exact CLI arguments belong in the tool's own `--help` and are passed by the agent at invocation time. Secret-looking keys such as `token`, `secret`, `password`, or `api_key` are rejected; put those in plugin `credentials` and configure them with `agentflow auth`.

These rules keep tool authority visible in the graph and consistent across Codex CLI and Cursor CLI.

## Validation

Use:

```bash
agentflow plugin resolve --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json --run-ready
agentflow validate --graph agentflow.graph.json --show-compiled
```

Inspect:

- lockfile commit pins
- resolved workflow public artifacts
- generated managed expansion
- plugin tool `--help` readiness under `--run-ready`
- credential references and config policy diagnostics
