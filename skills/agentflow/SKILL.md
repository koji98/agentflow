---
name: agentflow
description: Work with Agentflow graphs, managed workflows, local eval suites, run artifacts, and CLI validation. Use when authoring or reviewing Agentflow graph JSON, choosing managed patterns, designing or running agentic workflow evals, debugging failed runs, or inspecting resume/artifact behavior.
---

# Agentflow

Use this as the router for Agentflow work. Load only the reference that matches the task.

## Route by task

- Author or review graph JSON: read [references/graph-authoring.md](references/graph-authoring.md).
- Choose or fill managed patterns: read [references/managed-workflows.md](references/managed-workflows.md).
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
3. Use `agentflow --help` or the relevant `agentflow <command> --help` when the CLI surface matters.
4. Validate executable artifacts before handoff.
