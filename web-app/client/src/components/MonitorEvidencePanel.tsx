import React from 'react';
import {
  Badge,
  Button,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Tabs,
  Text,
} from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { RunArtifactItem } from '../../../shared/contracts/monitor.ts';
import { api } from '../api/client.ts';
import { EmptyState, SurfaceLabel } from '../design/primitives.tsx';
import {
  buildSelectedNodeNarrative,
  formatTraceEntry,
  type MonitorDetailTab,
  parseLogActivityEvents,
  requestPreviewForWorkflowItem,
  stripAnsi,
  type ExecutableRow,
  type JudgeEvaluation,
  type NodeSummary,
  type WorkflowGraphItem,
} from '../lib/monitor.ts';

function shortName(filePath: string) {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function artifactKind(filePath: string | null | undefined) {
  const normalized = String(filePath || '').toLowerCase();
  if (normalized.endsWith('.md')) return 'markdown';
  if (normalized.endsWith('.json')) return 'json';
  return 'text';
}

function formatLocalTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString();
}

function readableToken(value: string | null | undefined): string {
  return String(value || '')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .trim();
}

function renderTraceDetail(entry: Record<string, unknown>) {
  const detail = (entry.detail || {}) as Record<string, unknown>;
  if (Array.isArray(detail.reasons) && detail.reasons.length > 0) {
    return detail.reasons.map((reason) => `- ${String(reason)}`).join('\n');
  }
  if (typeof detail.reason === 'string' && detail.reason.trim()) {
    return detail.reason.trim();
  }
  const nextAttempt = detail.nextAttempt ? `Next attempt: ${String(detail.nextAttempt)}` : '';
  const iteration = detail.iteration ? `Iteration: ${String(detail.iteration)}` : '';
  return [iteration, nextAttempt].filter(Boolean).join('\n');
}

function latestTraceTakeaway(entry: Record<string, unknown>, totalEntries: number) {
  const type = String(entry.type || '');
  const detailText = renderTraceDetail(entry);

  if (type === 'run_failed') {
    return {
      label: 'Terminal outcome',
      value: formatTraceEntry(entry),
      detail: detailText || 'The selected scope ended in failure.',
    };
  }

  if (type === 'while_exhausted' || type === 'while_satisfied') {
    return {
      label: 'Loop outcome',
      value: formatTraceEntry(entry),
      detail: detailText || 'This loop reached a terminal gate result.',
    };
  }

  if (type === 'task_retry') {
    return {
      label: 'Retry transition',
      value: formatTraceEntry(entry),
      detail: detailText || 'Another attempt is scheduled for this scope.',
    };
  }

  return {
    label: 'Latest transition',
    value: formatTraceEntry(entry),
    detail: detailText || `${totalEntries} structured ${totalEntries === 1 ? 'transition stays' : 'transitions stay'} below this summary.`,
  };
}

function pathRows(taskRow: ExecutableRow | null) {
  if (!taskRow) return [];
  return [
    ['Prompt', taskRow.promptPath],
    ['Report', taskRow.reportPath],
    ['Summary', taskRow.summaryPath],
    ['Last message', taskRow.lastMessagePath],
    ['Log', taskRow.logPath],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
}

function DocumentPreview(props: {
  content: string;
  filePath?: string | null;
  emptyText?: string;
}) {
  const { content, filePath, emptyText = 'No preview available.' } = props;
  const trimmed = content.trim();
  if (!trimmed) {
    return (
      <Text size="sm" c="dimmed">
        {emptyText}
      </Text>
    );
  }

  const kind = artifactKind(filePath);
  if (kind === 'markdown') {
    return (
      <div className="af-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children, ...linkProps }) => {
              const targetHref = href && href.startsWith('/') ? api.fs.downloadUrl(href) : href || '#';
              return (
                <a {...linkProps} href={targetHref} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            },
          }}
        >
          {trimmed}
        </ReactMarkdown>
      </div>
    );
  }

  if (kind === 'json') {
    try {
      return (
        <Text className="af-code-block" component="pre">
          {JSON.stringify(JSON.parse(trimmed), null, 2)}
        </Text>
      );
    } catch {
      return (
        <Text className="af-code-block" component="pre">
          {trimmed}
        </Text>
      );
    }
  }

  return (
    <Text className="af-code-block" component="pre">
      {trimmed}
    </Text>
  );
}

