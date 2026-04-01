import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { loadPayload, normalizePlan, resolveRepoRoots, resolveConfigPaths, countExecutableNodes, countWorkflowNodes } from '../../../src/lib/plan.ts';
import { isPathAllowed } from '../fs_access.ts';

function nearbyDocs(dir: string): string[] {
  const out = new Set<string>();
  const add = (p: string): void => { if (fs.existsSync(p)) out.add(path.resolve(p)); };
  add(path.resolve(dir, 'README.md'));
  add(path.resolve(dir, 'GUIDE.md'));
  const docsDir = path.resolve(dir, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const name of fs.readdirSync(docsDir)) {
      if (name.toLowerCase().endsWith('.md')) add(path.resolve(docsDir, name));
    }
  }
  return Array.from(out);
}

function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export function buildRunRootCandidates(
  planPath: string,
  configuredRunRoot: string,
  repoRoots: Record<string, string>,
): string[] {
  const planDir = path.dirname(planPath);
  return uniquePaths([
    path.resolve(planDir, configuredRunRoot),
    ...Object.values(repoRoots).flatMap((repoRoot) => [
      path.resolve(repoRoot, '.tmp', 'agentflow_runs'),
      path.resolve(repoRoot, 'tmp', 'agentflow_runs'),
    ]),
  ]);
}

export default async function planRouter(app: FastifyInstance): Promise<void> {
  app.get('/inspect', async (req, reply) => {
    const q = req.query as { path?: string };
    if (!q.path) return reply.code(400).send({ error: 'path_required' });
    const planPath = path.resolve(String(q.path));
    if (!isPathAllowed(planPath)) return reply.code(403).send({ error: 'path_not_allowed' });
    if (!fs.existsSync(planPath)) return reply.code(404).send({ error: 'not_found' });

    let valid = false;
    const errors: string[] = [];
    let planPreview: Record<string, unknown> | undefined;
    let reposSummary: Array<{ alias: string; root: string; exists: boolean; isGitRepo: boolean }> = [];
    let runRootCandidates: string[] = [];
    let contextFiles: Array<{ path: string; exists: boolean }> = [];
    let workflowSummary: any = { totalNodes: 0, executableCount: 0, tasks: [], commands: [], groups: [], loops: [] };

    try {
      const rawPayload = loadPayload(planPath);
      const plan = normalizePlan(rawPayload);
      valid = true;
      planPreview = rawPayload as Record<string, unknown>;
      const repoRoots = resolveRepoRoots(planPath, plan.repos);
      reposSummary = Object.entries(repoRoots).map(([alias, root]) => ({
        alias,
        root,
        exists: fs.existsSync(root),
        isGitRepo: fs.existsSync(path.resolve(root, '.git')),
      }));
      runRootCandidates = buildRunRootCandidates(planPath, plan.options.runRoot, repoRoots);
      const globals = plan.contextFiles || [];
      try { contextFiles = resolveConfigPaths(planPath, repoRoots, globals).map((p) => ({ path: p, exists: fs.existsSync(p) })); } catch (err) {
        contextFiles = globals.map((raw) => ({ path: raw, exists: false }));
        errors.push(String(err));
      }
      const tasks: string[] = [];
      const commands: string[] = [];
      const groups: string[] = [];
      const loops: Array<{ id: string; type: string; passThreshold?: number | null } > = [];
      const walk = (node: any): void => {
        if (node.type === 'task') tasks.push(String(node.taskId || node.id || 'task'));
        else if (node.type === 'command') commands.push(String(node.id || 'command'));
        else if (node.type === 'group') { groups.push(node.id); node.steps.forEach(walk); }
        else if (node.type === 'while' || node.type === 'loop' || node.type === 'loop_judge') {
          const passThreshold = node.pass_threshold
            ?? node.passThreshold
            ?? node.until?.scoreThreshold
            ?? null;
          loops.push({ id: node.id, type: node.type, passThreshold });
          node.body.forEach(walk);
        }
      };
      plan.workflow.forEach(walk);
      workflowSummary = {
        totalNodes: countWorkflowNodes(plan.workflow),
        executableCount: countExecutableNodes(plan.workflow),
        tasks,
        commands,
        groups,
        loops,
      };
    } catch (err) {
      valid = false;
      errors.push(String(err));
    }

    return {
      planPath,
      valid,
      errors,
      plan: planPreview,
      repos: reposSummary,
      runRootCandidates,
      contextFiles,
      nearbyDocs: Array.from(new Set([
        ...nearbyDocs(path.dirname(planPath)),
        ...reposSummary.flatMap((repo) => nearbyDocs(repo.root)),
      ])),
      workflow: workflowSummary,
    };
  });
}
