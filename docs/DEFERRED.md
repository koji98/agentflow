# Deferred

These areas are intentionally deferred from the current release. They should remain absent unless a minimal interface stub is required to keep the architecture clean.

## Explicitly Deferred Features

- MCP sidecars
- native harnesses
- a generalized custom tool platform
- remote-devbox backends
- a fully featured controller

Additional deferred areas:

- container or VM workspace backends
- arbitrary plugin systems
- interactive graph editing surfaces
- background orchestration services
- resumable control-plane loops
- human-in-the-loop checkpoint mode that can pause at configured workflow gates, accept operator input, and resume the live run in place without restarting the full graph
- delivery automation beyond a minimal run summary
- branch, commit, or pull-request orchestration features

## Harness And Workflow Revisit Ideas

These are not part of the current release. Keep them deferred until the supported local-first executor and inspection surface is stable enough for a deliberate follow-on pass.

- add an explicit execution-contract gate between planning and workspace-write implementation in `execute_spec`, so the workflow confirms what "done" means before code changes start
- add a read-only evaluator or reviewer gate inside `execute_spec` repair flow, so the workflow can catch spec drift or weak fixes before relying only on terminal `review_change`
- promote managed-workflow handoffs to structured machine-readable artifacts first, with prose artifacts as operator-facing renderings rather than the only contract
- treat managed workflows as first-class workflow groups in runtime projection and future inspection surfaces, so operators can inspect workflow phases directly instead of reasoning from lowered primitive nodes alone
- keep repository agent instructions and canonical docs aligned, because stale harness guidance degrades long-running workflow quality even when runtime behavior is correct

## Guardrails

- Do not add user-facing settings for deferred features.
- Do not add partial runtime behavior for deferred features.
- If a deferred area needs a placeholder, keep it to a narrow type or README stub.
- Prefer deleting speculative hooks over preserving extension points that the release does not exercise.

## Minimal Stubs Allowed

These are acceptable if they reduce architecture churn:

- `src/controller/README.md`
- a narrow harness adapter interface that can support more adapters later
- a workspace backend type that currently enumerates only `inplace` and `worktree`

Anything beyond these must be justified by the current release build, not by future possibility.