function ArtifactSummaryCard(props: { summary: NodeSummary }) {
  const { summary } = props;
  const narrative = buildSelectedNodeNarrative(summary);

  return (
    <div className="af-activity-card af-activity-card--system">
      <Stack gap={8}>
        <Group justify="space-between" gap="sm" align="flex-start">
          <div>
            <SurfaceLabel>Artifacts at this scope</SurfaceLabel>
            <Text fw={700}>{summary.followTarget ? summary.followTarget.label : summary.identity.label}</Text>
          </div>
          <Badge variant="outline">
            {summary.evidence.summary || summary.evidence.report || summary.evidence.artifacts > 0 ? 'Ready' : 'Waiting'}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed" className="af-preview-block">
          Summaries, reports, last messages, and file previews stay here after the selected-node activity is clear. Raw logs stay one step deeper.
        </Text>
          <div className="af-stat-list">
            <div className="af-stat-row">
              <Text size="sm" c="dimmed">Selected scope</Text>
              <Text size="sm">{summary.identity.label}</Text>
            </div>
          {summary.followTarget ? (
            <div className="af-stat-row">
              <Text size="sm" c="dimmed">Evidence scope</Text>
              <Text size="sm">{narrative.evidenceScopeLabel}</Text>
            </div>
          ) : null}
          <div className="af-stat-row">
            <Text size="sm" c="dimmed">Next</Text>
            <Text size="sm">{summary.next.label}</Text>
          </div>
          {summary.followTarget?.descendant ? (
            <div className="af-stat-row">
              <Text size="sm" c="dimmed">Why evidence moves</Text>
              <Text size="sm">{narrative.relationshipDetail}</Text>
            </div>
          ) : null}
        </div>
      </Stack>
    </div>
  );
}

function ActivitySummaryCard(props: { summary: NodeSummary }) {
  const { summary } = props;
  const narrative = buildSelectedNodeNarrative(summary);
  const timingRows = summary.followTarget?.descendant
    ? [
        summary.stateNow.sinceAtUtc
          ? {
              label: 'Updated',
              value: formatLocalTimestamp(summary.stateNow.sinceAtUtc),
            }
          : null,
      ].filter((item): item is { label: string; value: string | null } => Boolean(item?.value))
    : [
        summary.evidenceRow?.startedAtUtc
          ? {
              label: 'Started',
              value: formatLocalTimestamp(summary.evidenceRow.startedAtUtc),
            }
          : null,
        summary.evidenceRow?.endedAtUtc
          ? {
              label: 'Ended',
              value: formatLocalTimestamp(summary.evidenceRow.endedAtUtc),
            }
          : null,
        summary.evidenceRow?.durationSec !== undefined
          ? {
              label: 'Duration',
              value: `${summary.evidenceRow.durationSec}s`,
            }
          : null,
        summary.stateNow.sinceAtUtc && !summary.evidenceRow?.startedAtUtc && !summary.evidenceRow?.endedAtUtc
          ? {
              label: 'Updated',
              value: formatLocalTimestamp(summary.stateNow.sinceAtUtc),
            }
          : null,
      ].filter((item): item is { label: string; value: string | null } => Boolean(item?.value));

  return (
    <div className="af-activity-card af-activity-card--system">
      <Stack gap={8}>
        <Group justify="space-between" gap="sm" align="flex-start">
          <div>
            <SurfaceLabel>What happened here</SurfaceLabel>
            <Text fw={700}>{summary.whyNow.message}</Text>
          </div>
          <Badge variant="outline">
            {summary.stateNow.phase ? summary.stateNow.phase.replaceAll('_', ' ') : summary.stateNow.status.toLowerCase()}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed" className="af-preview-block">
          {narrative.detailPanelDescription}
        </Text>
        <div className="af-stat-list">
          <div className="af-stat-row">
            <Text size="sm" c="dimmed">Selected scope</Text>
            <Text size="sm">{narrative.selectedScopeLabel}</Text>
          </div>
          {summary.followTarget ? (
            <div className="af-stat-row">
              <Text size="sm" c="dimmed">Evidence scope</Text>
              <Text size="sm">{narrative.evidenceScopeLabel}</Text>
            </div>
          ) : null}
          <div className="af-stat-row">
            <Text size="sm" c="dimmed">Next</Text>
            <Text size="sm">{summary.next.label}</Text>
          </div>
          {summary.followTarget?.descendant ? (
            <div className="af-stat-row">
              <Text size="sm" c="dimmed">Why evidence moves</Text>
              <Text size="sm">{narrative.relationshipDetail}</Text>
            </div>
          ) : null}
          {timingRows.map((item) => (
            <div className="af-stat-row" key={item.label}>
              <Text size="sm" c="dimmed">{item.label}</Text>
              <Text size="sm">{item.value}</Text>
            </div>
          ))}
        </div>
      </Stack>
    </div>
  );
}

