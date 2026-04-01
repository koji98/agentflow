import React from 'react';
import { Box, Group, Paper, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core';

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

type BentoCol = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
type BentoRow = 1 | 2 | 3 | 4;
type BentoTone = 'default' | 'hero' | 'subtle' | 'console';
type BentoAccent = 'paper' | 'yellow' | 'blue' | 'red' | 'ink';

export function SurfaceLabel(props: { children: React.ReactNode }) {
  return (
    <Text size="xs" fw={700} c="dimmed" tt="uppercase" className="af-surface-label">
      {props.children}
    </Text>
  );
}

export function BentoGrid(props: {
  children: React.ReactNode;
  className?: string;
}) {
  return <Box className={cx('af-bento-grid', props.className)}>{props.children}</Box>;
}

export function BentoTile(props: {
  children: React.ReactNode;
  col?: BentoCol;
  row?: BentoRow;
  tone?: BentoTone;
  accent?: BentoAccent;
  className?: string;
  header?: React.ReactNode;
}) {
  const { children, col = 4, row = 1, tone = 'default', accent = 'paper', className, header } = props;
  return (
    <Paper
      className={cx('af-tile', `af-tile--${tone}`, className)}
      data-col={String(col)}
      data-row={String(row)}
      data-accent={accent}
      p="sm"
    >
      {header ? <div className="af-tile__header">{header}</div> : null}
      <div className="af-tile__content">{children}</div>
    </Paper>
  );
}

export function TileHeader(props: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const { eyebrow, title, description, actions } = props;
  return (
    <Group justify="space-between" align="flex-start" gap="sm">
      <Stack gap={4}>
        {eyebrow ? <SurfaceLabel>{eyebrow}</SurfaceLabel> : null}
        <Text fw={700} size="lg" className="af-tile-title">
          {title}
        </Text>
        {description ? (
          <Text size="sm" c="dimmed" className="af-tile-description">
            {description}
          </Text>
        ) : null}
      </Stack>
      {actions ? <div className="af-tile-actions">{actions}</div> : null}
    </Group>
  );
}

export function KpiTile(props: {
  label: React.ReactNode;
  value: React.ReactNode;
  meta?: React.ReactNode;
  accent?: string;
  tileAccent?: BentoAccent;
  icon?: React.ReactNode;
}) {
  const { label, value, meta, accent = 'signal', tileAccent = 'paper', icon } = props;
  const metaLabel = typeof meta === 'string' || typeof meta === 'number' ? String(meta) : null;
  return (
    <BentoTile col={3} row={1} tone="subtle" accent={tileAccent} className="af-kpi-tile">
      <Group justify="space-between" align="stretch" gap="sm" wrap="nowrap" className="af-kpi-layout">
        <Stack gap={6} className="af-kpi-copy">
          <SurfaceLabel>{label}</SurfaceLabel>
          <Text className="af-kpi-value">{value}</Text>
          {meta ? (
            <Tooltip label={metaLabel || ''} disabled={!metaLabel} multiline maw={420} withArrow openDelay={120}>
              <Text size="sm" c="dimmed" className="af-kpi-meta" lineClamp={3}>
                {meta}
              </Text>
            </Tooltip>
          ) : null}
        </Stack>
        {icon ? (
          <div className="af-kpi-icon-wrap">
            <ThemeIcon size={38} color={accent} variant="light" className="af-kpi-icon">
              {icon}
            </ThemeIcon>
          </div>
        ) : null}
      </Group>
    </BentoTile>
  );
}

export function EmptyState(props: {
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <div className={cx('af-empty-state', props.className)}>
      <Text fw={700}>{props.title}</Text>
      <Text size="sm" c="dimmed">
        {props.description}
      </Text>
    </div>
  );
}
