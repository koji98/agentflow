import type { RunArtifactItem, RunStateResponse } from '../../../shared/contracts/monitor.ts';
import {
  inferActiveFromStateSnapshot,
  inferResumableFromStateSnapshot,
} from '../../../shared/run_state.ts';

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
  phase?: string | null;
  metrics?: string[];
  parentWorkflowId?: string | null;
  childWorkflowIds?: string[];
  descendantWorkflowIds?: string[];
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

export interface TraceSnapshotPayload {
  entries?: Array<Record<string, unknown>>;
  nextLength?: number;
  startIndex?: number;
}

export type GraphFocusMode = 'full' | 'selected' | 'active' | 'failed' | 'collapse-completed';
export type GraphNodeEmphasis = 'primary' | 'context' | 'muted';
export type MonitorDetailTab = 'activity' | 'artifacts' | 'raw';

export interface WorkflowGraph {
  items: WorkflowGraphItem[];
  edges: WorkflowGraphEdge[];
  nodeByWorkflowId: Map<string, WorkflowGraphItem>;
  nodeByGraphId: Map<string, WorkflowGraphItem>;
}

export interface NodeSummary {
  identity: {
    nodeId: string;
    type: string;
    label: string;
    breadcrumb: string[];
  };
  stateNow: {
    status: string;
    phase: string | null;
    sinceAtUtc: string | null;
  };
  whyNow: {
    reasonCode: string;
    message: string;
    retryFailureReason?: string | null;
  };
  next: {
    transition: string;
    label: string;
    targetNodeIds: string[];
  };
  progressItems: Array<{ label: string; value: string }>;
  graphMetrics: string[];
  evidence: {
    summary: boolean;
    report: boolean;
    artifacts: number;
    logs: boolean;
    traceEvents: number;
  };
  alerts: string[];
  evidenceRow: ExecutableRow | null;
  followTarget: {
    descendant: boolean;
    workflowId: string;
    label: string;
    type: string;
    reason:
      | 'selected_node'
      | 'blocking_child'
      | 'active_child'
      | 'next_eligible_child'
      | 'active_body_child'
      | 'retry_target'
      | 'latest_descendant';
    description: string;
  } | null;
  group?: {
    totalChildren: number;
    doneChildren: number;
    runningChildren: number;
    failedChildren: number;
    pendingChildren: number;
    activeChildId: string | null;
    activeChildLabel: string | null;
    blockingChildId: string | null;
    blockingChildLabel: string | null;
    nextEligibleChildId: string | null;
    nextEligibleChildLabel: string | null;
    mode: 'parallel' | 'serial';
  };
  judge?: {
    phase: string;
    score: number | null;
    threshold: number | null;
    result: string;
    reasons: string[];
    atUtc: string | null;
  };
  loop?: {
    activeBodyChildId: string | null;
    activeBodyChildLabel: string | null;
    failedBodyChildId: string | null;
    failedBodyChildLabel: string | null;
  };
  retry?: {
    attempt: number;
    previousAttempts: number;
    latestFailureReason: string | null;
    state: 'scheduled' | 'in_progress' | 'exhausted' | 'resolved';
    nextTarget: string | null;
  };
}

export interface SelectedNodeNarrative {
  selectedScopeLabel: string;
  evidenceScopeLabel: string;
  evidenceScopeIsDescendant: boolean;
  relationshipHeadline: string;
  relationshipDetail: string;
  stageHandoff: string;
  detailPanelDescription: string;
  layers: Record<MonitorDetailTab | 'overview', string>;
  extractsSurfaceLabel: string;
  extractsTitle: string;
  extractsDescription: string;
}

