import React, { useEffect, useMemo, useState } from 'react';
import {
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Group,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { DonutChart, Sparkline } from '@mantine/charts';
import {
  IconActivityHeartbeat,
  IconArrowLeft,
  IconChartDonut,
  IconPlayerPause,
  IconRefresh,
  IconRouteAltLeft,
} from '@tabler/icons-react';
import { Link, useParams } from 'react-router-dom';

import Graph from '../components/Graph.tsx';
import NodeInspector from '../components/NodeInspector.tsx';
import { api } from '../api/client.ts';
import { BentoGrid, BentoTile, KpiTile, SurfaceLabel, TileHeader } from '../design/primitives.tsx';
import { useArtifactPreview, useRun } from '../state/monitorStore.ts';
import {
  activitySparkline,
  buildWorkflowGraph,
  collectJudgeEvaluations,
  buildJudgeChartData,
  filterTraceForNode,
  formatTraceEntry,
  getRepresentativeTaskRow,
  pickInitialGraphSelection,
} from '../lib/monitor.ts';

function renderPreview(text: string) {
  return text || 'No content available.';
}

export default function Monitor() {
  const { runId = '' } = useParams();
  const [navbarOpened, { toggle: toggleNavbar }] = useDisclosure(false);
  const { state, trace, consoleEntries, status, connected, totals } = useRun(runId);
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<any | null>(null);
  const [selectedLogText, setSelectedLogText] = useState('');
  const [timelineFilter, setTimelineFilter] = useState('all');
  const planConfigPath = state?.configPath || state?.planPath || null;

  useEffect(() => {
    if (!planConfigPath) return;
    let disposed = false;
    api.fs.read(String(planConfigPath))
      .then((result) => {
        if (disposed) return;
        if (!result.text) {
          setPlan(null);
          return;
        }
        try {
          setPlan(JSON.parse(result.text));
        } catch {
          setPlan(null);
        }
      })
      .catch(() => {
        if (!disposed) setPlan(null);
      });
    return () => {
      disposed = true;
    };
  }, [planConfigPath]);

  const graph = useMemo(() => buildWorkflowGraph(plan, state, trace), [plan, state, trace]);

  useEffect(() => {
    setSelectedGraphId(null);
  }, [runId]);

  useEffect(() => {
    if (graph.items.length === 0) return;
    if (!selectedGraphId || !graph.items.some((item) => item.graphId === selectedGraphId)) {
      setSelectedGraphId(pickInitialGraphSelection(graph));
    }
  }, [graph, selectedGraphId]);

  const selectedNode = selectedGraphId
    ? graph.items.find((item) => item.graphId === selectedGraphId) || null
    : null;
  const selectedWorkflowId = selectedNode?.workflowId || null;
  const selectedTaskRow = useMemo(
    () => getRepresentativeTaskRow(state, selectedNode),
    [selectedNode, state],
  );

  useEffect(() => {
    if (!selectedTaskRow?.taskKey) {
      setArtifacts([]);
      setSelectedArtifact(null);
      return;
    }
    let disposed = false;
    setArtifacts([]);
    setSelectedArtifact(null);
    api.runs.artifacts(runId, selectedTaskRow.taskKey)
      .then((result) => {
        if (disposed) return;
        setArtifacts(result.items || []);
        setSelectedArtifact((current: any) => {
          if (current && result.items?.some((item: any) => item.path === current.path)) return current;
          return result.items?.[0] || null;
        });
      })
      .catch(() => {
        if (!disposed) {
          setArtifacts([]);
          setSelectedArtifact(null);
        }
      });
    return () => {
      disposed = true;
    };
  }, [runId, selectedTaskRow?.taskKey]);

  const { content: artifactPreview, loading: artifactPreviewLoading } = useArtifactPreview(runId, selectedArtifact);

  useEffect(() => {
    if (!selectedTaskRow?.taskKey) {
      setSelectedLogText('');
      return;
    }
    let disposed = false;
    setSelectedLogText('');
    api.runs.logs(runId, selectedTaskRow.taskKey)
      .then((text) => {
        if (!disposed) setSelectedLogText(text);
      })
      .catch(() => {
        if (!disposed) setSelectedLogText('');
      });

    if (!state?.isActive) {
      return () => {
        disposed = true;
      };
    }

    const source = api.sse.tail(runId, selectedTaskRow.taskKey);
    source.addEventListener('log-line', (event: MessageEvent) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { text?: string };
        if (!payload.text || disposed) return;
        setSelectedLogText((current) => `${current}${current ? '\n' : ''}${payload.text}`);
      } catch {}
    });
    return () => {
      disposed = true;
      source.close();
    };
  }, [runId, selectedTaskRow?.taskKey, state?.isActive]);

  const judgeEvaluations = useMemo(
    () => collectJudgeEvaluations(trace, selectedWorkflowId || ''),
    [selectedWorkflowId, trace],
  );
  const judgeChartData = useMemo(
    () => buildJudgeChartData(trace, selectedWorkflowId || ''),
    [selectedWorkflowId, trace],
  );

  const timelineEntries = useMemo(() => {
    const entries = filterTraceForNode(trace, selectedWorkflowId);
    if (timelineFilter === 'gates') return entries.filter((entry) => String(entry.type).includes('while'));
    if (timelineFilter === 'retries') return entries.filter((entry) => String(entry.type) === 'task_retry');
    if (timelineFilter === 'failures') {
      return entries.filter((entry) => {
        const type = String(entry.type);
        return type === 'while_exhausted' || type === 'termination_guard';
      });
    }
    return entries;
  }, [selectedWorkflowId, timelineFilter, trace]);
  const selectedNodeTraceEntries = useMemo(
    () => filterTraceForNode(trace, selectedWorkflowId),
    [selectedWorkflowId, trace],
  );

  const consoleText = consoleEntries
    .map((entry) => `[${entry.source}] ${entry.text}`)
    .join('\n');
  const transportLabel = status === 'RUNNING'
    ? (connected ? 'Live stream connected' : 'Reconnecting to live stream')
    : status === 'FAILED'
      ? 'Run failed'
      : status === 'DONE'
        ? 'Run completed'
        : status === 'CANCELLED'
          ? 'Run cancelled'
          : 'Historical run snapshot';
  const activityLabel = status === 'RUNNING'
    ? (connected ? 'Live event stream connected.' : 'Live event stream reconnecting.')
    : status === 'FAILED'
      ? 'Viewing the final persisted failure state.'
      : status === 'DONE'
        ? 'Viewing the final persisted success state.'
        : status === 'CANCELLED'
          ? 'Viewing the final persisted cancelled state.'
          : 'Historical run loaded from disk.';
  const dashboardBreakdown = [
    { name: 'Done', value: totals.done, color: '#ffe14a' },
    { name: 'Running', value: totals.running, color: '#8ed9ff' },
    { name: 'Failed', value: totals.failed, color: '#ff8c84' },
    { name: 'Pending', value: totals.pending, color: '#fff4cf' },
  ].filter((item) => item.value > 0);

  return (
    <AppShell
      header={{ height: 74 }}
      navbar={{ width: 310, breakpoint: 'lg', collapsed: { mobile: !navbarOpened } }}
      padding="lg"
    >
      <AppShell.Header className="af-shell-header">
        <Group h="100%" px="lg" justify="space-between">
          <Group>
            <Burger opened={navbarOpened} onClick={toggleNavbar} hiddenFrom="lg" size="sm" />
            <Box>
              <Title order={3}>Run monitor</Title>
              <Text size="sm" c="dimmed">
                {state?.configPath || state?.planPath || 'Loading run metadata...'}
              </Text>
            </Box>
          </Group>
          <div className="af-shell-actions">
            <Button component={Link} to="/" variant="default" leftSection={<IconArrowLeft size={16} />}>
              Launch view
            </Button>
            <Button
              variant="default"
              leftSection={<IconRefresh size={16} />}
              onClick={() => api.runs.resumeById(runId).catch(() => undefined)}
            >
              Resume
            </Button>
            <Button
              variant="filled"
              color="orange"
              leftSection={<IconPlayerPause size={16} />}
              onClick={() => api.runs.cancel({ runId }).catch(() => undefined)}
            >
              Cancel
            </Button>
          </div>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar className="af-shell-navbar" p="md">
        <div className="af-rail">
          <BentoTile
            accent="yellow"
            header={
              <TileHeader
                eyebrow="Run summary"
                title="Execution state"
                description="Core run metadata, kept anchored in a narrow rail."
              />
            }
          >
            <Stack gap="sm">
              <Group gap="xs">
                <Badge variant="outline">{runId}</Badge>
                <Badge color={status === 'RUNNING' ? 'electric' : status === 'DONE' ? 'signal' : status === 'FAILED' ? 'danger' : status === 'CANCELLED' ? 'danger' : 'ink'}>
                  {status.toLowerCase()}
                </Badge>
              </Group>
              {state?.runDir ? (
                <Text component="pre" className="af-code-block">
                  {String(state.runDir)}
                </Text>
              ) : null}
              <Text size="sm" c="dimmed">
                Last update {state?.updatedAtUtc ? new Date(String(state.updatedAtUtc)).toLocaleString() : 'pending'}
              </Text>
            </Stack>
          </BentoTile>

          <BentoTile
            accent="paper"
            header={<TileHeader eyebrow="Task health" title="Execution distribution" description="State breakdown across all executable rows." />}
          >
            {dashboardBreakdown.length > 0 ? (
              <DonutChart data={dashboardBreakdown} chartLabel={totals.tasks} />
            ) : (
              <Text size="sm" c="dimmed">Waiting for task state.</Text>
            )}
          </BentoTile>

          <BentoTile
            accent="red"
            header={<TileHeader eyebrow="Recent activity" title="Decision cadence" description="A compact sparkline for loop and control-flow activity." />}
          >
            <Stack gap="sm">
              <Sparkline data={activitySparkline(trace)} color="cyan.6" />
              <Text size="sm" c="dimmed">{trace.length} decision events captured.</Text>
              <Text size="sm" c="dimmed">{activityLabel}</Text>
            </Stack>
          </BentoTile>
        </div>
      </AppShell.Navbar>

      <AppShell.Main>
        <BentoGrid>
          <KpiTile
            label="Run status"
            value={status}
            meta={transportLabel}
            accent={status === 'DONE' ? 'signal' : status === 'FAILED' ? 'danger' : status === 'CANCELLED' ? 'danger' : 'electric'}
            tileAccent={status === 'DONE' ? 'yellow' : status === 'FAILED' ? 'red' : status === 'CANCELLED' ? 'red' : 'blue'}
            icon={<IconRouteAltLeft size={18} />}
          />
          <KpiTile
            label="Tasks"
            value={String(totals.tasks)}
            meta={`${totals.done} done · ${totals.running} running · ${totals.failed} failed`}
            accent="electric"
            tileAccent="paper"
            icon={<IconChartDonut size={18} />}
          />
          <KpiTile
            label="Loop iterations"
            value={String(state?.totalLoopIterations || 0)}
            meta={`${judgeEvaluations.length} judge events on selected node`}
            accent="signal"
            tileAccent="yellow"
            icon={<IconActivityHeartbeat size={18} />}
          />
          <KpiTile
            label="Selected node"
            value={selectedWorkflowId || 'None'}
            meta={selectedNode ? selectedNode.type : 'Choose a node in the graph'}
            accent="danger"
            tileAccent="red"
            icon={<IconRefresh size={18} />}
          />

          <BentoTile
            col={8}
            row={3}
            tone="hero"
            accent="paper"
            className="graph-panel"
            header={
              <TileHeader
                eyebrow="Workflow graph"
                title="Topology, state, and selection"
                description="The graph is the primary surface. Use it to track execution and drive the inspector."
                actions={selectedWorkflowId ? <Badge variant="outline">Selected: {selectedWorkflowId}</Badge> : null}
              />
            }
          >
            <Box h={690}>
              <Graph
                plan={plan}
                state={state}
                trace={trace}
                selectedId={selectedGraphId || undefined}
                selectionKey="graphId"
                onSelectNode={setSelectedGraphId}
              />
            </Box>
          </BentoTile>

          <BentoTile
            col={4}
            row={3}
            accent="blue"
            header={
              <TileHeader
                eyebrow="Inspector"
                title="Selected node detail"
                description="Prompt, artifacts, logs, and loop/judge output stay attached to the current selection."
              />
            }
          >
            <NodeInspector
              selectedNode={selectedNode}
              taskRow={selectedTaskRow}
              artifacts={artifacts}
              selectedArtifact={selectedArtifact}
              onSelectArtifact={setSelectedArtifact}
              artifactPreview={artifactPreview}
              artifactPreviewLoading={artifactPreviewLoading}
              selectedLogText={selectedLogText}
              judgeEvaluations={judgeEvaluations}
              judgeChartData={judgeChartData}
              traceEntries={selectedNodeTraceEntries}
            />
          </BentoTile>

          <BentoTile
            col={4}
            row={2}
            tone="console"
            accent="ink"
            header={
              <TileHeader
                eyebrow="Runner console"
                title="Live orchestration output"
                description="Parent CLI stdout and stderr stream here while the run is active."
              />
            }
          >
            <div className="af-console-pane">
              <ScrollArea h={350} className="af-console-scroll">
                <Text component="pre" className="af-console-pre">
                  {renderPreview(consoleText)}
                </Text>
              </ScrollArea>
            </div>
          </BentoTile>

          <BentoTile
            col={8}
            row={2}
            accent="yellow"
            header={
              <TileHeader
                eyebrow="Activity timeline"
                title="Recent control-flow events"
                description="Filter retries, gates, and failures without leaving the dashboard."
              />
            }
          >
            <Stack gap="md">
              <SegmentedControl
                value={timelineFilter}
                onChange={setTimelineFilter}
                data={[
                  { label: 'All', value: 'all' },
                  { label: 'Gates', value: 'gates' },
                  { label: 'Retries', value: 'retries' },
                  { label: 'Failures', value: 'failures' },
                ]}
              />
              <ScrollArea h={320}>
                <div className="af-timeline-list">
                  {timelineEntries.length === 0 ? (
                    <Text size="sm" c="dimmed">No timeline entries for the current filter.</Text>
                  ) : timelineEntries.map((entry, index) => (
                    <div className="af-timeline-entry" key={`${String(entry.atUtc || 't')}-${index}`}>
                      <Stack gap={6}>
                        <Group justify="space-between" align="flex-start" gap="sm">
                          <Text fw={600} size="sm">{formatTraceEntry(entry)}</Text>
                          <Badge variant="outline">{String(entry.type || '')}</Badge>
                        </Group>
                        <Text size="xs" c="dimmed">{String(entry.atUtc || '')}</Text>
                      </Stack>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </Stack>
          </BentoTile>
        </BentoGrid>
      </AppShell.Main>
    </AppShell>
  );
}
