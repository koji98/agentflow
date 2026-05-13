---
name: agentflow-run-review
description: Use when reviewing completed Agentflow runs, run roots, delivery packages, supervisor traces, or repeated workflow outcomes to extract lessons, plugin opportunities, eval scenarios, docs updates, or skill improvements.
---

# Agentflow Run Review

## Overview

Review completed runs to improve future Agentflow graphs. This is a learning loop, not a code review of the final diff.

## When To Use

- A run has reached terminal state and the user asks what went well, what failed, or what to improve.
- Repeated runs reveal recurring missing context, brittle checks, weak artifacts, or supervisor interventions.
- The user wants to extract a reusable plugin, eval scenario, docs update, or skill improvement from run evidence.

Use `agentflow-operations` for live run inspection and resume. Use `agentflow-plan-review` before launch.

## Core Workflow

1. Inspect delivery first, then supervisor and attempt evidence when needed; see `references/run-postmortem.md`.
2. Compare the intended workflow, authored graph, compiled/run behavior, and delivered artifacts.
3. Identify what helped: composition, context, artifacts, checks, tools, supervision.
4. Identify what hurt: over-specificity, missing context, brittle checks, artifact gaps, authority issues, weak rubrics, unnecessary cost.
5. Decide extraction targets: plugin, eval, docs, skill, graph template, or no extraction; see `references/plugin-extraction.md` and `references/eval-extraction.md`.
6. Produce a run learning report with concrete next actions.

## Decision Rules

- Recommend a plugin only when reuse, multi-CLI composition, auth isolation, stable I/O, policy, or auditability is real.
- Recommend an eval when the failure mode should be regression-tested across future graph or prompt changes.
- Recommend authoring-skill changes when the same graph mistake is likely to recur.
- Recommend docs updates when operator mental models or run review order were unclear.
- Do not turn one-off inconvenience into a plugin or skill.

## Red Flags

- Reviewing only final code and ignoring run evidence.
- Ignoring supervisor interventions.
- Treating heavy managed patterns as always good or always bad.
- Extracting a plugin for a one-time command.
- Failing to convert recurring brittle checks into an eval scenario.
- No concrete change to future workflow practice.

## Verification

- [ ] Delivery files were reviewed before raw logs.
- [ ] The report separates graph lessons from work-product findings.
- [ ] Plugin, eval, docs, and skill candidates are justified or rejected.
- [ ] Follow-up actions are concrete and owned by a surface.
