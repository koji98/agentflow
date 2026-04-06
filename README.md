# Agentflow

Agentflow is a local-first execution engine for coding graphs.

You write a graph JSON file, Agentflow validates it, compiles it into an executable graph, runs it against one or more local repositories, and stores durable artifacts for later inspection.

The intended workflow is:

1. author a graph
2. validate it
3. compile it
4. run it
5. inspect the emitted artifacts

## What Agentflow Does

- Graph-native CLI: `validate`, `compile`, `run`, `resume`, `graph-help`
- Executable node kinds: `agent`, `exec`, `check`
- Container node kinds: `sequence`, `parallel`, `repeat`
- Managed workflows: `deep_research`, `spec_design`, `execute_spec`, `review_change`
- Harness adapters: `codex-cli`, `cursor-cli`
- Workspace backends: `inplace`, `worktree`
- Durable run artifacts under a shared runs root
- CLI-readable compiled contracts, summaries, logs, and run state under those artifacts

## What Agentflow Does Not Do

- It does not execute authored containers directly. The runtime executes compiled graphs only.
- It does not provide a generalized tool plugin system yet.
- It does not support remote devboxes or native non-CLI harnesses in this release.

## Requirements

- Node `>= 20.7.0`
- npm
- Git
- Codex CLI if you want to run agent nodes or AI checks
- Cursor CLI only if you want to use `cursor-cli` profiles

Install dependencies:

```bash
npm install
```

Optional but useful:

```bash
npm run setup:link
```

That lets you use `agentflow ...` directly from the shell. Without linking, use the `npm run ...` commands shown below.

## 2-Minute Quick Start

Inspect the graph contract:

```bash
npm run graph-help
```

Validate the included showcase graph:

```bash
npm run validate -- --graph .tmp/feature-showcase.json
```

Compile it:

```bash
npm run compile -- --graph .tmp/feature-showcase.json
```

Run it:

```bash
npm run run -- --graph .tmp/feature-showcase.json
```

## Included Example Graphs

- [`.tmp/fake-plan.json`](/Users/chidiudeze/Documents/GitHub/agentflow/.tmp/fake-plan.json)
  Small read-only sample with primitive `agent` and deterministic `check` nodes.
- [`.tmp/feature-showcase.json`](/Users/chidiudeze/Documents/GitHub/agentflow/.tmp/feature-showcase.json)
  Broader sample that demonstrates profiles, `sequence`, `parallel`, `repeat`, primitive `agent`, `exec`, deterministic `check`, AI `check`, inputs, context flow, and outputs.
- [`.tmp/deep-research-showcase.json`](/Users/chidiudeze/Documents/GitHub/agentflow/.tmp/deep-research-showcase.json)
  Managed workflow sample showing the implemented `deep_research` node plus a downstream handoff node that consumes the synthesized result.
- [`.tmp/spec-design-showcase.json`](/Users/chidiudeze/Documents/GitHub/agentflow/.tmp/spec-design-showcase.json)
  Managed workflow sample showing the implemented `spec_design` node plus a downstream handoff node that consumes the published design spec.
- [`.tmp/execute-spec-showcase.json`](/Users/chidiudeze/Documents/GitHub/agentflow/.tmp/execute-spec-showcase.json)
  Managed workflow sample showing the implemented `spec_design -> execute_spec` path plus a downstream handoff node that consumes the published implementation handoff.
- [`.tmp/review-change-showcase.json`](/Users/chidiudeze/Documents/GitHub/agentflow/.tmp/review-change-showcase.json)
  Managed workflow sample showing the implemented `execute_spec -> review_change` path plus a downstream handoff node that consumes the final published review.

Important path rule:

- `--graph` resolves from the shell current working directory.
- `$.repos.*.path` resolves relative to the graph file directory.

That is why the sample graphs under `.tmp/` use `"path": ".."` for the main repo.

## Mental Model

### Graph

A graph is the authored execution document.

Top-level fields:

- `version`
- `graph_id`
- `repos`
- `defaults`
- `profiles`
- `graph`

Current graph version:

```json
{ "version": "1" }
```

### Profile

A profile is a reusable execution-policy bundle.

Profiles typically define:

