import React, { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Breadcrumbs,
  Button,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconArrowUp, IconFolder, IconFileCode, IconRefresh, IconSearch } from '@tabler/icons-react';

import type { FsItem } from '../../../shared/contracts/monitor.ts';
import { api } from '../api/client.ts';
import { SurfaceLabel } from '../design/primitives.tsx';

export type FilePickerMode = 'plan' | 'run';

export interface FilePickerModalProps {
  opened: boolean;
  mode: FilePickerMode;
  title: string;
  initialPath?: string | null;
  showHidden: boolean;
  recentPaths: string[];
  onChangeShowHidden(next: boolean): void;
  onRememberPath(next: string): void;
  onClose(): void;
  onPick(targetPath: string, item: FsItem | null): void;
}

function splitPath(value: string) {
  const normalized = value || '/';
  const separator = normalized.includes('\\') ? '\\' : '/';
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  const root = separator === '\\' && normalized.includes(':')
    ? `${normalized.slice(0, 2)}\\`
    : separator;
  const breadcrumbs = [{ label: root, value: root }];
  let current = root;
  for (const part of parts) {
    current = current === root ? `${root}${part}` : `${current}${separator}${part}`;
    breadcrumbs.push({ label: part, value: current });
  }
  return breadcrumbs;
}

function parentDir(value: string) {
  const trimmed = value.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index <= 0) return trimmed.startsWith('/') ? '/' : trimmed;
  return trimmed.slice(0, index);
}

function basename(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

function filterItems(items: FsItem[], mode: FilePickerMode, showHidden: boolean) {
  return items.filter((item) => {
    if (!showHidden && item.hidden) return false;
    if (mode === 'plan') return item.type === 'dir' || item.name.toLowerCase().endsWith('.json');
    return item.type === 'dir';
  });
}

export default function FilePickerModal(props: FilePickerModalProps) {
  const {
    opened,
    mode,
    title,
    initialPath,
    showHidden,
    recentPaths,
    onChangeShowHidden,
    onRememberPath,
    onClose,
    onPick,
  } = props;
  const [currentPath, setCurrentPath] = useState<string>('/');
  const [pathDraft, setPathDraft] = useState<string>('/');
  const [items, setItems] = useState<FsItem[]>([]);
  const [selected, setSelected] = useState<FsItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPath = async (nextPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const listing = await api.fs.ls(nextPath);
      setItems(listing.items);
      setCurrentPath(nextPath);
      setPathDraft(nextPath);
      setSelected(null);
      onRememberPath(nextPath);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    api.fs.roots()
      .then((roots) => {
        if (cancelled) return;
        const fallback = initialPath || roots.allowedRoots?.[0] || roots.repoRoot || roots.cwd || roots.home || '/';
        void loadPath(fallback);
      })
      .catch(() => {
        if (!cancelled) setError('Unable to read local filesystem roots.');
      });
    return () => {
      cancelled = true;
    };
  }, [initialPath, opened]);

  const visibleItems = useMemo(
    () => filterItems(items, mode, showHidden),
    [items, mode, showHidden],
  );

  const breadcrumbs = splitPath(currentPath);
  const canConfirm = mode === 'plan' ? selected?.type === 'file' : selected?.type === 'dir';

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={title}
      size="74rem"
      className="af-picker-modal"
    >
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <Stack gap={4}>
            <SurfaceLabel>{mode === 'plan' ? 'Plan file picker' : 'Run folder picker'}</SurfaceLabel>
            <Text size="sm" c="dimmed">
              Browse local files through the `agentflow web` bridge. Hidden folders stay available for `.tmp` workflows.
            </Text>
          </Stack>
          <Switch
            checked={showHidden}
            onChange={(event) => onChangeShowHidden(event.currentTarget.checked)}
            label="Show hidden folders"
            size="sm"
          />
        </Group>

        <div className="af-picker-toolbar">
          <TextInput
            value={pathDraft}
            onChange={(event) => setPathDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void loadPath(pathDraft);
              }
            }}
            leftSection={<IconSearch size={16} />}
            placeholder="Enter a folder path"
          />
          <Group gap="xs" wrap="nowrap">
            <ActionIcon variant="default" onClick={() => void loadPath(parentDir(currentPath))} aria-label="Parent directory">
              <IconArrowUp size={16} />
            </ActionIcon>
            <ActionIcon variant="default" onClick={() => void loadPath(currentPath)} aria-label="Refresh">
              <IconRefresh size={16} />
            </ActionIcon>
          </Group>
        </div>

        <Paper p="sm">
          <Breadcrumbs separator="›">
            {breadcrumbs.map((crumb) => (
              <Button
                key={crumb.value}
                variant="subtle"
                size="compact-sm"
                onClick={() => void loadPath(crumb.value)}
              >
                {crumb.label}
              </Button>
            ))}
          </Breadcrumbs>
        </Paper>

        {recentPaths.length > 0 ? (
          <div className="af-picker-recents">
            {recentPaths.slice(0, 6).map((recentPath) => (
              <Button
                key={recentPath}
                variant="default"
                size="compact-sm"
                onClick={() => void loadPath(recentPath)}
              >
                {basename(recentPath) || recentPath}
              </Button>
            ))}
          </div>
        ) : null}

        <Paper p={0}>
          <ScrollArea h={430} className="af-picker-table">
            <Table highlightOnHover withTableBorder={false}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Path</Table.Th>
                  <Table.Th w={112}>Modified</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {loading ? (
                  <Table.Tr>
                    <Table.Td colSpan={3}>
                      <Group justify="center" py="lg">
                        <Loader size="sm" />
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ) : null}
                {!loading && visibleItems.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={3}>
                      <Text c="dimmed" py="md">No matching entries in this directory.</Text>
                    </Table.Td>
                  </Table.Tr>
                ) : null}
                {!loading && visibleItems.map((item) => {
                  const isSelected = selected?.path === item.path;
                  const icon = item.type === 'dir' ? <IconFolder size={16} /> : <IconFileCode size={16} />;
                  return (
                    <Table.Tr
                      key={item.path}
                      className="af-picker-row"
                      data-selected={isSelected ? 'true' : 'false'}
                      onClick={() => setSelected(item)}
                      onDoubleClick={() => {
                        if (item.type === 'dir') {
                          void loadPath(item.path);
                          return;
                        }
                        onPick(item.path, item);
                      }}
                    >
                      <Table.Td>
                        <Group gap="xs" align="flex-start">
                          {icon}
                          <Stack gap={2}>
                            <Text fw={600}>{item.name}</Text>
                            {item.hidden ? <Badge size="xs" variant="outline">hidden</Badge> : null}
                          </Stack>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">{item.path}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">{new Date(item.mtime).toLocaleDateString()}</Text>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>

        {mode === 'run' ? (
          <Text size="sm" c="dimmed">
            Pick the folder that contains `run_state.json`. Double-click a folder to navigate deeper.
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            Pick a plan JSON file. Double-click a folder to navigate or a file to select immediately.
          </Text>
        )}

        {error ? <Text c="red.7" size="sm">{error}</Text> : null}

        <div className="af-picker-footer">
          <Text size="sm" c="dimmed" truncate>
            {selected?.path || currentPath}
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button
              onClick={() => onPick(mode === 'run' ? (selected?.path || currentPath) : String(selected?.path || ''), selected)}
              disabled={!canConfirm}
            >
              {mode === 'plan' ? 'Select plan' : 'Select folder'}
            </Button>
          </Group>
        </div>
      </Stack>
    </Modal>
  );
}
