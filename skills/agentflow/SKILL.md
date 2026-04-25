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
- Need failure semantics: read [references/failure-and-validation.md](references/failure-and-validation.md).
- Need examples: read [references/examples.md](references/examples.md).
- Need reusable plugin workflows or tools: use `agentflow-plugins`.

## Default Workflow

1. Confirm the graph has `intent.goal`, acceptance criteria, scope, approval boundaries, explicit `repos`, and explicit `profiles`.
2. Prefer fewer, larger outcome nodes with named artifacts and node-level `goal` plus `acceptance_criteria`.
3. Set `supervision` budgets and delivery sections appropriate to the task.
4. Use plugin-bundled CLI tools for team capabilities; verify each tool's `capability`, `impact`, and credential requirements.
5. Run `agentflow plugin resolve --graph <path>` when plugins are declared.
6. Run `agentflow validate --graph <path>`.
7. Run `agentflow validate --graph <path> --run-ready` before launch on this machine.
8. Run `agentflow validate --graph <path> --show-compiled` for managed patterns, plugin workflows, repeat scopes, or nontrivial artifact handoffs.
9. After a run, inspect `summary.md`, `interventions.jsonl`, `delivery/manifest.json`, and `delivery/reviewer-guide.md`.

## Authoring Posture

- Treat the authored DAG as the human contract, not a prose plan.
- Use `context` for node material and `artifacts` for durable handoffs.
- Treat `repos` and `profiles` as operational authority; treat `intent.scope` as governance.
- Keep downstream references on named artifacts from public node ids.
- Use deterministic checks for hard facts and AI checks for semantic judgment.
- Make approval boundaries explicit before granting external, secret, or mutation tools.
- Do not widen scope through supervisor behavior; use checkpoints or graph edits for human decisions.
