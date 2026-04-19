# Babysit Example Plugin

A small reference plugin showing how to ship a managed workflow alongside a CLI
tool. It backs the `ship-feature.graph.json` example under
`docs/examples/graphs/`.

This plugin packages two surfaces:

- A managed workflow `poll-pr` that runs the bundled `scripts/poll-pr.sh` and
  hands a clean status JSON to a publish agent.
- A CLI tool `poll` that consumer graphs can pull onto an agent's `PATH` as
  `babysit-poll`. The tool reads its GitHub token from
  `AGENTFLOW_TOOL_BABYSIT_POLL_TOKEN`, which Agentflow sets automatically from
  the consumer graph's `tool_config` block.

Layout:

```text
agentflow.plugin.json            # Plugin manifest declaring workflows and tools
scripts/poll-pr.sh               # Backing CLI for both the workflow and the tool
workflows/poll-pr/
  workflow.json                  # Managed workflow contract
  workflow.graph.json            # Workflow graph using plugin://scripts/poll-pr.sh
  config.schema.json             # Workflow config schema
```

## Trying It Locally

Plugin resolution requires the plugin directory to be a Git repository with at
least one commit. To use this example as a real plugin source:

```bash
cd docs/examples/plugins/babysit
git init
git add .
git -c user.email=you@example.com -c user.name="You" commit -m "init babysit example"
```

After that, run `agentflow plugin resolve --graph docs/examples/graphs/ship-feature.graph.json`
from the repository root to pin the plugin in `agentflow.plugins.lock.json`.

In production you would publish this plugin to its own Git repository and point
the consumer graph's `plugins.babysit.source` at that URL.
