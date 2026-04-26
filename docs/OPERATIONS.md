# Operations

This guide covers the operational loop for supervised Agentflow runs: validate, launch, inspect, resume, and review the delivery package.

## Local Setup

```bash
npm install
npm run build
```

For source-mode development, use `npm run <script> -- ...`. For packaged CLI checks after build, use `node dist/cli/index.js ...` or the linked `agentflow` binary.

The package also includes `af`, but that command is for agents inside a running node. Agentflow injects a generated `af` wrapper into each agent node's `PATH` with `$AGENTFLOW_RUNTIME_METADATA` pointing at that node's runtime contract.

## Validate A Graph

```bash
agentflow validate --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json --run-ready
agentflow validate --graph agentflow.graph.json --show-compiled
```

Use the three validation levels for different questions:

- plain `validate`: is the authored and compiled graph contract valid?
- `--run-ready`: are local repos, commands, env vars, plugin credentials, plugins, and harness binaries ready on this machine?
- `--show-compiled`: does the compiled primitive graph match the operator's intent?

Always inspect `intent`, `supervision`, resolved profiles, managed expansions, plugin tools, and artifact handoffs before launching serious work.

## Resolve Plugins

```bash
agentflow plugin resolve --graph agentflow.graph.json
```

Run this after changing plugin `source`, `ref`, local `path`, workflow files, tool manifests, credential metadata, or graph plugin declarations. The command writes `agentflow.plugins.lock.json` next to the graph. Validation and runtime use the lockfile, Git cache, and local-folder digests.

## Configure Plugin Auth

```bash
printf %s "$GITHUB_TOKEN" | agentflow auth set --scope github --key token --secret --value-stdin
agentflow auth list
```

Secret fields are stored in macOS Keychain and must be supplied with `--value-stdin` so the secret is not placed in the CLI argv. They are not exported into Codex CLI or Cursor CLI harness environments; generated plugin tool launchers resolve them only when starting the plugin tool subprocess.

## Launch

```bash
agentflow run --graph agentflow.graph.json
```

Important launch behavior:

- `workspace_backend: "worktree"` creates isolated git worktrees and cleans them up at terminal state.
- `workspace_backend: "inplace"` runs directly against the configured repo path.
- Codex CLI and Cursor CLI receive the same Agentflow context, `af` runtime CLI, plugin tool, artifact, timeout, and sandbox contract.
- `model: "auto"` leaves model selection to the configured harness. It does not switch between Codex CLI and Cursor CLI; choose the harness through `profiles`.
- Terminal runs write the delivery package after run completion.

Use `--resume-on-fail N` when a local automation should retry the same run root after failure using Agentflow resume semantics.

## Progress Events

TTY progress includes node lifecycle, check results, supervisor decisions, supervisor interventions, escalations, and delivery package completion.

Important event types:

- `run.started`
- `node.started`
- `node.completed`
- `node.failed`
- `check.completed`
- `supervisor.decision`
- `supervisor.intervention.started`
- `supervisor.intervention.completed`
- `supervisor.intervention.failed`
- `supervisor.escalated`
- `run.completed`
- `delivery.package.completed`

## Inspect A Run

```bash
agentflow inspect <run-root>
```

Inspect reports:

- run status and outcome
- supervisor status and intervention count
- failed nodes and stderr tails
- run summary path
- interventions ledger path
- delivery package manifest and reviewer guide paths
- recent events

Manual files worth opening:

- `<run-root>/summary.md`
- `<run-root>/events.jsonl`
- `<run-root>/interventions.jsonl`
- `<run-root>/delivery/manifest.json`
- `<run-root>/delivery/reviewer-guide.md`
- `<run-root>/delivery/evaluation-ledger.json`

Runtime coordination files are under `<run-root>/runtime/`. They are useful when debugging agent-to-agent coordination:

- `channel.jsonl`: typed shared channel messages and delivery notices.
- `mailboxes/<agent-id>.jsonl`: durable direct messages for an agent.
- `helpers/<helper-id>/session.json`: helper lifecycle, logs, output directory, and artifact paths.
- `supervisor-requests.jsonl`: requests recorded through `af supervisor request`.

Agents should publish durable results with `af artifact write` and then notify with `af channel post` or `af parent post`. A completed agent is not an online collaborator; inspect its artifacts or ask the supervisor to resume or replace it.

## Resume

```bash
agentflow resume --run-root <run-root>
agentflow resume --graph agentflow.graph.json --latest
```

Resume revalidates the current graph, recompiles it, and compares the new contract with the prior run.

Completed work is preserved only when the node contract and graph-level `intent`, `supervision`, and `delivery` contracts remain compatible. If the human contract or policy contract changes, affected completed work restarts so the final evidence matches the current graph.

## Delivery Review

At terminal state, review in this order:

1. `delivery/reviewer-guide.md`
2. `delivery/task-brief.md`
3. `delivery/implementation-summary.md`
4. `delivery/risk-notes.md`
5. `delivery/follow-up-items.md`
6. evidence files named by `delivery/manifest.json`
7. internal runtime artifacts only for resume debugging, failed repair diagnosis, or low-level audit

The reviewer guide should explain review order, risk areas, failed checks, supervisor interventions, and follow-up items. `delivery/manifest.json` labels human entrypoints, evidence files, and internal runtime artifacts so operators do not have to guess which files are for review versus resume/debugging. Treat missing or low-quality delivery artifacts as a failed run quality signal even if code changes exist.

## Applying Captured Changes

When a worktree run produced changes that should be moved into another checkout:

```bash
agentflow apply --run-root <run-root> --repo main --target /path/to/checkout
```

Use `--allow-dirty` only when the target checkout's existing changes are intentional. Use `--commit-message` when the application should create a commit in the target checkout.

## Local Validation Before Merge

```bash
npm run typecheck
npm test
npm run build
npm run validate:smoke
```

`validate:smoke` runs the package-level checks and exercises the built CLI against the repeat fixture across Codex CLI, Cursor CLI, `inplace`, and `worktree` combinations.
