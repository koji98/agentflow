import type { RunArtifactItem, RunStateResponse } from '../../../shared/contracts/monitor.ts';

export type UiRunStatus = 'IDLE' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface ExecutableRow {
  taskKey: string;
  taskId: string;
  nodePath: string;
  attempt: number;
  status: string;
  promptPath?: string;
  logPath?: string;
  reportPath?: string;
  summaryPath?: string;
  lastMessagePath?: string;
  startedAtUtc?: string;
  endedAtUtc?: string;
  durationSec?: number;
  failureReason?: string | null;
  [key: string]: unknown;
}

export interface WorkflowGraphItem {
  graphId: string;
  workflowId: string;
  type: string;
  label: string;
  depth: number;
  order: number;
  raw: Record<string, unknown>;
  status: string;
  subtitle: string;
  // Optional: parent chain for breadcrumbs in lightweight preview
  ancestors?: Array<{ workflowId: string; type: string; label: string }>;
}

export interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  animated?: boolean;
}

export interface JudgeEvaluation {
  iteration: number;
  phase: string;
  score: number | null;
  passed: boolean;
  reasons: string[];
  atUtc: string;
}

export interface ParsedLogActivityEvent {
  id: string;
  kind: 'system' | 'prompt' | 'thinking' | 'assistant' | 'tool' | 'file' | 'usage';
  title: string;
  body: string;
}

function statusRank(status: string): number {
  if (status === 'RUNNING') return 0;
  if (status === 'FAILED') return 1;
  if (status === 'PENDING') return 2;
  if (status === 'DONE') return 3;
  return 4;
}

function cancellationLikeReason(reason: string): boolean {
  return reason.includes('signal:SIGINT')
    || reason.includes('signal:SIGTERM')
    || reason.includes('cancelled')
    || reason.includes('canceled');
}

function rowLooksCancelled(row: ExecutableRow): boolean {
  return cancellationLikeReason(String(row.failureReason || ''));
}

