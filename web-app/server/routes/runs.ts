import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import {
  startRun,
  openRun,
  resumeRun,
  cancelRun,
  deriveRunCapabilities,
  getHandle,
  inspectRunResolution,
  inferHandleActive,
  inferActiveFromState,
  refreshHandleFromState,
  type RunHandle,
} from '../run_manager.ts';
import { isPathAllowed } from '../fs_access.ts';
import { readJsonFileWithRetries } from '../json_files.ts';
import { resolvePreferredRawOutputSource } from '../raw_output.ts';

function artifactItemsForRow(row: Record<string, unknown>) {
  const items = [
    { key: 'prompt', label: 'Prompt', path: String(row.promptPath || '') },
    { key: 'log', label: 'Execution Log', path: String(row.logPath || '') },
    { key: 'message', label: 'Last Message / Stdout', path: String(row.lastMessagePath || '') },
    { key: 'report', label: 'Report', path: String(row.reportPath || '') },
    { key: 'summary', label: 'Summary', path: String(row.summaryPath || '') },
  ];
  const taskArtifactPath = [
    row.promptPath,
    row.logPath,
    row.lastMessagePath,
    row.reportPath,
    row.summaryPath,
  ].find((value) => typeof value === 'string' && value.length > 0);
  const taskDir = typeof taskArtifactPath === 'string' ? path.dirname(taskArtifactPath) : null;
  if (taskDir) {
    items.push(
      { key: 'result', label: 'Command Result', path: path.resolve(taskDir, 'command_result.json') },
      { key: 'worker_report', label: 'Worker Report', path: path.resolve(taskDir, 'worker_report.md') },
      { key: 'worker_summary', label: 'Worker Summary', path: path.resolve(taskDir, 'worker_summary.md') },
    );
  }
  const seenPaths = new Set<string>();
  return items
    .filter((item) => item.path)
    .filter((item) => isPathAllowed(item.path))
    .filter((item) => {
      if (seenPaths.has(item.path)) return false;
      seenPaths.add(item.path);
      return true;
    })
    .map((item) => ({
      ...item,
      exists: fs.existsSync(item.path),
    }))
    .filter((item) => item.exists);
}

async function describeRunResolutionMatch(runDir: string) {
  const statePath = path.resolve(runDir, 'run_state.json');
  const state = await readJsonFileWithRetries<Record<string, unknown>>(statePath);
  return {
    runDir,
    planPath: typeof state?.configPath === 'string' ? state.configPath : null,
    updatedAtUtc: typeof state?.updatedAtUtc === 'string' ? state.updatedAtUtc : null,
  };
}

async function readHandleState(handle: RunHandle): Promise<Record<string, unknown> | null> {
  const statePath = path.resolve(handle.runDir, 'run_state.json');
  const state = await readJsonFileWithRetries<Record<string, unknown>>(statePath);
  if (state) {
    refreshHandleFromState(handle, state);
    return state;
  }
  return handle.lastKnownState ? { ...handle.lastKnownState } : null;
}

async function readHandleTrace(handle: RunHandle): Promise<Array<Record<string, unknown>>> {
  const tracePath = path.resolve(handle.runDir, 'decision_trace.json');
  if (!fs.existsSync(tracePath)) {
    return Array.isArray(handle.lastKnownDecisionTrace)
      ? [...handle.lastKnownDecisionTrace]
      : [];
  }
  const trace = await readJsonFileWithRetries<Array<Record<string, unknown>>>(tracePath);
  if (Array.isArray(trace)) {
    handle.lastKnownDecisionTrace = trace;
    return trace;
  }
  return Array.isArray(handle.lastKnownDecisionTrace)
    ? [...handle.lastKnownDecisionTrace]
    : [];
}

async function readRunTrace(
  runDir: string,
): Promise<Array<Record<string, unknown>>> {
  const tracePath = path.resolve(runDir, 'decision_trace.json');
  if (!fs.existsSync(tracePath)) return [];
  const trace = await readJsonFileWithRetries<Array<Record<string, unknown>>>(tracePath);
  return Array.isArray(trace) ? trace : [];
}