export interface FocusedWorkflowGraph {
  items: WorkflowGraphItem[];
  edges: WorkflowGraphEdge[];
  emphasis: Map<string, GraphNodeEmphasis>;
  focusCount: number;
  counts: {
    visible: number;
    hidden: number;
    primary: number;
    context: number;
    muted: number;
  };
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

function describeEvidenceScope(summary: NodeSummary): string {
  const followTarget = summary.followTarget;
  if (!followTarget?.descendant) {
    return 'Artifacts and raw logs stay attached to the selected node.';
  }

  const label = followTarget.label;
  if (followTarget.reason === 'blocking_child') {
    return `Artifacts and raw logs follow blocking child ${label}.`;
  }
  if (followTarget.reason === 'active_child') {
    return `Artifacts and raw logs follow active child ${label}.`;
  }
  if (followTarget.reason === 'next_eligible_child') {
    return `Artifacts and raw logs follow next eligible child ${label}.`;
  }
  if (followTarget.reason === 'active_body_child') {
    return `Artifacts and raw logs follow current body child ${label}.`;
  }
  if (followTarget.reason === 'retry_target') {
    return `Artifacts and raw logs follow retry target ${label}.`;
  }
  return `Artifacts and raw logs follow the latest actionable child ${label}.`;
}

export function buildSelectedNodeNarrative(summary: NodeSummary): SelectedNodeNarrative {
  const selectedScopeLabel = summary.identity.label;
  const evidenceScopeLabel = summary.followTarget?.label || selectedScopeLabel;
  const evidenceScopeIsDescendant = Boolean(summary.followTarget?.descendant);
  const relationshipDetail = describeEvidenceScope(summary);

  return {
    selectedScopeLabel,
    evidenceScopeLabel,
    evidenceScopeIsDescendant,
    relationshipHeadline: evidenceScopeIsDescendant
      ? `${selectedScopeLabel} keeps summary and activity while ${evidenceScopeLabel} holds artifacts and raw logs.`
      : `${selectedScopeLabel} stays both the selected scope and the evidence scope.`,
    relationshipDetail,
    stageHandoff: evidenceScopeIsDescendant
      ? `Overview and Activity stay on ${selectedScopeLabel}. Artifacts and Raw logs use ${evidenceScopeLabel}.`
      : `Overview, Activity, Artifacts, and Raw logs stay on ${selectedScopeLabel}.`,
    detailPanelDescription: evidenceScopeIsDescendant
      ? `Activity explains ${selectedScopeLabel} first. Artifacts and Raw logs then switch to ${evidenceScopeLabel}.`
      : `Activity stays the first deeper layer, followed by Artifacts and Raw logs at ${selectedScopeLabel}.`,
    layers: {
      overview: `Selected-node summary for ${selectedScopeLabel}: state, why now, and what happens next.`,
      activity: evidenceScopeIsDescendant
        ? `Judge, retry, and control flow stay on ${selectedScopeLabel}. Lightweight excerpts from ${evidenceScopeLabel} stay secondary.`
        : `Judge, retry, control flow, and lightweight excerpts stay on ${selectedScopeLabel}.`,
      artifacts: evidenceScopeIsDescendant
        ? `Summaries, reports, last messages, and file previews are loaded from ${evidenceScopeLabel}.`
        : `Summaries, reports, last messages, and file previews stay on ${selectedScopeLabel}.`,
      raw: evidenceScopeIsDescendant
        ? `Prompt text, stdout, and full execution logs are loaded from ${evidenceScopeLabel} only when you open Raw logs.`
        : `Prompt text, stdout, and full execution logs stay on ${selectedScopeLabel} only when you open Raw logs.`,
    },
    extractsSurfaceLabel: evidenceScopeIsDescendant ? 'Evidence-scope extracts' : 'Execution extracts',
    extractsTitle: evidenceScopeIsDescendant
      ? `Short parsed notes from ${evidenceScopeLabel}`
      : `Short parsed notes from ${selectedScopeLabel}`,
    extractsDescription: evidenceScopeIsDescendant
      ? `These excerpts come from the deeper evidence scope so you can scan what happened before opening the full raw log.`
      : 'These excerpts help you scan what happened before opening the full raw log.',
  };
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

export function inferRunActive(state: RunStateResponse | null): boolean {
  return inferActiveFromStateSnapshot(state);
}

export function inferRunResumable(state: RunStateResponse | null): boolean {
  return inferResumableFromStateSnapshot(state);
}

export function normalizeRunState(state: RunStateResponse | null): RunStateResponse | null {
  if (!state) return null;

  const isActive = inferRunActive(state);
  const configPath = typeof state.configPath === 'string' ? state.configPath : null;
  const normalized = {
    ...state,
    isActive,
    planPath: state.planPath || configPath,
  } as RunStateResponse;

  return {
    ...normalized,
    canCancel: isActive ? Boolean(normalized.canCancel) : false,
    canResume: isActive ? false : inferRunResumable(normalized),
  };
}

export function deriveRunControls(state: RunStateResponse | null): { canCancel: boolean; canResume: boolean } {
  const normalized = normalizeRunState(state);
  if (!normalized) return { canCancel: false, canResume: false };
  return {
    canCancel: Boolean(normalized.canCancel),
    canResume: Boolean(normalized.canResume),
  };
}

export function applyTraceSnapshot(
  current: Array<Record<string, unknown>>,
  payload: TraceSnapshotPayload,
): Array<Record<string, unknown>> {
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const nextLength = typeof payload.nextLength === 'number' && payload.nextLength >= 0
    ? payload.nextLength
    : entries.length;
  const startIndex = typeof payload.startIndex === 'number' && payload.startIndex >= 0
    ? payload.startIndex
    : Math.max(0, nextLength - entries.length);

  if (nextLength === 0 || startIndex === 0 || current.length === 0) {
    return entries.slice(0, nextLength);
  }
  if (current.length < nextLength) {
    const currentStartIndex = nextLength - current.length;
    if (startIndex <= currentStartIndex) {
      return entries.slice(0, Math.min(entries.length, nextLength));
    }
    const knownPrefixLength = Math.min(current.length, startIndex - currentStartIndex);
    return [...current.slice(0, knownPrefixLength), ...entries].slice(0, nextLength);
  }
  if (current.length < startIndex) {
    return entries.slice(0, nextLength);
  }

  const prefix = current.slice(0, Math.min(startIndex, nextLength));
  const merged = [...prefix, ...entries];
  if (merged.length === nextLength) return merged;
  if (merged.length > nextLength) return merged.slice(0, nextLength);
  return entries.slice(0, nextLength);
}

export function deriveBootstrapTrace(
  state: RunStateResponse | null,
  trace: Array<Record<string, unknown>> | null | undefined,
): Array<Record<string, unknown>> {
  if (Array.isArray(trace) && trace.length > 0) return trace;
  if (!Array.isArray(state?.decisionTrace)) return [];
  return state.decisionTrace.filter((entry): entry is Record<string, unknown> => (
    Boolean(entry) && typeof entry === 'object'
  ));
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
  const persistedFailureCount = Math.max(
    Number(state?.totalFailureCount || 0),
    Number(state?.totalRunFailureCount || 0),
  );
  summary.failed = Math.max(summary.failed, persistedFailureCount);
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

function titleCase(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function parseOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstMeaningfulLine(value: string | null | undefined): string {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function formatScore(score: number | null, threshold: number | null): string {
  if (score === null && threshold === null) return 'No score';
  if (score === null) return `Threshold ${threshold}`;
  if (threshold === null) return String(score);
  return `${score} / ${threshold}`;
}

function traceEntriesForWorkflow(trace: Array<Record<string, unknown>>, workflowId: string | null) {
  if (!workflowId) return trace;
  return trace.filter((entry) => {
    const detail = (entry.detail || {}) as Record<string, unknown>;
    return String(detail.taskId || '') === workflowId
      || String(detail.whileId || '') === workflowId
      || String(detail.gateId || '') === workflowId
      || String(entry.nodePath || '').includes(workflowId);
  });
}

function latestTraceForWorkflow(
  trace: Array<Record<string, unknown>>,
  workflowId: string | null,
  predicate?: (entry: Record<string, unknown>) => boolean,
) {
  const entries = traceEntriesForWorkflow(trace, workflowId);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!predicate || predicate(entry)) return entry;
  }
  return null;
}

function getRowsForWorkflowId(state: RunStateResponse | null, workflowId: string): ExecutableRow[] {
  if (!state?.tasks || !workflowId) return [];
  return Object.values(state.tasks as Record<string, ExecutableRow>)
    .filter((row) => String(row.taskId || '') === workflowId)
    .sort(compareExecutableRows);
}

function getScopeRows(state: RunStateResponse | null, node: WorkflowGraphItem | null): ExecutableRow[] {
  if (!state || !node) return [];
  const taskIds = descendantExecutableIds(node.raw || {});
  return taskIds
    .flatMap((workflowId) => getRowsForWorkflowId(state, workflowId))
    .sort(compareExecutableRows);
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
  return [...graph.items]
    .sort((a, b) => {
      const compositeRank = (item: WorkflowGraphItem) => {
        if (item.status === 'RUNNING' && !isActionableNode(item.type)) return 0;
        if (item.status === 'RUNNING') return 1;
        if (item.status === 'FAILED' && !isActionableNode(item.type)) return 2;
        if (item.status === 'FAILED') return 3;
        if (isLoopNode(item.type)) return 4;
        if (item.type === 'group') return 5;
        if (item.status === 'PENDING' && !isActionableNode(item.type)) return 6;
        if (item.status === 'PENDING') return 7;
        if (!isActionableNode(item.type)) return 8;
        return 9;
      };
      const typeDelta = compositeRank(a) - compositeRank(b);
      if (typeDelta !== 0) return typeDelta;
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

export function buildWorkflowGraph(
  plan: Record<string, unknown> | null,
  state: RunStateResponse | null,
  trace: Array<Record<string, unknown>>,
): WorkflowGraph {
  const items: WorkflowGraphItem[] = [];
  const edges: WorkflowGraphEdge[] = [];
  let order = 0;

  const walk = (
    nodes: Record<string, unknown>[],
    depth: number,
    parentGraphId: string | null,
    sequential: boolean,
    ancestors: Array<{ workflowId: string; type: string; label: string }>,
    parentWorkflowId: string | null,
  ): { firstId: string | null; lastId: string | null; directWorkflowIds: string[]; subtreeWorkflowIds: string[] } => {
    let firstId: string | null = null;
    let previousId: string | null = null;
    const directWorkflowIds: string[] = [];
    const subtreeWorkflowIds: string[] = [];

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
        subtitle: '',
        phase: null,
        metrics: [],
        parentWorkflowId,
        childWorkflowIds: [],
        descendantWorkflowIds: [],
        ancestors,
      };
      order += 1;
      items.push(item);
      directWorkflowIds.push(item.workflowId);
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
        const children = walk(
          node.steps as Record<string, unknown>[],
          depth + 1,
          graphId,
          !Boolean(node.parallel),
          nextAncestors,
          item.workflowId,
        );
        item.childWorkflowIds = children.directWorkflowIds;
        item.descendantWorkflowIds = children.subtreeWorkflowIds;
      }
      if (isLoopNode(String(node.type)) && Array.isArray(node.body)) {
        const nextAncestors = [...ancestors, { workflowId: item.workflowId, type: item.type, label: item.label }];
        const body = walk(
          node.body as Record<string, unknown>[],
          depth + 1,
          graphId,
          true,
          nextAncestors,
          item.workflowId,
        );
        item.childWorkflowIds = body.directWorkflowIds;
        item.descendantWorkflowIds = body.subtreeWorkflowIds;
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

      subtreeWorkflowIds.push(item.workflowId, ...(item.descendantWorkflowIds || []));
      previousId = graphId;
    }

    return { firstId, lastId: previousId, directWorkflowIds, subtreeWorkflowIds };
  };

  walk(getPlanFlow(plan), 0, null, true, [], null);
  const nodeByWorkflowId = new Map(items.map((item) => [item.workflowId, item]));
  const nodeByGraphId = new Map(items.map((item) => [item.graphId, item]));
  const graph: WorkflowGraph = { items, edges, nodeByWorkflowId, nodeByGraphId };

  for (const item of items) {
    const summary = buildNodeSummary(graph, item, state, trace);
    item.subtitle = summary?.whyNow.message || titleCase(String(item.type || 'node'));
    item.phase = summary?.stateNow.phase || null;
    item.metrics = summary?.graphMetrics || [];
  }

  return graph;
}

function getChildItems(graph: WorkflowGraph, node: WorkflowGraphItem): WorkflowGraphItem[] {
  return (node.childWorkflowIds || [])
    .map((workflowId) => graph.nodeByWorkflowId.get(workflowId))
    .filter(Boolean) as WorkflowGraphItem[];
}

function getSiblingItems(graph: WorkflowGraph, node: WorkflowGraphItem): WorkflowGraphItem[] {
  if (node.parentWorkflowId) {
    const parent = graph.nodeByWorkflowId.get(node.parentWorkflowId) || null;
    return parent
      ? getChildItems(graph, parent).filter((item) => item.workflowId !== node.workflowId)
      : [];
  }
  return graph.items.filter((item) => !item.parentWorkflowId && item.workflowId !== node.workflowId);
}

function getAncestorGraphIds(graph: WorkflowGraph, node: WorkflowGraphItem): string[] {
  return (node.ancestors || [])
    .map((ancestor) => graph.nodeByWorkflowId.get(ancestor.workflowId)?.graphId || null)
    .filter(Boolean) as string[];
}

function getLineageGraphIds(
  graph: WorkflowGraph,
  ancestor: WorkflowGraphItem | null,
  descendant: WorkflowGraphItem | null,
): string[] {
  if (!ancestor || !descendant) return [];
  const lineage: string[] = [];
  let current: WorkflowGraphItem | null = descendant;
  while (current) {
    lineage.push(current.graphId);
    if (current.workflowId === ancestor.workflowId) return lineage;
    current = current.parentWorkflowId
      ? graph.nodeByWorkflowId.get(current.parentWorkflowId) || null
      : null;
  }
  return [];
}

function hasVisibleIncompleteDescendant(graph: WorkflowGraph, node: WorkflowGraphItem): boolean {
  return (node.descendantWorkflowIds || []).some((workflowId) => {
    const child = graph.nodeByWorkflowId.get(workflowId);
    return child ? child.status !== 'DONE' : false;
  });
}

function hasDescendantWithStatus(graph: WorkflowGraph, node: WorkflowGraphItem, status: string): boolean {
  return (node.descendantWorkflowIds || []).some((workflowId) => {
    const child = graph.nodeByWorkflowId.get(workflowId);
    return child ? child.status === status : false;
  });
}

function buildRetryOverlay(
  rows: ExecutableRow[],
  latestRetry: Record<string, unknown> | null,
): NodeSummary['retry'] | undefined {
  const highestAttempt = rows.reduce((max, row) => Math.max(max, Number(row.attempt || 1)), 1);
  const previousAttempts = Math.max(0, highestAttempt - 1);
  const currentRow = rows.find((row) => Number(row.attempt || 0) === highestAttempt) || rows[0] || null;
  const latestFailureRow = rows.find((row) => row.failureReason || String(row.status || '') === 'FAILED') || null;
  const detail = ((latestRetry?.detail || {}) as Record<string, unknown>);
  if (previousAttempts === 0 && !latestRetry) return undefined;

  let state: 'scheduled' | 'in_progress' | 'exhausted' | 'resolved' = 'resolved';
  if (latestRetry && Number(detail.nextAttempt || 0) > highestAttempt) state = 'scheduled';
  else if (String(currentRow?.status || '') === 'RUNNING' && previousAttempts > 0) state = 'in_progress';
  else if (String(currentRow?.status || '') === 'FAILED') state = 'exhausted';

  return {
    attempt: highestAttempt,
    previousAttempts,
    latestFailureReason: latestFailureRow?.failureReason ? String(latestFailureRow.failureReason) : null,
    state,
    nextTarget: detail.taskId ? String(detail.taskId) : null,
  };
}

function describeFollowTarget(
  reason: NonNullable<NodeSummary['followTarget']>['reason'],
  label: string,
): string {
  if (reason === 'selected_node') {
    return 'Artifacts and raw logs attach directly to this node.';
  }
  if (reason === 'blocking_child') {
    return `Artifacts and raw logs follow blocking child ${label}.`;
  }
  if (reason === 'active_child') {
    return `Artifacts and raw logs follow active child ${label}.`;
  }
  if (reason === 'next_eligible_child') {
    return `Artifacts and raw logs follow the next eligible child ${label}.`;
  }
  if (reason === 'active_body_child') {
    return `Artifacts and raw logs follow current body child ${label}.`;
  }
  if (reason === 'retry_target') {
    return `Artifacts and raw logs follow retry target ${label}.`;
  }
  return `Artifacts and raw logs follow the most relevant actionable child, ${label}.`;
}

function preferredChildForFollow(graph: WorkflowGraph, node: WorkflowGraphItem): WorkflowGraphItem | null {
  const childItems = getChildItems(graph, node);
  if (childItems.length === 0) return null;
  if (node.type === 'group') {
    return childItems.find((item) => item.status === 'FAILED')
      || childItems.find((item) => item.status === 'RUNNING')
      || childItems.find((item) => item.status === 'PENDING')
      || childItems[0]
      || null;
  }
  if (isLoopNode(node.type)) {
    return childItems.find((item) => item.status === 'RUNNING')
      || childItems.find((item) => item.status === 'FAILED')
      || null;
  }
  return childItems.find((item) => item.status !== 'DONE') || childItems[0] || null;
}

function resolveActionableFollowNode(
  graph: WorkflowGraph,
  state: RunStateResponse | null,
  node: WorkflowGraphItem | null,
): WorkflowGraphItem | null {
  if (!node) return null;
  if (isActionableNode(node.type)) return node;

  const preferredChild = preferredChildForFollow(graph, node);
  if (preferredChild) {
    return resolveActionableFollowNode(graph, state, preferredChild);
  }

  const representativeRow = getRepresentativeTaskRow(state, node);
  if (representativeRow?.taskId) {
    return graph.nodeByWorkflowId.get(String(representativeRow.taskId)) || null;
  }

  for (const child of getChildItems(graph, node)) {
    const actionableChild = resolveActionableFollowNode(graph, state, child);
    if (actionableChild) return actionableChild;
  }

  return null;
}

function buildFollowTarget(
  graph: WorkflowGraph,
  state: RunStateResponse | null,
  node: WorkflowGraphItem,
  options: {
    preferredWorkflowId?: string | null;
    reason?: NonNullable<NodeSummary['followTarget']>['reason'];
    evidenceRow?: ExecutableRow | null;
  } = {},
): NodeSummary['followTarget'] {
  const { preferredWorkflowId = null, reason = 'latest_descendant', evidenceRow = null } = options;

  if (isActionableNode(node.type)) {
    return {
      descendant: false,
      workflowId: node.workflowId,
      label: node.label,
      type: node.type,
      reason: 'selected_node',
      description: describeFollowTarget('selected_node', node.label),
    };
  }

  const preferredNode = preferredWorkflowId
    ? graph.nodeByWorkflowId.get(preferredWorkflowId) || null
    : null;
  const candidate = resolveActionableFollowNode(graph, state, preferredNode)
    || (evidenceRow?.taskId ? graph.nodeByWorkflowId.get(String(evidenceRow.taskId)) || null : null)
    || resolveActionableFollowNode(graph, state, node);

  if (!candidate) return null;

  return {
    descendant: candidate.workflowId !== node.workflowId,
    workflowId: candidate.workflowId,
    label: candidate.label,
    type: candidate.type,
    reason,
    description: describeFollowTarget(reason, candidate.label),
  };
}

function evidenceRowForFollowTarget(
  graph: WorkflowGraph,
  state: RunStateResponse | null,
  followTarget: NodeSummary['followTarget'],
): ExecutableRow | null {
  if (!followTarget?.workflowId) return null;
  const targetNode = graph.nodeByWorkflowId.get(followTarget.workflowId) || null;
  return targetNode ? getRepresentativeTaskRow(state, targetNode) : null;
}

function buildTaskSummary(
  graph: WorkflowGraph,
  node: WorkflowGraphItem,
  state: RunStateResponse | null,
  trace: Array<Record<string, unknown>>,
  artifactCount: number,
): NodeSummary {
  const directRow = getLatestTaskRow(state, node.workflowId);
  const allRows = getRowsForWorkflowId(state, node.workflowId);
  const latestRetry = latestTraceForWorkflow(
    trace,
    node.workflowId,
    (entry) => String(entry.type || '') === 'task_retry' && String((entry.detail as any)?.taskId || '') === node.workflowId,
  );
  const retry = buildRetryOverlay(allRows, latestRetry);
  const followTarget = buildFollowTarget(graph, state, node, {
    preferredWorkflowId: node.workflowId,
    reason: 'selected_node',
    evidenceRow: directRow || null,
  });
  const evidenceRow = evidenceRowForFollowTarget(graph, state, followTarget)
    || directRow
    || getRepresentativeTaskRow(state, node);
  const status = String(node.status || 'PENDING');
  const attempt = Number(directRow?.attempt || evidenceRow?.attempt || 1);
  const durationSec = directRow?.durationSec ?? evidenceRow?.durationSec;

  let reasonCode = 'task_pending';
  let whyNow = 'This node is waiting for upstream work to finish.';
  if (status === 'RUNNING') {
    reasonCode = 'task_running';
    whyNow = `Attempt ${attempt} is currently in progress.`;
  } else if (status === 'FAILED') {
    reasonCode = 'task_failed';
    whyNow = firstMeaningfulLine(String(directRow?.failureReason || evidenceRow?.failureReason || '')) || `Attempt ${attempt} failed.`;
  } else if (status === 'DONE') {
    reasonCode = 'task_done';
    whyNow = `Attempt ${attempt} completed successfully.`;
  }

  const next = retry?.state === 'scheduled'
    ? {
        transition: 'retry_same_scope',
        label: `Retry attempt ${attempt + 1}`,
        targetNodeIds: [node.workflowId],
      }
    : status === 'RUNNING'
      ? {
          transition: 'await_completion',
          label: 'Wait for this node to finish',
          targetNodeIds: [node.workflowId],
        }
      : status === 'FAILED'
        ? {
            transition: 'inspect_failure',
            label: 'Inspect the failure evidence',
            targetNodeIds: [node.workflowId],
          }
        : status === 'DONE'
          ? {
              transition: 'continue_flow',
              label: 'Continue to the next eligible node',
              targetNodeIds: [],
            }
          : {
              transition: 'run_when_ready',
              label: 'Run when earlier work completes',
              targetNodeIds: [node.workflowId],
            };

  return {
    identity: {
      nodeId: node.workflowId,
      type: node.type,
      label: node.label,
      breadcrumb: [...(node.ancestors || []).map((ancestor) => ancestor.label), node.label],
    },
    stateNow: {
      status,
      phase: status.toLowerCase(),
      sinceAtUtc: status === 'RUNNING'
        ? String(directRow?.startedAtUtc || evidenceRow?.startedAtUtc || '')
        : String(directRow?.endedAtUtc || evidenceRow?.endedAtUtc || ''),
    },
    whyNow: {
      reasonCode,
      message: whyNow,
      retryFailureReason: retry?.latestFailureReason || null,
    },
    next,
    progressItems: [
      { label: 'Attempt', value: String(attempt) },
      ...(durationSec !== undefined ? [{ label: 'Duration', value: `${durationSec}s` }] : []),
      ...(retry ? [{ label: 'Previous tries', value: String(retry.previousAttempts) }] : []),
    ],
    graphMetrics: [
      `Attempt ${attempt}`,
      durationSec !== undefined ? `${durationSec}s` : titleCase(status.toLowerCase()),
    ],
    evidence: {
      summary: Boolean(evidenceRow?.summaryPath),
      report: Boolean(evidenceRow?.reportPath),
      artifacts: artifactCount,
      logs: Boolean(evidenceRow?.logPath || evidenceRow?.lastMessagePath),
      traceEvents: traceEntriesForWorkflow(trace, node.workflowId).length,
    },
    alerts: status === 'FAILED' && whyNow ? [whyNow] : [],
    evidenceRow,
    followTarget,
    retry,
  };
}

function buildGroupSummary(
  graph: WorkflowGraph,
  node: WorkflowGraphItem,
  state: RunStateResponse | null,
  trace: Array<Record<string, unknown>>,
  artifactCount: number,
): NodeSummary {
  const childItems = getChildItems(graph, node);
  const counts = {
    totalChildren: childItems.length,
    doneChildren: childItems.filter((item) => item.status === 'DONE').length,
    runningChildren: childItems.filter((item) => item.status === 'RUNNING').length,
    failedChildren: childItems.filter((item) => item.status === 'FAILED').length,
    pendingChildren: childItems.filter((item) => item.status === 'PENDING').length,
  };
  const failedChild = childItems.find((item) => item.status === 'FAILED') || null;
  const activeChild = childItems.find((item) => item.status === 'RUNNING') || null;
  const nextEligibleChild = childItems.find((item) => item.status === 'PENDING') || null;
  const phase = failedChild
    ? 'failed'
    : activeChild
      ? 'active'
      : counts.doneChildren === counts.totalChildren && counts.totalChildren > 0
        ? 'done'
        : counts.pendingChildren === counts.totalChildren
          ? 'pending'
        : 'blocked';
  const scopeRows = getScopeRows(state, node);
  const latestRetry = latestTraceForWorkflow(
    trace,
    node.workflowId,
    (entry) => String(entry.type || '') === 'task_retry',
  );
  const retry = buildRetryOverlay(scopeRows, latestRetry);
  let reasonCode = 'group_pending';
  let whyNow = 'This group has not started yet.';
  if (failedChild) {
    reasonCode = 'group_failed_child';
    whyNow = `${failedChild.label} is blocking the group.`;
  } else if (activeChild) {
    reasonCode = 'group_active_child';
    whyNow = `${activeChild.label} is currently running inside this group.`;
  } else if (nextEligibleChild && phase === 'blocked') {
    reasonCode = 'group_waiting_child';
    whyNow = `${nextEligibleChild.label} is next once earlier work clears.`;
  } else if (nextEligibleChild) {
    reasonCode = 'group_next_child';
    whyNow = `${nextEligibleChild.label} is the next eligible child.`;
  } else if (phase === 'done') {
    reasonCode = 'group_done';
    whyNow = `All ${counts.totalChildren} child nodes are complete.`;
  }

  const next = failedChild
    ? {
        transition: 'await_child',
        label: `Inspect ${failedChild.label}`,
        targetNodeIds: [failedChild.workflowId],
      }
    : activeChild
      ? {
          transition: 'await_child',
          label: `Wait for ${activeChild.label}`,
          targetNodeIds: [activeChild.workflowId],
        }
      : nextEligibleChild
        ? {
            transition: 'run_child',
            label: `Run ${nextEligibleChild.label}`,
            targetNodeIds: [nextEligibleChild.workflowId],
          }
        : {
            transition: 'complete_group',
            label: 'Group is complete',
            targetNodeIds: [],
          };
  const preferredFollowWorkflowId = failedChild?.workflowId || activeChild?.workflowId || nextEligibleChild?.workflowId || null;
  const followReason: NonNullable<NodeSummary['followTarget']>['reason'] = failedChild
    ? 'blocking_child'
    : activeChild
      ? 'active_child'
      : nextEligibleChild
        ? 'next_eligible_child'
        : 'latest_descendant';
  const followTarget = buildFollowTarget(graph, state, node, {
    preferredWorkflowId: preferredFollowWorkflowId,
    reason: followReason,
  });
  const evidenceRow = followTarget
    ? evidenceRowForFollowTarget(graph, state, followTarget)
    : getRepresentativeTaskRow(state, node);

  return {
    identity: {
      nodeId: node.workflowId,
      type: node.type,
      label: node.label,
      breadcrumb: [...(node.ancestors || []).map((ancestor) => ancestor.label), node.label],
    },
    stateNow: {
      status: node.status,
      phase,
      sinceAtUtc: String(
        activeChild
          ? getLatestTaskRow(state, activeChild.workflowId)?.startedAtUtc || ''
          : failedChild
            ? getLatestTaskRow(state, failedChild.workflowId)?.endedAtUtc || ''
            : latestTraceForWorkflow(trace, node.workflowId)?.atUtc || '',
      ),
    },
    whyNow: {
      reasonCode,
      message: whyNow,
      retryFailureReason: retry?.latestFailureReason || null,
    },
    next,
    progressItems: [
      { label: 'Children', value: String(counts.totalChildren) },
      { label: 'Done', value: String(counts.doneChildren) },
      ...(counts.runningChildren > 0 ? [{ label: 'Running', value: String(counts.runningChildren) }] : []),
      ...(counts.failedChildren > 0 ? [{ label: 'Failed', value: String(counts.failedChildren) }] : []),
      ...(counts.pendingChildren > 0 ? [{ label: 'Pending', value: String(counts.pendingChildren) }] : []),
    ],
    graphMetrics: [
      `${counts.doneChildren}/${counts.totalChildren || 0} done`,
      failedChild
        ? `${counts.failedChildren} failed`
        : activeChild
          ? `${counts.runningChildren} running`
          : nextEligibleChild
            ? `Next ${nextEligibleChild.label}`
            : 'Complete',
    ],
    evidence: {
      summary: Boolean(evidenceRow?.summaryPath),
      report: Boolean(evidenceRow?.reportPath),
      artifacts: artifactCount,
      logs: Boolean(evidenceRow?.logPath || evidenceRow?.lastMessagePath),
      traceEvents: traceEntriesForWorkflow(trace, node.workflowId).length,
    },
    alerts: failedChild ? [whyNow] : [],
    evidenceRow,
    followTarget,
    group: {
      ...counts,
      activeChildId: activeChild?.workflowId || null,
      activeChildLabel: activeChild?.label || null,
      blockingChildId: failedChild?.workflowId || null,
      blockingChildLabel: failedChild?.label || null,
      nextEligibleChildId: nextEligibleChild?.workflowId || null,
      nextEligibleChildLabel: nextEligibleChild?.label || null,
      mode: Boolean(node.raw.parallel) ? 'parallel' : 'serial',
    },
    retry,
  };
}

function judgeResultLabel(phase: string, passed: boolean): string {
  if (phase === 'pre_body') return passed ? 'exit_loop' : 'enter_body';
  return passed ? 'exit_loop' : 'retry_body';
}

function buildLoopSummary(
  graph: WorkflowGraph,
  node: WorkflowGraphItem,
  state: RunStateResponse | null,
  trace: Array<Record<string, unknown>>,
  artifactCount: number,
): NodeSummary {
  const childItems = getChildItems(graph, node);
  const activeChild = childItems.find((item) => item.status === 'RUNNING') || null;
  const failedChild = childItems.find((item) => item.status === 'FAILED') || null;
  const evaluations = collectJudgeEvaluations(trace, node.workflowId);
  const latestEvaluation = evaluations[evaluations.length - 1] || null;
  const satisfied = Boolean(latestTraceForWorkflow(trace, node.workflowId, (entry) => String(entry.type || '') === 'while_satisfied'));
  const exhausted = Boolean(latestTraceForWorkflow(trace, node.workflowId, (entry) => String(entry.type || '') === 'while_exhausted'));
  const latestRetry = latestTraceForWorkflow(trace, node.workflowId, (entry) => String(entry.type || '') === 'task_retry');
  const scopeRows = getScopeRows(state, node);
  const retry = buildRetryOverlay(scopeRows, latestRetry);
  const threshold = parseOptionalNumber((node.raw as any).pass_threshold ?? (node.raw as any).passThreshold);
  const maxIterations = parseOptionalNumber((node.raw as any).max_iterations ?? (node.raw as any).maxIterations);
  const iteration = latestEvaluation?.iteration || parseOptionalNumber((latestRetry?.detail as any)?.iteration) || 1;
  const bodyEntryWorkflowId = childItems[0]?.workflowId || null;

  let phase: string | null = null;
  if (satisfied) phase = 'satisfied';
  else if (exhausted) phase = 'exhausted';
  else if (retry?.state === 'scheduled') phase = 'retrying';
  else if (activeChild) phase = 'running_body';
  else if (latestEvaluation?.phase === 'post_body') phase = latestEvaluation.passed ? 'satisfied' : 'post_body_gate';
  else if (latestEvaluation?.phase === 'pre_body') phase = latestEvaluation.passed ? 'satisfied' : 'pre_body_gate';
  else if (failedChild || node.status === 'FAILED') phase = 'failed';
  else if (node.status === 'DONE') phase = 'satisfied';
  else if (node.status === 'RUNNING') phase = 'running_body';
  else phase = 'pending';

  let reasonCode = 'loop_pending';
  let whyNow = 'This loop has not started yet.';
  if (phase === 'exhausted') {
    reasonCode = 'loop_exhausted';
    whyNow = `The loop exhausted ${maxIterations || iteration} iterations without meeting the threshold.`;
  } else if (phase === 'failed' && failedChild) {
    reasonCode = 'loop_failed_child';
    whyNow = `${failedChild.label} failed inside the loop body.`;
  } else if (phase === 'retrying' && retry) {
    reasonCode = 'loop_retrying';
    whyNow = retry.latestFailureReason
      ? `Retrying after ${retry.latestFailureReason}`
      : 'Another attempt is scheduled for this loop scope.';
  } else if (latestEvaluation) {
    reasonCode = latestEvaluation.phase === 'pre_body' ? 'judge_pre_body' : 'judge_post_body';
    whyNow = `${titleCase(latestEvaluation.phase)} judge scored ${latestEvaluation.score ?? 'no score'}${threshold !== null ? ` against ${threshold}` : ''}${latestEvaluation.passed ? ' and cleared the gate.' : ' and kept the loop active.'}`;
  } else if (activeChild) {
    reasonCode = 'loop_body_running';
    whyNow = `Iteration ${iteration} is currently running ${activeChild.label}.`;
  } else if (phase === 'satisfied') {
    reasonCode = 'loop_satisfied';
    whyNow = 'The loop exit condition is satisfied.';
  }

  const next = phase === 'exhausted' || phase === 'failed'
    ? {
        transition: 'fail_loop',
        label: 'Loop stops here',
        targetNodeIds: [],
      }
    : phase === 'satisfied'
      ? {
          transition: 'exit_loop',
          label: 'Exit the loop',
          targetNodeIds: [],
        }
      : retry?.state === 'scheduled'
        ? {
            transition: 'retry_same_scope',
            label: 'Run the next retry attempt',
            targetNodeIds: retry.nextTarget ? [retry.nextTarget] : [],
          }
        : activeChild
          ? {
              transition: 'await_body',
              label: `Wait for ${activeChild.label}`,
              targetNodeIds: [activeChild.workflowId],
            }
          : latestEvaluation?.phase === 'pre_body' && latestEvaluation.passed !== true
            ? {
                transition: 'enter_body',
                label: `Run body iteration ${latestEvaluation.iteration}`,
                targetNodeIds: childItems.map((item) => item.workflowId),
              }
            : latestEvaluation?.phase === 'post_body' && latestEvaluation.passed !== true
              ? {
                  transition: 'schedule_next_iteration',
                  label: `Schedule iteration ${latestEvaluation.iteration + 1}`,
                  targetNodeIds: childItems.map((item) => item.workflowId),
                }
              : {
                  transition: 'evaluate_gate',
                  label: 'Evaluate the loop gate',
                  targetNodeIds: [node.workflowId],
                };
  const shouldFollowNextBodyChild = Boolean(
    latestEvaluation
      && latestEvaluation.passed !== true
      && (
        latestEvaluation.phase === 'pre_body'
        || (latestEvaluation.phase === 'post_body' && !exhausted && !satisfied && phase !== 'failed')
      ),
  );
  const preferredFollowWorkflowId = retry?.state === 'scheduled'
    ? retry.nextTarget || bodyEntryWorkflowId
    : activeChild?.workflowId
      || failedChild?.workflowId
      || bodyEntryWorkflowId
      || null;
  const followReason: NonNullable<NodeSummary['followTarget']>['reason'] = retry?.state === 'scheduled'
    ? 'retry_target'
    : activeChild
      ? 'active_body_child'
      : failedChild
        ? 'blocking_child'
        : shouldFollowNextBodyChild
          ? 'next_eligible_child'
          : 'latest_descendant';
  const followTarget = buildFollowTarget(graph, state, node, {
    preferredWorkflowId: preferredFollowWorkflowId,
    reason: followReason,
  });
  const evidenceRow = followTarget
    ? evidenceRowForFollowTarget(graph, state, followTarget)
    : getRepresentativeTaskRow(state, node);

  return {
    identity: {
      nodeId: node.workflowId,
      type: node.type,
      label: node.label,
      breadcrumb: [...(node.ancestors || []).map((ancestor) => ancestor.label), node.label],
    },
    stateNow: {
      status: node.status,
      phase,
      sinceAtUtc: String(
        latestEvaluation?.atUtc
          || latestTraceForWorkflow(trace, node.workflowId)?.atUtc
          || getLatestTaskRow(state, activeChild?.workflowId || failedChild?.workflowId || '')?.startedAtUtc
          || '',
      ),
    },
    whyNow: {
      reasonCode,
      message: whyNow,
      retryFailureReason: retry?.latestFailureReason || null,
    },
    next,
    progressItems: [
      { label: 'Iteration', value: String(iteration) },
      ...(maxIterations !== null ? [{ label: 'Max iterations', value: String(maxIterations) }] : []),
      ...(threshold !== null || latestEvaluation?.score !== null
        ? [{ label: 'Score', value: formatScore(latestEvaluation?.score ?? null, threshold) }]
        : []),
      ...(activeChild ? [{ label: 'Active body', value: activeChild.label }] : []),
    ],
    graphMetrics: [
      `Iter ${iteration}${maxIterations !== null ? ` / ${maxIterations}` : ''}`,
      latestEvaluation
        ? formatScore(latestEvaluation.score, threshold)
        : titleCase(String(phase || node.status || 'pending')),
    ],
    evidence: {
      summary: Boolean(evidenceRow?.summaryPath),
      report: Boolean(evidenceRow?.reportPath),
      artifacts: artifactCount,
      logs: Boolean(evidenceRow?.logPath || evidenceRow?.lastMessagePath),
      traceEvents: traceEntriesForWorkflow(trace, node.workflowId).length,
    },
    alerts: phase === 'exhausted' || phase === 'failed' ? [whyNow] : [],
    evidenceRow,
    followTarget,
    judge: latestEvaluation ? {
      phase: latestEvaluation.phase,
      score: latestEvaluation.score,
      threshold,
      result: judgeResultLabel(latestEvaluation.phase, latestEvaluation.passed),
      reasons: latestEvaluation.reasons,
      atUtc: latestEvaluation.atUtc,
    } : undefined,
    loop: {
      activeBodyChildId: activeChild?.workflowId || null,
      activeBodyChildLabel: activeChild?.label || null,
      failedBodyChildId: failedChild?.workflowId || null,
      failedBodyChildLabel: failedChild?.label || null,
    },
    retry,
  };
}

export function buildNodeSummary(
  graph: WorkflowGraph,
  node: WorkflowGraphItem | null,
  state: RunStateResponse | null,
  trace: Array<Record<string, unknown>>,
  options: { artifactCount?: number } = {},
): NodeSummary | null {
  if (!node) return null;
  const artifactCount = options.artifactCount ?? 0;
  if (node.type === 'group') {
    return buildGroupSummary(graph, node, state, trace, artifactCount);
  }
  if (isLoopNode(node.type)) {
    return buildLoopSummary(graph, node, state, trace, artifactCount);
  }
  return buildTaskSummary(graph, node, state, trace, artifactCount);
}

export function buildFocusedWorkflowGraph(
  graph: WorkflowGraph,
  options: {
    selectedId?: string | null;
    selectionKey?: 'workflowId' | 'graphId';
    mode?: GraphFocusMode;
    followId?: string | null;
  } = {},
): FocusedWorkflowGraph {
  const {
    selectedId = null,
    selectionKey = 'workflowId',
    mode = 'full',
    followId = null,
  } = options;
  const selectedNode = selectedId
    ? (selectionKey === 'graphId' ? graph.nodeByGraphId.get(selectedId) : graph.nodeByWorkflowId.get(selectedId)) || null
    : null;
  const followNode = followId ? graph.nodeByWorkflowId.get(followId) || null : null;

  const visible = new Set<string>();
  const primary = new Set<string>();
  const context = new Set<string>();
  let focusMatched = mode === 'full';

  if (mode === 'full') {
    for (const item of graph.items) {
      visible.add(item.graphId);
      primary.add(item.graphId);
    }
  }

  const includeItem = (item: WorkflowGraphItem | null, emphasis: GraphNodeEmphasis = 'context') => {
    if (!item) return;
    visible.add(item.graphId);
    if (emphasis === 'primary') {
      primary.add(item.graphId);
      return;
    }
    context.add(item.graphId);
  };

  const addAncestors = (node: WorkflowGraphItem | null) => {
    if (!node) return;
    for (const graphId of getAncestorGraphIds(graph, node)) {
      visible.add(graphId);
      context.add(graphId);
    }
  };
  const addChildren = (node: WorkflowGraphItem | null) => {
    if (!node) return;
    for (const child of getChildItems(graph, node)) includeItem(child, 'context');
  };
  const addSiblings = (node: WorkflowGraphItem | null) => {
    if (!node) return;
    for (const sibling of getSiblingItems(graph, node)) includeItem(sibling, 'context');
  };

  if (mode === 'selected' && selectedNode) {
    focusMatched = true;
    includeItem(selectedNode, 'primary');
    addAncestors(selectedNode);
    addSiblings(selectedNode);
    addChildren(selectedNode);
  }

  if (mode === 'active') {
    const activeItems = graph.items.filter((entry) => entry.status === 'RUNNING' && !hasDescendantWithStatus(graph, entry, 'RUNNING'));
    if (activeItems.length > 0) focusMatched = true;
    for (const item of activeItems) {
      includeItem(item, 'primary');
      addAncestors(item);
      addSiblings(item);
      addChildren(item);
    }
  }

  if (mode === 'failed') {
    const failedItems = graph.items.filter((entry) => entry.status === 'FAILED' && !hasDescendantWithStatus(graph, entry, 'FAILED'));
    if (failedItems.length > 0) focusMatched = true;
    for (const item of failedItems) {
      includeItem(item, 'primary');
      addAncestors(item);
      addSiblings(item);
      addChildren(item);
    }
  }

  if (mode === 'collapse-completed') {
    focusMatched = true;
    visible.clear();
    for (const item of graph.items) {
      if (item.status !== 'DONE' || hasVisibleIncompleteDescendant(graph, item)) {
        visible.add(item.graphId);
      }
    }
    if (selectedNode) {
      visible.add(selectedNode.graphId);
      for (const graphId of getAncestorGraphIds(graph, selectedNode)) visible.add(graphId);
      for (const child of getChildItems(graph, selectedNode)) visible.add(child.graphId);
      primary.add(selectedNode.graphId);
    } else {
      for (const item of graph.items) {
        if (visible.has(item.graphId) && item.status !== 'DONE') primary.add(item.graphId);
      }
    }
  }

  if (!focusMatched) {
    for (const item of graph.items) {
      visible.add(item.graphId);
      primary.add(item.graphId);
    }
  }

  if (selectedNode) {
    includeItem(selectedNode, 'primary');
    addAncestors(selectedNode);
  }

  if (followNode) {
    includeItem(followNode, 'primary');
    const lineage = getLineageGraphIds(graph, selectedNode, followNode);
    if (lineage.length > 0) {
      for (const graphId of lineage) {
        visible.add(graphId);
        primary.add(graphId);
      }
    } else {
      primary.add(followNode.graphId);
      addAncestors(followNode);
    }
  }

  const emphasis = new Map<string, GraphNodeEmphasis>();
  let primaryCount = 0;
  let contextCount = 0;
  let mutedCount = 0;
  for (const item of graph.items) {
    if (!visible.has(item.graphId)) continue;
    if (primary.has(item.graphId)) {
      emphasis.set(item.graphId, 'primary');
      primaryCount += 1;
    } else if (context.has(item.graphId)) {
      emphasis.set(item.graphId, 'context');
      contextCount += 1;
    } else {
      emphasis.set(item.graphId, 'muted');
      mutedCount += 1;
    }
  }

  const items = graph.items.filter((item) => visible.has(item.graphId));
  const edges = graph.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));

  return {
    items,
    edges,
    emphasis,
    focusCount: emphasis.size,
    counts: {
      visible: items.length,
      hidden: Math.max(0, graph.items.length - items.length),
      primary: primaryCount,
      context: contextCount,
      muted: mutedCount,
    },
  };
}

export function graphFocusModeLabel(mode: GraphFocusMode): string {
  if (mode === 'selected') return 'Selected scope';
  if (mode === 'active') return 'Active path';
  if (mode === 'failed') return 'Failed path';
  if (mode === 'collapse-completed') return 'Collapse completed';
  return 'Full graph';
}

export function graphFocusModeDescription(mode: GraphFocusMode): string {
  if (mode === 'selected') {
    return 'Keep the current scope in focus, with the followed evidence path pulled forward.';
  }
  if (mode === 'active') {
    return 'Surface the running path first so live work does not get lost in the full topology.';
  }
  if (mode === 'failed') {
    return 'Surface blocking and failed scopes first so historical failure analysis starts on the hot path.';
  }
  if (mode === 'collapse-completed') {
    return 'Hide fully completed branches unless they still explain an incomplete or selected scope.';
  }
  return 'Show the entire plan topology with status overlays intact.';
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
  return [...traceEntriesForWorkflow(trace, workflowId)].reverse();
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
  if (type === 'run_failed') {
    return 'Run failed';
  }
  if (type === 'run_completed') {
    return 'Run completed';
  }
  if (type === 'while_satisfied') {
    return `Loop satisfied at ${String(detail.phase || '')}`;
  }
  if (type === 'while_exhausted') {
    return `Loop exhausted after ${String(detail.maxIterations || '')} iterations`;
  }
  if (type === 'while_iteration_started') {
    return `Iteration ${String(detail.iteration || '')} started`;
  }
  if (type === 'task_started') {
    return detail.taskId ? `${String(detail.taskId)} started` : 'Task started';
  }
  if (type === 'task_completed') {
    return detail.taskId ? `${String(detail.taskId)} completed` : 'Task completed';
  }
  if (type === 'command_started') {
    return detail.taskId ? `${String(detail.taskId)} started` : 'Command started';
  }
  if (type === 'command_completed') {
    return detail.taskId ? `${String(detail.taskId)} completed` : 'Command completed';
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
