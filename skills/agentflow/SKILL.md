---
name: agentflow
description: Use when authoring, validating, running, inspecting, or debugging supervised Agentflow graphs, managed patterns, plugin tools, delivery packages, supervisor interventions, or Codex/Cursor harness behavior.
---

# Agentflow

Agentflow is a supervised local runtime for long-running coding work. Humans author a graph with intent and outcome boundaries; Codex CLI or Cursor CLI executes substantial nodes; the supervisor records bounded interventions; terminal runs produce a delivery package.

## Must Know

- Graphs are execution contracts: intent, authority, context, artifacts, validation, supervision, and delivery.
- `acceptance_criteria` are runtime-enforced by outcome verification for passing `agent` attempts.
- Context is prompt design. Prefer exact, high-signal material over broad dumps; validate real token cost with `--run-ready`.
- Artifacts are durable handoffs. Downstream nodes should consume named artifacts, not raw logs or assumed workspace state.
- Inside `repeat` loops, prior-iteration artifacts need explicit selectors such as `iteration: "previous"` or `iteration: "latest_failed"`; Agentflow also injects `repeat_history` so retrying nodes can see what already happened.
- Checks prove hard facts or gate control flow. Do not add AI checks just to repeat outcome verification.
- Agents are capable terminal users. Inventory useful local CLIs and let nodes use native commands when that is enough.
- Do not wrap mature CLIs or protocols just to make them "agent tools"; wrappers should add auth isolation, stable I/O, reuse, or auditability.
- Do not over-prescribe implementation mechanics. Give agents clear intent, authority, context, artifacts, and validation; let them decide exact files and approach unless the user specified them.
- In GitHub repos, consider rollout strategy before authoring: prefer small reviewable PRs, `establish_base -> parallel_prs`, or `cascading_prs` over one large PR unless the user asks otherwise.
- A graph is not complete until validation passes: plugin resolution when needed, `validate`, `--review`, `--run-ready`, and `--show-compiled`.
- Supervisor recovery handles runtime failure. Do not author supervisor safety pauses as planned workflow nodes.
- `repos`, `profiles`, sandbox, and tools define authority. Constraints should name scope boundaries and high-impact limits.

## Route By Task

- Author or review a graph, choose primitive shape, or pressure-test graph quality: read [references/graph-authoring.md](references/graph-authoring.md).
- Need reusable authored workflow compositions that are not managed patterns: read [references/common-patterns.md](references/common-patterns.md).
- Working in a GitHub repo or planning PR rollout: read [references/github-rollout.md](references/github-rollout.md).
- Need exact fields: read [references/graph-contract.md](references/graph-contract.md).
- Choose compiler-supported managed pattern nodes: read [references/managed-workflows.md](references/managed-workflows.md).
- Need CLI validation or launch behavior: read [references/cli-and-validation.md](references/cli-and-validation.md).
- Debug failures, resume, or inspect delivery: read [references/run-debugging.md](references/run-debugging.md).
- Need implementation mechanics: read `docs/technical/` in the repository.
- Need failure semantics: read [references/failure-and-validation.md](references/failure-and-validation.md).
- Need examples: read [references/examples.md](references/examples.md).
- Need workflow eval suites, scenarios, criteria, environment simulation, trajectory checks, scorecards, benchmarks, or prompt-pack comparisons: use `agentflow-evals`.
- Need reusable plugin workflows or tools: use `agentflow-plugins`.

## Default Workflow

1. Capture graph intent: goal, acceptance criteria, constraints, and out-of-scope boundaries.
2. In GitHub repos, choose rollout shape before node shape: one focused PR, `establish_base -> parallel_prs`, or `cascading_prs`.
3. Choose the graph shape: primitive flow, common authored pattern, or managed pattern.
4. Define authority: repos, profiles, workspace backend, sandbox, tools, credentials, and high-impact limits.
5. Inventory relevant local CLIs and decide what stays as ordinary terminal use versus plugin-bundled tools.
6. Define node contracts: each substantial agent gets a goal, acceptance criteria, constraints, context, and named artifacts.
7. Add checks and supervision budgets that match risk; terminal delivery is automatic.
8. Resolve plugins when declared, then run `agentflow validate --graph <path>`.
9. Run `agentflow validate --graph <path> --review`, `--run-ready`, and `--show-compiled` before considering the graph complete.
10. After a run, inspect `delivery/reviewer-guide.md`, `delivery/manifest.json`, `delivery/run-map.md`, and declared artifacts before raw runtime files.

## Authoring Posture

- Treat the authored DAG as the human contract, not a prose plan.
- Use `context` for node material and `artifacts` for durable handoffs.
- Treat `repos` and `profiles` as operational authority; put scope boundaries and out-of-scope notes in `constraints`.
- Keep downstream references on named artifacts from public node ids.
- Treat `acceptance_criteria` as a runtime contract: passing `agent` attempts are graded by the outcome verifier against graph and node intent. Vague criteria produce vague verification, so write the criteria you want the verifier to enforce.
- Do not author boilerplate iteration guidance ("iterate until done", "investigate ambiguity", "stop only when blocked") in graph or node `constraints`. The runtime injects a `## Working Loop` section into every standard agent prompt that already covers this, and outcome verification will reject early-bailing.
- Use deterministic checks for hard facts. Reach for AI checks only when another node depends on the gate or when the deterministic command is genuinely unavailable; do not stack an AI `check` after every agent node to re-evaluate the same acceptance criteria.
- Treat checks, outcome verification, supervisor `semantic_evaluation`, managed pattern evaluation, and `agentflow eval` as separate lanes. Use `agentflow-evals` for the offline eval lane.
- Make high-impact limits explicit in `constraints` before granting credential-backed, external, or mutating tools.
- Do not widen scope through supervisor behavior; use repeat-scoped checkpoints or graph edits for planned human decisions, and reserve `pause_for_human` for supervisor safety stops.

## Runtime CLI Posture

- Humans use `agentflow`; agents inside running nodes use `af`.
- `af` is injected into agent nodes on `PATH` and reads `$AGENTFLOW_RUNTIME_METADATA`.
- Use `af --help` and `af <command> --help` for exact runtime CLI arguments, defaults, output shape, examples, and safety notes.
- Prefer `af status`, `af tools list`, and `af context show` when debugging what a node actually received.
- Prefer `af artifact write` for declared handoffs instead of ad hoc output files.
- Use `af log --type` for worker evidence and helper coordination notes, including `af log --type decision --decision ... --rationale ... --evidence ...` for major scope-affecting decisions, but keep durable conclusions in artifacts.
- Treat `af spawn` helpers as supervised sessions with their own artifacts, not persistent coworkers.
