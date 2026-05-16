# Plugin Workflows And Tools

Plugins provide reusable workflows and supervised CLI tool capabilities.

## Decision Model

Use native repo/device CLIs when the task is simple, local, discoverable with `--help`, and does not need special auth or stable reusable output.

Use a plugin when it adds one or more of:

- reusable team workflow;
- composition of multiple CLIs into one reliable capability;
- credential isolation through Agentflow auth;
- stable JSON/text output for downstream agents;
- policy boundary for external services or mutations;
- auditability through a shared tool contract.

Do not create a plugin just to hide a mature CLI. Do create a plugin when the agent would otherwise have to remember a fragile multi-command sequence, merge outputs from several tools, or handle credentials directly.

## Naming And Collision Policy

Name plugins by domain and capability, not by implementation detail.

Good plugin ids:

- `github-pr-ops`
- `release-readiness`
- `customer-import`
- `terraform-plan-review`

Weak plugin ids:

- `tools`
- `helpers`
- `scripts`
- `utils`

Export names should be short but specific inside the plugin domain:

- Workflow ids: `prepare-release`, `poll-pr`, `review-plan`.
- Tool aliases: `pr-status`, `render-report`, `validate-import`.
- Credential scopes: `github`, `jira`, `aws-prod-readonly`.

Avoid names that collide with:

- reserved Agentflow commands such as `af`;
- common shell commands such as `git`, `npm`, `node`, `python`, `test`, `check`, `run`;
- other plugin exports likely to be used in the same graph.

Agentflow derives graph-visible callable names from the plugin declaration and tool alias, so a domain-specific plugin id plus a specific alias gives agents readable commands without hiding the capability. Prefer `github-pr-ops/pr-status` over a generic `team/poll`.

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

- `kind: "plugin_file"` injects plugin-owned text context and requires `name`, `path`, `what`, and `why`.
- Plain relative paths such as `./context/guidance.md` resolve inside the workflow directory.
- `plugin://...` resolves from the plugin package root, which lets workflow graphs reuse package-level scripts and shared context files directly.
- `{{config.key}}` interpolates workflow config.

## Tool Exports

Tools are CLIs. Each export declares:

- `executable`
- `description`
- optional `config_schema` for non-secret managed tool `config` defaults
- optional `credentials`

The graph-visible callable name is derived from the declaration alias or `plugin-tool`.

## Tool Implementation Choice

Plugin tools can be shell-native or language-backed.

Use a shell-native tool when:

- the tool is mostly orchestration of existing CLIs;
- argument parsing is minimal;
- output can be produced reliably with simple shell;
- portability requirements are clear;
- the failure modes are easy to express with exit codes and stderr.

Use a language-backed tool when:

- the tool parses JSON, HTTP responses, logs, or complex stdout;
- the tool composes multiple CLIs with branching behavior;
- output should be stable JSON for downstream agents;
- validation, retries, timeouts, or normalization are nontrivial;
- unit tests would materially reduce risk.

For language-backed tools, keep the shell executable as a thin launcher that invokes the checked-in implementation:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/poll-pr.mjs" "$@"
```

The launcher should not hide errors, swallow stderr, or rewrite the language tool's contract. The language implementation should own `--help`, argument validation, output format, and exit codes.

## Tool CLI Contract

Every plugin tool should have a predictable contract:

- `--help` is credential-free, side-effect-free, exits `0`, and documents the complete interface.
- Normal machine-readable output goes to stdout.
- Human diagnostics and warnings go to stderr.
- Exit `0` means success and output is parseable according to the documented contract.
- Nonzero exits mean no consumer should trust stdout unless the help text explicitly documents partial output.
- Prefer stable JSON for outputs that downstream agents or checks consume.

Help output template:

```text
Purpose:
  Poll a GitHub pull request and print a JSON status object.

Usage:
  babysit-poll --pr-url <url> [--timeout-ms <ms>]

Options:
  --pr-url <url>       GitHub pull request URL.
  --timeout-ms <ms>    Poll timeout in milliseconds. Default: 60000.
  --help              Show this help.

Configured defaults:
  poll_interval_ms: 15000

Output:
  JSON on stdout:
  {"status":"success|pending|failed","pr_url":"...","checks":[]}

Exit codes:
  0  Poll succeeded and stdout is valid JSON.
  1  Invalid arguments.
  2  Remote service or auth failure.
  3  Timeout.

Examples:
  babysit-poll --pr-url https://github.com/acme/repo/pull/123
```

Policy:

- declaring a tool in the graph or agent node is the operator approval to expose that CLI to the agent
- tools share the node sandbox and timeout
- credential values are configured through `agentflow auth`, stored in macOS Keychain for secret fields, and injected only into the plugin tool subprocess
- managed tool `config` values are not exported into the agent harness environment; the generated launcher resolves them only for the plugin tool subprocess
- managed tool `config` accepts non-secret graph-provided defaults only; secret-looking keys such as `token`, `secret`, `password`, or `api_key` belong in plugin `credentials`
- `config_schema` validates graph config defaults; it is not the tool's CLI argument schema
- graph config values are exposed to the tool subprocess as `AGENTFLOW_TOOL_<CALLABLE_NAME>_<KEY>` environment variables, with non-alphanumeric characters converted to `_`
- default CLI arguments are not declared in the manifest; the executable defines its own interface, and agents pass arguments when invoking the callable tool
- every plugin tool executable must support credential-free, side-effect-free `--help` that exits `0` and includes purpose, usage, options, defaults, output, exit codes, and examples
- `agentflow validate --graph <path>` executes resolved plugin tools with `--help` and blocks launch if the help contract fails

For the generated wrapper, launcher, credential isolation, harness prompt, and tool invocation ledger mechanics, see `docs/technical/runtime-tooling.md` in the repository.

## Validate

```bash
agentflow plugin resolve --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json --show-compiled
```
