import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Badge, Button, Group, SegmentedControl, Stack, Text, Tooltip } from '@mantine/core';
import { IconPlayerSkipBack, IconPlayerTrackNext, IconPlayerTrackPrev } from '@tabler/icons-react';

import { EmptyState, SurfaceLabel } from '../design/primitives.tsx';
import type { WorkflowGraphEdge, WorkflowGraphItem } from '../lib/monitor.ts';
import { isActionableNode, requestPreviewForWorkflowItem } from '../lib/monitor.ts';

export type WalkthroughFilter = 'actionable' | 'all';

function HeaderText(props: { label: string; tooltipThreshold?: number }) {
  const { label, tooltipThreshold = 20 } = props;
  const showTooltip = label.length > tooltipThreshold;
  return (
    <Tooltip label={label} disabled={!showTooltip} multiline maw={520} withArrow openDelay={120}>
      <Text fw={700} size="sm" truncate="end">
        {label}
      </Text>
    </Tooltip>
  );
}

function previewLabelForType(type: string) {
  if (type === 'task' || type === 'command') return 'Prompt / command';
  if (type === 'loop_judge') return 'Judge rubric';
  if (type === 'while' || type === 'loop') return 'Loop hint';
  if (type === 'group') return 'Group summary';
  return 'Node summary';
}

function previewTextForItem(item: WorkflowGraphItem) {
  const requested = requestPreviewForWorkflowItem(item);
  if (requested) return requested;
  if (item.subtitle && item.subtitle !== item.type.toUpperCase()) return item.subtitle;
  if (item.type === 'group') {
    const steps = Array.isArray(item.raw.steps) ? item.raw.steps.length : 0;
    return steps > 0 ? `${steps} nested ${steps === 1 ? 'step' : 'steps'}.` : 'No nested steps.';
  }
  return '';
}

