# Deferred

These areas are intentionally deferred from the current release. They should remain absent unless a minimal interface stub is required to keep the architecture clean.

## Explicitly Deferred Features

- MCP sidecars
- native harnesses
- native Agent Skills installation from graph execution
- remote-devbox backends
- a fully featured controller

The release ships a focused tool surface for plugin-bundled CLIs only (see `docs/PLUGINS.md`). Built-in CLI tools, inline graph- or agent-defined tools, a broader long-running tool platform (sidecar processes, persistent tool state, harness-specific bindings), and a built-in artifact-publishing CLI all remain deferred.

Additional deferred areas:

- container or VM workspace backends
- interactive graph editing surfaces
- background orchestration services
- resumable control-plane loops
- generalized human-in-the-loop control flow beyond the shipped repeat-scoped `checkpoint` node, including arbitrary workflow pauses, richer operator UIs, and resume semantics outside the current execution contract
- delivery automation beyond a minimal run summary
- branch, commit, or pull-request orchestration features
- non-macOS credential backends (Linux Secret Service, Windows Credential Manager) and any non-interactive CI credential issuance flow
- non-`pat-paste` credential login types (OAuth device flow, SSO, machine-to-machine credential exchange) and shared remote secret managers
- credential rotation policy, expiry enforcement, and cross-host credential sync

## Harness And Workflow Revisit Ideas

These are not part of the current release. Keep them deferred until the supported local-first executor and inspection surface is stable enough for a deliberate follow-on pass.

- add an explicit execution-contract gate between planning and workspace-write implementation in `pattern_generate_evaluate_fix`, so the workflow confirms what "done" means before code changes start
- add a read-only evaluator or reviewer gate inside `pattern_generate_evaluate_fix` repair flow, so the workflow can catch spec drift or weak fixes before relying only on terminal `pattern_review_change`
- promote managed-workflow handoffs to structured machine-readable artifacts first, with prose artifacts as operator-facing renderings rather than the only contract
- treat managed patterns as first-class workflow groups in runtime projection and future inspection surfaces, so operators can inspect workflow phases directly instead of reasoning from lowered primitive nodes alone
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
