# Prompt Iteration 2026-04-29

This pass used the real `codex-cli` harness through Agentflow evals. The loop was: run capability scenarios, inspect scorecards and raw run artifacts, tune prompt/context surfaces, rerun failing clusters, then run the suite again.

## Run Summary

- Baseline full run: `.agentflow/evals/capability-workflows-baseline`
  - 80 trials, 75 passed, pass rate `0.9375`, average score `4.33`.
- Tuned full run: `.agentflow/evals/capability-workflows-tuned-full`
  - 80 trials, 79 passed, pass rate `0.9875`, average score `4.3713`.
  - The single failure was scenario 08 before the local tool fixture was corrected.
- Final targeted tool rerun: `.agentflow/evals/capability-workflows-tuned-08-pass2`
  - 5 trials, 5 passed, average score `4.40`.
- Effective final coverage after applying the targeted scenario 08 rerun:
  - 80/80 passed across 16 scenarios, each scenario run at least 5 times.
  - Effective average score: `4.4063`.

## Changes

- Agent prompt: added explicit declared-artifact discipline, literal-label guidance, placeholder checks, and a guard against treating Agentflow as the target instead of the runner.
- Verifier prompt: made declared artifact snippets authoritative for presence when path/content/size are present and no read error exists.
- Eval docs fixture: local docs server now serves `index.md` for directory roots when `index.html` is absent.
- Eval scenario context: graph templates now state literal handoff fields and scope boundaries directly instead of hiding them in graders.
- Tool fixture: replaced the extensionless Node executable with a shell wrapper that calls a `.cjs` implementation.

## Follow-Ups

- Fix concurrent eval `MaxListenersExceededWarning` noise.
- Compact successful delivery packages when repeated artifacts do not add value.
- Improve trace provenance so judges do not rely on stale or absent provenance paths.
- Give supervisor-recovery judges an explicit clean-pass not-applicable signal when no intervention occurred.
