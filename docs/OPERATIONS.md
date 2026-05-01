# Operations

This guide covers the operational loop for supervised Agentflow runs: validate, launch, inspect, resume, and review the delivery package.

## Local Setup

```bash
npm install
npm run build
```

For source-mode development, use `npm run <script> -- ...`. For packaged CLI checks after build, use `node dist/cli/index.js ...` or the linked `agentflow` binary.

The package also includes `af`, but that command is for agents inside a running node. Agentflow injects a generated `af` wrapper into each agent node's `PATH` with `$AGENTFLOW_RUNTIME_METADATA` pointing at that node's runtime contract.
Agents can run `af --help` and `af <command> --help` inside a node for the authoritative runtime CLI arguments, defaults, output shape, examples, and safety notes.

## Validate A Graph

```bash
agentflow validate --graph agentflow.graph.json
agentflow validate --graph agentflow.graph.json --review
agentflow validate --graph agentflow.graph.json --strict-review
agentflow validate --graph agentflow.graph.json --run-ready
agentflow validate --graph agentflow.graph.json --show-compiled
agentflow validate --graph agentflow.graph.json --diagram-output graph.mmd
agentflow validate --graph agentflow.graph.json --diagram-image-output graph.svg
agentflow validate --graph agentflow.graph.json --diagram-image-output graph.svg --diagram-image-package @mermaid-js/mermaid-cli@latest
```

Use the validation modes for different questions:

- plain `validate`: is the authored and compiled graph contract valid, and are there standard authoring warnings?
- `--review`: what deeper node-by-node authoring guidance should the operator consider before launch?
- `--strict-review`: should serious authoring review findings fail validation?
- `--run-ready`: are local repos, commands, env vars, plugin credentials, plugin tool `--help` contracts, plugins, and harness binaries ready on this machine?
- `--show-compiled`: does the compiled primitive graph match the operator's intent?
- `--diagram` or `--diagram-output`: what Mermaid diagram represents the resolved compiled graph, scopes, artifacts, checks, supervision, and delivery surface?
- `--diagram-image-output`: can Mermaid CLI render that compiled diagram as an image for review? This uses `npx -y @mermaid-js/mermaid-cli` by default; use `--diagram-image-package` for a specific package spec, or `--diagram-image-renderer mmdc` for an installed local binary.

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
- `checkpoint` nodes are planned human gates inside repeat bodies; they prompt on a TTY when reached and feed pass, deny, or abort back into the graph.
- Supervisor `pause_for_human` is an authority pause, not a graph node; local context, validation, artifact, workspace, and recoverable environment failures should attempt machine recovery before a pause is considered.
- Terminal runs write the delivery package after run completion.

For the implementation flow behind launch, node attempts, context materialization, generated runtime tooling, supervision, and delivery, see `technical-implementation/runtime-lifecycle.md`.

## Progress Events

TTY progress includes node lifecycle, check results, supervisor decisions, supervisor interventions, human pauses, and delivery package completion.

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
- `supervisor.paused`
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
- delivery artifact taxonomy counts when the delivery manifest is available
- recent events

Manual files worth opening:

- `<run-root>/events.jsonl`
- `<run-root>/interventions.jsonl`
- `<run-root>/delivery/manifest.json`
- `<run-root>/delivery/run-map.md`
- `<run-root>/delivery/reviewer-guide.md`
- `<run-root>/delivery/evaluation-ledger.json`
- `<run-root>/summary.md`

Runtime coordination files are under `<run-root>/runtime/`. They are useful when debugging worker evidence and helper sub-nodes:

- `log.jsonl`: structured worker evidence recorded with `af log --type`.
- `helpers/<helper-id>/session.json`: helper lifecycle, logs, output directory, and artifact paths.
- `human-resume-input.jsonl`: structured human input used when resuming paused runs.

Agents should publish durable results with `af artifact write` and record progress, findings, blockers, risks, questions, handoff notes, or major decisions with `af log --type`. Decision logs use `decision`, `rationale`, and `evidence[]` so outcome verification can inspect why the node chose a scope-affecting path. A completed agent is not an online collaborator; inspect its artifacts and supervisor timeline rather than expecting live intervention.

When debugging what an agent actually received, use `technical-implementation/context-and-artifacts.md` and `technical-implementation/runtime-tooling.md` to map context packet files, generated wrappers, tool invocation ledgers, and credential isolation. `agentflow validate --run-ready` also reports real context token analysis; use it before launch when a graph has broad globs, large docs, generated trees, or strict `input_rules.max_total_tokens`.

## Resume

```bash
agentflow resume --run-root <run-root>
agentflow resume --run-root <run-root> --dry-run
agentflow resume --run-root <run-root> --reset-supervisor-budget
agentflow resume --graph agentflow.graph.json --latest
```

