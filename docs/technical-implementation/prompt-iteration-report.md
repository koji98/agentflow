# Prompt Iteration Report

Generated: 2026-04-29T06:46:09.074Z

This pass focused on the prompt and context surfaces that affect normal node execution, supervisor recovery, helper nodes, artifact repair, and verification. I followed the scenario-driven prompt iteration loop from Mirascope's prompt iteration writeup: define target behavior, run representative cases, score against explicit expectations, inspect failures/awkward traces, revise the prompt/context surface, then rerun.

## Run Summary

- Final validation pass: 340 prompt/context scenario iterations.
- Final pass coverage: 20 iterations across 17 scenarios.
- Total scenario iterations across tuning passes: 940.
- Final pass result: every scenario scored 1.0000 with no failed rules.
- Final raw results: `prompt-iteration-runs/pass-4/results.json` (generated local output; ignored by git).

## Scenario Coverage

| Scenario | Runs | Avg Score | Failed Rules |
| --- | ---: | ---: | --- |
| agent-no-tools | 20 | 1.0000 | none |
| agent-declared-artifact | 20 | 1.0000 | none |
| agent-with-tools | 20 | 1.0000 | none |
| agent-read-only | 20 | 1.0000 | none |
| agent-recovery-retry | 20 | 1.0000 | none |
| supervisor-evidence-external | 20 | 1.0000 | none |
| supervisor-evidence-local | 20 | 1.0000 | none |
| supervisor-evidence-pattern | 20 | 1.0000 | none |
| supervisor-evidence-dependency | 20 | 1.0000 | none |
| supervisor-evidence-diagnostic | 20 | 1.0000 | none |
| supervisor-evidence-semantic | 20 | 1.0000 | none |
| supervisor-evidence-investigate | 20 | 1.0000 | none |
| artifact-repair | 20 | 1.0000 | none |
| ai-check | 20 | 1.0000 | none |
| outcome-verifier | 20 | 1.0000 | none |
| context-manifest-source | 20 | 1.0000 | none |
| helper-prompt-source | 20 | 1.0000 | none |

## Iteration Notes

- Pass 1 proved the basic contract rules, but manual inspection found two prompt-quality issues: non-recovery node prompts skipped a `Start Here` number, and supervisor evidence prompts showed every gather-kind instruction instead of only the selected gatherer's instructions.
- Pass 2 expanded iterations and caught a brittle diagnostic phrasing issue: the diagnostic prompt had the right safety rule, but the scenario expected the exact lower-case phrase `do not run mutating commands`.
- Pass 3 confirmed the targeted fixes across 20 iterations per scenario.
- Pass 4 added coverage for every supervisor evidence gatherer kind: `local_context`, `pattern_mining`, `dependency_metadata`, `external_context`, `diagnostic_probe`, `semantic_rejudge`, and `investigate_failure`.

## Changed Surfaces

### Agent Node Prompt

Changed in `src/runtime/harness/types.ts`.

- Added a `Contract Priority` section before the working instructions. This tells the node how to resolve conflicts: authored graph contract first, then supervisor recovery envelope, then declared artifacts/runtime metadata, then retrieved context, then prior attempt outputs.
- Added a compact `Start Here` checklist so nodes begin by reading recovery material, runtime metadata, context, artifacts, and tool availability before acting.
- Tightened context uncertainty language: missing, truncated, stale, or contradictory context must be treated as evidence quality problems, not as permission to invent facts.
- Tightened tool guidance: nodes must not invent tools, hidden commands, credentials, or undocumented flags, and should use structured JSON stdout where practical.
- Clarified retry behavior: the recovery envelope changes tactics, not the task; original goal, acceptance criteria, constraints, sandbox, repo authority, and declared artifact requirements stay binding.

Why: failed or retried nodes need an explicit authority order. Without it, supervisor evidence can look like a replacement task rather than evidence that helps satisfy the original graph contract.

### Supervisor Recovery Envelope

Changed in `src/runtime/harness/types.ts`.

- Retitled the original task block from background material to `Original Authored Node Task (Still Binding)`.
- Added direct language that the next attempt should adapt its plan to the failed symptom after reading cited evidence.
- Clarified that current-attempt outputs should be written normally and not into prior attempt directories.

Why: retries should not drift into a new mission. The node needs to understand the recovery plan as a tactical correction under the same contract.

### Supervisor Evidence Prompts

Changed in `src/runtime/harness/types.ts`.

- Added gather-kind-specific instructions for every internal evidence gatherer: `local_context`, `pattern_mining`, `dependency_metadata`, `external_context`, `diagnostic_probe`, `semantic_rejudge`, and `investigate_failure`.
- Made external context explicitly read-only and bounded to evidence gathering; it cannot change graph intent, authority, acceptance criteria, sandbox, or declared artifacts.
- Made diagnostic probes explicitly non-mutating unless the gatherer is granted authority elsewhere.
- Required a consistent JSON object containing `claims`, `sources`, `confidence`, `conflicts`, `retry_guidance`, and `scope_or_authority_changed`.
- Restricted each evidence prompt to only the selected gatherer's guidance.

Why: the recovery loop depends on evidence patches that are specific enough to merge. Generic supervisor prompts made every intervention feel like the same static retry brief.

### Context Manifest

Changed in `src/runtime/context/resolve.ts`.

- Reframed context as evidence, not authority.
- Added a recommended read order: runtime supervisor recovery material first, authored task context second, repeat/prior-attempt evidence third, omitted/truncated entries only when absence matters.
- Added omitted/truncated guidance: do not guess required facts; inspect provenance or report uncertainty.

Why: nodes often fail because relevant context exists but is not prioritized, or because absent context is silently guessed. The manifest now tells the node how to use context without widening the graph contract.

### Outcome Verifier Prompt

Changed in `src/runtime/verification/prompt.ts`.

- Made missing, empty, placeholder, inconsistent, or content-free declared artifacts blocker evidence.
- Told the verifier to read the full artifact path before judging a truncated snippet as a blocker.
- Required exact citations to artifact paths, decision logs, commands, or response excerpts when making a judgment.

Why: verification should catch the common failure mode where the node claims success but the durable handoff is missing or meaningless.

### Helper Prompt

Changed in `src/af/index.ts`.

- Added the same contract-priority and start-checklist structure used by main node prompts.
- Nudged helper sessions toward `af log --type decision` for major direction changes and `af log --type note` for blockers or completion notes.
- Kept helper outputs scoped to supervised artifacts rather than implicit side channels.

Why: helpers can accidentally become unsupervised agents. Their prompt now keeps them inside the node's authority and makes their useful decisions visible to the parent attempt.

### Prompt Iteration Harness

Added `scripts/prompt-iteration.mjs`.

- Exercises production prompt rendering and source strings from `dist/`.
- Runs scenario rules repeatedly and emits raw results plus representative rendered outputs.
- Covers node prompts, supervisor gatherer prompts, repair/check/verifier prompts, context manifests, helper prompt source, tool contracts, and recovery envelope placement.

Why: prompt changes need regression coverage just like code changes. This gives Agentflow a local prompt-quality loop that can be rerun after future prompt/context edits.
