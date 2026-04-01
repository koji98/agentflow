import React from 'react';
import { Badge, Button, Group, Stack, Text } from '@mantine/core';

import {
  buildSelectedNodeNarrative,
  type MonitorDetailTab,
  type NodeSummary,
  type WorkflowGraphItem,
} from '../lib/monitor.ts';
import { EmptyState, SurfaceLabel } from '../design/primitives.tsx';

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

function sectionRows(summary: NodeSummary) {
  return [
    {
      label: 'State now',
      value: summary.stateNow.phase
        ? `${summary.stateNow.status.toLowerCase()} · ${readableToken(summary.stateNow.phase)}`
        : summary.stateNow.status.toLowerCase(),
    },
    {
      label: 'Updated',
      value: formatLocalTimestamp(summary.stateNow.sinceAtUtc),
    },
    { label: 'Next', value: summary.next.label },
    {
      label: 'Proof ready',
      value: buildProofReadyValue(summary),
    },
  ];
}

function buildProofReadyValue(summary: NodeSummary) {
  const segments: string[] = [];
  if (summary.evidence.traceEvents > 0) {
    segments.push(`Activity ${summary.evidence.traceEvents}`);
  }
  if (summary.evidence.artifacts > 0) {
    segments.push(`Artifacts ${summary.evidence.artifacts}`);
  } else if (summary.evidence.summary || summary.evidence.report) {
    segments.push('Docs ready');
  }
  if (summary.evidence.logs) {
    segments.push('Raw logs');
  }
  return segments.join(' · ') || 'Summary only';
}

function evidenceItems(summary: NodeSummary) {
  const artifactValue = summary.evidence.artifacts > 0
    ? `${summary.evidence.artifacts} ${summary.evidence.artifacts === 1 ? 'file' : 'files'}`
    : summary.evidence.summary || summary.evidence.report
      ? 'Key docs ready'
      : 'Waiting';
  const activityValue = summary.evidence.traceEvents > 0
    ? `${summary.evidence.traceEvents} ${summary.evidence.traceEvents === 1 ? 'event' : 'events'}`
    : summary.judge || summary.retry
      ? 'Overlay ready'
      : 'Summary only';
  return [
    {
      label: 'Activity',
      value: activityValue,
    },
    {
      label: 'Artifacts',
      value: artifactValue,
    },
    { label: 'Raw logs', value: summary.evidence.logs ? 'Available' : 'None' },
  ];
}

function inspectionLayers(summary: NodeSummary, activeDetailTab: MonitorDetailTab) {
  const narrative = buildSelectedNodeNarrative(summary);

  return [
    {
      key: 'overview',
      step: '01',
      label: 'Overview',
      badge: 'Anchor',
      current: false,
      description: narrative.layers.overview,
    },
    {
      key: 'activity',
      step: '02',
      label: 'Activity',
      badge: activeDetailTab === 'activity' ? 'Open now' : 'Default detail',
      current: activeDetailTab === 'activity',
      description: narrative.layers.activity,
    },
    {
      key: 'artifacts',
      step: '03',
      label: 'Artifacts',
      badge: activeDetailTab === 'artifacts' ? 'Open now' : 'Files + docs',
      current: activeDetailTab === 'artifacts',
      description: narrative.layers.artifacts,
    },
    {
      key: 'raw',
      step: '04',
      label: 'Raw logs',
      badge: activeDetailTab === 'raw' ? 'Open now' : 'Deep inspection',
      current: activeDetailTab === 'raw',
      description: narrative.layers.raw,
    },
  ];
}

