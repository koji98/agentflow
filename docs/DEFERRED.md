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
- graph editing in the web UI
- background orchestration services
- resumable control-plane loops
- delivery automation beyond a minimal run summary
- branch, commit, or pull-request orchestration features

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