export default function PreviewWalkthrough(props: {
  graph: { items: WorkflowGraphItem[]; edges: WorkflowGraphEdge[] };
  selectedGraphId: string | null;
  onSelect(id: string): void;
  filter: WalkthroughFilter;
  onChangeFilter(next: WalkthroughFilter): void;
}) {
  const { graph, selectedGraphId, onSelect, filter, onChangeFilter } = props;
  const [expanded, setExpanded] = useState(false);
  const regionRef = useRef<HTMLDivElement | null>(null);

  const items = useMemo(() => graph.items.slice().sort((a, b) => a.order - b.order), [graph.items]);
  const actionable = useMemo(() => items.filter((item) => isActionableNode(item.type)), [items]);
  const traversal = filter === 'actionable' ? actionable : items;
  const byGraphId = useMemo(() => new Map(items.map((item) => [item.graphId, item])), [items]);
  const selected = selectedGraphId ? byGraphId.get(selectedGraphId) || null : null;

  const index = useMemo(() => {
    if (!selected) return -1;
    return traversal.findIndex((item) => item.graphId === selected.graphId);
  }, [selected, traversal]);
  const insertionIndex = useMemo(() => {
    if (!selected) return -1;
    const candidate = traversal.findIndex((item) => item.order >= selected.order);
    return candidate >= 0 ? candidate : traversal.length;
  }, [selected, traversal]);

  const prevItem = index >= 0
    ? (index > 0 ? traversal[index - 1] : null)
    : insertionIndex > 0
      ? traversal[insertionIndex - 1]
      : null;
  const nextItem = index >= 0
    ? (index < traversal.length - 1 ? traversal[index + 1] : null)
    : insertionIndex >= 0 && insertionIndex < traversal.length
      ? traversal[insertionIndex]
      : null;

  const previewText = selected ? previewTextForItem(selected) : '';
  const previewCollapsed = previewText.length > 260 && !expanded
    ? `${previewText.slice(0, 260).trimEnd()}…`
    : previewText;
  const previewLabel = selected ? previewLabelForType(selected.type) : 'Prompt / command';

  const nextCandidates = useMemo(() => {
    if (!selected) return [] as Array<{ item: WorkflowGraphItem; kind: string }>;
    return graph.edges
      .filter((edge) => edge.source === selected.graphId)
      .map((edge) => {
        const target = byGraphId.get(edge.target);
        if (!target) return null;
        const depthDiff = target.depth - selected.depth;
        const kind = edge.label ? String(edge.label) : depthDiff > 0 ? 'into' : 'next';
        return { item: target, kind };
      })
      .filter(Boolean) as Array<{ item: WorkflowGraphItem; kind: string }>;
  }, [byGraphId, graph.edges, selected]);

  const countLabel = index >= 0
    ? `${index + 1} / ${traversal.length}`
    : filter === 'actionable'
      ? `${actionable.length} actionable`
      : `${items.length} total`;
  const firstStepLabel = filter === 'actionable' ? 'First action' : 'First step';
  const firstSelectable = filter === 'actionable' && actionable.length > 0
    ? actionable[0]
    : traversal.length > 0
      ? traversal[0]
      : items[0] || null;

  const selectFirst = () => {
    if (firstSelectable) onSelect(firstSelectable.graphId);
  };

  const moveBy = (delta: number) => {
    if (delta < 0 && prevItem) {
      onSelect(prevItem.graphId);
      return;
    }
    if (delta > 0 && nextItem) {
      onSelect(nextItem.graphId);
    }
  };

  useEffect(() => {
    setExpanded(false);
  }, [selected?.workflowId]);

  useEffect(() => {
    regionRef.current?.focus();
  }, [selected?.workflowId]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveBy(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveBy(1);
      return;
    }
    if (event.key === 'Enter' && !selected) {
      event.preventDefault();
      selectFirst();
    }
  };

  if (!selected) {
    return (
      <div
        ref={regionRef}
        className="af-preview-inspector"
        role="region"
        tabIndex={0}
        aria-label="Workflow walkthrough"
        onKeyDown={handleKeyDown}
      >
        <Stack gap="md" h="100%" className="af-preview-shell">
          <Group justify="space-between" align="center" gap="sm">
            <SurfaceLabel>Walkthrough</SurfaceLabel>
            <Badge variant="outline">{countLabel}</Badge>
          </Group>
          <SegmentedControl
            fullWidth
            value={filter}
            onChange={(value) => onChangeFilter(value as WalkthroughFilter)}
            data={[
              { label: 'Actionable', value: 'actionable' },
              { label: 'All', value: 'all' },
            ]}
          />
          <EmptyState
            className="af-preview-empty"
            title="No node selected"
            description="Click a node in the graph preview or jump into the walkthrough from the first step."
          />
          <Group justify="space-between" align="center" mt="auto">
            <Text size="xs" c="dimmed">
              Tip: press Enter to jump in, then use ←/→ to step.
            </Text>
            <Button leftSection={<IconPlayerSkipBack size={14} />} onClick={selectFirst}>
              {firstStepLabel}
            </Button>
          </Group>
        </Stack>
      </div>
    );
  }

  return (
    <div
      ref={regionRef}
      className="af-preview-inspector"
      role="region"
      tabIndex={0}
      aria-label="Workflow walkthrough"
      onKeyDown={handleKeyDown}
    >
      <Stack gap="md" h="100%" className="af-preview-shell">
        <Group justify="space-between" align="flex-start" gap="sm">
          <Stack gap={6} className="af-preview-title-block">
            <SurfaceLabel>Selected node</SurfaceLabel>
            <HeaderText label={selected.label} tooltipThreshold={18} />
            <Text size="sm" c="dimmed">
              {selected.type.replaceAll('_', ' ')}
            </Text>
          </Stack>
          <Badge variant="outline">{countLabel}</Badge>
        </Group>

        <SegmentedControl
          fullWidth
          value={filter}
          onChange={(value) => onChangeFilter(value as WalkthroughFilter)}
          data={[
            { label: 'Actionable', value: 'actionable' },
            { label: 'All', value: 'all' },
          ]}
        />

        <Group gap="xs" className="af-preview-controls">
          <Tooltip
            label={prevItem ? `Previous action: ${prevItem.label}` : 'At the first step'}
            withArrow
            openDelay={120}
          >
            <ActionIcon
              size="lg"
              aria-label={prevItem ? `Previous action: ${prevItem.label}` : 'Previous action unavailable'}
              onClick={() => prevItem && onSelect(prevItem.graphId)}
              disabled={!prevItem}
            >
              <IconPlayerTrackPrev size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip
            label={firstSelectable ? `${firstStepLabel}: ${firstSelectable.label}` : firstStepLabel}
            withArrow
            openDelay={120}
          >
            <ActionIcon
              size="lg"
              aria-label={firstStepLabel}
              onClick={selectFirst}
              disabled={items.length === 0}
            >
              <IconPlayerSkipBack size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip
            label={nextItem ? `Next action: ${nextItem.label}` : 'At the last step'}
            withArrow
            openDelay={120}
          >
            <ActionIcon
              size="lg"
              aria-label={nextItem ? `Next action: ${nextItem.label}` : 'Next action unavailable'}
              onClick={() => nextItem && onSelect(nextItem.graphId)}
              disabled={!nextItem}
            >
              <IconPlayerTrackNext size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>

        <div className="af-preview-scroll">
          <Stack gap="md">
            <Group gap="xs">
              <Badge variant="light">{selected.status.toLowerCase()}</Badge>
              <Badge variant="outline">{selected.type}</Badge>
              <Badge variant="outline">depth {selected.depth}</Badge>
            </Group>

            {previewText ? (
              <Stack gap="xs">
                <SurfaceLabel>{previewLabel}</SurfaceLabel>
                <Text size="sm" className="af-preview-block">
                  {previewCollapsed}
                </Text>
                {previewText.length > 260 ? (
                  <Button variant="subtle" size="compact-sm" onClick={() => setExpanded((value) => !value)}>
                    {expanded ? 'Show less' : 'Show more'}
                  </Button>
                ) : null}
              </Stack>
            ) : null}

            {selected.ancestors && selected.ancestors.length > 0 ? (
              <Stack gap="xs">
                <SurfaceLabel>Path</SurfaceLabel>
                <Tooltip
                  label={[...selected.ancestors, { label: selected.label }]
                    .map((entry) => entry.label)
                    .join(' / ')}
                  multiline
                  maw={520}
                  withArrow
                >
                  <Text size="sm" c="dimmed" truncate="end">
                    {[...selected.ancestors, { label: selected.label }].map((entry) => entry.label).join(' / ')}
                  </Text>
                </Tooltip>
              </Stack>
            ) : null}

            <Stack gap="xs">
              <SurfaceLabel>What happens next</SurfaceLabel>
              {nextCandidates.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No downstream connections.
                </Text>
              ) : (
                <Stack gap="xs">
                  {nextCandidates.map((candidate) => (
                    <Group key={candidate.item.graphId} justify="space-between" gap="xs" className="af-preview-next-row">
                      <Tooltip label={candidate.item.label} multiline maw={420} withArrow disabled={candidate.item.label.length <= 24}>
                        <Text size="sm" truncate="end">
                          {candidate.item.label}
                        </Text>
                      </Tooltip>
                      <Badge variant="outline">{candidate.kind}</Badge>
                    </Group>
                  ))}
                  <Text size="xs" c="dimmed">
                    Downstream connections, not guaranteed runtime order.
                  </Text>
                </Stack>
              )}
            </Stack>
          </Stack>
        </div>

        <Text size="xs" c="dimmed" mt="auto">
          Tip: use ←/→ to step through the selected traversal.
        </Text>
      </Stack>
    </div>
  );
}