function buildActivityTakeaways(props: {
  summary: NodeSummary;
  traceEntries: Array<Record<string, unknown>>;
  keyArtifactCount: number;
  parsedLogEventCount: number;
}) {
  const { summary, traceEntries, keyArtifactCount, parsedLogEventCount } = props;
  const items: Array<{ label: string; value: string; detail: string }> = [];
  const latestTrace = traceEntries[0] || null;

  if (summary.judge) {
    const scoreText = summary.judge.score === null
      ? 'No score'
      : summary.judge.threshold === null
        ? String(summary.judge.score)
        : `${summary.judge.score}/${summary.judge.threshold}`;
    items.push({
      label: 'Judge state',
      value: `${readableToken(summary.judge.phase)} -> ${readableToken(summary.judge.result)}`,
      detail: summary.judge.reasons[0] || `Latest score: ${scoreText}.`,
    });
  }

  if (summary.retry) {
    items.push({
      label: 'Retry state',
      value: `Attempt ${summary.retry.attempt} after ${summary.retry.previousAttempts} prior ${summary.retry.previousAttempts === 1 ? 'failure' : 'failures'}`,
      detail: summary.retry.latestFailureReason || 'Another attempt is in flight or scheduled for this scope.',
    });
  }

  if (latestTrace) {
    items.push(latestTraceTakeaway(latestTrace, traceEntries.length));
  }

  if (keyArtifactCount > 0) {
    items.push({
      label: 'Artifacts ready',
      value: `${keyArtifactCount} key ${keyArtifactCount === 1 ? 'document' : 'documents'}`,
      detail: summary.followTarget?.descendant
        ? `Open Artifacts for summaries and reports from ${summary.followTarget.label}.`
        : 'Open Artifacts for summaries, reports, and last messages at this scope.',
    });
  }

  if (parsedLogEventCount > 0) {
    items.push({
      label: 'Execution extracts',
      value: `${parsedLogEventCount} parsed ${parsedLogEventCount === 1 ? 'excerpt' : 'excerpts'}`,
      detail: 'Activity keeps only lightweight excerpts. Raw logs holds the full prompt, stdout, and log text.',
    });
  }

  return items;
}

function OutputMetaChips(props: { summary: NodeSummary }) {
  const { summary } = props;
  const chips = [
    summary.evidenceRow?.startedAtUtc
      ? {
          label: 'Started',
          value: new Date(summary.evidenceRow.startedAtUtc).toLocaleString(),
        }
      : null,
    summary.evidenceRow?.endedAtUtc
      ? {
          label: 'Ended',
          value: new Date(summary.evidenceRow.endedAtUtc).toLocaleString(),
        }
      : null,
    summary.evidenceRow?.durationSec !== undefined
      ? {
          label: 'Duration',
          value: `${summary.evidenceRow.durationSec}s`,
        }
      : null,
    {
      label: 'Next',
      value: summary.next.label,
    },
  ].filter(Boolean) as Array<{ label: string; value: string }>;

  if (chips.length === 0) return null;

  return (
    <div className="af-summary-chip-grid">
      {chips.map((item) => (
        <div className="af-summary-chip" key={`${item.label}:${item.value}`}>
          <Text size="xs" c="dimmed" fw={700} tt="uppercase">
            {item.label}
          </Text>
          <Text fw={700}>{item.value}</Text>
        </div>
      ))}
    </div>
  );
}

