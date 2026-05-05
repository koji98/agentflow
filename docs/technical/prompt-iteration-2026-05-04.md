# Prompt Iteration 2026-05-04

This pass implemented the prompt-quality release gate and used real `codex-cli` evals to prove the active prompt contract. The scope was prompt governance, prompt cleanup, completion-contract hardening, runtime CLI discipline, verifier guidance, managed prompt behavior, and prompt-regression infrastructure.

## Run Summary

- Prompt gate command: `npm run validate:prompts`
- Final full run: `.agentflow/evals/2026-05-04T13-01-42-539Z-agentflow-prompt-regression`
- Trials: 28
- Passed: 28
- Failed: 0
- Pass rate: `1`
- Blocker rate: `0`
- Average score: `5`
- Threshold passed: `true`

Targeted real `codex-cli` reruns were used before the final gate for failures in exact artifact content, verifier ambiguity, Codex harness MCP contamination, managed JSON artifact readiness, and manifest-first context inspection. The manifest-first failure exposed an agent stall after optional `af status`; the worker prompt now prioritizes exact `af` commands named by the node task, `af context show` before optional status when requested, and explicit evidence-kind values for `af log`.

## Changes

- Added prompt surface governance docs, cruft rejection rules, and a reusable prompt-iteration template.
- Removed generic persona wording from managed prompts and kept role text tied to authority/output contracts.
- Tightened standard worker prompt guidance for exact artifact labels, JSON artifacts, validation evidence, completion checks, runtime logs, and unsupported blockers.
- Made task-named `af` commands operationally first-class: if the node says to run `af context show`, the agent must do that before optional `af status` or repo search.
- Isolated Agentflow-managed Codex executions from user-level Codex MCP/plugin config by default through a minimal per-run `CODEX_HOME`; later harness policy work keeps that default while allowing explicit profile-declared Codex config or deliberate `inherit_user` opt-in.
- Hardened completion packets for required exact content, forbidden content, evidence `data`, command evidence, completion-check blocker misuse, current-attempt artifacts, and invalid declared JSON artifacts.
- Extended verifier prompts so completion packets, declared artifact status, captured evidence, artifact findings, and ambiguity rules are explicit inputs.
- Added `evals/agentflow-prompt-regression` with 28 strict scenarios covering artifact completion, runtime CLI discipline, context authority, tool discipline, validation/completion, supervisor/managed behavior, and verifier behavior.
- Added prompt-pack diff/report artifacts for eval runs and a `validate:prompts` release gate.
- Reduced prompt-regression worker timeouts so prompt stalls fail quickly in the gate instead of consuming the default long-running node budget.

## Promotion Decision

Promote. The final prompt-regression gate passed 28/28 real `codex-cli` trials with zero blockers and average score `5`.

## Residual Risks

- The prompt-regression suite is a strict one-trial gate for solved behaviors; noisy future behaviors should use targeted repeated trials before promotion.
- User-level harness config is intentionally excluded from default Agentflow runs. Tool capabilities should enter through Agentflow plugin CLIs or explicit `profiles.*.harness_config`; `inherit_user` profiles are non-reproducible and should stay out of prompt-regression release gates.
- Capability suites remain separate and should be used to discover new prompt failure modes without weakening this release gate.