Resume revalidates the current graph, recompiles it, and compares the new contract with the prior run.

Completed work is preserved only when the node contract and graph-level `intent` and `supervision` contracts remain compatible. If the human contract or policy contract changes, affected completed work restarts so the final evidence matches the current graph.

Use `--dry-run` before resuming a complicated run. It reports preserved nodes, restarted nodes, initially startable nodes, supervisor status, and remaining budget without reconciling artifacts, creating workspaces, or executing nodes. Use `--reset-supervisor-budget` when the previous run exhausted recovery actions and the operator has changed the graph, environment, credentials, or other blocking condition enough to justify a fresh recovery budget.

Paused runs require explicit human input when actually executing the resume:

```bash
agentflow resume --run-root <run-root> --human-action retry_with_guidance --human-note "Reviewed the policy pause; retry with this constraint."
```

Dry-run previews of paused runs do not require `--human-action` because they do not mutate state or continue execution.

Use this for supervisor pauses. Planned checkpoint prompts are handled during the original TTY run; if a checkpoint deny causes the surrounding repeat to continue, inspect the repeat attempts and operator feedback artifact rather than looking for `human-resume-input.jsonl`.

## Evaluation Lanes

Choose the smallest evaluation lane that matches the question:

- Use graph `check` nodes for in-run sensors that should gate flow or produce delivery evidence.
- Let outcome verification grade passing `agent` attempts against authored acceptance criteria. It writes per-attempt verifier artifacts and routes rejected attempts through supervision.
- Let supervisor `semantic_evaluation` spend intervention budget when a failed AI check or semantic uncertainty needs runtime recovery evidence.
- Use managed pattern evaluation when the evaluation loop is part of a reusable authored workflow, such as `pattern_generate_evaluate_fix`.
- Use `agentflow eval` for offline workflow suites that compare scenarios, variants, and repeated trials with required criteria, quality criteria, trajectory checks, and deterministic environment simulation. It follows Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), adopts useful ADK eval mechanics, and writes `.agentflow/evals` artifacts, including `eval-run.json`, `evaluation-ledger.json`, trial `trace-packet.json`, `scorecard.json`, `benchmark.json`, and `report.md`; exit status follows infrastructure failures and `benchmark.threshold_passed`.

## Run Eval Suites

Use `docs/EVALS.md` as the canonical eval guide. The operational loop is:

```bash
agentflow eval validate evals/agentflow-workflow-quality
agentflow eval run evals/agentflow-workflow-quality --variant current --scenario all --trials 3 --eval-root .agentflow/evals/workflow-quality --concurrency 4
agentflow eval report .agentflow/evals/workflow-quality --format markdown
agentflow eval inspect .agentflow/evals/workflow-quality --scenario missing-dependency-docs --variant current --trial 1
agentflow eval compare .agentflow/evals/workflow-quality --baseline current --candidate terse
```

For prompt/context iteration against larger local repo fixtures:

```bash
npm run setup:eval-repos
agentflow eval validate evals/agentflow-capability-workflows
agentflow eval run evals/agentflow-capability-workflows --variant current --scenario all --trials 1 --eval-root .agentflow/evals/capability-workflows --concurrency 2
```

Run `validate` before `run`; it catches missing scenario files, graph templates, variant files, criteria, rubrics, scripts, and environment fixtures before any expensive harness work starts.

Review eval output in this order:

1. `<eval-root>/report.md`
2. `<eval-root>/benchmark.json`
3. failing trial `scorecard.json`
4. failing trial `criteria-results.json`
5. quality criterion `ai-check-result.json` and `judge-packet.json`
6. trial `trace-packet.json`
7. the underlying Agentflow run root named in `run-root.txt`

For real Codex-backed eval plumbing, run:

```bash
node scripts/validate-real-evals.mjs --harness codex-cli
```

The real validator skips only when `codex-cli` is unavailable. When the binary exists, incomplete artifacts, invalid criteria scorecards, invalid quality output, or incorrect expected behavior fail validation.

## Delivery Review

At terminal state, review in this order:

1. `delivery/reviewer-guide.md`
2. `delivery/task-brief.md`
3. `delivery/implementation-summary.md`
4. `delivery/risk-notes.md`
5. `delivery/follow-up-items.md`
6. `delivery/run-map.md` when you need the run tree explained
7. evidence files named by `delivery/manifest.json`
8. internal runtime artifacts only for resume debugging, failed repair diagnosis, or low-level audit

The reviewer guide should explain review order, risk areas, failed checks, supervisor interventions, and follow-up items. `delivery/manifest.json` includes an `artifact_taxonomy` that labels human entrypoints, declared artifacts, resume-required files, audit trail files, debug-only files, and empty/no-op files so operators do not have to guess which files are for review versus resume/debugging. Treat missing or low-quality delivery artifacts as a failed run quality signal even if code changes exist.

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
