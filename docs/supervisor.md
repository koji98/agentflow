# Supervisor Defaults and Overrides

This document defines default control-plane assets for dynamic, long-running Agentflow operation:

- Planner prompt: `docs/supervisor/planner.default.md`
- Plan QA prompt: `docs/supervisor/plan_qa.default.md`
- Plan QA rubric: `docs/supervisor/plan_qa_rubric.default.json`
- Example workspace override config: `agentflow.supervisor.example.json`

## Supervisor CLI

Run one supervisor cycle:

```bash
agentflow --supervise state/mission_state.json
```

Validate supervisor inputs only:

```bash
agentflow --supervise state/mission_state.json --validate
```

Select config/profile explicitly when needed:

```bash
agentflow --supervise state/mission_state.json \
  --supervisor-config agentflow.supervisor.json \
  --supervisor-profile default
```

## Why this exists

For long-running operation, the system should:

1. Plan work in bounded child runs.
2. Run deterministic and rubric-based QA on each candidate plan.
3. Revise plans until quality thresholds are met.
4. Execute only approved child plans.
5. Record state and repeat in supervisor cycles.

## Override precedence

Use this precedence so defaults stay safe while teams can customize:

1. CLI selectors (`--supervisor-config`, `--supervisor-profile`, mission-state path).
2. Workspace config file (`agentflow.supervisor.json`).
3. Built-in defaults from `docs/supervisor/*`.

Supported config keys (workspace file):

- `profile`
- `prompts.planner`, `prompts.plan_qa`
- `rubrics.plan_qa`
- `thresholds.plan_qa_pass_score`, `thresholds.max_planner_revisions`
- `paths.mission_state`, `paths.plan_candidate`, `paths.plan_rationale`, `paths.plan_score`, `paths.run_ledger`, `paths.run_root`, `paths.stop_flag`
- `execute_approved_plan`
- `agents.planner.*`, `agents.plan_qa.*`

## Recommended artifact contract

Store control-plane artifacts under `state/` (paths are configurable):

- `mission_state.json`: mission goals, constraints, unknowns, budgets.
- `plan_candidate.json`: next proposed child plan.
- `plan_rationale.md`: planner explanation and coverage mapping.
- `plan_score.json`: plan QA result JSON.
- `run_ledger.jsonl`: child run lineage and outcomes.
- `stop.flag`: optional kill switch checked before each cycle.

## Supervisor cycle pattern

1. Planner generates `plan_candidate.json` + `plan_rationale.md`.
2. Plan QA scores against rubric and emits `plan_score.json`.
3. If score fails threshold, planner revises (bounded revision count).
4. Validate approved plan: `agentflow --plan <candidate> --validate`.
5. Execute approved plan.
6. Update mission state and run ledger.
7. Continue next cycle or stop.

## Guardrails

1. Keep child plans bounded (`max_runtime_sec`, `max_total_tasks`, `max_failures`).
2. Prefer per-loop `max_iterations` over broad global iteration caps.
3. Require deterministic validation after each significant modification batch.
4. Require a canary review before large fan-out.