const ANSI_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function clipActivityBody(text: string, maxChars = 1600): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n…`;
}

function markerForLine(
  line: string,
): { kind: ParsedLogActivityEvent['kind']; title: string; body?: string } | null {
  if (!line) return null;
  if (line === 'user') return { kind: 'prompt', title: 'Prompt sent to the agent' };
  if (line === 'thinking') return { kind: 'thinking', title: 'Reasoning summary' };
  if (line === 'codex' || line === 'cursor') return { kind: 'assistant', title: 'Agent update' };
  if (line === 'exec') return { kind: 'tool', title: 'Tool call' };
  if (line === 'file update' || line === 'file update:') return { kind: 'file', title: 'File update' };
  if (line === 'tokens used') return { kind: 'usage', title: 'Token usage' };
  if (line.startsWith('mcp startup:')) {
    return {
      kind: 'system',
      title: 'MCP startup',
      body: line.replace(/^mcp startup:\s*/, ''),
    };
  }
  return null;
}

function pushParsedEvent(
  events: ParsedLogActivityEvent[],
  id: string,
  kind: ParsedLogActivityEvent['kind'],
  title: string,
  lines: string[],
  inlineBody?: string,
) {
  const body = clipActivityBody([inlineBody, ...lines].filter(Boolean).join('\n'));
  if (!body) return;
  events.push({ id, kind, title, body });
}

export function parseLogActivityEvents(logText: string): ParsedLogActivityEvent[] {
  const cleaned = stripAnsi(logText).replace(/\r/g, '');
  if (!cleaned.trim()) return [];

  const lines = cleaned.split('\n');
  const events: ParsedLogActivityEvent[] = [];
  const prelude: string[] = [];
  let current:
    | {
        id: string;
        kind: ParsedLogActivityEvent['kind'];
        title: string;
        lines: string[];
        inlineBody?: string;
      }
    | null = null;
  let index = 0;

  const flushCurrent = () => {
    if (!current) return;
    pushParsedEvent(events, current.id, current.kind, current.title, current.lines, current.inlineBody);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const marker = markerForLine(line.trim());
    if (marker) {
      if (!current && prelude.length > 0) {
        pushParsedEvent(events, `event-${index}`, 'system', 'Execution session', prelude);
        prelude.length = 0;
        index += 1;
      } else {
        flushCurrent();
      }
      current = {
        id: `event-${index}`,
        kind: marker.kind,
        title: marker.title,
        lines: [],
        inlineBody: marker.body,
      };
      index += 1;
      continue;
    }

    if (current) current.lines.push(line);
    else prelude.push(line);
  }

  flushCurrent();
  if (prelude.length > 0) {
    pushParsedEvent(events, `event-${index}`, 'system', 'Execution session', prelude);
  }

  return events.filter((event) => event.body.trim().length > 0);
}

export function getPlanFlow(plan: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!plan) return [];
  const flow = (plan.workflow || plan.flow) as unknown;
  return Array.isArray(flow) ? (flow as Record<string, unknown>[]) : [];
}

export function isLoopNode(type: string): boolean {
  return type === 'while' || type === 'loop' || type === 'loop_judge';
}

export function isActionableNode(type: string): boolean {
  return type === 'task' || type === 'command';
}

export function formatLoopJudgeRubricPreview(rubric: unknown): string {
  if (typeof rubric === 'string') return rubric.trim();
  if (!rubric || typeof rubric !== 'object') return '';

  const criteria = Array.isArray((rubric as any).criteria)
    ? ((rubric as any).criteria as Array<Record<string, unknown>>)
    : [];
  if (criteria.length === 0) {
    return JSON.stringify(rubric, null, 2);
  }

  return criteria
    .map((criterion) => {
      const label = String(criterion.label || criterion.id || 'criterion');
      const weight = criterion.weight !== undefined ? ` (${String(criterion.weight)})` : '';
      const guidance = criterion.guidance ? `: ${String(criterion.guidance)}` : '';
      return `- ${label}${weight}${guidance}`;
    })
    .join('\n');
}

export function deriveRunStatus(state: RunStateResponse | null): UiRunStatus {
  if (!state) return 'IDLE';

  const taskRows = Object.values((state.tasks as Record<string, ExecutableRow>) || {});
  const runFailureReasons = Array.isArray(state.runFailureReasons)
    ? state.runFailureReasons.map((reason) => String(reason))
    : [];
  if (state.isActive) return 'RUNNING';

  const failures = Number(state.totalFailureCount || 0);
  const failedRows = taskRows.filter((row) => String(row.status) === 'FAILED');
  const hasFailures = failures > 0 || failedRows.length > 0 || runFailureReasons.length > 0;
  const cancellationMarked = Boolean(state.cancelRequested)
    || runFailureReasons.some((reason) => cancellationLikeReason(reason));
  const allFailuresLookCancelled = hasFailures
    && failedRows.length > 0
    && failedRows.every((row) => rowLooksCancelled(row))
    && runFailureReasons.every((reason) => cancellationLikeReason(reason));
  if (hasFailures) {
    if (cancellationMarked && allFailuresLookCancelled) return 'CANCELLED';
    return 'FAILED';
  }
  if (cancellationMarked) return 'CANCELLED';

  const doneRows = taskRows.filter((row) => String(row.status) === 'DONE');
  if (taskRows.length > 0 && doneRows.length === taskRows.length) return 'DONE';
  return 'IDLE';
}

export function countTotals(state: RunStateResponse | null) {
  const taskRows = Object.values((state?.tasks as Record<string, ExecutableRow>) || {});
  const summary = { tasks: taskRows.length, running: 0, done: 0, failed: 0, pending: 0 };
  for (const row of taskRows) {
    const status = String(row.status || 'PENDING');
    if (status === 'RUNNING') summary.running += 1;
    else if (status === 'DONE') summary.done += 1;
    else if (status === 'FAILED') summary.failed += 1;
    else summary.pending += 1;
  }
  return summary;
}

export function getLatestTaskRow(state: RunStateResponse | null, workflowId: string | null): ExecutableRow | null {
  if (!state || !workflowId || !state.tasks) return null;
  let match: ExecutableRow | null = null;
  for (const row of Object.values(state.tasks as Record<string, ExecutableRow>)) {
    if (String(row.taskId) !== workflowId) continue;
    if (!match || Number(row.attempt || 0) >= Number(match.attempt || 0)) {
      match = row;
    }
  }
  return match;
}

function compareExecutableRows(a: ExecutableRow, b: ExecutableRow): number {
  const statusDelta = statusRank(String(a.status || '')) - statusRank(String(b.status || ''));
  if (statusDelta !== 0) return statusDelta;
  const attemptDelta = Number(b.attempt || 0) - Number(a.attempt || 0);
  if (attemptDelta !== 0) return attemptDelta;
  const endA = a.endedAtUtc ? Date.parse(String(a.endedAtUtc)) : 0;
  const endB = b.endedAtUtc ? Date.parse(String(b.endedAtUtc)) : 0;
  if (endA !== endB) return endB - endA;
  const startA = a.startedAtUtc ? Date.parse(String(a.startedAtUtc)) : 0;
  const startB = b.startedAtUtc ? Date.parse(String(b.startedAtUtc)) : 0;
  return startB - startA;
}

function descendantExecutableIds(node: Record<string, unknown>): string[] {
  const type = String(node.type || '');
  if (type === 'task') return [String(node.taskId || node.id || '')].filter(Boolean);
  if (type === 'command') return [String(node.id || '')].filter(Boolean);
  const children = Array.isArray(node.steps)
    ? (node.steps as Record<string, unknown>[])
    : Array.isArray(node.body)
      ? (node.body as Record<string, unknown>[])
      : [];
  return children.flatMap((child) => descendantExecutableIds(child));
}

export function getRepresentativeTaskRow(
  state: RunStateResponse | null,
  selectedNode: WorkflowGraphItem | null,
): ExecutableRow | null {
  if (!state || !selectedNode) return null;

  const direct = getLatestTaskRow(state, selectedNode.workflowId);
  if (direct) return direct;

  const descendantRows = descendantExecutableIds(selectedNode.raw || {})
    .map((workflowId) => getLatestTaskRow(state, workflowId))
    .filter(Boolean) as ExecutableRow[];
  if (descendantRows.length === 0) return null;
  return [...descendantRows].sort(compareExecutableRows)[0] || null;
}

export function pickInitialGraphSelection(graph: {
  items: WorkflowGraphItem[];
}): string | null {
  if (graph.items.length === 0) return null;
  const actionable = graph.items.filter((item) => isActionableNode(item.type));
  const candidates = actionable.length > 0 ? actionable : graph.items;
  return [...candidates]
    .sort((a, b) => {
      const statusDelta = statusRank(String(a.status || '')) - statusRank(String(b.status || ''));
      if (statusDelta !== 0) return statusDelta;
      return a.order - b.order;
    })[0]?.graphId || null;
}

function summarizeCompositeStatus(node: Record<string, unknown>, state: RunStateResponse | null, trace: Array<Record<string, unknown>>) {
  const type = String(node.type || '');
  const workflowId = String(node.id || '');
  if (isLoopNode(type)) {
    const evaluations = collectJudgeEvaluations(trace, workflowId);
    const exhausted = trace.some((entry) => {
      const detail = (entry.detail || {}) as Record<string, unknown>;
      return String(entry.type) === 'while_exhausted' && String(detail.whileId || '') === workflowId;
    });
    const satisfied = trace.some((entry) => {
      const detail = (entry.detail || {}) as Record<string, unknown>;
      return String(entry.type) === 'while_satisfied' && String(detail.whileId || '') === workflowId;
    });
    if (satisfied) return 'DONE';
    if (exhausted) return 'FAILED';
    if (evaluations.length > 0 && state?.isActive) return 'RUNNING';
  }

  const rows = descendantExecutableIds(node)
    .map((taskId) => getLatestTaskRow(state, taskId))
    .filter(Boolean) as ExecutableRow[];
  if (rows.some((row) => String(row.status) === 'FAILED')) return 'FAILED';
  if (rows.some((row) => String(row.status) === 'RUNNING')) return 'RUNNING';
  if (rows.length > 0 && rows.every((row) => String(row.status) === 'DONE')) return 'DONE';
  return 'PENDING';
}

function nodeStatus(node: Record<string, unknown>, state: RunStateResponse | null, trace: Array<Record<string, unknown>>) {
  const type = String(node.type || '');
  if (type === 'task') return getLatestTaskRow(state, String(node.taskId || node.id || ''))?.status || 'PENDING';
  if (type === 'command') return getLatestTaskRow(state, String(node.id || ''))?.status || 'PENDING';
  return summarizeCompositeStatus(node, state, trace);
}

function nodeLabel(node: Record<string, unknown>) {
  const type = String(node.type || '');
  if (type === 'task') return String(node.taskId || node.id || 'task');
  return String(node.id || type || 'node');
}

function nodeSubtitle(node: Record<string, unknown>) {
  const type = String(node.type || '');
  if (type === 'task') return String(node.prompt || '').slice(0, 80);
  if (type === 'command') {
    const command = [String(node.command || ''), ...((node.args as string[]) || [])].filter(Boolean).join(' ');
    return command.slice(0, 96);
  }
  if (isLoopNode(type)) {
    return type === 'loop_judge'
      ? `Pass threshold ${String(node.pass_threshold ?? node.passThreshold ?? 'n/a')}`
      : `Max iterations ${String(node.max_iterations ?? node.maxIterations ?? 'n/a')}`;
  }
  return String(type).toUpperCase();
}

export function buildWorkflowGraph(plan: Record<string, unknown> | null, state: RunStateResponse | null, trace: Array<Record<string, unknown>>) {
  const items: WorkflowGraphItem[] = [];
  const edges: WorkflowGraphEdge[] = [];
  let order = 0;

  const walk = (
    nodes: Record<string, unknown>[],
    depth: number,
    parentGraphId: string | null,
    sequential: boolean,
    ancestors: Array<{ workflowId: string; type: string; label: string }>,
  ): { firstId: string | null; lastId: string | null } => {
    let firstId: string | null = null;
    let previousId: string | null = null;

    for (const node of nodes) {
      const workflowId = nodeLabel(node);
      const graphId = `${workflowId}:${depth}:${order}`;
      const item: WorkflowGraphItem = {
        graphId,
        workflowId,
        type: String(node.type || 'node'),
        label: workflowId,
        depth,
        order,
        raw: node,
        status: String(nodeStatus(node, state, trace)),
        subtitle: nodeSubtitle(node),
        ancestors,
      };
      order += 1;
      items.push(item);
      if (!firstId) firstId = graphId;

      if (parentGraphId) {
        edges.push({
          id: `${parentGraphId}->${graphId}`,
          source: parentGraphId,
          target: graphId,
          animated: item.status === 'RUNNING',
        });
      }
      if (previousId && sequential) {
        edges.push({
          id: `${previousId}->${graphId}`,
          source: previousId,
          target: graphId,
          animated: item.status === 'RUNNING',
        });
      }

      if (String(node.type) === 'group' && Array.isArray(node.steps)) {
        const nextAncestors = [...ancestors, { workflowId: item.workflowId, type: item.type, label: item.label }];
        walk(node.steps as Record<string, unknown>[], depth + 1, graphId, !Boolean(node.parallel), nextAncestors);
      }
      if (isLoopNode(String(node.type)) && Array.isArray(node.body)) {
        const nextAncestors = [...ancestors, { workflowId: item.workflowId, type: item.type, label: item.label }];
        const body = walk(node.body as Record<string, unknown>[], depth + 1, graphId, true, nextAncestors);
        if (body.lastId) {
          edges.push({
            id: `${body.lastId}->${graphId}:loop`,
            source: body.lastId,
            target: graphId,
            label: 'retry',
            animated: item.status === 'RUNNING',
          });
        }
      }

      previousId = graphId;
    }

    return { firstId, lastId: previousId };
  };

  walk(getPlanFlow(plan), 0, null, true, []);
  const nodeByWorkflowId = new Map(items.map((item) => [item.workflowId, item]));
  return { items, edges, nodeByWorkflowId };
}

export function collectJudgeEvaluations(trace: Array<Record<string, unknown>>, workflowId: string): JudgeEvaluation[] {
  return trace
    .filter((entry) => {
      const detail = (entry.detail || {}) as Record<string, unknown>;
      return String(entry.type) === 'while_gate_evaluation'
        && String(detail.whileId || '') === workflowId;
    })
    .map((entry) => {
      const detail = (entry.detail || {}) as Record<string, unknown>;
      return {
        iteration: Number(detail.iteration || 0),
        phase: String(detail.phase || 'unknown'),
        score: detail.score === null || detail.score === undefined ? null : Number(detail.score),
        passed: detail.passed === true,
        reasons: Array.isArray(detail.reasons) ? detail.reasons.map((reason) => String(reason)) : [],
        atUtc: String(entry.atUtc || ''),
      };
    });
}

export function buildJudgeChartData(trace: Array<Record<string, unknown>>, workflowId: string) {
  return collectJudgeEvaluations(trace, workflowId)
    .filter((entry) => entry.score !== null)
    .map((entry) => ({
      step: `${entry.iteration}-${entry.phase === 'post_body' ? 'post' : 'pre'}`,
      score: Number(entry.score || 0),
    }));
}

export function filterTraceForNode(trace: Array<Record<string, unknown>>, workflowId: string | null) {
  if (!workflowId) return [...trace].reverse();
  return [...trace]
    .filter((entry) => {
      const detail = (entry.detail || {}) as Record<string, unknown>;
      return String(detail.taskId || '') === workflowId
        || String(detail.whileId || '') === workflowId
        || String(detail.gateId || '') === workflowId
        || String(entry.nodePath || '').includes(workflowId);
    })
    .reverse();
}

export function formatTraceEntry(entry: Record<string, unknown>) {
  const detail = (entry.detail || {}) as Record<string, unknown>;
  const type = String(entry.type || '');
  if (type === 'while_gate_evaluation') {
    return `${String(detail.phase || 'phase')} evaluation · score ${String(detail.score ?? '—')} · ${detail.passed === true ? 'passed' : 'retry'}`;
  }
  if (type === 'task_retry') {
    return `Retry ${String(detail.taskId || '')} from attempt ${String(detail.attempt || '')} to ${String(detail.nextAttempt || '')}`;
  }
  if (type === 'while_satisfied') {
    return `Loop satisfied at ${String(detail.phase || '')}`;
  }
  if (type === 'while_exhausted') {
    return `Loop exhausted after ${String(detail.maxIterations || '')} iterations`;
  }
  if (type === 'termination_guard') {
    return `Termination guard: ${String(detail.reason || '')}`;
  }
  return type;
}

export function artifactPreviewLabel(item: RunArtifactItem) {
  return item.label || item.key;
}

export function activitySparkline(trace: Array<Record<string, unknown>>) {
  if (trace.length === 0) return [0];
  let running = 0;
  return trace.slice(-18).map((entry) => {
    const type = String(entry.type || '');
    if (type === 'while_iteration_started') running += 1;
    if (type === 'while_satisfied' || type === 'while_exhausted') running = Math.max(0, running - 1);
    return running;
  });
}

// Lightweight prompt / command preview for pre-run walkthrough
export function requestPreviewForWorkflowItem(selectedNode: WorkflowGraphItem): string {
  const raw = selectedNode.raw || {};
  const type = String(selectedNode.type);
  if (type === 'task') return String((raw as any).prompt || '').trim();
  if (type === 'command') {
    const args = Array.isArray((raw as any).args) ? ((raw as any).args as string[]) : [];
    return [String((raw as any).command || ''), ...args].filter(Boolean).join(' ');
  }
  if (type === 'loop_judge') {
    return formatLoopJudgeRubricPreview((raw as any).rubric || (raw as any).judge_rubric);
  }
  if (type === 'while' || type === 'loop') {
    return `Max iterations: ${String((raw as any).max_iterations ?? (raw as any).maxIterations ?? 'n/a')}`;
  }
  return '';
}
