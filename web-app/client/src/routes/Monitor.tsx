import React, { useEffect, useMemo, useState } from 'react';
import {
  AppShell,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  IconArrowLeft,
  IconPlayerPause,
  IconRefresh,
} from '@tabler/icons-react';
import { Link, useParams } from 'react-router-dom';

import Graph from '../components/Graph.tsx';
import MonitorEvidencePanel from '../components/MonitorEvidencePanel.tsx';
import NodeInspector from '../components/NodeInspector.tsx';
import MonitorRunFeedPanel from '../components/MonitorRunFeedPanel.tsx';
import { api } from '../api/client.ts';
import { BentoGrid, BentoTile, EmptyState, SurfaceLabel, TileHeader } from '../design/primitives.tsx';
import {
  useArtifactPreview,
  useMonitorPreference,
  useRun,
  useRunScopedMonitorPreference,
} from '../state/monitorStore.ts';
import {
  buildFocusedWorkflowGraph,
  buildJudgeChartData,
  buildNodeSummary,
  buildSelectedNodeNarrative,
  buildWorkflowGraph,
  collectJudgeEvaluations,
  filterTraceForNode,
  graphFocusModeDescription,
  graphFocusModeLabel,
  pickInitialGraphSelection,
  type GraphFocusMode,
  type MonitorDetailTab,
} from '../lib/monitor.ts';

type StoredMonitorDetailTab = MonitorDetailTab | 'outputs';

function normalizeDetailTab(value: StoredMonitorDetailTab): MonitorDetailTab {
  return value === 'outputs' ? 'artifacts' : value;
}

function readableToken(value: string | null | undefined): string {
  return String(value || '')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .trim();
}

function formatLocalTimestamp(value: string | null | undefined): string {
  if (!value) return 'No timestamp yet';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'No timestamp yet';
  return parsed.toLocaleString();
}

