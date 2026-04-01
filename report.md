# strengthen_run_state_log_and_trace_behavior

## What I Changed
- Tightened managed-run state inference in [web-app/server/run_manager.ts](/Users/chidiudeze/Documents/GitHub/agentflow/web-app/server/run_manager.ts) so bridge-owned runs stay historical once their child process has exited, even if `run_state.json` still carries stale `RUNNING` rows or `isActive: true`.
- Routed that handle-aware inference through [web-app/server/routes/runs.ts](/Users/chidiudeze/Documents/GitHub/agentflow/web-app/server/routes/runs.ts), which means `/resolve`, `/state`, and resume-preflight now agree about:
  - active vs completed truth
  - cancelability after managed exit
  - resumability after managed nonzero exit
- Tightened client trace-snapshot merging in [web-app/client/src/lib/monitor.ts](/Users/chidiudeze/Documents/GitHub/agentflow/web-app/client/src/lib/monitor.ts) for the bootstrap-fallback path. When `/trace` is unavailable and the monitor seeds from `state.decisionTrace`, a later `decision-trace-snapshot` now replaces the known tail instead of duplicating it.

## Contract Adjustments
- No API shape changed, but the monitor contract is stricter:
  - bridge-owned exit now overrides stale persisted active markers
  - `canResume` can stay true after managed nonzero exit even if the persisted snapshot still looks live
  - `canCancel` and `/cancel` no longer treat those managed-exit snapshots as controllable
- Client trace handling now treats partial bootstrap tails as a tail window, not as a full trace prefix.

## Tests Added Or Updated
- Updated [web-app/tests/server.live-command-run.test.ts](/Users/chidiudeze/Documents/GitHub/agentflow/web-app/tests/server.live-command-run.test.ts) to run a real failed command-only run, rewrite `run_state.json` into a stale active-looking snapshot, and verify:
  - `/state` still reports `isActive: false`
  - `/resolve` stays historical
  - `/cancel` returns `run_not_active`
  - the run still resumes cleanly after the original failed snapshot is restored
- Updated [web-app/tests/client.monitor-state.test.ts](/Users/chidiudeze/Documents/GitHub/agentflow/web-app/tests/client.monitor-state.test.ts) with a regression that proves tail-only bootstrap traces are replaced, not duplicated, by later snapshot rewrites.

## Files Changed
- [web-app/server/run_manager.ts](/Users/chidiudeze/Documents/GitHub/agentflow/web-app/server/run_manager.ts)
- [web-app/server/routes/runs.ts](/Users/chidiudeze/Documents/GitHub/agentflow/web-app/server/routes/runs.ts)
- [web-app/client/src/lib/monitor.ts](/Users/chidiudeze/Documents/GitHub/agentflow/web-app/client/src/lib/monitor.ts)
- [web-app/tests/server.live-command-run.test.ts](/Users/chidiudeze/Documents/GitHub/agentflow/web-app/tests/server.live-command-run.test.ts)
- [web-app/tests/client.monitor-state.test.ts](/Users/chidiudeze/Documents/GitHub/agentflow/web-app/tests/client.monitor-state.test.ts)

## Validation
- `npm --prefix web-app run test -- --run tests/client.monitor-state.test.ts tests/server.live-command-run.test.ts tests/server.runs.test.ts`
- `npm --prefix web-app run typecheck`
- `npm --prefix web-app run test`
- `npm --prefix web-app run build`
- `npm run typecheck`
- `npm test`

## Residual Risks
- Unmanaged external processes are still observable but not actually cancellable.
- A first historical open can still miss full trace history if `decision_trace.json` is unreadable before any stable snapshot has been cached.

## Blockers
- None.
