---
name: agentflow
description: Work with Agentflow graphs, managed workflows, local eval suites, run artifacts, and CLI validation. Use when authoring or reviewing Agentflow graph JSON, choosing managed patterns, designing or running agentic workflow evals, debugging failed runs, or inspecting resume/artifact behavior.
---

# Agentflow

Use this as the router for Agentflow work. Agentflow is a local-first graph executor for agentic workflows over local repositories. A graph is executable control flow: nodes run, context is materialized, artifacts are published, validation gates decide outcomes, and durable run artifacts explain what happened.

Do not treat an Agentflow graph as a prose plan. It must validate, compile, and have intentional handoffs.

## Route by task

- Author or review graph JSON: read [references/graph-authoring.md](references/graph-authoring.md).
- Choose or fill managed patterns: read [references/managed-workflows.md](references/managed-workflows.md).
- Use or package Git-resolved plugin workflows: use `agentflow-plugins`.
- Design, validate, run, or grade local eval suites: read [references/evals.md](references/evals.md).
- Debug a failed run or inspect resume behavior: read [references/run-debugging.md](references/run-debugging.md).
- Need exact graph syntax or node fields: read [references/graph-contract.md](references/graph-contract.md).
- Need CLI behavior or validation order: read [references/cli-and-validation.md](references/cli-and-validation.md).
- Need failure semantics for `exec`, `check`, `checkpoint`, or `repeat`: read [references/failure-and-validation.md](references/failure-and-validation.md).
- Need graph topology examples: read [references/examples.md](references/examples.md).

## Grounding rule

Prefer the repository `docs/`, `src/`, and `tests/` when available. The packaged references are compact agent-facing guidance for installed use and may trail the repo docs during active development.

## Default workflow

1. Identify whether the user needs authoring, managed patterns, evals, or run debugging.
2. Read the smallest relevant reference.
3. Use `agentflow graph-help` or the relevant `agentflow <command> --help` when the CLI surface matters.
4. Author or edit the graph using current fields only: `context` and `artifacts`, not `inputs`, `context_from`, or `outputs`.
5. Run `agentflow validate --graph <path>` and fix diagnostics.
6. Run `agentflow validate --graph <path> --run-ready` when the user needs launch assurance on this machine, or when the graph depends on local commands, git worktrees, Codex, or Cursor.
7. Run `agentflow validate --graph <path> --show-compiled` and inspect lowered shape when the graph uses managed patterns, plugin workflows, `repeat`, `parallel`, or nontrivial artifact handoffs.
8. Hand off only after validation passes and the compiled contract looks right, or explicitly report the exact command that failed and the diagnostics that remain.

## Authoring posture

- Keep nodes narrow enough that a failure tells the operator what broke.
- Use named artifacts for durable handoffs. Do not rely on downstream nodes rediscovering scratch files.
- Treat an agent node's final response as the `agent_response` handoff summary, but declare structured artifacts when downstream work needs stable data.
- Use deterministic `check` for real gates and `exec` for evidence collection.
- Use managed patterns only when the task lifecycle matches the pattern contract.
- Use plugin workflows when a graph needs a reusable team-owned managed graph from Git; resolve them before validation.
- Prefer smaller explicit graphs over clever graphs with ambiguous context or hidden dependencies.
