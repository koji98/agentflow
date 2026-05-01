# Prompt Iteration Report

Generated: 2026-04-29T22:40:00-04:00

This pass used the real `codex-cli` harness through the Agentflow eval system, not the older synthetic prompt harness. The loop was: run each capability scenario five times, inspect scorecards and raw run artifacts, tune the prompt/context surface, rerun the failing clusters, then run a full suite pass.

## Run Summary

- Baseline full run: `.agentflow/evals/capability-workflows-baseline`
  - 80 trials, 75 passed, pass rate `0.9375`, average score `4.33`.
- Tuned full run: `.agentflow/evals/capability-workflows-tuned-full`
  - 80 trials, 79 passed, pass rate `0.9875`, average score `4.3713`.
  - The single failure was scenario 08 before the local tool fixture was corrected.
- Final targeted tool rerun: `.agentflow/evals/capability-workflows-tuned-08-pass2`
  - 5 trials, 5 passed, average score `4.40`.
- Effective final coverage after applying the targeted scenario 08 rerun:
  - 80/80 passed across the 16 scenarios, with each scenario run at least 5 times.
  - Effective average score: `4.4063`.

## Final Scenario Results

| Scenario | Runs | Passed | Avg Score | Blockers |
| --- | ---: | ---: | ---: | ---: |
| 01-config-deep-merge | 5 | 5 | 4.32 | 0 |
| 02-cache-ttl-regression | 5 | 5 | 4.34 | 0 |
| 03-api-client-docs-migration | 5 | 5 | 4.46 | 0 |
| 04-ui-accessibility | 5 | 5 | 4.48 | 0 |
| 05-design-token-scope | 5 | 5 | 4.56 | 0 |
| 06-data-normalization | 5 | 5 | 4.38 | 0 |
| 07-noisy-monorepo-targeting | 5 | 5 | 4.32 | 0 |
| 08-tool-guided-discovery | 5 | 5 | 4.40 | 0 |
| 09-cli-error-discipline | 5 | 5 | 4.48 | 0 |
| 10-no-edit-audit | 5 | 5 | 4.54 | 0 |
| 11-forbidden-scope-guard | 5 | 5 | 4.36 | 0 |
| 12-sequence-research-implement | 5 | 5 | 4.54 | 0 |
| 13-worktree-change-capture | 5 | 5 | 4.40 | 0 |
| 14-stale-docs-conflict | 5 | 5 | 4.44 | 0 |
| 15-supervisor-retry-envelope | 5 | 5 | 4.46 | 0 |
| 16-terminal-repeated-failure | 5 | 5 | 4.02 | 0 |

## Findings And Changes

### Agent Node Prompt

Changed in `src/runtime/harness/types.ts`.

- Added explicit declared-artifact discipline: if the task, acceptance criteria, or artifact description requires literal labels or phrases, the agent must copy those strings exactly into the artifact body.
- Added a final artifact self-check: verify every declared artifact exists at the exact path and does not contain placeholders, blank link labels, unresolved template fields, or empty evidence slots.
- Added a guard against meta detours: Agentflow is the runner, not the task target, and nodes should not consult global Agentflow skills, installed assistant skills, stale playbooks, or unrelated Agentflow docs unless the authored node explicitly asks.
- Reduced runtime-help noise: `af --help` is now just-in-time for missing options/details, not a default first step.

Why: scenario 12 showed that successful implementations could still miss exact artifact labels, and one trial timed out after the model detoured into global Agentflow skill behavior instead of writing a small research artifact.

### Outcome Verifier Prompt

Changed in `src/runtime/verification/prompt.ts`.

- Declared artifact snippets in the verifier prompt are now authoritative for artifact presence when they include path/content/size and no read error.
- The verifier is told not to claim an artifact is missing because a separate directory search or transcript appears incomplete.

Why: scenario 14 had a false verification failure where `handoff.md` was inlined in the verifier prompt but the verifier still claimed it was missing.

### Eval Docs Fixture

Changed in `src/evals/runner.ts`.

- The local docs server now serves `index.md` for directory roots when `index.html` is absent.

Why: docs-backed scenarios were given a valid local HTTP fixture URL, but root requests returned 404 because the fixture used Markdown. Agents then fell back to tests and negative probe evidence instead of citing the intended docs content.

### Eval Scenario Context

Changed in `evals/agentflow-capability-workflows/templates/*.graph.template.json` and mirrored in `scripts/setup-eval-repos.mjs`.

- `agent-sequence` now gives the implementation node explicit handoff acceptance criteria and constraints.
- `agent-docs` now requires literal `Docs evidence:` and forbids editing `docs/**` when repo docs are stale.
- `agent-tool` now requires a literal `Tool command:` field in the handoff.

Why: the evals should test well-authored graphs. Hidden grader expectations are not useful prompt signal when the graph never asked for the behavior.

### Tool Fixture

Changed in `scripts/setup-eval-repos.mjs`.

- Replaced the extensionless Node fixture implementation with a shell wrapper (`fixture-lookup`) that calls `fixture-lookup.cjs`.

Why: direct execution of the extensionless script failed under the repository's `type: module` ancestor. Agents found workarounds, but the eval should test tool discipline, not Node module-resolution trivia.

## Remaining Follow-Ups

- The eval runner still emits a `MaxListenersExceededWarning` during concurrent runs. It did not affect trial outcomes, but it is noisy and should be fixed separately.
- Judge feedback repeatedly calls out duplicated delivery artifacts (`follow-up-items.md`, `risk-notes.md`, `run-map.md`) on clean passes. Delivery packaging can probably become more compact for successful runs.
- Several judges noted missing or stale provenance paths in packets. The trace packet should either inline the relevant provenance summary or avoid pointing at paths that are not present in the judge context.
- Supervisor-recovery judges often need an explicit "not applicable because no intervention occurred" signal on clean-pass scenarios.