async function requireHandle(runId: string, reply: FastifyReply): Promise<RunHandle | null> {
  const resolution = inspectRunResolution(runId);
  if (resolution.kind === 'resolved') return resolution.handle;
  if (resolution.kind === 'ambiguous') {
    const matches = await Promise.all(resolution.runDirs.map((runDir) => describeRunResolutionMatch(runDir)));
    matches.sort((left, right) => String(right.updatedAtUtc || '').localeCompare(String(left.updatedAtUtc || '')));
    await reply.code(409).send({
      error: 'run_id_ambiguous',
      runId,
      matches,
    });
    return null;
  }
  await reply.code(404).send({ error: 'run_not_found', runId });
  return null;
}

export default async function runsRouter(app: FastifyInstance): Promise<void> {
  (app as any).getHandle = getHandle;

  app.post('/start', async (req, reply) => {
    const body = req.body as any || {};
    const planPath = String(body.planPath || '');
    if (!planPath || !path.isAbsolute(planPath)) return reply.code(400).send({ error: 'absolute_plan_path_required' });
    if (!isPathAllowed(planPath)) return reply.code(403).send({ error: 'path_not_allowed' });
    if (!fs.existsSync(planPath)) return reply.code(404).send({ error: 'plan_not_found' });

    const settings = body.settings || {};
    const handle = await startRun({
      planPath,
      skipGitRepoCheck: Boolean(settings.skipGitRepoCheck),
      sandbox: settings.sandbox,
      dryRun: Boolean(settings.dryRun),
    });
    return { runId: handle.runId, runDir: handle.runDir };
  });

  app.post('/open', async (req, reply) => {
    const body = req.body as any || {};
    const runDir = String(body.runDir || '');
    if (!runDir || !path.isAbsolute(runDir)) return reply.code(400).send({ error: 'absolute_run_dir_required' });
    if (!isPathAllowed(runDir)) return reply.code(403).send({ error: 'path_not_allowed' });
    if (!fs.existsSync(path.resolve(runDir, 'run_state.json'))) return reply.code(404).send({ error: 'state_missing' });
    const handle = openRun(runDir);
    return { runId: handle.runId, runDir: handle.runDir };
  });

  app.get('/:runId/resolve', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const handle = await requireHandle(runId, reply);
    if (!handle) return reply;
    return {
      runId: handle.runId,
      runDir: handle.runDir,
      planPath: handle.planPath || null,
      isActive: handle.isActive,
    };
  });

  app.post('/resume', async (req, reply) => {
    const body = req.body as any || {};
    const runDir = String(body.runDir || '');
    if (!runDir || !path.isAbsolute(runDir)) return reply.code(400).send({ error: 'absolute_run_dir_required' });
    if (!isPathAllowed(runDir)) return reply.code(403).send({ error: 'path_not_allowed' });
    const statePath = path.resolve(runDir, 'run_state.json');
    if (!fs.existsSync(statePath)) return reply.code(404).send({ error: 'state_missing' });
    const state = await readJsonFileWithRetries<Record<string, unknown>>(statePath) || null;
    if (!state) return reply.code(503).send({ error: 'state_unavailable' });
    const trace = await readRunTrace(runDir);
    const existing = state.runId ? getHandle(String(state.runId)) : undefined;
    const capabilities = deriveRunCapabilities(existing, state, trace);
    if (!capabilities.canResume) {
      const isActive = existing
        ? inferHandleActive(existing, state, trace)
        : inferActiveFromState(state, trace);
      return reply.code(409).send({ error: isActive ? 'run_already_active' : 'run_not_resumable' });
    }
    const settings = body.settings || {};
    const handle = await resumeRun({
      runDir,
      planPath: body.planPath,
      skipGitRepoCheck: Boolean(settings.skipGitRepoCheck),
      sandbox: settings.sandbox,
      dryRun: Boolean(settings.dryRun),
    });
    return { runId: handle.runId, runDir: handle.runDir };
  });

  // Convenience: resume by runId (derive runDir + planPath from state)
  app.post('/:runId/resume', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const handle = await requireHandle(runId, reply);
    if (!handle) return reply;
    const statePath = path.resolve(handle.runDir, 'run_state.json');
    if (!fs.existsSync(statePath)) return reply.code(404).send({ error: 'state_missing' });
    const state = await readHandleState(handle);
    if (!state) return reply.code(503).send({ error: 'state_unavailable' });
    const trace = await readHandleTrace(handle);
    const capabilities = deriveRunCapabilities(handle, state, trace);
    if (!capabilities.canResume) {
      const isActive = inferHandleActive(handle, state, trace);
      return reply.code(409).send({ error: isActive ? 'run_already_active' : 'run_not_resumable' });
    }
    const inferredPlan = String(state.configPath || handle.planPath || '');
    if (!inferredPlan) return reply.code(400).send({ error: 'plan_missing' });
    const body = req.body as any || {};
    const settings = body.settings || {};
    const resumed = await resumeRun({ runDir: handle.runDir, planPath: inferredPlan, skipGitRepoCheck: Boolean(settings.skipGitRepoCheck), sandbox: settings.sandbox, dryRun: Boolean(settings.dryRun) });
    return { runId: resumed.runId, runDir: resumed.runDir };
  });

  app.post('/cancel', async (req, reply) => {
    const body = req.body as any || {};
    const runId = String(body.runId || '');
    if (!runId) return reply.code(400).send({ error: 'runId_required' });
    const handle = await requireHandle(runId, reply);
    if (!handle) return reply;
    if (!handle.isActive) return reply.code(409).send({ error: 'run_not_active' });
    if (!handle.child) return reply.code(409).send({ error: 'run_not_controllable' });
    const ok = await cancelRun(runId);
    if (!ok) return reply.code(409).send({ error: 'run_not_active' });
    return { ok: true };
  });

  app.get('/:runId/state', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const handle = await requireHandle(runId, reply);
    if (!handle) return reply;
    const p = path.resolve(handle.runDir, 'run_state.json');
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'state_missing' });
    const state = await readHandleState(handle);
    if (!state) return reply.code(503).send({ error: 'state_unavailable' });
    const trace = await readHandleTrace(handle);
    const isActive = inferHandleActive(handle, state, trace);
    const capabilities = deriveRunCapabilities(handle, state, trace);
    if (trace.length > 0) state.decisionTrace = trace.slice(-50);
    return {
      ...state,
      runDir: handle.runDir,
      planPath: handle.planPath || null,
      isActive,
      cancelRequested: handle.child ? handle.cancelRequested : Boolean(state.cancelRequested ?? handle.cancelRequested),
      canCancel: capabilities.canCancel,
      canResume: capabilities.canResume,
      lastExitCode: handle.lastExitCode,
      recentConsole: handle.recentConsole,
    };
  });

  app.get('/:runId/trace', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const handle = await requireHandle(runId, reply);
    if (!handle) return reply;
    return reply.code(200).send(await readHandleTrace(handle));
  });

  app.get('/:runId/logs/:taskKey', async (req, reply) => {
    const { runId, taskKey } = req.params as { runId: string; taskKey: string };
    const handle = await requireHandle(runId, reply);
    if (!handle) return reply;
    const statePath = path.resolve(handle.runDir, 'run_state.json');
    if (!fs.existsSync(statePath)) return reply.code(404).send({ error: 'state_missing' });
    const state = await readHandleState(handle);
    if (!state) return reply.code(503).send({ error: 'state_unavailable' });
    const tasks = (state.tasks as Record<string, Record<string, unknown>> | undefined) || undefined;
    const row = tasks?.[taskKey];
    const source = row ? resolvePreferredRawOutputSource(row) : null;
    if (!source) return reply.code(404).send({ error: 'log_not_found' });
    if (!isPathAllowed(source.path)) return reply.code(403).send({ error: 'path_not_allowed' });
    try {
      const text = fs.readFileSync(source.path, 'utf8');
      return reply.type('text/plain').send(text);
    } catch {
      return reply.code(500).send({ error: 'read_failed' });
    }
  });

  app.get('/:runId/artifacts/:taskKey', async (req, reply) => {
    const { runId, taskKey } = req.params as { runId: string; taskKey: string };
    const handle = await requireHandle(runId, reply);
    if (!handle) return reply;
    const statePath = path.resolve(handle.runDir, 'run_state.json');
    if (!fs.existsSync(statePath)) return reply.code(404).send({ error: 'state_missing' });
    const state = await readHandleState(handle);
    if (!state) return reply.code(503).send({ error: 'state_unavailable' });
    const tasks = (state.tasks as Record<string, Record<string, unknown>> | undefined) || undefined;
    const row = tasks?.[taskKey];
    if (!row) return reply.code(404).send({ error: 'task_not_found' });
    return { items: artifactItemsForRow(row) };
  });

  app.get('/:runId/console', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const handle = await requireHandle(runId, reply);
    if (!handle) return reply;
    return { entries: handle.recentConsole };
  });
}
