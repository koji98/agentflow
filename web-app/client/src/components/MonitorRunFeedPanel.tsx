import React from 'react';
import { Badge, Group, ScrollArea, SegmentedControl, Stack, Text } from '@mantine/core';

import { SurfaceLabel } from '../design/primitives.tsx';
import { formatTraceEntry } from '../lib/monitor.ts';

export default function MonitorRunFeedPanel(props: {
  timelineEntries: Array<Record<string, unknown>>;
  timelineFilter: string;
  onChangeTimelineFilter(value: string): void;
  consoleText: string;
}) {
  const { timelineEntries, timelineFilter, onChangeTimelineFilter, consoleText } = props;

  return (
    <Stack gap="md">
      <SegmentedControl
        value={timelineFilter}
        onChange={onChangeTimelineFilter}
        data={[
          { label: 'All', value: 'all' },
          { label: 'Gates', value: 'gates' },
          { label: 'Retries', value: 'retries' },
          { label: 'Failures', value: 'failures' },
        ]}
      />
      <div className="af-monitor-feed-grid">
        <div className="af-summary-card">
          <Stack gap="sm">
            <div>
              <SurfaceLabel>Run feed</SurfaceLabel>
              <Text fw={700} size="sm">
                Whole-run control flow
              </Text>
            </div>
            <ScrollArea h={320}>
              <div className="af-timeline-list">
                {timelineEntries.length === 0 ? (
                  <Text size="sm" c="dimmed">No run-feed entries for the current filter.</Text>
                ) : timelineEntries.map((entry, index) => (
                  <div className="af-timeline-entry" key={`${String(entry.atUtc || 'timeline')}-${index}`}>
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
        </div>

        <div className="af-summary-card af-summary-card--console">
          <Stack gap="sm">
            <div>
              <SurfaceLabel>Runner console</SurfaceLabel>
              <Text fw={700} size="sm">
                Global process output
              </Text>
            </div>
            <div className="af-console-pane">
              <ScrollArea h={320} className="af-console-scroll">
                <Text component="pre" className="af-console-pre">
                  {consoleText || 'No run console output captured yet.'}
                </Text>
              </ScrollArea>
            </div>
          </Stack>
        </div>
      </div>
    </Stack>
  );
}
