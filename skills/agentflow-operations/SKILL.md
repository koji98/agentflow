---
name: agentflow-operations
description: Use when validating, resolving plugins for, launching, inspecting, resuming, applying, debugging, or reviewing delivery packages for Agentflow runs and run roots.
---

# Agentflow Operations

## Overview

Operate Agentflow runs from preflight through delivery review. Humans use `agentflow`; agents inside running nodes use `af`.

## When To Use

- Validating a graph, resolving plugins, launching a run, inspecting a run root, resuming a run, applying captured changes, or reviewing delivery files.
- Debugging failed nodes, supervisor pauses, missing artifacts, context failures, or harness issues.
- Deciding which run files matter for review versus audit or debugging.

Use `agentflow-authoring` for graph creation and `agentflow-run-review` for post-run lessons.

## Core Workflow

1. Preflight with plugin resolution when needed and `agentflow validate --graph <path>`; see `references/validation-launch-resume.md`.
2. Inspect compiled shape with `--show-compiled`, `--output-dir`, or diagrams when the graph is nontrivial.
3. Launch with `agentflow run --graph <path>` only after validation.
4. Inspect terminal or failed runs with `agentflow inspect <run-root>`.
5. Review delivery files before raw runtime files; see `references/delivery-review.md`.
6. Use resume dry-runs before continuing complicated or paused runs; check which compiled nodes restart and why before launching real work. Use `references/failure-triage.md` when status, failure class, or next action is unclear.
7. Apply captured changes only when the operator wants worktree output moved into another checkout.

## Decision Rules

- Validate before expensive harness work.
- Start delivery review by checking `delivery/manifest.json` for `graph_status`, `delivery_status`, and `review_ready`, then use `delivery/01-review-brief.md`, `delivery/02-run-learnings.md`, and `delivery/03-audit-index.md`.
- Use raw `events.jsonl`, attempts, and runtime logs only for debug, audit, or resume.
- Treat missing or weak delivery as a run-quality failure even when code changed.
- Use `agentflow-run-review` after completion when the goal is learning or extraction.

## Red Flags

- Launching without validate.
- Ignoring plugin lockfile or tool `--help` failures.
- Reviewing raw logs before delivery files.
- Resuming a changed graph without dry-run when preservation matters.
- Assuming changed support/tools/skills/CLI hints are safe to preserve; they are prompt-affecting node contract changes.
- Treating a supervisor authority pause as a planned checkpoint, or assuming free-text failures can pause a run.
- Expecting a completed agent node to be a live collaborator.

## Verification

- [ ] Plugin resolution was run when plugins are declared.
- [ ] Validation output is recorded or summarized.
- [ ] Run root, status, review brief, run learnings, audit index, delivery manifest, and interventions are known.
- [ ] Resume decisions are based on dry-run when compatibility matters.
- [ ] Delivery files were reviewed before debug-only artifacts.
