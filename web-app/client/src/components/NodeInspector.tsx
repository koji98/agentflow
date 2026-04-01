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
import {
  formatTraceEntry,
  parseLogActivityEvents,
  requestPreviewForWorkflowItem,
  stripAnsi,
  type ExecutableRow,
  type JudgeEvaluation,
  type WorkflowGraphItem,
} from '../lib/monitor.ts';
import { api } from '../api/client.ts';
import { EmptyState, SurfaceLabel } from '../design/primitives.tsx';

function shortName(filePath: string) {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
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

function artifactKind(filePath: string | null | undefined) {
  const normalized = String(filePath || '').toLowerCase();
  if (normalized.endsWith('.md')) return 'markdown';
  if (normalized.endsWith('.json')) return 'json';
  return 'text';
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

export default function NodeInspector(props: {
  selectedNode: WorkflowGraphItem | null;
  taskRow: ExecutableRow | null;
  artifacts: RunArtifactItem[];
  selectedArtifact: RunArtifactItem | null;
  onSelectArtifact(item: RunArtifactItem): void;
  artifactPreview: string;
  artifactPreviewLoading: boolean;
  selectedLogText: string;
  judgeEvaluations: JudgeEvaluation[];
  judgeChartData: Array<Record<string, unknown>>;
  traceEntries: Array<Record<string, unknown>>;
}) {
  const {
    selectedNode,
    taskRow,
    artifacts,
    selectedArtifact,
    onSelectArtifact,
    artifactPreview,
    artifactPreviewLoading,
    selectedLogText,
    judgeEvaluations,
    judgeChartData,
    traceEntries,
  } = props;
  const paths = pathRows(taskRow);
  const sourcedFromDescendant = Boolean(taskRow && selectedNode && taskRow.taskId !== selectedNode.workflowId);
  const [activityDocs, setActivityDocs] = React.useState<Record<string, string>>({});
  const cleanedLogText = React.useMemo(() => stripAnsi(selectedLogText), [selectedLogText]);
  const request = React.useMemo(
    () => (selectedNode ? requestPreviewForWorkflowItem(selectedNode) : ''),
    [selectedNode],
  );
  const parsedLogEvents = React.useMemo(
    () => {
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
    },
    [cleanedLogText],
  );
  const displayRequest = activityDocs.prompt || request;
  const outputCards = [
    { key: 'lastMessage', label: 'Last message', content: activityDocs.lastMessage, path: taskRow?.lastMessagePath },
    { key: 'summary', label: 'Summary', content: activityDocs.summary, path: taskRow?.summaryPath },
    { key: 'report', label: 'Report', content: activityDocs.report, path: taskRow?.reportPath },
  ].filter((item) => item.content);

  React.useEffect(() => {
    let disposed = false;
    const targets = [
      ['prompt', taskRow?.promptPath],
      ['summary', taskRow?.summaryPath],
      ['report', taskRow?.reportPath],
      ['lastMessage', taskRow?.lastMessagePath],
    ] as const;

    setActivityDocs({});
    if (targets.every(([, value]) => !value)) return () => {
      disposed = true;
    };

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
      setActivityDocs(
        Object.fromEntries(entries.filter((entry) => entry[1])) as Record<string, string>,
      );
    });

    return () => {
      disposed = true;
    };
  }, [taskRow?.lastMessagePath, taskRow?.promptPath, taskRow?.reportPath, taskRow?.summaryPath]);

  if (!selectedNode) {
    return (
      <EmptyState
        title="No node selected"
        description="Select a workflow node to inspect its request, outputs, artifacts, and logs."
      />
    );
  }

  return (
    <Stack gap="md">
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" gap="sm">
          <div>
            <SurfaceLabel>{selectedNode.type.replaceAll('_', ' ')}</SurfaceLabel>
            <Text fw={700} size="lg">
              {selectedNode.label}
            </Text>
            <Text size="sm" c="dimmed">
              {selectedNode.subtitle}
            </Text>
          </div>
          <Badge
            color={
              selectedNode.status === 'DONE'
                ? 'signal'
                : selectedNode.status === 'FAILED'
                  ? 'danger'
                  : selectedNode.status === 'RUNNING'
                    ? 'electric'
                    : 'ink'
            }
            variant="light"
          >
            {selectedNode.status.toLowerCase()}
          </Badge>
        </Group>
        <Group gap="xs">
          <Badge variant="outline">{selectedNode.type}</Badge>
          {taskRow ? <Badge variant="outline">Attempt {taskRow.attempt}</Badge> : null}
          {taskRow?.durationSec !== undefined ? <Badge variant="outline">{taskRow.durationSec}s</Badge> : null}
          {sourcedFromDescendant ? <Badge variant="outline">Log source {taskRow?.taskId}</Badge> : null}
        </Group>
      </Stack>

      <Tabs defaultValue="activity">
        <Tabs.List grow>
          <Tabs.Tab value="activity">Activity</Tabs.Tab>
          <Tabs.Tab value="artifacts">Artifacts</Tabs.Tab>
          <Tabs.Tab value="logs">Raw log</Tabs.Tab>
          <Tabs.Tab value="judge">Judge / Loop</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="activity" pt="md">
          <ScrollArea h={540}>
            <Stack gap="md" pr={4}>
              <div className="af-activity-card af-activity-card--system">
                <Stack gap={8}>
                  <Group justify="space-between" gap="sm" align="flex-start">
                    <div>
                      <SurfaceLabel>Run state</SurfaceLabel>
                      <Text fw={700}>Attempt {taskRow?.attempt || 1}</Text>
                    </div>
                    <Badge variant="outline">{selectedNode.status.toLowerCase()}</Badge>
                  </Group>
                  <div className="af-stat-list">
                    {taskRow?.startedAtUtc ? (
                      <div className="af-stat-row">
                        <Text size="sm" c="dimmed">Started</Text>
                        <Text size="sm">{new Date(taskRow.startedAtUtc).toLocaleString()}</Text>
                      </div>
                    ) : null}
                    {taskRow?.endedAtUtc ? (
                      <div className="af-stat-row">
                        <Text size="sm" c="dimmed">Ended</Text>
                        <Text size="sm">{new Date(taskRow.endedAtUtc).toLocaleString()}</Text>
                      </div>
                    ) : null}
                    {taskRow?.durationSec !== undefined ? (
                      <div className="af-stat-row">
                        <Text size="sm" c="dimmed">Duration</Text>
                        <Text size="sm">{taskRow.durationSec}s</Text>
                      </div>
                    ) : null}
                    {taskRow?.provider ? (
                      <div className="af-stat-row">
                        <Text size="sm" c="dimmed">Provider</Text>
                        <Text size="sm">{String(taskRow.provider)}</Text>
                      </div>
                    ) : null}
                    {taskRow?.model ? (
                      <div className="af-stat-row">
                        <Text size="sm" c="dimmed">Model</Text>
                        <Text size="sm">{String(taskRow.model)}</Text>
                      </div>
                    ) : null}
                  </div>
                  {sourcedFromDescendant ? (
                    <Text size="sm" c="dimmed">
                      Following descendant activity from <strong>{taskRow?.taskId}</strong>.
                    </Text>
                  ) : null}
                </Stack>
              </div>

              {taskRow?.failureReason ? (
                <div className="af-activity-card af-activity-card--failure">
                  <Stack gap={4}>
                    <Group justify="space-between" gap="sm" align="flex-start">
                      <SurfaceLabel>Failure</SurfaceLabel>
                      <Badge color="danger" variant="light">failed</Badge>
                    </Group>
                    <Text fw={600} c="red.8">
                      {String(taskRow.failureReason)}
                    </Text>
                  </Stack>
                </div>
              ) : null}

              {displayRequest ? (
                <div className="af-activity-card af-activity-card--prompt">
                  <Stack gap={8}>
                    <Group justify="space-between" gap="sm" align="flex-start">
                      <SurfaceLabel>Prompt / command</SurfaceLabel>
                      <Badge variant="outline">{selectedNode.type}</Badge>
                    </Group>
                    <DocumentPreview
                      content={displayRequest}
                      filePath={taskRow?.promptPath || null}
                    />
                  </Stack>
                </div>
              ) : null}

              {traceEntries.map((entry, index) => (
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

              {parsedLogEvents.map((event) => (
                <div className={`af-activity-card af-activity-card--${event.kind}`} key={event.id}>
                  <Stack gap={8}>
                    <Group justify="space-between" gap="sm" align="flex-start">
                      <SurfaceLabel>{event.kind.replace('_', ' ')}</SurfaceLabel>
                      <Badge variant="outline">{event.title}</Badge>
                    </Group>
                    <Text className="af-code-block" component="pre">
                      {event.body}
                    </Text>
                  </Stack>
                </div>
              ))}

              {outputCards.map((item) => (
                <div className="af-activity-card af-activity-card--artifact" key={item.key}>
                  <Stack gap={8}>
                    <Group justify="space-between" gap="sm" align="flex-start">
                      <SurfaceLabel>Output</SurfaceLabel>
                      <Badge variant="outline">{item.label}</Badge>
                    </Group>
                    <DocumentPreview
                      content={String(item.content || '')}
                      filePath={item.path}
                    />
                  </Stack>
                </div>
              ))}

              {parsedLogEvents.length === 0 && traceEntries.length === 0 && !displayRequest && outputCards.length === 0 ? (
                <EmptyState
                  title="No structured activity yet"
                  description="This node does not have parsed activity output yet. Use the raw log tab for the full execution log."
                />
              ) : null}
            </Stack>
          </ScrollArea>
        </Tabs.Panel>

        <Tabs.Panel value="artifacts" pt="md">
          <Stack gap="sm">
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
                No artifacts available for the selected node.
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
                  <ScrollArea h={330}>
                    <DocumentPreview
                      content={artifactPreview}
                      filePath={selectedArtifact.path}
                    />
                  </ScrollArea>
                )}
              </>
            ) : null}
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="logs" pt="md">
          <div className="af-console-pane">
            <ScrollArea h={420} className="af-console-scroll">
              <Text component="pre" className="af-console-pre">
                {cleanedLogText || 'No node log available for the selected item.'}
              </Text>
            </ScrollArea>
          </div>
        </Tabs.Panel>

        <Tabs.Panel value="judge" pt="md">
          <Stack gap="sm">
            {judgeChartData.length > 0 ? (
                <AreaChart
                  h={180}
                  data={judgeChartData}
                  dataKey="step"
                  series={[{ name: 'score', color: '#4dcfff' }]}
                  valueFormatter={(value) => `${value}/10`}
                  withLegend={false}
                />
            ) : (
              <Text size="sm" c="dimmed">
                No loop or judge evaluations available for this node.
              </Text>
            )}

            {judgeEvaluations.length > 0 ? (
              <ScrollArea h={240}>
                <Stack gap="xs">
                  {judgeEvaluations.slice().reverse().map((evaluation) => (
                    <div className="af-timeline-entry" key={`${evaluation.iteration}-${evaluation.phase}-${evaluation.atUtc}`}>
                      <Stack gap={6}>
                        <Group justify="space-between" align="flex-start">
                          <Text fw={600} size="sm">
                            Iteration {evaluation.iteration} · {evaluation.phase}
                          </Text>
                          <Badge color={evaluation.passed ? 'green' : 'orange'} variant="light">
                            {evaluation.score === null ? 'No score' : `${evaluation.score}/10`}
                          </Badge>
                        </Group>
                        {evaluation.reasons.length > 0 ? (
                          <Stack gap={4}>
                            {evaluation.reasons.map((reason, index) => (
                              <Text key={`${evaluation.atUtc}-${index}`} size="sm">
                                {reason}
                              </Text>
                            ))}
                          </Stack>
                        ) : (
                          <Text size="sm" c="dimmed">
                            No evaluator reasons recorded.
                          </Text>
                        )}
                      </Stack>
                    </div>
                  ))}
                </Stack>
              </ScrollArea>
            ) : null}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
