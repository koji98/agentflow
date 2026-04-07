# Agent Notes

This repository is the current Agentflow workspace. Prefer the repository docs and source files when they disagree with stale notes or prior staging references.

## Read First

1. `README.md`
2. `docs/SCOPE.md`
3. `docs/DEFERRED.md`
4. `docs/OPERATIONS.md`
5. `docs/ARCHITECTURE.md`
6. `docs/MANAGED_WORKFLOWS.md`
7. `docs/DEEP_RESEARCH_WORKFLOW.md`
8. `docs/SPEC_DESIGN_WORKFLOW.md`
9. `docs/EXECUTE_SPEC_WORKFLOW.md`
10. `docs/REVIEW_CHANGE_WORKFLOW.md`

## Canonical Surface

Treat these paths as the source of truth for review, implementation, and validation:

- `docs/`
- `src/`
- `tests/`
- `scripts/validate-smoke.mjs`
- `scripts/validate-confidence.mjs`
- `scripts/validate-real-harness.mjs`

## Generated Or Installed State

Ignore these paths unless the change is explicitly about build or install behavior:

- `node_modules/`
- `dist/`
- `coverage/`
- `.vite/`
- `.agentflow/`

## Release Boundaries

- Use graph-native terms: `graph`, `node`, `agent`, `exec`, `check`, `sequence`, `parallel`, `repeat`, `harness`, `profile`.
- Keep Agentflow lean and local-first.
- The CLI owns validation, compilation, launch, resume, and artifact inspection handoff in this release.
- Keep deferred items deferred: MCP sidecars, native harnesses, remote devboxes, a broad custom tool platform, and a full controller redesign.

## Validation

Run these from the repository root when the change affects behavior:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run validate:smoke`