- `harness`
- `model`
- `reasoning_effort`
  Supported values: `none`, `low`, `medium`, `high`, `xhigh`
- `sandbox`
- `timeout_sec`
- `input_rules`

Profiles do not define graph structure.

### Node kinds

Executable node kinds:

- `agent`
- `exec`
- `check`

Container node kinds:

- `sequence`
- `parallel`
- `repeat`

Managed workflow direction:

- `deep_research`
- `spec_design`
- `execute_spec`
- `review_change`

`deep_research`, `spec_design`, `execute_spec`, and `review_change` are implemented now as structured managed workflows that lower into generated primitive subgraphs. Start with [docs/MANAGED_WORKFLOWS.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/MANAGED_WORKFLOWS.md). The concrete contracts for the implementation and review stages are documented in [docs/EXECUTE_SPEC_WORKFLOW.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/EXECUTE_SPEC_WORKFLOW.md) and [docs/REVIEW_CHANGE_WORKFLOW.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/REVIEW_CHANGE_WORKFLOW.md).

### `deep_research`

`deep_research` is the first real managed workflow node.

Required fields:

- `type: "deep_research"`
- `id`
- `question`
- `objective`

Optional fields:

- `label`
- `repo`
- `profile`
- `inputs`
- `context_from`
- `outputs`
- `timeout_sec`
- `audience`
- `sources`
- `deliverable`
- `orchestration`

Current structured sub-objects:

- `sources`
  - `web`
  - `files`
  - `apps`
  - `allow_domains`
  - `deny_domains`
- `deliverable`
  - `format`
  - `citations`
  - `sections`
- `orchestration`
  - `track_count`
  - `max_parallel_tracks`
  - `summary_fan_in`
  - `final_critique`

What it does today:

1. clarifies the research brief
2. plans the work
3. generates track briefs
4. fans out parallel research workers
5. scans for contradictions
6. reduces track summaries through a summary tree
7. synthesizes the final report
8. optionally critiques the final report

The original `deep_research` node id becomes the final synthesis node in the lowered workflow, so downstream nodes can reference it normally through `context_from`.

### `spec_design`

`spec_design` is the second real managed workflow node.

Required fields:

- `type: "spec_design"`
- `id`
- `problem`
- `goal`

Optional fields:

- `label`
- `repo`
- `profile`
- `inputs`
- `context_from`
- `outputs`
- `timeout_sec`
- `audience`
- `constraints`
- `decision_drivers`
- `scope`
- `research_policy`
- `deliverable`
- `orchestration`

Current structured sub-objects:

- `scope`
  - `paths`
  - `areas`
- `research_policy`
  - `repo_first`
  - `allow_web_fallback`
  - `web_triggers`
  - `allow_domains`
  - `max_external_research_tasks`
- `deliverable`
  - `format`
  - `sections`
- `orchestration`
  - `option_count`
  - `max_parallel_options`
  - `critique_roles`
  - `revision_rounds`

What it does today:

1. clarifies the problem
2. inspects the repository
3. assesses whether repo context is sufficient
4. optionally fans out targeted external research tasks
5. synthesizes the design constraints
6. generates parallel design options
7. compares tradeoffs
8. drafts the initial spec
9. runs a bounded critique-and-quality revision loop
10. publishes the final design spec and supporting outputs

The original `spec_design` node id becomes the final published spec node in the lowered workflow, so downstream nodes can reference it normally through `context_from`.

### `execute_spec`

`execute_spec` is the third implemented managed workflow node.

It is implemented now as a structured managed workflow that lowers into a generated primitive subgraph. The fuller contract and design notes live in [EXECUTE_SPEC_WORKFLOW.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/EXECUTE_SPEC_WORKFLOW.md).

The key design choice is that `execute_spec` should require a structured `spec_source`, not a vague prompt.

Required fields:

- `type: "execute_spec"`
- `id`
- `spec_source`

Optional fields:

- `label`
- `repo`
- `profile`
- `inputs`
- `context_from`
- `outputs`
- `timeout_sec`
- `objective`
- `scope`
- `execution_policy`
- `validation`
- `implementation_research`
- `delivery`

Current structured sub-objects:

- `spec_source`
  - `kind: "managed_node"` with `node`
  - `kind: "artifact_bundle"` with `design_spec` and optional supporting references
- `scope`
  - `paths`
  - `areas`
- `execution_policy`
  - `max_repair_rounds`
- `validation`
  - `commands`
  - `required`
- `implementation_research`
  - `allow_official_docs_fallback`
  - `allow_domains`
  - `max_external_lookup_tasks`
- `delivery`
  - `write_change_summary`
  - `write_validation_results`
  - `write_residual_risks`
  - `write_files_touched`
  - `write_implementation_plan`

Supported `spec_source` modes:

- `managed_node`
  - use a prior managed node, usually `spec_design`
- `artifact_bundle`
  - use file-based or external spec artifacts

What it does today:

1. ingest the spec packet
2. assess whether the spec is executable
3. inspect the repo for execution context
4. optionally do narrow implementation research
5. plan execution
6. implement the spec with a single writer
7. run a bounded stabilize-and-validate repair loop
8. publish the final handoff

The original `execute_spec` node id becomes the final published handoff node in the lowered workflow, so downstream nodes can reference it normally through `context_from`.

### `review_change`

`review_change` is the fourth implemented managed workflow node.

It is implemented now as a structured managed workflow that lowers into a generated primitive subgraph. The fuller contract lives in [REVIEW_CHANGE_WORKFLOW.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/REVIEW_CHANGE_WORKFLOW.md).

Required fields:

- `type: "review_change"`
- `id`
- `review_source`

Optional fields:

- `label`
- `repo`
- `profile`
- `inputs`
- `context_from`
- `outputs`
- `timeout_sec`
- `scope`
- `criteria`
- `orchestration`
- `delivery`

Current structured sub-objects:

- `review_source`
  - `kind: "managed_node"` with `node`
  - `kind: "artifact_bundle"` with `diff`, `summary`, `validation_results`, `files_touched`, and `additional_context`
- `scope`
  - `paths`
  - `areas`
- `criteria`
  - `focus`
  - `require_file_references`
- `orchestration`
  - `reviewer_roles`
  - `max_parallel_reviewers`
- `delivery`
  - `write_review_report`
  - `write_findings_json`
  - `write_findings_markdown`

Supported `review_source` modes:

- `managed_node`
  - use a prior managed node, usually `execute_spec`
- `artifact_bundle`
  - use file-based or external review inputs

What it does today:

1. prepares a review packet from the review source and repo state
2. fans out parallel role-based reviewers
3. merges reviewer findings
4. runs a normalization AI gate over the merged result
5. publishes the final prose and machine-readable review

The original `review_change` node id becomes the final published review node in the lowered workflow, so downstream nodes can reference it normally through `context_from`.

### Runs root

Every run writes durable artifacts under a runs root.

Resolution rules:

- If `AGENTFLOW_RUNS_ROOT` is set, it must be an absolute path and CLI commands use it.
- Otherwise Agentflow uses `<launch-cwd>/.agentflow/runs`.

## Minimal Graph

```json
{
  "version": "1",
  "graph_id": "example-graph",
  "repos": {
    "main": { "path": "." }
  },
  "defaults": {
    "launch_profile": "default",
    "workspace_backend": "worktree"
  },
  "profiles": {
    "default": {
      "harness": "codex-cli",
      "sandbox": "read-only"
    }
  },
  "graph": {
    "type": "sequence",
    "id": "root",
    "steps": [
      {
        "type": "agent",
        "id": "inspect_repo",
        "repo": "main",
        "prompt": "Inspect the repository and summarize what it does."
      },
      {
        "type": "check",
        "id": "verify_package",
        "repo": "main",
        "check_kind": "deterministic",
        "command": "node",
        "args": ["-e", "console.log(JSON.stringify({passed:true}))"],
        "pass_if": {
          "json_path": "$.passed",
          "equals": true
        }
      }
    ]
  }
}
```

## CLI Commands

### `graph-help`

Prints the current graph contract and a minimal example.

```bash
npm run graph-help
```

### `validate`

Validates and compiles a graph without running it.

```bash
npm run validate -- --graph ./agentflow.graph.json
```

Use this first whenever you author or change a graph.

### `compile`

Shows the compiled graph contract that the runtime will actually execute.