function buildScopeSignals(summary: NodeSummary) {
  const items: Array<{ key: string; label: string; value: string; detail: string }> = [];
  const iterationValue = summary.progressItems.find((item) => item.label === 'Iteration')?.value || null;
  const maxIterationValue = summary.progressItems.find((item) => item.label === 'Max iterations')?.value || null;

  if (summary.group) {
    const stateLine = `${summary.group.doneChildren}/${summary.group.totalChildren} done`;
    const detail = summary.group.blockingChildLabel
      ? `Blocking child: ${summary.group.blockingChildLabel}`
      : summary.group.activeChildLabel
        ? `Active child: ${summary.group.activeChildLabel}`
        : summary.group.nextEligibleChildLabel
          ? `Next child: ${summary.group.nextEligibleChildLabel}`
          : 'All group children are resolved.';
    items.push({
      key: 'group',
      label: 'Group scope',
      value: `${readableToken(summary.group.mode)} · ${stateLine}`,
      detail,
    });
  }

  if (summary.identity.type === 'loop_judge' || summary.identity.type === 'loop' || summary.identity.type === 'while') {
    const value = iterationValue
      ? maxIterationValue
        ? `Iteration ${iterationValue} / ${maxIterationValue}`
        : `Iteration ${iterationValue}`
      : summary.stateNow.phase
        ? readableToken(summary.stateNow.phase)
        : summary.stateNow.status.toLowerCase();
    const detail = summary.loop?.failedBodyChildLabel
      ? `Blocking body child: ${summary.loop.failedBodyChildLabel}`
      : summary.loop?.activeBodyChildLabel
        ? `Active body child: ${summary.loop.activeBodyChildLabel}`
        : `Phase: ${summary.stateNow.phase ? readableToken(summary.stateNow.phase) : summary.stateNow.status.toLowerCase()}`;
    items.push({
      key: 'loop',
      label: 'Loop scope',
      value,
      detail,
    });
  }

  if (summary.judge) {
    const scoreText = summary.judge.score === null
      ? 'No score'
      : summary.judge.threshold === null
        ? String(summary.judge.score)
        : `${summary.judge.score}/${summary.judge.threshold}`;
    items.push({
      key: 'judge',
      label: 'Judge state',
      value: `${readableToken(summary.judge.phase)} · ${scoreText}`,
      detail: summary.judge.reasons[0] || 'No judge reasons recorded yet.',
    });
  }

  if (summary.retry) {
    items.push({
      key: 'retry',
      label: 'Retry state',
      value: `Attempt ${summary.retry.attempt} · ${readableToken(summary.retry.state)}`,
      detail: summary.retry.latestFailureReason || 'No retry failure reason was captured.',
    });
  }

  return items;
}

function buildActivitySignals(summary: NodeSummary) {
  const items = buildScopeSignals(summary);
  if (items.length > 0) return items;

  if (summary.evidence.traceEvents > 0) {
    return [{
      key: 'activity',
      label: 'Activity layer',
      value: `${summary.evidence.traceEvents} structured ${summary.evidence.traceEvents === 1 ? 'event' : 'events'}`,
      detail: 'Open Activity to scan transitions and short execution notes before switching to artifacts or raw logs.',
    }];
  }

  if (summary.evidence.logs) {
    return [{
      key: 'activity',
      label: 'Activity layer',
      value: 'Raw output ready',
      detail: 'This scope has raw output on demand, but the summary already tells the high-signal story first.',
    }];
  }

  return [{
    key: 'activity',
    label: 'Activity layer',
    value: 'Summary-first only',
    detail: 'No structured transitions are recorded yet, so Overview stays the primary explanation until new activity lands.',
  }];
}

