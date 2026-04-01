import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Group,
  NativeSelect,
  ScrollArea,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { DonutChart } from '@mantine/charts';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconCheckupList,
  IconFileCode,
  IconFolderOpen,
  IconHistory,
  IconPlayerPlay,
  IconRefresh,
  IconRouteAltLeft,
} from '@tabler/icons-react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import FilePickerModal, { type FilePickerMode } from '../components/FilePickerModal.tsx';
import Graph from '../components/Graph.tsx';
import PreviewWalkthrough from '../components/PreviewWalkthrough.tsx';
import { buildWorkflowGraph } from '../lib/monitor.ts';
import { api } from '../api/client.ts';
import { BentoTile, KpiTile, TileHeader } from '../design/primitives.tsx';
import { useLocalSettings } from '../state/monitorStore.ts';

function dirname(value: string) {
  const normalized = value.replace(/[\\/]+$/, '');
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (slash <= 0) return normalized.startsWith('/') ? '/' : normalized;
  return normalized.slice(0, slash);
}

function joinPath(basePath: string, child: string) {
  const separator = basePath.includes('\\') ? '\\' : '/';
  return `${basePath.replace(/[\\/]+$/, '')}${separator}${child}`;
}

function basename(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

function TruncatedValue(props: {
  value: string;
  size?: string;
  dimmed?: boolean;
  weight?: number;
}) {
  const { value, size = 'sm', dimmed = false, weight } = props;
  return (
    <Tooltip label={value} multiline maw={520} withArrow openDelay={120}>
      <Text fw={weight} size={size} c={dimmed ? 'dimmed' : undefined} truncate="end">
        {value}
      </Text>
    </Tooltip>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [navbarOpened, { toggle: toggleNavbar }] = useDisclosure(false);
  const settings = useLocalSettings();

  const [planPath, setPlanPath] = useState('');
  const [inspect, setInspect] = useState<any | null>(null);
  const [version, setVersion] = useState<{ agentflowVersion: string; webAppVersion: string } | null>(null);
  const [busy, setBusy] = useState<'start' | 'open' | 'resume' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpened, setPickerOpened] = useState(false);
  const [pickerMode, setPickerMode] = useState<FilePickerMode>('plan');
  const [pickerAction, setPickerAction] = useState<'inspect' | 'open' | 'resume'>('inspect');
  const [pickerInitialPath, setPickerInitialPath] = useState<string | null>(null);
  const [previewSelectedGraphId, setPreviewSelectedGraphId] = useState<string | null>(null);
  const [walkthroughFilter, setWalkthroughFilter] = useState<'actionable' | 'all'>('actionable');
  const [visibleRecentPlans, setVisibleRecentPlans] = useState(3);
  const [visibleRecentRuns, setVisibleRecentRuns] = useState(3);

  useEffect(() => {
    api.version().then(setVersion).catch(() => undefined);
  }, []);

  const workflowBreakdown = useMemo(() => {
    if (!inspect?.workflow) return [];
    return [
      { name: 'Tasks', value: Number(inspect.workflow.tasks?.length || 0), color: '#8ed9ff' },
      { name: 'Commands', value: Number(inspect.workflow.commands?.length || 0), color: '#fff4cf' },
      { name: 'Groups', value: Number(inspect.workflow.groups?.length || 0), color: '#ffe14a' },
      { name: 'Loops', value: Number(inspect.workflow.loops?.length || 0), color: '#ff8c84' },
    ].filter((item) => item.value > 0);
  }, [inspect]);

  const inspectPlan = async (nextPlanPath: string, opts?: { fromQuery?: boolean }) => {
    setError(null);
    try {
      const result = await api.plan.inspect(nextPlanPath);
      if (!result.plan) {
        try {
          const file = await api.fs.read(nextPlanPath);
          if (file.text) {
            const raw = JSON.parse(file.text);
            if (raw && (Array.isArray(raw.workflow) || Array.isArray(raw.flow))) {
              result.plan = raw;
            }
          }
        } catch {}
      }
      setPlanPath(nextPlanPath);
      setInspect(result);
      settings.rememberPlan(nextPlanPath);
      settings.rememberPickerPath(dirname(nextPlanPath));
      if (result.valid) {
        notifications.show({ color: 'electric', message: 'Plan inspected successfully.' });
      }
    } catch (err) {
      const message = String(err);
      setError(message);
      if (opts?.fromQuery) {
        setPickerMode('plan');
        setPickerAction('inspect');
        setPickerInitialPath(dirname(nextPlanPath));
        setPickerOpened(true);
      }
    }
  };

  useEffect(() => {
    const planFromQuery = searchParams.get('plan');
    if (!planFromQuery || planFromQuery === planPath) return;
    void inspectPlan(planFromQuery, { fromQuery: true });
  }, [planPath, searchParams]);

  useEffect(() => {
    setPreviewSelectedGraphId(null);
  }, [inspect?.planPath]);

  const previewGraph = useMemo(() => buildWorkflowGraph(inspect?.plan || null, null, []), [inspect?.plan]);

  const startRun = async () => {
    if (!planPath) return;
    setBusy('start');
    setError(null);
    try {
      const result = await api.runs.start({
        planPath,
        settings: {
          skipGitRepoCheck: settings.skipGitRepoCheck,
          sandbox: settings.sandbox,
        },
      });
      settings.rememberRunDir(result.runDir);
      navigate(`/run/${encodeURIComponent(result.runId)}`);
    } catch (err) {
      const message = String(err);
      setError(message);
      notifications.show({ color: 'red', message });
    } finally {
      setBusy(null);
    }
  };

  const openRun = async (runDir: string, resume: boolean) => {
    setBusy(resume ? 'resume' : 'open');
    setError(null);
    try {
      const result = resume
        ? await api.runs.resume({
          runDir,
          settings: {
            skipGitRepoCheck: settings.skipGitRepoCheck,
            sandbox: settings.sandbox,
          },
        })
        : await api.runs.open({ runDir });
      settings.rememberRunDir(runDir);
      navigate(`/run/${encodeURIComponent(result.runId)}`);
    } catch (err) {
      const message = String(err);
      setError(message);
      notifications.show({ color: 'red', message });
    } finally {
      setBusy(null);
    }
  };

  const openPicker = (mode: FilePickerMode, action: 'inspect' | 'open' | 'resume', initialPath?: string | null) => {
    setPickerMode(mode);
    setPickerAction(action);
    setPickerInitialPath(
      initialPath || (planPath ? dirname(planPath) : settings.recentPickerPaths[0] || null),
    );
    setPickerOpened(true);
  };

  const contextReadyCount = (inspect?.contextFiles || []).filter((entry: any) => entry.exists).length;
  const repoReadyCount = (inspect?.repos || []).filter((repo: any) => repo.exists).length;
  const recentPlans = settings.recentPlans.slice(0, visibleRecentPlans);
  const recentRunDirs = settings.recentRunDirs.slice(0, visibleRecentRuns);

  return (
    <>
      <AppShell
        header={{ height: 74 }}
        navbar={{ width: 320, breakpoint: 'md', collapsed: { mobile: !navbarOpened } }}
        padding="lg"
      >
        <AppShell.Header className="af-shell-header">
          <Group h="100%" px="lg" justify="space-between">
            <Group>
              <Burger opened={navbarOpened} onClick={toggleNavbar} hiddenFrom="md" size="sm" />
              <Box>
                <Title order={3}>Agentflow Web</Title>
                <Text size="sm" c="dimmed">
                  Launch, reopen, and resume runs from a cleaner operator dashboard.
                </Text>
              </Box>
            </Group>
            <div className="af-shell-actions">
              {version ? (
                <Badge variant="outline">
                  agentflow {version.agentflowVersion} · web {version.webAppVersion}
                </Badge>
              ) : null}
              <Button
                leftSection={<IconFileCode size={16} />}
                variant="default"
                onClick={() => openPicker('plan', 'inspect')}
              >
                Choose plan
              </Button>
              <Button
                leftSection={<IconFolderOpen size={16} />}
                variant="default"
                onClick={() => openPicker('run', 'open')}
              >
                Open run
              </Button>
              <Button
                leftSection={<IconRefresh size={16} />}
                variant="filled"
                onClick={() => openPicker('run', 'resume')}
              >
                Resume run
              </Button>
            </div>
          </Group>
        </AppShell.Header>

        <AppShell.Navbar className="af-shell-navbar" p="md">
          <div className="af-rail">
            <BentoTile
              accent="blue"
              header={
                <TileHeader
                  eyebrow="Launch settings"
                  title="Execution defaults"
                  description="Keep the run settings close to the launcher, not buried in a form."
                />
              }
            >
              <Stack gap="sm">
                <Switch
                  checked={settings.skipGitRepoCheck}
                  onChange={(event) => settings.setSkipGitRepoCheck(event.currentTarget.checked)}
                  label="Skip git repo check"
                />
                <NativeSelect
                  label="Sandbox mode"
                  value={settings.sandbox}
                  onChange={(event) => settings.setSandbox(event.currentTarget.value as any)}
                  data={[
                    { label: 'workspace-write', value: 'workspace-write' },
                    { label: 'read-only', value: 'read-only' },
                    { label: 'danger-full-access', value: 'danger-full-access' },
                  ]}
                />
                <Button
                  leftSection={<IconPlayerPlay size={16} />}
                  onClick={startRun}
                  disabled={!planPath || inspect?.valid === false}
                  loading={busy === 'start'}
                >
                  Start run
                </Button>
              </Stack>
            </BentoTile>

            <BentoTile
              accent="paper"
              header={<TileHeader eyebrow="Recent plans" title="Plan history" description="Jump back into plans you inspected recently." />}
            >
              <Stack gap={6}>
                {settings.recentPlans.length === 0 ? (
                  <Text size="sm" c="dimmed">No recent plans yet.</Text>
                ) : recentPlans.map((recentPlan) => (
                  <div className="af-file-row" key={recentPlan}>
                    <Stack gap={2}>
                      <TruncatedValue value={basename(recentPlan)} weight={600} />
                      <TruncatedValue value={recentPlan} dimmed />
                    </Stack>
                    <Button variant="subtle" size="compact-sm" onClick={() => void inspectPlan(recentPlan)}>
                      Open
                    </Button>
                  </div>
                ))}
                {settings.recentPlans.length > recentPlans.length ? (
                  <Button
                    variant="default"
                    fullWidth
                    onClick={() => setVisibleRecentPlans((count) => count + 3)}
                  >
                    Load more
                  </Button>
                ) : null}
              </Stack>
            </BentoTile>

            <BentoTile
              accent="yellow"
              header={<TileHeader eyebrow="Recent runs" title="Run folders" description="Open historical runs or resume them from disk." />}
            >
              <Stack gap={6}>
                {settings.recentRunDirs.length === 0 ? (
                  <Text size="sm" c="dimmed">No recent runs yet.</Text>
                ) : recentRunDirs.map((runDir) => (
                  <div className="af-file-row" key={runDir}>
                    <Stack gap={2}>
                      <TruncatedValue value={basename(runDir)} weight={600} />
                      <TruncatedValue value={runDir} dimmed />
                    </Stack>
                    <Group gap={6} wrap="nowrap">
                      <Button variant="subtle" size="compact-sm" onClick={() => void openRun(runDir, false)}>
                        Open
                      </Button>
                      <Button variant="subtle" size="compact-sm" onClick={() => void openRun(runDir, true)}>
                        Resume
                      </Button>
                    </Group>
                  </div>
                ))}
                {settings.recentRunDirs.length > recentRunDirs.length ? (
                  <Button
                    variant="default"
                    fullWidth
                    onClick={() => setVisibleRecentRuns((count) => count + 3)}
                  >
                    Load more
                  </Button>
                ) : null}
              </Stack>
            </BentoTile>
          </div>
        </AppShell.Navbar>

        <AppShell.Main>
          <Stack gap="md" className="af-home-main">
            {error ? (
              <Alert variant="light" color="red" icon={<IconAlertCircle size={18} />}>
                {error}
              </Alert>
            ) : null}

            <div className="af-home-overview">
              <div className="af-home-kpi-grid">
                <KpiTile
                  label="Plan status"
                  value={planPath ? (inspect?.valid ? 'Ready' : 'Review') : 'Idle'}
                  meta={planPath ? basename(planPath) : 'Choose a plan file'}
                  accent={inspect?.valid ? 'electric' : 'danger'}
                  tileAccent={inspect?.valid ? 'yellow' : 'red'}
                  icon={<IconFileCode size={18} />}
                />
                <KpiTile
                  label="Workflow nodes"
                  value={String(inspect?.workflow?.totalNodes || 0)}
                  meta="Total nodes discovered"
                  accent="electric"
                  tileAccent="paper"
                  icon={<IconRouteAltLeft size={18} />}
                />
                <KpiTile
                  label="Executable steps"
                  value={String(inspect?.workflow?.executableCount || 0)}
                  meta="Tasks and commands ready to run"
                  accent="signal"
                  tileAccent="blue"
                  icon={<IconPlayerPlay size={18} />}
                />
                <KpiTile
                  label="Context health"
                  value={`${contextReadyCount}/${inspect?.contextFiles?.length || 0}`}
                  meta={`${repoReadyCount}/${inspect?.repos?.length || 0} repos found`}
                  accent="danger"
                  tileAccent="red"
                  icon={<IconCheckupList size={18} />}
                />
              </div>

              <BentoTile
                accent="blue"
                className="af-home-summary-tile"
                header={
                  <TileHeader
                    eyebrow="Workflow mix"
                    title="Shape of the workflow"
                    description="Use the count mix to spot whether the plan is mostly executable work or orchestration."
                    actions={
                      inspect?.workflow?.totalNodes
                        ? <Badge variant="outline">{inspect.workflow.totalNodes} nodes</Badge>
                        : null
                    }
                  />
                }
              >
                {workflowBreakdown.length > 0 ? (
                  <Group justify="space-between" align="center">
                    <DonutChart data={workflowBreakdown} chartLabel={inspect?.workflow?.totalNodes || 0} />
                    <Stack gap={8}>
                      {workflowBreakdown.map((item) => (
                        <div className="af-stat-row" key={item.name}>
                          <Text size="sm" fw={600}>{item.name}</Text>
                          <Badge variant="light">{item.value}</Badge>
                        </div>
                      ))}
                    </Stack>
                  </Group>
                ) : (
                  <Text size="sm" c="dimmed">
                    Inspect a plan to populate the workflow composition.
                  </Text>
                )}
              </BentoTile>
            </div>

            <BentoTile
              accent="paper"
              className="af-home-preview-tile"
              header={
                <TileHeader
                  eyebrow="Workflow preview"
                  title="See the execution graph before you run"
                  description="The preview uses the inspected plan topology, so you can sanity-check orchestration and step order before launching."
                />
              }
            >
              <Box className="af-home-preview-frame">
                <div className="af-home-preview-left">
                  <Graph
                    plan={inspect?.plan || null}
                    state={null}
                    trace={[]}
                    selectedId={previewSelectedGraphId || undefined}
                    selectionKey="graphId"
                    onSelectNode={setPreviewSelectedGraphId}
                    onPaneClick={() => setPreviewSelectedGraphId(null)}
                    showMiniMap={false}
                    showControls={false}
                    className="graph-surface--preview"
                  />
                </div>
                <div className="af-home-preview-right">
                  <PreviewWalkthrough
                    graph={previewGraph}
                    selectedGraphId={previewSelectedGraphId}
                    onSelect={(id) => setPreviewSelectedGraphId(id)}
                    filter={walkthroughFilter}
                    onChangeFilter={setWalkthroughFilter}
                  />
                </div>
              </Box>
            </BentoTile>

            <div className="af-home-primary">
              <BentoTile
                tone="hero"
                accent="yellow"
                className="af-home-hero"
                header={
                  <TileHeader
                    eyebrow="Plan overview"
                    title="Launch from a readable plan summary"
                    description="Inspect a plan, confirm its topology and context, then start the run from the same surface."
                    actions={
                      <Button
                        leftSection={<IconPlayerPlay size={16} />}
                        onClick={startRun}
                        disabled={!planPath || inspect?.valid === false}
                        loading={busy === 'start'}
                      >
                        Start run
                      </Button>
                    }
                  />
                }
              >
                {planPath ? (
                  <Stack gap="md">
                    <Text component="pre" className="af-path-code">
                      {planPath}
                    </Text>
                    <Group gap="xs">
                      <Badge color={inspect?.valid ? 'green' : 'orange'} variant="light">
                        {inspect?.valid ? 'valid' : 'needs review'}
                      </Badge>
                      {(inspect?.errors || []).length > 0 ? (
                        <Badge color="red" variant="light">{inspect.errors.length} validation issues</Badge>
                      ) : null}
                    </Group>
                    {(inspect?.errors || []).length > 0 ? (
                      <div className="af-stat-list">
                        {inspect.errors.map((entry: string) => (
                          <div className="af-timeline-entry" key={entry}>
                            <Text size="sm">{entry}</Text>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Text size="sm" c="dimmed">
                        The selected plan is ready to launch. Use the supporting tiles to verify workflow shape, context files, and inferred run roots before starting.
                      </Text>
                    )}
                  </Stack>
                ) : (
                  <Stack gap="sm">
                    <Text size="sm" c="dimmed">
                      Pick a plan file here or launch `agentflow web --plan /absolute/path.json` to preload it directly into the dashboard.
                    </Text>
                    <Button leftSection={<IconFileCode size={16} />} onClick={() => openPicker('plan', 'inspect')}>
                      Inspect a plan
                    </Button>
                  </Stack>
                )}
              </BentoTile>

              <div className="af-home-right-stack">
                <BentoTile
                  accent="paper"
                  className="af-home-side-tile"
                  header={
                    <TileHeader
                      eyebrow="Context"
                      title="Repo and file health"
                      description="Resolve the critical paths before starting the run."
                    />
                  }
                >
                  {inspect ? (
                    <Stack gap="sm">
                      <div className="af-stat-list">
                        {(inspect.repos || []).map((repo: any) => (
                          <div className="af-stat-row" key={repo.alias}>
                            <Stack gap={2}>
                              <TruncatedValue value={repo.alias} weight={600} />
                              <TruncatedValue value={repo.root} dimmed />
                            </Stack>
                            <Badge color={repo.exists ? 'green' : 'red'} variant="light">
                              {repo.exists ? 'found' : 'missing'}
                            </Badge>
                          </div>
                        ))}
                      </div>
                      <Text size="sm" c="dimmed">
                        {contextReadyCount} of {inspect.contextFiles.length} context files resolve from the selected plan.
                      </Text>
                    </Stack>
                  ) : (
                    <Text size="sm" c="dimmed">
                      Plan inspection fills this tile with repo roots and context-file health.
                    </Text>
                  )}
                </BentoTile>
              </div>
            </div>

            <div className="af-home-secondary">
              <BentoTile
                accent="yellow"
                className="af-home-secondary-tile"
                header={
                  <TileHeader
                    eyebrow="Run roots"
                    title="Inferred artifact directories"
                    description="These are the candidate run roots the bridge can use once the plan starts."
                  />
                }
              >
                <ScrollArea h={220}>
                  <Stack gap={6}>
                    {(inspect?.runRootCandidates || []).length === 0 ? (
                      <Text size="sm" c="dimmed">No run-root candidates inferred yet.</Text>
                    ) : (inspect.runRootCandidates || []).map((candidate: string) => (
                      <Text key={candidate} component="pre" className="af-code-block">
                        {candidate}
                      </Text>
                    ))}
                  </Stack>
                </ScrollArea>
              </BentoTile>

              <BentoTile
                accent="red"
                className="af-home-secondary-tile"
                header={
                  <TileHeader
                    eyebrow="Nearby docs"
                    title="Context around the plan"
                    description="Useful markdown discovered near the plan and repo roots."
                  />
                }
              >
                <ScrollArea h={220}>
                  <Stack gap={6}>
                    {(inspect?.nearbyDocs || []).length === 0 ? (
                      <Text size="sm" c="dimmed">No nearby markdown docs detected.</Text>
                    ) : (inspect.nearbyDocs || []).map((docPath: string) => (
                      <div className="af-file-row" key={docPath}>
                        <Stack gap={2}>
                          <TruncatedValue value={basename(docPath)} weight={600} />
                          <TruncatedValue value={docPath} dimmed />
                        </Stack>
                        <Badge variant="outline">
                          <IconHistory size={12} />
                        </Badge>
                      </div>
                    ))}
                  </Stack>
                </ScrollArea>
              </BentoTile>
            </div>
          </Stack>
        </AppShell.Main>
      </AppShell>

      <FilePickerModal
        opened={pickerOpened}
        mode={pickerMode}
        title={
          pickerAction === 'inspect'
            ? 'Choose agentflow plan'
            : pickerAction === 'resume'
              ? 'Choose run folder to resume'
              : 'Choose run folder to open'
        }
        initialPath={pickerInitialPath}
        showHidden={settings.showHidden}
        recentPaths={settings.recentPickerPaths}
        onChangeShowHidden={settings.setShowHidden}
        onRememberPath={settings.rememberPickerPath}
        onClose={() => setPickerOpened(false)}
        onPick={async (targetPath, item) => {
          setPickerOpened(false);
          if (pickerAction === 'inspect') {
            await inspectPlan(targetPath);
            return;
          }
          if (!targetPath) return;
          try {
            await api.fs.read(joinPath(targetPath, 'run_state.json'));
            await openRun(targetPath, pickerAction === 'resume');
          } catch (err) {
            const message = item?.type === 'dir'
              ? 'Selected folder does not contain run_state.json.'
              : String(err);
            setError(message);
            notifications.show({ color: 'red', message });
          }
        }}
      />
    </>
  );
}
