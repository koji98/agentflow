# Agentflow Web App

Local Fastify bridge + Vite/React monitor UI.

- Dev: `npm run dev` (starts Fastify :3208 and Vite :5173 via proxy)
- Build: `npm run build`
- Start (prod): `npm run start` -> serves built client from Fastify

APIs
- `/api/fs/*` in-app file browser (dotfiles allowed)
- `/api/plan/inspect` plan inspection and context inference
- `/api/runs/*` start/open/resume/cancel + state/trace/logs/artifacts
- `/api/stream/run/:id/events` run SSE; `/api/stream/run/:id/tail?taskKey=...` log tail SSE

Tests
- `npm test` (Vitest)

