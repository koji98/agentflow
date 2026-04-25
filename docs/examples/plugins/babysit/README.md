# Babysit Example Plugin

This is a small plugin used by `docs/examples/graphs/ship-feature.graph.json`.

The demo graph consumes its `poll` tool as `babysit-poll`. The tool is classified as:

- `capability`: `verification`
- `impact`: `secret`

The plugin declares a `github` credential scope. Configure it with:

```bash
printf %s "$GITHUB_TOKEN" | agentflow auth set --scope github --key token --secret --value-stdin
```

Agentflow stores the secret in macOS Keychain and injects it as `AGENTFLOW_CREDENTIAL_GITHUB_TOKEN` only into the plugin tool subprocess. The Codex/Cursor harness environment does not receive the credential value.

The package also includes a `poll-pr` workflow export so plugin workflow authoring has a local example. Workflow nodes lower into normal graph nodes, and downstream consumers read only the public artifacts declared by the workflow manifest.

## Layout

```text
agentflow.plugin.json
scripts/poll-pr.sh
workflows/poll-pr/workflow.json
workflows/poll-pr/workflow.graph.json
workflows/poll-pr/config.schema.json
```

## Trying It Locally

Run from the repository root:

```bash
agentflow plugin resolve --graph docs/examples/graphs/ship-feature.graph.json
agentflow validate --graph docs/examples/graphs/ship-feature.graph.json --run-ready
```
