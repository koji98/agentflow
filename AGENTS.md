# Agent Notes

This repository is the current Agentflow workspace. Prefer the repository docs and source files when they disagree with stale notes or prior staging references.

## Hard Rules

- Do not add backwards-compatibility layers, migration aliases, legacy schema support, deprecated CLI paths, compatibility shims, or dual old/new behavior unless the user explicitly asks for them.
- Agentflow is still alpha. When refactoring or adding code, choose the best current design and move the repo toward that design directly.
- Remove or replace obsolete paths instead of preserving them. Update docs, skills, tests, examples, and validation scripts in the same change.
- Prefer one clear contract over multiple tolerated shapes. If an old surface conflicts with the desired current surface, delete the old surface.
- Do not preserve stale artifact formats, prompt shapes, event payloads, eval schemas, or supervisor internals for compatibility. Keep only the active contract documented in this repo.
- Keep the graph contract stable unless the user explicitly asks to change it.

## Read First

1. `README.md`: project overview, core runtime model, quick start, and repository map.
2. `docs/README.md`: documentation map; use this to choose the right product, technical, or example docs.
3. `docs/product/README.md`: workflow author/operator guidance; read for graph usage, evals, plugins, operations, and managed patterns.
4. `docs/product/patterns/README.md`: managed-pattern chooser; read before authoring or changing pattern-based workflows.
5. `docs/technical/README.md`: implementation map; read before changing runtime, context, supervisor, tooling, verification, or delivery internals.
6. `docs/examples/README.md`: runnable examples map; read when updating graph, eval, or plugin examples.

## Canonical Surface

Treat these paths as the source of truth for review, implementation, and validation:

- `docs/`
- `src/`
- `tests/`
- `scripts/validate-smoke.mjs`
- `scripts/validate-confidence.mjs`
- `scripts/validate-real-harness.mjs`
- `scripts/validate-real-evals.mjs`

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
- Tool capabilities are added through plugin-bundled CLI tools described in `docs/product/plugins.md`. Do not add alternate tool surfaces, MCP sidecars, native non-CLI harnesses, remote devboxes, or controller rewrites to this v1 contract.

## Validation

Run these from the repository root when the change affects behavior:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run validate:smoke`
