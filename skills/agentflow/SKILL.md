---
name: agentflow
description: Use when authoring, validating, running, inspecting, or debugging supervised Agentflow graphs, managed patterns, plugin tools, delivery packages, supervisor interventions, or Codex/Cursor harness behavior.
---

# Agentflow

Agentflow is a supervised local runtime for long-running coding work. Humans author a graph with intent and outcome boundaries; Codex CLI or Cursor CLI executes substantial nodes; the supervisor records bounded interventions; terminal runs produce a delivery package.

## Route By Task

- Author or review a graph: read [references/graph-authoring.md](references/graph-authoring.md).
- Need exact fields: read [references/graph-contract.md](references/graph-contract.md).
- Choose managed patterns: read [references/managed-workflows.md](references/managed-workflows.md).
- Need CLI validation or launch behavior: read [references/cli-and-validation.md](references/cli-and-validation.md).
- Debug failures, resume, or inspect delivery: read [references/run-debugging.md](references/run-debugging.md).
- Need implementation mechanics: read `docs/technical-implementation/` in the repository.
- Need failure semantics: read [references/failure-and-validation.md](references/failure-and-validation.md).
- Need examples: read [references/examples.md](references/examples.md).
- Need reusable plugin workflows or tools: use `agentflow-plugins`.

## Default Workflow

1. Confirm the graph has `intent.goal`, `intent.acceptance_criteria`, explicit `constraints`, explicit `repos`, and explicit `profiles`.
2. Prefer fewer, larger outcome nodes with named artifacts and node-level `goal` plus `acceptance_criteria`.
3. Set `supervision` budgets and delivery sections appropriate to the task.
4. Use plugin-bundled CLI tools for team capabilities; verify each tool's description, credential requirements, and `--help` contract.
5. Run `agentflow plugin resolve --graph <path>` when plugins are declared.
6. Run `agentflow validate --graph <path>`.
7. Run `agentflow validate --graph <path> --review` for substantive graphs; use `--strict-review` for release gates or team-owned templates.
8. Run `agentflow validate --graph <path> --run-ready` before launch on this machine.
9. Run `agentflow validate --graph <path> --show-compiled` for managed patterns, plugin workflows, repeat scopes, or nontrivial artifact handoffs; use `--diagram-output` or `--diagram-image-output` when a visual graph helps review.
10. After a run, inspect `delivery/reviewer-guide.md`, `delivery/manifest.json`, `delivery/run-map.md`, and declared artifacts before raw runtime files.

## Authoring Posture

- Treat the authored DAG as the human contract, not a prose plan.
- Use `context` for node material and `artifacts` for durable handoffs.
- Treat `repos` and `profiles` as operational authority; put scope boundaries and out-of-scope notes in `constraints`.
- Keep downstream references on named artifacts from public node ids.
- Treat `acceptance_criteria` as a runtime contract: passing `agent` attempts are graded by the outcome verifier against graph and node intent. Vague criteria produce vague verification, so write the criteria you want the verifier to enforce.
- Do not author boilerplate iteration guidance ("iterate until done", "investigate ambiguity", "stop only when blocked") in graph or node `constraints`. The runtime injects a `## Working Loop` section into every standard agent prompt that already covers this, and outcome verification will reject early-bailing.
- Use deterministic checks for hard facts. Reach for AI checks only when another node depends on the gate or when the deterministic command is genuinely unavailable; do not stack an AI `check` after every agent node to re-evaluate the same acceptance criteria.
- Treat checks, outcome verification, supervisor `semantic_evaluation`, managed pattern evaluation, and `agentflow eval` as separate lanes.
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