export default function NodeInspector(props: {
  selectedNode: WorkflowGraphItem | null;
  summary: NodeSummary | null;
  activeDetailTab: MonitorDetailTab;
  focusLabel: string;
  onOpenEvidenceTab(tab: MonitorDetailTab): void;
  onJumpToFollowNode?(): void;
}) {
  const { selectedNode, summary, activeDetailTab, focusLabel, onOpenEvidenceTab, onJumpToFollowNode } = props;

  if (!selectedNode || !summary) {
    return (
      <EmptyState
        title="No node selected"
        description="Select a workflow node to see its current state, why it matters, and which activity, artifacts, or raw evidence sit behind it."
      />
    );
  }

  const badgeColor = selectedNode.status === 'DONE'
    ? 'signal'
    : selectedNode.status === 'FAILED'
      ? 'danger'
      : selectedNode.status === 'RUNNING'
        ? 'electric'
        : 'ink';
  const activitySignals = buildActivitySignals(summary);
  const narrative = buildSelectedNodeNarrative(summary);

  return (
    <Stack gap="md">
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" gap="sm">
          <div>
            <SurfaceLabel>{selectedNode.type.replaceAll('_', ' ')}</SurfaceLabel>
            <Text fw={700} size="lg">
              {selectedNode.label}
            </Text>
            <Text size="sm" c="dimmed" className="af-preview-block">
              {summary.identity.breadcrumb.join(' / ')}
            </Text>
          </div>
          <Stack gap={6} align="flex-end">
            <Badge color={badgeColor} variant="light">
              {selectedNode.status.toLowerCase()}
            </Badge>
            {summary.stateNow.phase && summary.stateNow.phase !== selectedNode.status.toLowerCase() ? (
              <Badge variant="outline">
                {summary.stateNow.phase.replaceAll('_', ' ')}
              </Badge>
            ) : null}
          </Stack>
        </Group>

        <Group gap="xs">
          <Badge variant="outline">{selectedNode.type}</Badge>
          {summary.retry ? <Badge variant="outline">Attempt {summary.retry.attempt}</Badge> : null}
          {summary.judge ? <Badge variant="outline">Judge visible</Badge> : null}
        </Group>
      </Stack>

      <div className="af-summary-card af-summary-card--hero">
        <Stack gap="sm">
          <div className="af-summary-key-grid af-summary-key-grid--quad">
            {sectionRows(summary).map((row) => (
              <div className="af-summary-key-card" key={row.label}>
                <Text size="xs" c="dimmed" fw={700} tt="uppercase">
                  {row.label}
                </Text>
                <Text size="sm" fw={700}>
                  {row.value}
                </Text>
              </div>
            ))}
          </div>
          <div className="af-summary-card af-summary-card--nested">
            <Stack gap={6}>
              <SurfaceLabel>Why now</SurfaceLabel>
              <Text size="sm" className="af-preview-block">
                {summary.whyNow.message}
              </Text>
            </Stack>
          </div>
        </Stack>
      </div>

      {summary.progressItems.length > 0 ? (
        <div className="af-summary-chip-grid">
          {summary.progressItems.map((item) => (
            <div className="af-summary-chip" key={`${item.label}:${item.value}`}>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase">
                {item.label}
              </Text>
              <Text fw={700}>{item.value}</Text>
            </div>
          ))}
        </div>
      ) : null}

      <div className="af-summary-card af-summary-card--accent">
        <Stack gap="sm">
          <Group justify="space-between" gap="sm" align="flex-start">
            <div>
              <SurfaceLabel>Activity briefing</SurfaceLabel>
              <Text fw={700} size="sm">
                High-signal selected-scope activity before files or raw logs
              </Text>
            </div>
            <Badge variant="outline">{summary.identity.label}</Badge>
          </Group>
          <Text size="sm" c="dimmed" className="af-preview-block">
            {narrative.layers.activity}
          </Text>
          <div className="af-inspector-signal-grid">
            {activitySignals.map((item) => (
              <div className="af-inspector-signal-card" key={item.key}>
                <Stack gap={6}>
                  <SurfaceLabel>{item.label}</SurfaceLabel>
                  <Text fw={700} size="sm">
                    {item.value}
                  </Text>
                  <Text size="sm" c="dimmed" className="af-preview-block">
                    {item.detail}
                  </Text>
                </Stack>
              </div>
            ))}
          </div>
        </Stack>
      </div>

      <div className="af-summary-card">
        <Stack gap="sm">
          <Group justify="space-between" gap="sm" align="flex-start">
            <div>
              <SurfaceLabel>Artifacts handoff</SurfaceLabel>
              <Text fw={700} size="sm">
                {narrative.evidenceScopeIsDescendant
                  ? `${summary.identity.label} keeps overview and activity while ${narrative.evidenceScopeLabel} holds artifacts and raw logs.`
                  : `${summary.identity.label} keeps all four layers at one scope.`}
              </Text>
            </div>
            <Badge variant="outline">{focusLabel}</Badge>
          </Group>
          <div className="af-summary-list">
            <div className="af-summary-row">
              <Text size="xs" c="dimmed" fw={700} tt="uppercase">
                Selected scope
              </Text>
              <Text size="sm" fw={700}>
                {summary.identity.label}
              </Text>
            </div>
            <div className="af-summary-row">
              <Text size="xs" c="dimmed" fw={700} tt="uppercase">
                Artifacts + raw logs
              </Text>
              <Text size="sm" fw={700}>
                {narrative.evidenceScopeLabel}
              </Text>
            </div>
            {summary.followTarget?.descendant ? (
              <div className="af-summary-row">
                <Text size="xs" c="dimmed" fw={700} tt="uppercase">
                  Why this handoff
                </Text>
                <Text size="sm" c="dimmed" className="af-preview-block">
                  {narrative.relationshipDetail}
                </Text>
              </div>
            ) : null}
          </div>
        </Stack>
      </div>

      <div className="af-summary-card af-summary-card--accent">
        <Stack gap="sm">
          <Group justify="space-between" gap="sm" align="flex-start">
            <div>
              <SurfaceLabel>Detail order</SurfaceLabel>
              <Text fw={700} size="sm">
                Read this node from summary to raw
              </Text>
            </div>
            <Badge variant="outline">{activeDetailTab === 'raw' ? 'Raw open' : `${readableToken(activeDetailTab)} open`}</Badge>
          </Group>
          <Text size="sm" c="dimmed" className="af-preview-block">
            {narrative.detailPanelDescription}
          </Text>
          <div className="af-inspector-ladder">
            {inspectionLayers(summary, activeDetailTab).map((item) => (
              <div className={`af-inspector-step ${item.current ? 'af-inspector-step--active' : ''}`} key={item.key}>
                <div className="af-inspector-step__count">
                  <Text size="xs" fw={800}>
                    {item.step}
                  </Text>
                </div>
                <div className="af-inspector-step__body">
                  <Group justify="space-between" gap="xs" align="flex-start">
                    <Text fw={700} size="sm">
                      {item.label}
                    </Text>
                    <Badge variant={item.current ? 'filled' : 'outline'}>{item.badge}</Badge>
                  </Group>
                  <Text size="sm" c="dimmed" className="af-preview-block">
                    {item.description}
                  </Text>
                </div>
              </div>
            ))}
          </div>
          <div className="af-summary-chip-grid">
            {evidenceItems(summary).map((item) => (
              <div className="af-summary-chip" key={item.label}>
                <Text size="xs" c="dimmed" fw={700} tt="uppercase">
                  {item.label}
                </Text>
                <Text fw={700}>{item.value}</Text>
              </div>
            ))}
          </div>
          <div className="af-summary-actions">
            <Button size="compact-sm" variant={activeDetailTab === 'activity' ? 'filled' : 'default'} onClick={() => onOpenEvidenceTab('activity')}>
              Activity
            </Button>
            <Button size="compact-sm" variant={activeDetailTab === 'artifacts' ? 'filled' : 'default'} onClick={() => onOpenEvidenceTab('artifacts')}>
              Artifacts
            </Button>
            <Button size="compact-sm" variant={activeDetailTab === 'raw' ? 'filled' : 'default'} onClick={() => onOpenEvidenceTab('raw')}>
              Raw logs
            </Button>
            {summary.followTarget?.descendant && onJumpToFollowNode ? (
              <Button size="compact-sm" variant="default" onClick={onJumpToFollowNode}>
                Jump to {summary.followTarget.label}
              </Button>
            ) : null}
          </div>
        </Stack>
      </div>
    </Stack>
  );
}