```bash
npm run compile -- --graph ./agentflow.graph.json
```

Use this when you want to inspect lowered managed nodes, resolved profiles, compiled ids, repeat wiring, and dependency edges.

### `run`

Compiles and executes the graph and writes a new run root with artifacts.

```bash
npm run run -- --graph ./agentflow.graph.json
```

Useful flags:

```bash
npm run run -- --graph ./agentflow.graph.json --workspace-backend worktree
npm run run -- --graph ./agentflow.graph.json --profile default --label demo
```

During a run, `agent` and AI `check` nodes append live harness output into each execution's `stdout.log` and `stderr.log` under the run root. The final completed logs still remain the authoritative artifact.

While the graph is running, the CLI also prints human-readable progress to `stderr`. The final machine-readable command result remains on `stdout`, so piping `agentflow run ... | jq` still works.

Cancel behavior:

- Press `Ctrl-C` in the terminal that launched the run.
- The runtime performs cleanup and writes durable canceled state.
- `summary.md`, `state.json`, and `events.jsonl` reflect that state from artifacts.

### `resume`

Resumes a failed or canceled run root in place.

```bash
npm run resume -- --run-root ./.agentflow/runs/<run-id>
```

Resume behavior:

- recompiles from the original graph path with the current Agentflow build
- preserves only nodes whose latest durable outcome is `passed` and whose compiled execution contract is unchanged
- restarts failed, canceled, blocked, skipped, and pending nodes
- restarts repeat scopes from iteration 1 when they were unfinished or their compiled contract changed
- appends new events and attempts into the same run root

Like `run`, `resume` prints live graph progress to `stderr` and keeps its final structured result on `stdout`.

This is meant for interrupted or failed runs where you want to keep unchanged passed work while still picking up graph or workflow fixes.

## Inputs, Context, and Outputs

Supported input kinds:

- `file`
- `glob`
- `text`

Context can be pulled from earlier nodes with `context_from`.

Supported context includes:

- `summary`
- `result`
- `output`

Outputs let one node expose named material for downstream use.

This is how later nodes can consume:

- a prior agent summary
- a deterministic check result
- an AI check output file
- the latest passed loop iteration output

## Harness Notes

### Codex

- Works for `agent` nodes
- Works for AI `check` nodes
- If `reasoning_effort` is omitted, Agentflow resolves Codex to `medium`

### Cursor

- Works for `agent` nodes
- Read-only agent flows run without `--force`, so they stay in proposal mode
- AI checks are currently Codex-only because strict read-only evaluator guarantees are enforced there

## Validation and Confidence

Use these in increasing order of proof.

### Basic graph checks

```bash
npm run validate -- --graph .tmp/fake-plan.json
npm run compile -- --graph .tmp/feature-showcase.json
```

### Package-level smoke gate

```bash
npm run validate:smoke
```

This runs:

- canonical docs check
- `typecheck`
- `test`
- `build`
- built CLI smoke over the shipped graph fixture
- built run smoke with mock Codex and Cursor harnesses

### Stronger deterministic confidence

```bash
npm run validate:confidence
```

This adds:

- coverage policy enforcement

### Real harness smoke

```bash
npm run validate:real-harness
```

This is optional and machine-local. It only runs for harness binaries detected on your machine.

## Day-One Commands

If you only want the commands most people need first:

```bash
npm install
npm run graph-help
npm run validate -- --graph .tmp/feature-showcase.json
npm run compile -- --graph .tmp/feature-showcase.json
npm run run -- --graph .tmp/feature-showcase.json
npm run resume -- --run-root ./.agentflow/runs/<run-id>
```

## Where To Read Next

You should not need anything else to get started. If you want deeper detail after that:

- [SCOPE.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/SCOPE.md): supported product surface
- [ARCHITECTURE.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/ARCHITECTURE.md): compiler, runtime, and artifact contracts
- [OPERATIONS.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/OPERATIONS.md): runs-root behavior, lifecycle, cleanup, and operator runbook
- [MANAGED_WORKFLOWS.md](/Users/chidiudeze/Documents/GitHub/agentflow/docs/MANAGED_WORKFLOWS.md): managed workflow model and shipped workflow nodes