export default function MonitorEvidencePanel(props: {
  selectedNode: WorkflowGraphItem | null;
  followNode: WorkflowGraphItem | null;
  summary: NodeSummary | null;
  artifacts: RunArtifactItem[];
  selectedArtifact: RunArtifactItem | null;
  onSelectArtifact(item: RunArtifactItem): void;
  artifactPreview: string;
  artifactPreviewLoading: boolean;
  selectedLogText: string;
  rawOutputLabel: string;
  judgeEvaluations: JudgeEvaluation[];
  judgeChartData: Array<Record<string, unknown>>;
  traceEntries: Array<Record<string, unknown>>;
  tab: MonitorDetailTab;
  onChangeTab(value: MonitorDetailTab): void;
  layout?: 'standalone' | 'embedded';
  scrollHeight?: number | string;
}) {
  const {
    selectedNode,
    followNode,
    summary,
    artifacts,
    selectedArtifact,
    onSelectArtifact,
    artifactPreview,
    artifactPreviewLoading,
    selectedLogText,
    rawOutputLabel,
    judgeEvaluations,
    judgeChartData,
    traceEntries,
    tab,
    onChangeTab,
    layout = 'standalone',
    scrollHeight = 420,
  } = props;
  const embedded = layout === 'embedded';
  const paths = React.useMemo(
    () => pathRows(summary?.evidenceRow || null),
    [summary?.evidenceRow],
  );
  const [documentPreviews, setDocumentPreviews] = React.useState<Record<string, string>>({});
  const [showAllActivityTrace, setShowAllActivityTrace] = React.useState(false);
  const cleanedLogText = React.useMemo(() => stripAnsi(selectedLogText), [selectedLogText]);
  const requestPreview = React.useMemo(
    () => (followNode ? requestPreviewForWorkflowItem(followNode) : ''),
    [followNode],
  );
  const parsedLogEvents = React.useMemo(() => {
    const events = parseLogActivityEvents(cleanedLogText);
    return events.filter((event) => {
      if (event.kind === 'prompt') return false;
      if (
        event.kind === 'system'
        && event.title === 'Execution session'
        && events.length > 1
        && /workdir:|provider:|reasoning effort:|\$ \(cd /.test(event.body)
      ) {
        return false;
      }
      return true;
    });
  }, [cleanedLogText]);
  const activityTraceEntries = React.useMemo(() => traceEntries.filter((entry) => {
    const type = String(entry.type || '');
    if (summary?.judge && type === 'while_gate_evaluation') return false;
    if (summary?.retry && type === 'task_retry') return false;
    return true;
  }), [summary?.judge, summary?.retry, traceEntries]);
  const defaultVisibleTraceCount = 3;
  const visibleActivityTraceEntries = React.useMemo(
    () => (showAllActivityTrace ? activityTraceEntries : activityTraceEntries.slice(0, defaultVisibleTraceCount)),
    [activityTraceEntries, showAllActivityTrace],
  );
  const canExpandActivityTrace = activityTraceEntries.length > defaultVisibleTraceCount;
  const hiddenActivityTraceCount = Math.max(0, activityTraceEntries.length - defaultVisibleTraceCount);
  const visibleParsedLogEvents = React.useMemo(() => parsedLogEvents.slice(0, 3), [parsedLogEvents]);
  const hiddenParsedLogEventCount = Math.max(0, parsedLogEvents.length - visibleParsedLogEvents.length);
  const displayRequest = documentPreviews.prompt || requestPreview;
  const outputCards = [
    { key: 'lastMessage', label: 'Last message', content: documentPreviews.lastMessage, path: summary?.evidenceRow?.lastMessagePath },
    { key: 'summary', label: 'Summary', content: documentPreviews.summary, path: summary?.evidenceRow?.summaryPath },
    { key: 'report', label: 'Report', content: documentPreviews.report, path: summary?.evidenceRow?.reportPath },
  ].filter((item) => item.content);
  const activityTakeaways = React.useMemo(
    () => summary
      ? buildActivityTakeaways({
          summary,
          traceEntries: activityTraceEntries,
          keyArtifactCount: outputCards.length,
          parsedLogEventCount: parsedLogEvents.length,
        })
      : [],
    [activityTraceEntries, outputCards.length, parsedLogEvents.length, summary],
  );
  const narrative = React.useMemo(
    () => (summary ? buildSelectedNodeNarrative(summary) : null),
    [summary],
  );

  React.useEffect(() => {
    setShowAllActivityTrace(false);
  }, [summary?.identity.nodeId]);

  React.useEffect(() => {
    let disposed = false;
    const targets = [
      ['prompt', summary?.evidenceRow?.promptPath],
      ['summary', summary?.evidenceRow?.summaryPath],
      ['report', summary?.evidenceRow?.reportPath],
      ['lastMessage', summary?.evidenceRow?.lastMessagePath],
    ] as const;

    setDocumentPreviews({});
    if (targets.every(([, value]) => !value)) {
      return () => {
        disposed = true;
      };
    }

    void Promise.all(
      targets.map(async ([key, filePath]) => {
        if (!filePath) return [key, ''] as const;
        try {
          const preview = await api.fs.read(String(filePath));
          return [key, preview.text || [preview.head, preview.tail].filter(Boolean).join('\n...\n')] as const;
        } catch {
          return [key, ''] as const;
        }
      }),
    ).then((entries) => {
      if (disposed) return;
      setDocumentPreviews(Object.fromEntries(entries.filter((entry) => entry[1])) as Record<string, string>);
    });

    return () => {
      disposed = true;
    };
  }, [
    summary?.evidenceRow?.lastMessagePath,
    summary?.evidenceRow?.promptPath,
    summary?.evidenceRow?.reportPath,
    summary?.evidenceRow?.summaryPath,
  ]);

  if (!selectedNode || !summary) {
    return (
      <EmptyState
        title="No evidence selected"
        description="Choose a node in the graph to load scoped activity, artifacts, and raw output behind the selected summary."
      />
    );
  }

  function panelBody(children: React.ReactNode) {
    if (embedded) {
      return (
        <Stack gap="md">
          {children}
        </Stack>
      );
    }

    return (
      <ScrollArea h={scrollHeight}>
        <Stack gap="md" pr={4}>
          {children}
        </Stack>
      </ScrollArea>
    );
  }

  const activityPanel = panelBody(
    <>
      {!embedded ? <ActivitySummaryCard summary={summary} /> : null}

      {activityTakeaways.length > 0 ? (
        <div className="af-activity-card af-activity-card--artifact">
          <Stack gap={8}>
            <Group justify="space-between" gap="sm" align="flex-start">
              <div>
                <SurfaceLabel>Activity highlights</SurfaceLabel>
                <Text fw={700}>Scan the selected scope before opening deeper evidence</Text>
              </div>
              <Badge variant="outline">
                {summary.identity.label}
              </Badge>
            </Group>
            <Text size="sm" c="dimmed" className="af-preview-block">
              Judge state, retry status, recent transitions, and lightweight execution notes are compressed here so you can tell what happened without opening raw logs.
            </Text>
            <div className="af-summary-list">
              {activityTakeaways.map((item) => (
                <div className="af-summary-row" key={`${item.label}:${item.value}`}>
                  <Text size="xs" c="dimmed" fw={700} tt="uppercase">
                    {item.label}
                  </Text>
                  <Text size="sm" fw={700}>
                    {item.value}
                  </Text>
                  <Text size="sm" c="dimmed" className="af-preview-block">
                    {item.detail}
                  </Text>
                </div>
              ))}
            </div>
          </Stack>
        </div>
      ) : null}

      {summary.judge ? (
        <div className="af-activity-card af-activity-card--decision">
          <Stack gap="sm">
            <Group justify="space-between" gap="sm" align="flex-start">
              <div>
                <SurfaceLabel>Judge trail</SurfaceLabel>
                <Text fw={700}>
                  {summary.judge.phase.replaceAll('_', ' ')} · {summary.judge.result.replaceAll('_', ' ')}
                </Text>
              </div>
              <Badge variant="outline">
                {summary.judge.score === null ? 'No score' : summary.judge.threshold === null ? summary.judge.score : `${summary.judge.score}/${summary.judge.threshold}`}
              </Badge>
            </Group>
            {judgeChartData.length > 0 ? (
              <AreaChart
                h={160}
                data={judgeChartData}
                dataKey="step"
                series={[{ name: 'score', color: '#4dcfff' }]}
                valueFormatter={(value) => `${value}/10`}
                withLegend={false}
              />
            ) : null}
            {judgeEvaluations.length > 0 ? (
              <Stack gap="xs">
                {judgeEvaluations.slice().reverse().slice(0, 3).map((evaluation) => (
                  <div className="af-summary-row" key={`${evaluation.iteration}-${evaluation.phase}-${evaluation.atUtc}`}>
                    <Text size="xs" c="dimmed" fw={700} tt="uppercase">
                      Iteration {evaluation.iteration} · {evaluation.phase}
                    </Text>
                    <Text size="sm" fw={600}>
                      {evaluation.score === null ? 'No score recorded' : `${evaluation.score}/10`} · {evaluation.passed ? 'passed' : 'retry'}
                    </Text>
                    {evaluation.reasons.length > 0 ? (
                      <Text size="sm" className="af-preview-block">
                        {evaluation.reasons.join('\n')}
                      </Text>
                    ) : null}
                  </div>
                ))}
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                No evaluator reasons recorded yet.
              </Text>
            )}
          </Stack>
        </div>
      ) : null}

      {summary.retry ? (
        <div className="af-activity-card af-activity-card--thinking">
          <Stack gap={8}>
            <Group justify="space-between" gap="sm" align="flex-start">
              <div>
                <SurfaceLabel>Retry trail</SurfaceLabel>
                <Text fw={700}>
                  Attempt {summary.retry.attempt} after {summary.retry.previousAttempts} prior {summary.retry.previousAttempts === 1 ? 'failure' : 'failures'}
                </Text>
              </div>
              <Badge variant="outline">{summary.retry.state.replaceAll('_', ' ')}</Badge>
            </Group>
            {summary.retry.latestFailureReason ? (
              <Text size="sm" className="af-preview-block">
                {summary.retry.latestFailureReason}
              </Text>
            ) : (
              <Text size="sm" c="dimmed">
                No retry failure reason was captured.
              </Text>
            )}
          </Stack>
        </div>
      ) : null}

      {visibleActivityTraceEntries.map((entry, index) => (
        <div className="af-activity-card af-activity-card--decision" key={`${String(entry.atUtc || 'trace')}-${index}`}>
          <Stack gap={8}>
            <Group justify="space-between" gap="sm" align="flex-start">
              <SurfaceLabel>Control flow</SurfaceLabel>
              <Badge variant="outline">{String(entry.type || '')}</Badge>
            </Group>
            <Text fw={600}>{formatTraceEntry(entry)}</Text>
            {renderTraceDetail(entry) ? (
              <Text size="sm" className="af-preview-block">
                {renderTraceDetail(entry)}
              </Text>
            ) : null}
            {entry.atUtc ? (
              <Text size="xs" c="dimmed">
                {new Date(String(entry.atUtc)).toLocaleString()}
              </Text>
            ) : null}
          </Stack>
        </div>
      ))}

      {canExpandActivityTrace ? (
        <div className="af-summary-card">
          <Stack gap="sm">
            <SurfaceLabel>{showAllActivityTrace ? 'Full scoped activity' : 'More structured activity available'}</SurfaceLabel>
            <Text size="sm" c="dimmed" className="af-preview-block">
              {showAllActivityTrace
                ? 'Showing the full structured trail for this scope. Collapse it again to keep the newest transitions and judge output easy to scan.'
                : `${hiddenActivityTraceCount} older scoped ${hiddenActivityTraceCount === 1 ? 'event stays' : 'events stay'} hidden until you expand this section so the activity layer stays readable.`}
            </Text>
            <Group gap="xs">
              <Button size="compact-sm" variant="default" onClick={() => setShowAllActivityTrace((current) => !current)}>
                {showAllActivityTrace
                  ? 'Show fewer activity events'
                  : `Show ${hiddenActivityTraceCount} older ${hiddenActivityTraceCount === 1 ? 'event' : 'events'}`}
              </Button>
            </Group>
          </Stack>
        </div>
      ) : null}

      {visibleParsedLogEvents.length > 0 ? (
        <div className="af-activity-card af-activity-card--prompt">
          <Stack gap={8}>
            <Group justify="space-between" gap="sm" align="flex-start">
              <div>
                <SurfaceLabel>{narrative?.extractsSurfaceLabel || 'Execution extracts'}</SurfaceLabel>
                <Text fw={700}>
                  {narrative?.extractsTitle || `Short parsed notes from ${summary.followTarget?.label || summary.identity.label}`}
                </Text>
              </div>
              <Badge variant="outline">
                {visibleParsedLogEvents.length} shown
              </Badge>
            </Group>
            <Text size="sm" c="dimmed" className="af-preview-block">
              {narrative?.extractsDescription || 'These excerpts help you scan what happened without opening the full raw log. Use Raw logs for the complete text.'}
            </Text>
            <div className="af-summary-list">
              {visibleParsedLogEvents.map((event) => (
                <div className="af-summary-row" key={event.id}>
                  <Group justify="space-between" gap="sm" align="flex-start">
                    <SurfaceLabel>{event.kind.replace('_', ' ')}</SurfaceLabel>
                    <Badge variant="outline">{event.title}</Badge>
                  </Group>
                  <Text className="af-code-block" component="pre">
                    {event.body}
                  </Text>
                </div>
              ))}
            </div>
            <Group gap="xs">
              <Button size="compact-sm" variant="default" onClick={() => onChangeTab('raw')}>
                Open raw logs
              </Button>
            </Group>
          </Stack>
        </div>
      ) : null}

      {hiddenParsedLogEventCount > 0 ? (
        <div className="af-summary-card">
          <Stack gap="sm">
            <SurfaceLabel>More raw detail available</SurfaceLabel>
            <Text size="sm" c="dimmed">
              {hiddenParsedLogEventCount} additional log {hiddenParsedLogEventCount === 1 ? 'event stays' : 'events stay'} behind the raw logs tab so the activity view stays readable.
            </Text>
            <Group gap="xs">
              <Button size="compact-sm" variant="default" onClick={() => onChangeTab('raw')}>
                Open raw logs
              </Button>
            </Group>
          </Stack>
        </div>
      ) : null}

      {visibleParsedLogEvents.length === 0 && activityTraceEntries.length === 0 && !summary.judge && !summary.retry && activityTakeaways.length === 0 ? (
        <EmptyState
          title="No structured activity yet"
          description="This scope does not have structured control-flow or execution summaries yet. Open Artifacts for files or Raw logs for the full execution text."
        />
      ) : null}
    </>,
  );

  const artifactsPanel = panelBody(
    <>
      {!embedded ? <ArtifactSummaryCard summary={summary} /> : null}
      <OutputMetaChips summary={summary} />

      {outputCards.map((item) => (
        <div className="af-activity-card af-activity-card--artifact" key={item.key}>
          <Stack gap={8}>
            <Group justify="space-between" gap="sm" align="flex-start">
              <SurfaceLabel>Key artifact</SurfaceLabel>
              <Badge variant="outline">{item.label}</Badge>
            </Group>
            <DocumentPreview content={String(item.content || '')} filePath={item.path} />
          </Stack>
        </div>
      ))}

      {paths.length > 0 ? (
        <div className="af-file-list">
          {paths.map(([label, value]) => (
            <div className="af-file-row" key={`${label}:${value}`}>
              <Text size="sm" fw={600}>{label}</Text>
              <Text size="sm" c="dimmed">{value}</Text>
            </div>
          ))}
        </div>
      ) : null}

      {artifacts.length === 0 ? (
        <Text size="sm" c="dimmed">
          No artifacts are available for the followed scope yet.
        </Text>
      ) : (
        <div className="af-artifact-actions">
          {artifacts.map((item) => (
            <Button
              key={item.path}
              variant={selectedArtifact?.path === item.path ? 'filled' : 'default'}
              size="compact-sm"
              onClick={() => onSelectArtifact(item)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      )}

      {selectedArtifact ? (
        <>
          <Group justify="space-between" gap="sm">
            <Stack gap={2}>
              <SurfaceLabel>Selected artifact</SurfaceLabel>
              <Text fw={600} size="sm">{selectedArtifact.label}</Text>
            </Stack>
            <Button
              component="a"
              href={api.fs.downloadUrl(selectedArtifact.path)}
              variant="subtle"
              size="compact-sm"
            >
              Download {shortName(selectedArtifact.path)}
            </Button>
          </Group>
          {artifactPreviewLoading ? (
            <Group py="lg" justify="center">
              <Loader size="sm" />
            </Group>
          ) : (
            <ScrollArea h={embedded ? 260 : 300}>
              <DocumentPreview content={artifactPreview} filePath={selectedArtifact.path} />
            </ScrollArea>
          )}
        </>
      ) : null}

      {outputCards.length === 0 && artifacts.length === 0 ? (
        <EmptyState
          title="No artifacts captured yet"
          description="This scope does not have summaries, reports, last messages, or file outputs yet. Activity stays higher-signal; Raw logs remain available for deep inspection."
        />
      ) : null}
    </>,
  );

  const rawPanel = panelBody(
    <>
      {summary.followTarget?.descendant ? (
        <div className="af-summary-card">
          <Stack gap={6}>
            <SurfaceLabel>Raw scope</SurfaceLabel>
            <Text fw={700} size="sm">{narrative?.evidenceScopeLabel || summary.followTarget.label}</Text>
            <Text size="sm" c="dimmed" className="af-preview-block">
              {narrative?.relationshipDetail || summary.followTarget.description}
            </Text>
          </Stack>
        </div>
      ) : null}

      <div className="af-activity-card af-activity-card--prompt">
        <Stack gap={8}>
          <Group justify="space-between" gap="sm" align="flex-start">
            <SurfaceLabel>Prompt / command</SurfaceLabel>
            <Badge variant="outline">{followNode?.type || selectedNode.type}</Badge>
          </Group>
          <DocumentPreview
            content={displayRequest}
            filePath={summary.evidenceRow?.promptPath || null}
            emptyText="No prompt or command snapshot is available for the followed scope."
          />
        </Stack>
      </div>

      <div className="af-activity-card af-activity-card--tool">
        <Stack gap={8}>
          <Group justify="space-between" gap="sm" align="flex-start">
            <SurfaceLabel>{rawOutputLabel}</SurfaceLabel>
            {summary.followTarget ? (
              <Badge variant="outline">{summary.followTarget.label}</Badge>
            ) : null}
          </Group>
          <div className="af-console-pane">
            <ScrollArea h={embedded ? 220 : 240} className="af-console-scroll">
              <Text component="pre" className="af-console-pre">
                {cleanedLogText || 'No node log available for this scope.'}
              </Text>
            </ScrollArea>
          </div>
        </Stack>
      </div>
    </>,
  );

  return (
    <Tabs
      value={tab}
      onChange={(value) => value && onChangeTab(value as MonitorDetailTab)}
      className={embedded ? 'af-monitor-evidence-panel af-monitor-evidence-panel--embedded' : 'af-monitor-evidence-panel'}
    >
      <Tabs.List grow>
        <Tabs.Tab value="activity">Activity</Tabs.Tab>
        <Tabs.Tab value="artifacts">Artifacts</Tabs.Tab>
        <Tabs.Tab value="raw">Raw logs</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="activity" pt="md">
        {activityPanel}
      </Tabs.Panel>

      <Tabs.Panel value="artifacts" pt="md">
        {artifactsPanel}
      </Tabs.Panel>

      <Tabs.Panel value="raw" pt="md">
        {rawPanel}
      </Tabs.Panel>
    </Tabs>
  );
}