export default function Monitor() {
  const { runId = '' } = useParams();
  const [refreshToken, setRefreshToken] = useState(0);
  const { state, trace, consoleEntries, status, connected, hydrating, loadIssue, totals, controls } = useRun(runId, refreshToken);
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [planLoadState, setPlanLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [selectedGraphId, setSelectedGraphId] = useRunScopedMonitorPreference<string | null>(runId, 'selectedGraphId', null);
  const [focusMode, setFocusMode] = useMonitorPreference<GraphFocusMode>('focusMode', 'selected');
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<any | null>(null);
  const [selectedLogText, setSelectedLogText] = useState('');
  const [runActionBusy, setRunActionBusy] = useState<'resume' | 'cancel' | null>(null);
  const [storedEvidenceTab, setStoredEvidenceTab] = useMonitorPreference<StoredMonitorDetailTab>('detailTab', 'activity');
  const [timelineFilter, setTimelineFilter] = useMonitorPreference<string>('timelineFilter', 'all');
  const [feedOpen, setFeedOpen] = useMonitorPreference<boolean>('feedOpen', false);
  const planConfigPath = state?.configPath || state?.planPath || null;
  const evidenceTab = normalizeDetailTab(storedEvidenceTab);

  useEffect(() => {
    if (storedEvidenceTab === 'outputs') {
      setStoredEvidenceTab('artifacts');
    }
  }, [setStoredEvidenceTab, storedEvidenceTab]);

  useEffect(() => {
    setPlan(null);
    if (!planConfigPath) {
      setPlanLoadState('idle');
      return;
    }
    let disposed = false;
    setPlanLoadState('loading');
    api.fs.read(String(planConfigPath))
      .then((result) => {
        if (disposed) return;
        if (!result.text) {
          setPlan(null);
          setPlanLoadState('error');
          return;
        }
        try {
          setPlan(JSON.parse(result.text));
          setPlanLoadState('ready');
        } catch {
          setPlan(null);
          setPlanLoadState('error');
        }
      })
      .catch(() => {
        if (!disposed) {
          setPlan(null);
          setPlanLoadState('error');
        }
      });
    return () => {
      disposed = true;
    };
  }, [planConfigPath]);

  const graph = useMemo(() => buildWorkflowGraph(plan, state, trace), [plan, state, trace]);

  useEffect(() => {
    setPlan(null);
    setPlanLoadState('idle');
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
  const selectedSummary = useMemo(
    () => buildNodeSummary(graph, selectedNode, state, trace, { artifactCount: artifacts.length }),
    [artifacts.length, graph, selectedNode, state, trace],
  );
  const selectedNarrative = useMemo(
    () => (selectedSummary ? buildSelectedNodeNarrative(selectedSummary) : null),
    [selectedSummary],
  );
  const selectedFollowWorkflowId = selectedSummary?.followTarget?.workflowId || null;
  const focusedGraph = useMemo(
    () => buildFocusedWorkflowGraph(graph, {
      selectedId: selectedGraphId || undefined,
      selectionKey: 'graphId',
      mode: focusMode,
      followId: selectedFollowWorkflowId,
    }),
    [focusMode, graph, selectedFollowWorkflowId, selectedGraphId],
  );
  const focusedStatusCounts = useMemo(() => ({
    running: focusedGraph.items.filter((item) => item.status === 'RUNNING').length,
    failed: focusedGraph.items.filter((item) => item.status === 'FAILED').length,
    pending: focusedGraph.items.filter((item) => item.status === 'PENDING').length,
    done: focusedGraph.items.filter((item) => item.status === 'DONE').length,
  }), [focusedGraph.items]);
  const selectedTaskRow = selectedSummary?.evidenceRow || null;
  const selectedFollowNode = selectedSummary?.followTarget
    ? graph.nodeByWorkflowId.get(selectedSummary.followTarget.workflowId) || selectedNode
    : selectedNode;
  const selectedRawOutputSource = useMemo(() => {
    if (!selectedTaskRow) return null;
    const logArtifact = artifacts.find((item) => item.key === 'log' && item.path);
    if (logArtifact) {
      return {
        kind: 'log' as const,
        path: logArtifact.path,
        label: 'Execution log',
      };
    }
    const messageArtifact = artifacts.find((item) => item.key === 'message' && item.path);
    if (messageArtifact) {
      return {
        kind: 'file' as const,
        path: messageArtifact.path,
        label: 'Last message / stdout',
      };
    }
    if (selectedTaskRow.logPath) {
      return {
        kind: 'log' as const,
        path: selectedTaskRow.logPath,
        label: 'Execution log',
      };
    }
    if (selectedTaskRow.lastMessagePath) {
      return {
        kind: 'file' as const,
        path: selectedTaskRow.lastMessagePath,
        label: 'Last message / stdout',
      };
    }
    return null;
  }, [artifacts, selectedTaskRow]);

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
    if (!selectedTaskRow?.taskKey || !selectedRawOutputSource) {
      setSelectedLogText('');
      return;
    }
    let disposed = false;
    setSelectedLogText('');
    const loadStaticFile = async (filePath: string) => {
      const preview = await api.fs.read(filePath);
      return preview.text || [preview.head, preview.tail].filter(Boolean).join('\n...\n');
    };
    const loadInitialOutput = async () => {
      try {
        if (selectedRawOutputSource.kind === 'log') {
          const text = await api.runs.logs(runId, selectedTaskRow.taskKey);
          if (!disposed) setSelectedLogText(text);
          return;
        }
        const text = await loadStaticFile(selectedRawOutputSource.path);
        if (!disposed) setSelectedLogText(text);
      } catch {
        if (selectedTaskRow.lastMessagePath && selectedRawOutputSource.path !== selectedTaskRow.lastMessagePath) {
          try {
            const fallback = await loadStaticFile(selectedTaskRow.lastMessagePath);
            if (!disposed) setSelectedLogText(fallback);
            return;
          } catch {}
        }
        if (!disposed) setSelectedLogText('');
      }
    };
    void loadInitialOutput();

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
    source.addEventListener('log-snapshot', (event: MessageEvent) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { text?: string };
        if (disposed) return;
        setSelectedLogText(payload.text || '');
      } catch {}
    });
    return () => {
      disposed = true;
      source.close();
    };
  }, [
    runId,
    selectedRawOutputSource,
    selectedTaskRow?.lastMessagePath,
    selectedTaskRow?.taskKey,
    state?.isActive,
  ]);

  const handleResume = async () => {
    if (!runId || !canResume || runActionBusy) return;
    setRunActionBusy('resume');
    try {
      await api.runs.resumeById(runId);
      setRefreshToken((current) => current + 1);
    } catch {
      // noop
    } finally {
      setRunActionBusy(null);
    }
  };

  const handleCancel = async () => {
    if (!runId || !canCancel || runActionBusy) return;
    setRunActionBusy('cancel');
    try {
      await api.runs.cancel({ runId });
      setRefreshToken((current) => current + 1);
    } catch {
      // noop
    } finally {
      setRunActionBusy(null);
    }
  };

  const judgeEvaluations = useMemo(
    () => collectJudgeEvaluations(trace, selectedWorkflowId || ''),
    [selectedWorkflowId, trace],
  );
  const judgeChartData = useMemo(
    () => buildJudgeChartData(trace, selectedWorkflowId || ''),
    [selectedWorkflowId, trace],
  );

  const timelineEntries = useMemo(() => {
    const entries = filterTraceForNode(trace, null);
    if (timelineFilter === 'gates') return entries.filter((entry) => String(entry.type).includes('while'));
    if (timelineFilter === 'retries') return entries.filter((entry) => String(entry.type) === 'task_retry');
    if (timelineFilter === 'failures') {
      return entries.filter((entry) => {
        const type = String(entry.type);
        return type === 'while_exhausted' || type === 'termination_guard';
      });
    }
    return entries;
  }, [timelineFilter, trace]);
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
  const monitorStripAccent = status === 'DONE'
    ? 'yellow'
    : status === 'FAILED' || status === 'CANCELLED'
      ? 'red'
      : status === 'RUNNING'
        ? 'blue'
        : 'paper';
  const runStatusBadgeColor = status === 'RUNNING'
    ? 'electric'
    : status === 'DONE'
      ? 'signal'
      : status === 'FAILED' || status === 'CANCELLED'
        ? 'danger'
        : 'ink';
  const focusLabel = graphFocusModeLabel(focusMode);
  const focusDescription = graphFocusModeDescription(focusMode);
  const selectedScopeLabel = selectedNarrative?.selectedScopeLabel || 'Choose a node in the graph';
  const evidenceScopeLabel = selectedNarrative?.evidenceScopeLabel || 'No scope selected';
  const currentEvidenceLabel = evidenceTab === 'activity'
    ? 'Activity'
    : evidenceTab === 'artifacts'
      ? 'Artifacts'
      : 'Raw logs';
  const selectedStateLabel = selectedSummary
    ? selectedSummary.stateNow.phase
      ? `${selectedSummary.stateNow.status.toLowerCase()} · ${readableToken(selectedSummary.stateNow.phase)}`
      : selectedSummary.stateNow.status.toLowerCase()
    : 'Select a node to focus the monitor';
  const selectedWhyLabel = selectedSummary?.whyNow.message || 'The graph stays primary. Select a node to understand the current scope, why it matters, and what happens next.';
  const selectedNextLabel = selectedSummary?.next.label || 'Open a node to see the next transition.';
  const selectedUpdatedLabel = selectedSummary ? formatLocalTimestamp(selectedSummary.stateNow.sinceAtUtc) : 'No timestamp yet';
  const evidenceHandoffLabel = selectedNarrative?.detailPanelDescription
    || 'Activity stays the first deeper layer, followed by Artifacts and Raw logs.';
  const stageHandoffLabel = selectedNarrative?.stageHandoff
    || 'Overview, Activity, Artifacts, and Raw logs stay on the selected scope.';
  const feedToggleLabel = feedOpen ? 'Hide run feed' : 'Open run feed';
  const detailSurfaceLabel = selectedSummary
    ? evidenceTab === 'activity'
      ? `${currentEvidenceLabel} stays scoped to ${selectedScopeLabel}`
      : `${currentEvidenceLabel} follows ${evidenceScopeLabel}`
    : 'Choose a graph node to inspect the next evidence layer.';
  const isPlanHydrating = Boolean(planConfigPath) && planLoadState !== 'ready' && planLoadState !== 'error';
  const showResolvingState = hydrating || isPlanHydrating;
  const canResume = controls.canResume;
  const canCancel = controls.canCancel;
  const executionStats = [
    { label: 'Tasks', value: String(totals.tasks) },
    { label: 'Running', value: String(totals.running) },
    { label: 'Failed', value: String(totals.failed) },
    { label: 'Loops', value: String(state?.totalLoopIterations || 0) },
  ];
  const focusStats = [
    { label: 'Visible', value: String(focusedGraph.counts.visible) },
    { label: 'Hidden', value: String(focusedGraph.counts.hidden) },
    { label: 'Running', value: String(focusedStatusCounts.running) },
    { label: 'Failed', value: String(focusedStatusCounts.failed) },
  ];
  const selectedScopeStats = [
    { label: 'State', value: selectedStateLabel },
    { label: 'Updated', value: selectedUpdatedLabel },
    { label: 'Next', value: selectedNextLabel },
  ];
  const jumpToFollowTarget = () => {
    const followWorkflowId = selectedSummary?.followTarget?.workflowId;
    if (!followWorkflowId) return;
    const followNode = graph.nodeByWorkflowId.get(followWorkflowId);
    if (!followNode) return;
    setFocusMode('selected');
    setSelectedGraphId(followNode.graphId);
  };
  const recoveryTitle = loadIssue?.kind === 'run_id_ambiguous'
    ? 'Choose the exact historical run'
    : loadIssue?.kind === 'run_not_found'
      ? 'Run not found in the current local roots'
      : 'Unable to hydrate this run';
  const recoveryDescription = loadIssue?.kind === 'run_id_ambiguous'
    ? `Multiple persisted runs match ${runId}. Open the exact run directory from Launch view so the monitor does not guess.`
    : loadIssue?.kind === 'run_not_found'
      ? `No persisted run with id ${runId} was found under the current allowed local roots.`
      : 'The monitor could not load a persisted snapshot from the current local roots.';
  const recoveryEmptyTitle = loadIssue?.kind === 'run_id_ambiguous'
    ? 'Open the exact run directory from Launch view.'
    : 'Open the run from Launch view or restore its local root.';
  const recoveryEmptyDescription = loadIssue?.kind === 'run_id_ambiguous'
    ? 'This deep link is not specific enough. Use Launch view -> Open existing run, pick the correct directory, and then return to the monitor.'
    : 'If the run still exists on disk, reopen it from the launch board or add its parent path to AGENTFLOW_WEB_ALLOWED_ROOTS before retrying this deep link.';

  return (
    <AppShell
      header={{ height: { base: 196, sm: 86 } }}
      padding="lg"
    >
      <AppShell.Header className="af-shell-header">
        <Group px="lg" py="sm" className="af-shell-header__inner">
          <Box className="af-shell-header__meta">
            <Box>
              <Title order={3}>Run monitor</Title>
              <Text size="sm" c="dimmed" className="af-shell-plan-path">
                {state?.configPath || state?.planPath || 'Loading run metadata...'}
              </Text>
            </Box>
          </Box>
          <div className="af-shell-actions">
            <Button component={Link} to="/" variant="default" leftSection={<IconArrowLeft size={16} />}>
              Launch view
            </Button>
            <Button
              variant="default"
              leftSection={<IconRefresh size={16} />}
              onClick={() => { void handleResume(); }}
              disabled={!runId || !canResume || runActionBusy !== null}
              loading={runActionBusy === 'resume'}
            >
              Resume
            </Button>
            <Button
              variant="filled"
              color="orange"
              leftSection={<IconPlayerPause size={16} />}
              onClick={() => { void handleCancel(); }}
              disabled={!runId || !canCancel || runActionBusy !== null}
              loading={runActionBusy === 'cancel'}
            >
              Cancel
            </Button>
          </div>
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        {showResolvingState ? (
          <BentoGrid className="af-monitor-grid">
            <BentoTile
              col={12}
              row={2}
              tone="hero"
              accent="paper"
              header={
                <TileHeader
                  eyebrow="Resolving run"
                  title="Hydrating monitor surfaces"
                  description="Load persisted run state, graph topology, and selected-scope context before showing the monitor shell."
                />
              }
            >
              <Stack align="center" justify="center" gap="md" py="xl">
                <Loader size="sm" />
                <Text fw={700}>{runId || 'Preparing monitor session'}</Text>
                <Text size="sm" c="dimmed" ta="center" maw={540}>
                  The monitor waits for the first run snapshot and plan topology so the graph, overview, and evidence tiles do not open in a misleading empty state.
                </Text>
              </Stack>
            </BentoTile>
          </BentoGrid>
        ) : !state ? (
          <BentoGrid className="af-monitor-grid">
            <BentoTile
              col={12}
              row={loadIssue?.kind === 'run_id_ambiguous' ? 3 : 2}
              accent="red"
              header={
                <TileHeader
                  eyebrow="Run unavailable"
                  title={recoveryTitle}
                  description={recoveryDescription}
                />
              }
            >
              <Stack gap="md">
                <EmptyState
                  title={recoveryEmptyTitle}
                  description={recoveryEmptyDescription}
                />
                {loadIssue?.kind === 'run_id_ambiguous' && loadIssue.matches.length > 0 ? (
                  <div className="af-monitor-recovery-list">
                    {loadIssue.matches.map((match) => (
                      <div key={match.runDir} className="af-monitor-recovery-card">
                        <Group justify="space-between" gap="sm" align="flex-start">
                          <div>
                            <SurfaceLabel>Matched run</SurfaceLabel>
                            <Text fw={700} size="sm">{match.runDir}</Text>
                          </div>
                          <Badge variant="outline">
                            {match.updatedAtUtc ? formatLocalTimestamp(match.updatedAtUtc) : 'No timestamp'}
                          </Badge>
                        </Group>
                        <Text size="sm" c="dimmed">
                          {match.planPath || 'No plan path recorded in run_state.json'}
                        </Text>
                      </div>
                    ))}
                  </div>
                ) : null}
              </Stack>
            </BentoTile>
          </BentoGrid>
        ) : (
          <BentoGrid className="af-monitor-grid">
            <BentoTile
              col={8}
              row={4}
              tone="hero"
              accent="paper"
              className="graph-panel"
              header={
                <TileHeader
                  eyebrow="Workflow graph"
                  title={transportLabel}
                  description="Select a node to reframe the topology. Run state, focus mode, and selected-scope evidence stay attached without pushing the graph out of view."
                  actions={
                    selectedSummary ? (
                      <Group gap="xs">
                        <Badge variant="outline">Scope: {selectedSummary.identity.label}</Badge>
                        <Badge variant="outline">Evidence: {evidenceScopeLabel}</Badge>
                        <Badge variant="outline">Layer: {currentEvidenceLabel}</Badge>
                      </Group>
                    ) : null
                  }
                />
              }
            >
              <div className="af-monitor-stage-shell">
                <div className="af-monitor-stage-strip">
                  <div className="af-monitor-stage-card" data-accent={monitorStripAccent}>
                    <Stack gap={8}>
                      <Group justify="space-between" align="flex-start" gap="sm">
                        <div className="af-monitor-stage-card__copy">
                          <SurfaceLabel>Execution status</SurfaceLabel>
                          <Text fw={700} size="sm">
                            {transportLabel}
                          </Text>
                        </div>
                        <Badge color={runStatusBadgeColor}>
                          {status.toLowerCase()}
                        </Badge>
                      </Group>
                      <Group gap="xs">
                        <Badge variant="outline">{runId}</Badge>
                        <Badge variant="outline">{connected && status === 'RUNNING' ? 'Live stream' : 'Snapshot view'}</Badge>
                      </Group>
                      <Text size="sm" c="dimmed" className="af-preview-block" lineClamp={2}>
                        {activityLabel}
                      </Text>
                      {state?.runDir ? (
                        <Text size="xs" c="dimmed" className="af-monitor-brief-path" title={String(state.runDir)}>
                          {String(state.runDir)}
                        </Text>
                      ) : null}
                      <div className="af-monitor-stage-stats">
                        {executionStats.map((item) => (
                          <div className="af-monitor-stage-stat" key={item.label}>
                            <Text size="xs" c="dimmed" fw={700} tt="uppercase">{item.label}</Text>
                            <Text fw={700}>{item.value}</Text>
                          </div>
                        ))}
                      </div>
                    </Stack>
                  </div>

                  <div className="af-monitor-stage-card">
                    <Stack gap={8}>
                      <Group justify="space-between" align="flex-start" gap="sm">
                        <div className="af-monitor-stage-card__copy">
                          <SurfaceLabel>Graph lens</SurfaceLabel>
                          <Text fw={700} size="sm">
                            {focusLabel}
                          </Text>
                        </div>
                        <Badge variant="outline">{focusedGraph.counts.hidden} hidden</Badge>
                      </Group>
                      <Text size="sm" c="dimmed" className="af-preview-block" lineClamp={2}>
                        {focusDescription}
                      </Text>
                      <SegmentedControl
                        size="sm"
                        value={focusMode}
                        onChange={(value) => setFocusMode(value as GraphFocusMode)}
                        data={[
                          { label: 'Scope', value: 'selected' },
                          { label: 'Active', value: 'active' },
                          { label: 'Failed', value: 'failed' },
                          { label: 'Collapse', value: 'collapse-completed' },
                          { label: 'Full', value: 'full' },
                        ]}
                      />
                      <div className="af-monitor-stage-stats af-monitor-stage-stats--focus">
                        {focusStats.map((item) => (
                          <div className="af-monitor-stage-stat" key={item.label}>
                            <Text size="xs" c="dimmed" fw={700} tt="uppercase">{item.label}</Text>
                            <Text fw={700}>{item.value}</Text>
                          </div>
                        ))}
                      </div>
                    </Stack>
                  </div>

                  <div className="af-monitor-stage-card af-monitor-stage-card--scope">
                    <Stack gap={8}>
                      <Group justify="space-between" gap="sm" align="flex-start">
                        <div className="af-monitor-stage-card__copy">
                          <SurfaceLabel>Selected path</SurfaceLabel>
                          <Text fw={700} size="sm">
                            {selectedScopeLabel}
                          </Text>
                        </div>
                        {selectedSummary ? (
                          <Badge variant="outline">{selectedSummary.identity.type.replaceAll('_', ' ')}</Badge>
                        ) : (
                          <Badge variant="outline">Awaiting selection</Badge>
                        )}
                      </Group>
                      <div className="af-monitor-stage-meta">
                        {selectedScopeStats.map((item) => (
                          <div className="af-monitor-stage-meta__item" key={item.label}>
                            <Text size="xs" c="dimmed" fw={700} tt="uppercase">{item.label}</Text>
                            <Text fw={700} size="sm">{item.value}</Text>
                          </div>
                        ))}
                      </div>
                      <Text size="sm" fw={700} className="af-preview-block" lineClamp={2}>
                        {selectedWhyLabel}
                      </Text>
                      <Text size="sm" c="dimmed" className="af-preview-block" lineClamp={2}>
                        {stageHandoffLabel}
                      </Text>
                      <div className="af-monitor-stage-actions">
                        <Button
                          size="compact-sm"
                          variant={evidenceTab === 'activity' ? 'filled' : 'default'}
                          onClick={() => setStoredEvidenceTab('activity')}
                        >
                          Activity
                        </Button>
                        <Button
                          size="compact-sm"
                          variant={evidenceTab === 'artifacts' ? 'filled' : 'default'}
                          onClick={() => setStoredEvidenceTab('artifacts')}
                        >
                          Artifacts
                        </Button>
                        <Button
                          size="compact-sm"
                          variant={evidenceTab === 'raw' ? 'filled' : 'default'}
                          onClick={() => setStoredEvidenceTab('raw')}
                        >
                          Raw logs
                        </Button>
                        {selectedSummary?.followTarget?.descendant ? (
                          <Button size="compact-sm" variant="default" onClick={jumpToFollowTarget}>
                            Jump to {selectedSummary.followTarget.label}
                          </Button>
                        ) : null}
                      </div>
                    </Stack>
                  </div>
                </div>
                <Box className="af-monitor-graph-frame">
                  <Graph
                    graph={graph}
                    plan={plan}
                    state={state}
                    trace={trace}
                    selectedId={selectedGraphId || undefined}
                    selectionKey="graphId"
                    focusMode={focusMode}
                    followId={selectedFollowWorkflowId || undefined}
                    onSelectNode={setSelectedGraphId}
                  />
                </Box>
              </div>
            </BentoTile>

            <BentoTile
              col={4}
              row={4}
              accent="paper"
              className="af-monitor-inspector-tile"
              header={
                <TileHeader
                  eyebrow="Selected scope"
                  title={selectedScopeLabel}
                  description="Keep selection attached to the graph. Overview stays first, and the current evidence layer sits directly below it instead of competing as a separate full-width pane."
                  actions={
                    selectedSummary ? (
                      <Group gap="xs">
                        <Badge variant="outline">{currentEvidenceLabel}</Badge>
                        <Badge variant="outline">Evidence {evidenceScopeLabel}</Badge>
                      </Group>
                    ) : null
                  }
                />
              }
            >
              <ScrollArea className="af-monitor-inspector-scroll">
                <div className="af-monitor-inspector-stack">
                  <NodeInspector
                    selectedNode={selectedNode}
                    summary={selectedSummary}
                    activeDetailTab={evidenceTab}
                    focusLabel={focusLabel}
                    onOpenEvidenceTab={setStoredEvidenceTab}
                    onJumpToFollowNode={selectedSummary?.followTarget?.descendant ? jumpToFollowTarget : undefined}
                  />

                  <div className="af-summary-card af-summary-card--console af-monitor-inspector-detail">
                    <Stack gap="sm">
                      <Group justify="space-between" gap="sm" align="flex-start">
                        <div>
                          <SurfaceLabel>Selected-node detail</SurfaceLabel>
                          <Text fw={700} size="sm">
                            {selectedSummary ? `${currentEvidenceLabel} for ${selectedScopeLabel}` : 'Selected-scope deep dive'}
                          </Text>
                        </div>
                        <Button size="compact-sm" variant="default" onClick={() => setFeedOpen((current) => !current)}>
                          {feedToggleLabel}
                        </Button>
                      </Group>
                      <Text size="sm" c="dimmed" className="af-preview-block">
                        {detailSurfaceLabel}
                      </Text>
                      <Text size="sm" c="dimmed" className="af-preview-block">
                        {evidenceHandoffLabel}
                      </Text>
                      <MonitorEvidencePanel
                        selectedNode={selectedNode}
                        followNode={selectedFollowNode}
                        summary={selectedSummary}
                        artifacts={artifacts}
                        selectedArtifact={selectedArtifact}
                        onSelectArtifact={setSelectedArtifact}
                        artifactPreview={artifactPreview}
                        artifactPreviewLoading={artifactPreviewLoading}
                        selectedLogText={selectedLogText}
                        rawOutputLabel={selectedRawOutputSource?.label || 'Raw execution log'}
                        judgeEvaluations={judgeEvaluations}
                        judgeChartData={judgeChartData}
                        traceEntries={selectedNodeTraceEntries}
                        tab={evidenceTab}
                        onChangeTab={setStoredEvidenceTab}
                        layout="embedded"
                      />
                    </Stack>
                  </div>
                </div>
              </ScrollArea>
            </BentoTile>

            <BentoTile
              col={12}
              row={feedOpen ? 2 : 1}
              accent="paper"
              className="af-monitor-feed-tile"
              header={
                <TileHeader
                  eyebrow="Whole-run feed"
                  title={feedOpen ? 'Whole-run feed' : 'Whole-run feed stays secondary'}
                  description={feedOpen
                    ? 'Use this only after the graph and selected-scope inspector stop answering the question.'
                    : 'Keep cross-scope console and timeline debugging folded away until the graph-first read is exhausted.'}
                  actions={(
                    <Group gap="xs">
                      <Badge variant="outline">{feedOpen ? timelineFilter : 'Secondary surface'}</Badge>
                      <Button size="compact-sm" variant="default" onClick={() => setFeedOpen((current) => !current)}>
                        {feedToggleLabel}
                      </Button>
                    </Group>
                  )}
                />
              }
            >
              {feedOpen ? (
                <div className="af-monitor-feed-shell">
                  <MonitorRunFeedPanel
                    timelineEntries={timelineEntries}
                    timelineFilter={timelineFilter}
                    onChangeTimelineFilter={setTimelineFilter}
                    consoleText={consoleText}
                  />
                </div>
              ) : (
                <div className="af-summary-card af-summary-card--console">
                  <Stack gap="sm">
                    <Group justify="space-between" gap="sm" align="flex-start">
                      <div>
                        <SurfaceLabel>Cross-scope debugging</SurfaceLabel>
                        <Text fw={700} size="sm">
                          Open the global timeline and runner console only when local graph context is not enough
                        </Text>
                      </div>
                      <Badge variant="outline">{timelineEntries.length} events</Badge>
                    </Group>
                    <Text size="sm" c="dimmed" className="af-preview-block">
                      The monitor now keeps graph, selection, and selected-node evidence together. The whole-run feed remains available for cross-scope debugging, but it no longer competes with the primary graph read on first paint.
                    </Text>
                  </Stack>
                </div>
              )}
            </BentoTile>
          </BentoGrid>
        )}
      </AppShell.Main>
    </AppShell>
  );
}
