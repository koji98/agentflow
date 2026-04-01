import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { startRun, openRun, resumeRun, cancelRun, getHandle } from '../run_manager.ts';
import { isPathAllowed } from '../fs_access.ts';

function artifactItemsForRow(row: Record<string, unknown>) {
  const items = [
    { key: 'prompt', label: 'Prompt', path: String(row.promptPath || '') },
    { key: 'log', label: 'Execution Log', path: String(row.logPath || '') },
    { key: 'message', label: 'Last Message / Stdout', path: String(row.lastMessagePath || '') },
    { key: 'report', label: 'Report', path: String(row.reportPath || '') },
    { key: 'summary', label: 'Summary', path: String(row.summaryPath || '') },
  ];
  const taskDir = typeof row.promptPath === 'string' ? path.dirname(row.promptPath) : null;
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

  app.post('/resume', async (req, reply) => {
    const body = req.body as any || {};
    const runDir = String(body.runDir || '');
    if (!runDir || !path.isAbsolute(runDir)) return reply.code(400).send({ error: 'absolute_run_dir_required' });
    if (!isPathAllowed(runDir)) return reply.code(403).send({ error: 'path_not_allowed' });
    if (!fs.existsSync(path.resolve(runDir, 'run_state.json'))) return reply.code(404).send({ error: 'state_missing' });
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
    const handle = getHandle(runId);
    if (!handle) return reply.code(404).send({ error: 'run_not_open' });
    const statePath = path.resolve(handle.runDir, 'run_state.json');
    if (!fs.existsSync(statePath)) return reply.code(404).send({ error: 'state_missing' });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as any;
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
    const ok = await cancelRun(runId);
    if (!ok) return reply.code(409).send({ error: 'cancel_incomplete' });
    return { ok: true };
  });

  app.get('/:runId/state', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const handle = getHandle(runId);
    if (!handle) return reply.code(404).send({ error: 'run_not_open' });
    const p = path.resolve(handle.runDir, 'run_state.json');
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'state_missing' });
    const text = fs.readFileSync(p, 'utf8');
    const state = JSON.parse(text);
    // Attach a small tail of decision trace for clients that need meta without SSE
    const tracePath = path.resolve(handle.runDir, 'decision_trace.json');
    if (fs.existsSync(tracePath)) {
      try {
        const arr = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
        if (Array.isArray(arr)) state.decisionTrace = arr.slice(-50);
      } catch {}
    }
    return {
      ...state,
      runDir: handle.runDir,
      planPath: handle.planPath || null,
      isActive: handle.isActive,
      cancelRequested: handle.cancelRequested,
      lastExitCode: handle.lastExitCode,
      recentConsole: handle.recentConsole,
    };
  });

  app.get('/:runId/trace', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const handle = getHandle(runId);
    if (!handle) return reply.code(404).send({ error: 'run_not_open' });
    const p = path.resolve(handle.runDir, 'decision_trace.json');
    if (!fs.existsSync(p)) return reply.code(200).send([]);
    const text = fs.readFileSync(p, 'utf8');
    try { return JSON.parse(text); } catch { return []; }
  });

  app.get('/:runId/logs/:taskKey', async (req, reply) => {
    const { runId, taskKey } = req.params as { runId: string; taskKey: string };
    const handle = getHandle(runId);
    if (!handle) return reply.code(404).send({ error: 'run_not_open' });
    const statePath = path.resolve(handle.runDir, 'run_state.json');
    if (!fs.existsSync(statePath)) return reply.code(404).send({ error: 'state_missing' });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as any;
    const row = state.tasks?.[taskKey];
    if (!row || !row.logPath) return reply.code(404).send({ error: 'log_not_found' });
    if (!isPathAllowed(String(row.logPath))) return reply.code(403).send({ error: 'path_not_allowed' });
    try { const text = fs.readFileSync(String(row.logPath), 'utf8'); return reply.type('text/plain').send(text); } catch { return reply.code(500).send({ error: 'read_failed' }); }
  });

  app.get('/:runId/artifacts/:taskKey', async (req, reply) => {
    const { runId, taskKey } = req.params as { runId: string; taskKey: string };
    const handle = getHandle(runId);
    if (!handle) return reply.code(404).send({ error: 'run_not_open' });
    const statePath = path.resolve(handle.runDir, 'run_state.json');
    if (!fs.existsSync(statePath)) return reply.code(404).send({ error: 'state_missing' });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as any;
    const row = state.tasks?.[taskKey];
    if (!row) return reply.code(404).send({ error: 'task_not_found' });
    return { items: artifactItemsForRow(row) };
  });

  app.get('/:runId/console', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const handle = getHandle(runId);
    if (!handle) return reply.code(404).send({ error: 'run_not_open' });
    return { entries: handle.recentConsole };
  });
}
