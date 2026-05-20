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
agentflow validate --graph agentflow.graph.json --strict
agentflow validate --graph agentflow.graph.json --show-compiled
agentflow validate --graph agentflow.graph.json --output-dir .agentflow/validation/latest
agentflow validate --graph agentflow.graph.json --diagram-output graph.mmd
agentflow validate --graph agentflow.graph.json --diagram-image-output graph.svg
agentflow validate --graph agentflow.graph.json --diagram-image-output graph.svg --diagram-image-package @mermaid-js/mermaid-cli@latest
```

Default `validate` is the launch preflight. It checks authored graph normalization, launch profile/workspace resolution, compilation, full authoring review, local repo/command/harness readiness, plugin tool help, credential references, and context pointer/provenance analysis without launching a run or mutating workspace files.

- `--strict`: fail validation when serious authoring review findings are present.
- `--show-compiled`: does the compiled primitive graph match the operator's intent?
- `--output-dir`: write a validation package with compiled graph, Mermaid, review, readiness, and context files.
- `--diagram-output`: write a Mermaid diagram for the resolved compiled graph, scopes, artifacts, checks, supervision, and delivery surface.
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
- Harness-native config is isolated by default. Declare Codex MCP/plugins or Cursor config/permissions in `profiles.*.harness_config` when they are part of the intended run; use `isolation: "inherit_user"` only when accepting non-reproducible local harness behavior.
- `model: "auto"` leaves model selection to the configured harness. It does not switch between Codex CLI and Cursor CLI; choose the harness through `profiles`.
- `checkpoint` nodes are planned human gates inside repeat bodies; they prompt on a TTY when reached and feed pass, deny, or abort back into the graph.
- Supervisor authority pauses are not graph nodes; they require a typed runtime `AuthorityRequest`. Local context, validation, artifact, workspace, graph-contract, repo/sandbox/scope, and recoverable environment failures recover autonomously or fail with evidence instead of asking a human.
- Terminal runs write the delivery package after run completion.

For the implementation flow behind launch, node attempts, context pointer resolution, generated runtime tooling, supervision, and delivery, see `../technical/runtime-lifecycle.md`.

## Progress Events

Terminal progress uses fixed status labels such as `RUN`, `PASS`, `FAIL`, `BLOCK`, `SKIP`, and `CANCEL` for node lifecycle lines.
Verification, repeat, supervisor, managed-pattern, and delivery updates are indented one level under the active flow so they scan as supporting events rather than additional graph depth.
TTY-like streams use gated color for status labels and muted metadata; pipes, CI logs, `NO_COLOR`, and `TERM=dumb` stay deterministic plain text.
Verification is visible as its own phase so transient verifier/check substrate failures are distinguishable from worker failures.

Important event types:

- `run.started`
- `node.started`
- `node.completed`
- `node.failed`
- `check.completed`
- `verification.started`
- `verification.retry`
- `verification.completed`
- `supervisor.decision`
- `supervisor.intervention.started`
- `supervisor.intervention.completed`
- `supervisor.intervention.failed`
- `supervisor.paused`
- `run.completed`
- `delivery.curation.started`
- `delivery.curation.completed`
- `delivery.curation.failed`
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
- delivery package manifest and review brief paths
- delivery artifact taxonomy counts when the delivery manifest is available
- recent events

Manual files worth opening:

- `<run-root>/events.jsonl`
- `<run-root>/interventions.jsonl`
- `<run-root>/delivery/manifest.json`
- `<run-root>/delivery/01-review-brief.md`
- `<run-root>/delivery/02-run-learnings.md`
- `<run-root>/delivery/03-audit-index.md`
- `<run-root>/delivery/evidence/validation-ledger.json`
- `<run-root>/summary.md`

Runtime coordination files are under `<run-root>/runtime/`. They are useful when debugging worker evidence and helper sub-nodes:

- `milestones/<execution>.json`: worker milestones and attached finding, decision, and validation evidence.
- `helpers/<helper-id>/session.json`: helper lifecycle, logs, and artifact paths.
- `observations.jsonl`: live human observations added without pausing the run.
- `human-resume-input.jsonl`: structured human input used when resuming paused runs.

Agents should orient with `af orient`, understand any provided plan/research/context before committing to execution milestones, publish durable results with `af artifact write <name>` from stdin, check mechanical readiness with `af complete check`, and record milestone evidence with `finding`, `decision`, and `validation` logs. A completed agent is not an online collaborator; inspect its artifacts, completion packet, milestone state, observations, and supervisor timeline rather than expecting live intervention.

On retries, `af orient` starts with retry orientation and runtime-authored attempt memory. It tells the agent the prior failure symptom, best resume point, restart boundary, workspace decision, progress to reuse, progress to discard, required next action, validation gate, and do-not-redo guidance before showing the unchanged contract. Use this instead of asking the agent to rediscover the entire prior attempt from raw logs.

Operators can add non-pausing live feedback with:

```bash
agentflow observe add --run <run-root> --kind observation --summary "Reviewer note"
agentflow observe add --run <run-root> --kind blocker --summary "Backend worker unavailable" --blocking --blocked-on backend-worker
agentflow observe resolve --run <run-root> --observation <id> --resolution "Worker restored"
```

`af orient` and `af complete check` surface active observations relevant to the current node. Observations are evidence, not graph edits; they do not change acceptance criteria, repo authority, sandbox, or declared artifacts.

When debugging what an agent actually received, use `../technical/context-and-artifacts.md` and `../technical/runtime-tooling.md` to map the agent context brief, runtime context state, generated wrappers, tool invocation ledgers, and credential isolation. `agentflow validate --graph <path>` reports context analysis before launch when a graph has broad globs, large docs, generated trees, unresolved context pointers, missing CLI hints, or managed tool readiness issues.

## Resume

```bash
agentflow resume --run-root <run-root>
agentflow resume --run-root <run-root> --dry-run
agentflow resume --run-root <run-root> --reset-supervisor-budget
agentflow resume --graph agentflow.graph.json --latest
```

Resume revalidates the current graph, recompiles it, and compares the new contract with the prior run.

Completed work is preserved only when the node contract and graph-level `intent` and `supervision` contracts remain compatible. Node contracts include prompt-affecting support such as context pointers, skills, CLI hints, managed tool grants/config, declared artifacts, policy, commands/checks, and managed lowering metadata. If the human contract or supervision contract changes, affected completed work restarts so the final evidence matches the current graph.

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
- Use managed pattern evaluation when the evaluation loop is part of a reusable authored workflow, such as `pattern_deep_work`.
- Use `agentflow eval` for offline workflow suites that compare scenarios, variants, and repeated trials with required criteria, quality criteria, trajectory checks, and deterministic environment simulation. It follows Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), adopts useful ADK eval mechanics, and writes `.agentflow/evals` artifacts, including `eval-run.json`, `evaluation-ledger.json`, trial `trace-packet.json`, `scorecard.json`, `benchmark.json`, and `report.md`; exit status follows infrastructure failures and `benchmark.threshold_passed`.

## Run Eval Suites

Use `evals.md` as the canonical eval guide. The operational loop is:

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

Use simulated sentinels as regression gates, not as release proof. Release-confidence claims require:

```bash
npm run validate:release-confidence
```

That command runs the standard checks, validates the sentinel suite, and runs all five validation sentinels with three trials. Do not claim production or release confidence from unit tests, build output, smoke validation, prompt validation, or simulated sentinel runs alone.

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

1. `delivery/01-review-brief.md`
2. `delivery/02-run-learnings.md`
3. `delivery/03-audit-index.md` only when debugging or auditing raw evidence
4. evidence files named by `delivery/manifest.json`
5. internal runtime artifacts only for resume debugging, failed repair diagnosis, or low-level audit

The review brief is the primary human handoff: outcome, reviewer decision, success contract, changed files, final declared artifacts, validation evidence, active risks, recovered issues, and intervention summary. Run learnings capture future improvements for workspace docs, tests, scripts, graph shape, prompts, skills, tools, plugins, and evals. Both files are curated by a required read-only delivery curator and verified against deterministic evidence. The audit index maps runtime context state, tool ledgers, milestones, supervisor timeline, and runtime logs without making them the default review path.

`delivery/manifest.json` keeps semantic machine keys for human entrypoints and evidence files. `delivery/evidence/delivery-source.json` is the deterministic source packet and `delivery/evidence/curation-verdict.json` is the trust check for the curated Markdown. Generated human-facing Markdown files use numeric prefixes so local file browsers present the review order clearly. Treat missing or failed curated delivery as a failed run quality signal even if code changes exist.

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

`validate:smoke` runs lightweight package checks and exercises the built CLI against the repeat fixture across Codex CLI, Cursor CLI, `inplace`, and `worktree` combinations. It does not rerun the full `npm test` suite.
