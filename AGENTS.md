# Agent Notes

This repository is the current Agentflow workspace. Prefer the repository docs and source files when they disagree with stale notes or prior staging references.

## Read First

1. `README.md`
2. `docs/SCOPE.md`
3. `docs/DEFERRED.md`
4. `docs/REPLACEMENT_READINESS.md`
5. `docs/TEST_CONFIDENCE.md`
6. `docs/OPERATIONS.md`
7. `docs/HANDOFF.md`
8. `docs/ARCHITECTURE.md`
9. `docs/UI_MODEL.md`
10. `docs/FILE_PLAN.md`

## Canonical Surface

Treat these paths as the source of truth for review, implementation, and validation:

- `docs/`
- `src/`
- `tests/`
- `web-app/client/src/`
- `web-app/scripts/`
- `web-app/server/`
- `web-app/shared/contracts/`
- `scripts/validate-smoke.mjs`

## Generated Or Installed State

Ignore these paths unless the change is explicitly about build or install behavior:

- `node_modules/`
- `web-app/node_modules/`
- `dist/`
- `web-app/dist/`
- `coverage/`
- `.vite/`
- `.agentflow/`

## Release Boundaries

- Use graph-native terms: `graph`, `node`, `agent`, `exec`, `check`, `sequence`, `parallel`, `repeat`, `harness`, `profile`.
- Keep Agentflow lean and local-first.
- The CLI owns run launch in this release.
- The web app validates, compiles, inspects, and monitors runs from durable artifacts.
- Keep deferred items deferred: MCP sidecars, native harnesses, remote devboxes, a broad custom tool platform, and a full controller redesign.

## Validation

Run these from the repository root when the change affects behavior:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run validate:smoke`
