import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SampleAgentflowScenario = 'success' | 'resume_failure' | 'loop_judge_failure' | 'builder_snapshot';

export type SuccessTaskKeyMap = {
  setupAgent: string;
  jokeAgent: string;
  factAgent: string;
  echoStatus: string;
  refineAgent: string;
  finalAgent: string;
};

export type ResumeFailureTaskKeyMap = {
  prepareWorkspace: string;
  lintWorkspace: string;
  resumeProbe: string;
};

export type LoopJudgeFailureTaskKeyMap = {
  seedBrief: string;
  rewriteBrief: string;
  captureGateContext: string;
};

export type BuilderSnapshotTaskKeyMap = {
  draftOutline: string;
  snapshotMetadata: string;
  draftPolish: string;
  publishSummary: string;
};

export type SampleFixtureAcceptance = {
  validates: string[];
  laterLoopUse: string[];
};

export type SampleFixtureSupportingFileKind =
  | 'run_state'
  | 'decision_trace'
  | 'plan'
  | 'command_result'
  | 'log'
  | 'report'
  | 'summary'
  | 'last_message'
  | 'source_plan'
  | 'draft_plan'
  | 'launch_plan'
  | 'draft_meta';

export type SampleFixtureSupportingFile = {
  kind: SampleFixtureSupportingFileKind;
  title: string;
  path: string;
  purpose: string;
};

export type SampleBuilderDraftInfo = {
  draftId: string;
  draftDir: string;
  sourcePlanPath: string;
  draftPlanPath: string;
  launchPlanPath: string;
};

export type SampleAgentflowFixture<TTaskKeys extends Record<string, string> = Record<string, string>> = {
  scenario: SampleAgentflowScenario;
  workspaceRoot: string;
  planPath: string;
  plan: Record<string, unknown>;
  runDir: string;
  runId: string;
  runState: Record<string, unknown>;
  trace: Array<Record<string, unknown>>;
  taskKeys: TTaskKeys;
  acceptance: SampleFixtureAcceptance;
  supportingFiles: SampleFixtureSupportingFile[];
  draft?: SampleBuilderDraftInfo;
};

type SampleFixtureOptions = {
  rootDir?: string;
  scenario?: SampleAgentflowScenario;
};

type WorkspacePaths = {
  workspaceRoot: string;
  tmpRoot: string;
  docsDir: string;
};

export const SAMPLE_AGENTFLOW_SCENARIO_NOTES: Record<SampleAgentflowScenario, SampleFixtureAcceptance> = {
  success: {
    validates: [
      'Two parallel agent tasks, one parallel command node, and loop_judge summaries in one lightweight historical run.',
      'Happy-path monitor inspection for overview, activity, artifacts, raw logs, and historical reopen.',
      'Plan inspection fallback via planPath and repo-root run candidate discovery.',
    ],
    laterLoopUse: [
      'Use for fast monitor smoke checks and Playwright-oriented happy-path validation.',
      'Use when a task needs concurrent work, one command node, and one loop_judge without introducing a failing state.',
    ],
  },
  resume_failure: {
    validates: [
      'Historical failure rendering, failure-path evidence inspection, and resume-preflight copy without provider auth.',
      'A stopped run with partial success, one blocking failed command, and an unstarted downstream node.',
      'Deterministic failure artifacts that later resume and reliability loops can reopen without rerunning setup.',
    ],
    laterLoopUse: [
      'Use to validate `/run/:runId` failure-state copy, `Resume` affordances, and failed-command evidence.',
      'Pair with the live command-only resume test when a loop needs both fast fixture-backed monitor coverage and one end-to-end resume proof.',
    ],
  },
  loop_judge_failure: {
    validates: [
      'Historical loop_judge failure after a post-body evaluation records no numeric score.',
      'Judge-state rendering for `No score`, post-body retry intent, and timeout-style gate-error reasons.',
      'A deterministic exhausted-loop path that mirrors gate failures like `spawnSync codex ETIMEDOUT` without needing live provider auth.',
    ],
    laterLoopUse: [
      'Use when monitor or graph work touches loop_judge failure copy, null-score judge badges, or judge-trail progressive disclosure.',
      'Use alongside the command-only resume fixture when a loop needs stable judge-failure coverage plus one live rerun proof.',
    ],
  },
  builder_snapshot: {
    validates: [
      'Builder-launch snapshot handoff through a plan path under `.tmp/web_builder_drafts/<draftId>/launches/`.',
      'Builder source, draft, and launch plans form one realistic lineage while keeping runtime JSON plain and explicit.',
      'Persona-template-style edits compile to plain `persona` strings with no runtime `persona_ref` field.',
      'Snapshot plans that still inspect and reopen like ordinary runtime plans.',
    ],
    laterLoopUse: [
      'Use for builder-to-monitor handoff work and future `Reopen draft` inference checks.',
      'Use to compare source-versus-draft/launch plan JSON when builder editing or snapshot compilation changes.',
      'Use to verify that builder-generated plans remain plain JSON plans and keep a stable run-root contract.',
    ],
  },
};

function writeText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function initWorkspace(rootDir?: string): WorkspacePaths {
  const workspaceRoot = rootDir || fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-web-sample-'));
  const tmpRoot = path.join(workspaceRoot, '.tmp');
  const docsDir = path.join(workspaceRoot, 'docs');

  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  writeText(path.join(workspaceRoot, 'README.md'), '# Sample workspace\n');
  writeText(path.join(docsDir, 'sample-guide.md'), '# Sample guide\n');

  return { workspaceRoot, tmpRoot, docsDir };
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '');
}

function createTaskRow(
  runDir: string,
  groupDir: string,
  taskSlug: string,
  taskKey: string,
  taskId: string,
  nodePath: string,
  status: string,
  promptText: string,
  logText: string,
  reportText: string,
  summaryText: string,
  lastMessageText: string,
  extra: Record<string, unknown> = {},
) {
  const taskDir = path.join(runDir, groupDir, `task_${taskSlug}`);
  const promptPath = path.join(taskDir, 'prompt.md');
  const logPath = path.join(taskDir, 'worker_exec.log');
  const reportPath = path.join(taskDir, 'worker_report.md');
  const summaryPath = path.join(taskDir, 'worker_summary.md');
  const lastMessagePath = path.join(taskDir, 'worker_last_message.md');

  writeText(promptPath, promptText);
  writeText(logPath, logText);
  writeText(reportPath, reportText);
  writeText(summaryPath, summaryText);
  writeText(lastMessagePath, lastMessageText);

  return {
    taskKey,
    taskId,
    attempt: 1,
    status,
    nodePath,
    promptPath,
    logPath,
    reportPath,
    summaryPath,
    lastMessagePath,
    startedAtUtc: '2026-03-31T16:00:00Z',
    endedAtUtc: '2026-03-31T16:01:00Z',
    durationSec: 60,
    ...extra,
  };
}

function writeCommandResult(row: Record<string, unknown>, result: Record<string, unknown>): void {
  const promptPath = String(row.promptPath || '');
  if (!promptPath) return;
  const taskDir = path.dirname(promptPath);
  writeJson(path.join(taskDir, 'command_result.json'), result);
}

function taskDirForRow(row: Record<string, unknown>): string {
  return path.dirname(String(row.promptPath || ''));
}

function commandResultPath(row: Record<string, unknown>): string {
  return path.join(taskDirForRow(row), 'command_result.json');
}

function finalizeFixture<TTaskKeys extends Record<string, string>>(params: {
  scenario: SampleAgentflowScenario;
  workspaceRoot: string;
  planPath: string;
  plan: Record<string, unknown>;
  runDir: string;
  runId: string;
  runState: Record<string, unknown>;
  trace: Array<Record<string, unknown>>;
  taskKeys: TTaskKeys;
  supportingFiles?: SampleFixtureSupportingFile[];
  draft?: SampleBuilderDraftInfo;
}): SampleAgentflowFixture<TTaskKeys> {
  const runStatePath = path.join(params.runDir, 'run_state.json');
  const decisionTracePath = path.join(params.runDir, 'decision_trace.json');

  writeJson(runStatePath, params.runState);
  writeJson(decisionTracePath, params.trace);

  return {
    scenario: params.scenario,
    workspaceRoot: params.workspaceRoot,
    planPath: params.planPath,
    plan: params.plan,
    runDir: params.runDir,
    runId: params.runId,
    runState: params.runState,
    trace: params.trace,
    taskKeys: params.taskKeys,
    acceptance: SAMPLE_AGENTFLOW_SCENARIO_NOTES[params.scenario],
    supportingFiles: [
      {
        kind: 'run_state',
        title: 'Run state snapshot',
        path: runStatePath,
        purpose: 'Inspect persisted task rows, group state, failure totals, and reopen state without loading the monitor UI.',
      },
      {
        kind: 'decision_trace',
        title: 'Decision trace snapshot',
        path: decisionTracePath,
        purpose: 'Inspect judge, loop, and control-flow events that back the monitor Activity layer.',
      },
      ...(params.supportingFiles || []),
    ],
    draft: params.draft,
  };
}

function createSuccessFixture(rootDir?: string): SampleAgentflowFixture<SuccessTaskKeyMap> {
  const { workspaceRoot, tmpRoot, docsDir } = initWorkspace(rootDir);
  const planPath = path.join(tmpRoot, 'sample-fun-plan.json');
  const runId = `run_sample_fun_${sanitizeName(path.basename(workspaceRoot))}`;
  const runDir = path.join(tmpRoot, 'agentflow_runs', runId);

  writeText(path.join(docsDir, 'monitor-happy-path.md'), '# Happy-path monitor fixture\n');

  const plan = {
    repos: {
      main: '..',
    },
    options: {
      run_root: 'agentflow_runs',
    },
    flow: [
      {
        type: 'task',
        id: 'setup_agent',
        prompt: 'Brainstorm a playful product pitch about cloud noodles.',
      },
      {
        type: 'group',
        id: 'parallel_fun',
        parallel: true,
        steps: [
          {
            type: 'task',
            id: 'joke_agent',
            prompt: 'Tell a clean pun about databases and noodles.',
          },
          {
            type: 'task',
            id: 'fact_agent',
            prompt: 'Write one playful supporting fact about cloud noodles in a single sentence.',
          },
          {
            type: 'command',
            id: 'echo_status',
            command: '/bin/sh',
            args: ['-c', 'echo pipeline_ready'],
          },
        ],
      },
      {
        type: 'loop_judge',
        id: 'quality_gate',
        max_iterations: 2,
        pass_threshold: 8,
        rubric: {
          notes: 'Prefer punchlines that are specific and easy to repeat.',
          criteria: [
            { id: 'clarity', label: 'Clarity', weight: 0.4, guidance: 'Easy to understand on first read.' },
            { id: 'humor', label: 'Humor', weight: 0.6, guidance: 'Should land as a light joke.' },
          ],
        },
        body: [
          {
            type: 'task',
            id: 'refine_agent',
            prompt: 'Improve the joke using the latest judge feedback.',
          },
        ],
      },
      {
        type: 'task',
        id: 'final_agent',
        prompt: 'Summarize the strongest final line in one sentence.',
      },
    ],
  } satisfies Record<string, unknown>;

  writeJson(planPath, plan);

  const taskKeys: SuccessTaskKeyMap = {
    setupAgent: 'g01:setup_agent#a1',
    jokeAgent: 'g02:joke_agent#a1',
    factAgent: 'g03:fact_agent#a1',
    echoStatus: 'g04:echo_status#a1',
    refineAgent: 'g05:refine_agent#a1',
    finalAgent: 'g06:final_agent#a1',
  };

  const tasks = {
    [taskKeys.setupAgent]: createTaskRow(
      runDir,
      'group_01',
      'setup-agent-a1',
      taskKeys.setupAgent,
      'setup_agent',
      'workflow[0]/task:setup_agent',
      'DONE',
      'Brainstorm a playful product pitch about cloud noodles.',
      'setup_agent started\nsetup_agent done',
      '## Report\nProduced a playful kickoff line.',
      'Created the opening concept.',
      'Cloud noodles: now with 99.99% uptime.',
    ),
    [taskKeys.jokeAgent]: createTaskRow(
      runDir,
      'group_02',
      'joke-agent-a1',
      taskKeys.jokeAgent,
      'joke_agent',
      'workflow[1]/group:parallel_fun/step_1/task:joke_agent',
      'DONE',
      'Tell a clean pun about databases and noodles.',
      'joke_agent started\njoke_agent done',
      '## Report\nGenerated a clean database pun.',
      'Database pun drafted.',
      'I told my database a noodle joke and it said it could not pasta query.',
    ),
    [taskKeys.factAgent]: createTaskRow(
      runDir,
      'group_03',
      'fact-agent-a1',
      taskKeys.factAgent,
      'fact_agent',
      'workflow[1]/group:parallel_fun/step_2/task:fact_agent',
      'DONE',
      'Write one playful supporting fact about cloud noodles in a single sentence.',
      'fact_agent started\nfact_agent done',
      '## Report\nProduced one playful supporting fact about cloud noodles.',
      'Supporting fact drafted.',
      'Cloud noodles scale best when every strand shares the same broth cache.',
    ),
    [taskKeys.echoStatus]: createTaskRow(
      runDir,
      'group_04',
      'echo-status-a1',
      taskKeys.echoStatus,
      'echo_status',
      'workflow[1]/group:parallel_fun/step_3/command:echo_status',
      'DONE',
      '/bin/sh -c echo pipeline_ready',
      'pipeline_ready',
      '## Report\nCommand completed successfully.',
      'Command emitted pipeline_ready.',
      'pipeline_ready',
    ),
    [taskKeys.refineAgent]: createTaskRow(
      runDir,
      'group_05',
      'refine-agent-a1',
      taskKeys.refineAgent,
      'refine_agent',
      'workflow[2]/while:quality_gate/body[0]/task:refine_agent',
      'DONE',
      'Improve the joke using the latest judge feedback.',
      'refine_agent started\nrefine_agent done',
      '## Report\nRefined the joke to be clearer and more specific.',
      'Refined the joke with judge feedback.',
      'The database loved the noodle joke because it was already al dente-normalized.',
    ),
    [taskKeys.finalAgent]: createTaskRow(
      runDir,
      'group_06',
      'final-agent-a1',
      taskKeys.finalAgent,
      'final_agent',
      'workflow[3]/task:final_agent',
      'DONE',
      'Summarize the strongest final line in one sentence.',
      'final_agent started\nfinal_agent done',
      '## Report\nProduced the final summary sentence.',
      'Final summary sentence ready.',
      'The final joke lands best when it leans into noodle-specific database wordplay.',
    ),
  };

  writeCommandResult(tasks[taskKeys.echoStatus], {
    exitCode: 0,
    stdout: 'pipeline_ready\n',
    stderr: '',
  });

  const runState = {
    runId,
    configPath: planPath,
    workflowLength: 4,
    totalTaskCount: 6,
    totalFailureCount: 0,
    totalRunFailureCount: 0,
    totalLoopIterations: 1,
    runFailureReasons: [],
    cancelRequested: false,
    updatedAtUtc: '2026-03-31T16:05:00Z',
    groups: {
      parallel_fun: {
        groupId: 'parallel_fun',
        status: 'DONE',
        nodePath: 'workflow[1]/group:parallel_fun',
      },
    },
    tasks,
  } satisfies Record<string, unknown>;

  const trace = [
    {
      atUtc: '2026-03-31T16:02:00Z',
      type: 'while_iteration_started',
      nodePath: 'workflow[2]/while:quality_gate',
      detail: { whileId: 'quality_gate', iteration: 1 },
    },
    {
      atUtc: '2026-03-31T16:02:10Z',
      type: 'while_gate_evaluation',
      nodePath: 'workflow[2]/while:quality_gate',
      detail: {
        whileId: 'quality_gate',
        iteration: 1,
        phase: 'pre_body',
        score: 6,
        passed: false,
        reasons: ['Make the punchline more specific and easier to repeat.'],
      },
    },
    {
      atUtc: '2026-03-31T16:03:30Z',
      type: 'while_gate_evaluation',
      nodePath: 'workflow[2]/while:quality_gate',
      detail: {
        whileId: 'quality_gate',
        iteration: 1,
        phase: 'post_body',
        score: 9,
        passed: true,
        reasons: ['The revised joke lands cleanly and stays memorable.'],
      },
    },
    {
      atUtc: '2026-03-31T16:03:31Z',
      type: 'while_satisfied',
      nodePath: 'workflow[2]/while:quality_gate',
      detail: {
        whileId: 'quality_gate',
        iteration: 1,
        phase: 'post_body',
      },
    },
  ] satisfies Array<Record<string, unknown>>;

  return finalizeFixture({
    scenario: 'success',
    workspaceRoot,
    planPath,
    plan,
    runDir,
    runId,
    runState,
    trace,
    taskKeys,
    supportingFiles: [
      {
        kind: 'plan',
        title: 'Happy-path plan JSON',
        path: planPath,
        purpose: 'Inspect the stable graph shape with one setup task, a parallel group of two agent tasks plus one command node, one loop_judge, and one final task.',
      },
      {
        kind: 'last_message',
        title: 'joke_agent last message',
        path: String(tasks[taskKeys.jokeAgent].lastMessagePath),
        purpose: 'Check one parallel agent output without opening the full monitor artifacts panel.',
      },
      {
        kind: 'command_result',
        title: 'echo_status command result',
        path: commandResultPath(tasks[taskKeys.echoStatus]),
        purpose: 'Validate deterministic command-node evidence for the parallel command branch.',
      },
      {
        kind: 'report',
        title: 'refine_agent worker report',
        path: String(tasks[taskKeys.refineAgent].reportPath),
        purpose: 'Inspect the loop body output that precedes the successful post-body judge evaluation.',
      },
    ],
  });
}

function createResumeFailureFixture(rootDir?: string): SampleAgentflowFixture<ResumeFailureTaskKeyMap> {
  const { workspaceRoot, tmpRoot, docsDir } = initWorkspace(rootDir);
  const planPath = path.join(tmpRoot, 'sample-resume-failure-plan.json');
  const runId = `run_sample_resume_failure_${sanitizeName(path.basename(workspaceRoot))}`;
  const runDir = path.join(tmpRoot, 'agentflow_runs', runId);

  writeText(path.join(docsDir, 'resume-playbook.md'), '# Resume-ready failure fixture\n');

  const plan = {
    setup: 'Historical failure fixture for resume and failure-state monitor coverage.',
    objective: 'Expose deterministic failure, resume, and command-node evidence without provider auth.',
    repos: {
      main: '..',
    },
    on_failure: 'stop',
    options: {
      run_root: 'agentflow_runs',
    },
    limits: {
      worker_timeout_sec: 120,
      timeout_grace_sec: 5,
      max_parallel_tasks: 2,
    },
    flow: [
      {
        type: 'command',
        id: 'prepare_workspace',
        command: '/bin/sh',
        args: ['-c', 'printf workspace_seeded'],
      },
      {
        type: 'group',
        id: 'verification_fanout',
        parallel: true,
        steps: [
          {
            type: 'command',
            id: 'lint_workspace',
            command: '/bin/sh',
            args: ['-c', 'printf lint_clean'],
          },
          {
            type: 'command',
            id: 'resume_probe',
            command: '/bin/sh',
            args: ['-c', 'printf retry_required >&2; exit 17'],
          },
        ],
      },
      {
        type: 'command',
        id: 'publish_status',
        command: '/bin/sh',
        args: ['-c', 'printf publish_complete'],
      },
    ],
  } satisfies Record<string, unknown>;

  writeJson(planPath, plan);

  const taskKeys: ResumeFailureTaskKeyMap = {
    prepareWorkspace: 'g01:prepare_workspace#a1',
    lintWorkspace: 'g02:lint_workspace#a1',
    resumeProbe: 'g03:resume_probe#a1',
  };

  const tasks = {
    [taskKeys.prepareWorkspace]: createTaskRow(
      runDir,
      'group_01',
      'prepare-workspace-a1',
      taskKeys.prepareWorkspace,
      'prepare_workspace',
      'workflow[0]/command:prepare_workspace',
      'DONE',
      '/bin/sh -c printf workspace_seeded',
      'workspace_seeded',
      '## Report\nSeeded the workspace before verification.',
      'Workspace seed completed.',
      'workspace_seeded',
      {
        startedAtUtc: '2026-04-01T09:00:00Z',
        endedAtUtc: '2026-04-01T09:00:03Z',
        durationSec: 3,
      },
    ),
    [taskKeys.lintWorkspace]: createTaskRow(
      runDir,
      'group_02',
      'lint-workspace-a1',
      taskKeys.lintWorkspace,
      'lint_workspace',
      'workflow[1]/group:verification_fanout/step_1/command:lint_workspace',
      'DONE',
      '/bin/sh -c printf lint_clean',
      'lint_clean',
      '## Report\nWorkspace lint completed cleanly.',
      'Lint completed cleanly.',
      'lint_clean',
      {
        startedAtUtc: '2026-04-01T09:00:05Z',
        endedAtUtc: '2026-04-01T09:00:07Z',
        durationSec: 2,
      },
    ),
    [taskKeys.resumeProbe]: createTaskRow(
      runDir,
      'group_03',
      'resume-probe-a1',
      taskKeys.resumeProbe,
      'resume_probe',
      'workflow[1]/group:verification_fanout/step_2/command:resume_probe',
      'FAILED',
      '/bin/sh -c printf retry_required >&2; exit 17',
      'retry_required',
      '## Report\nResume probe failed because the resume marker was not present.',
      'Resume probe failed and should be retried after the marker is created.',
      'retry_required',
      {
        startedAtUtc: '2026-04-01T09:00:05Z',
        endedAtUtc: '2026-04-01T09:00:08Z',
        durationSec: 3,
        failureReason: 'Exit code 17: retry_required',
      },
    ),
  };

  writeCommandResult(tasks[taskKeys.prepareWorkspace], {
    exitCode: 0,
    stdout: 'workspace_seeded',
    stderr: '',
  });
  writeCommandResult(tasks[taskKeys.lintWorkspace], {
    exitCode: 0,
    stdout: 'lint_clean',
    stderr: '',
  });
  writeCommandResult(tasks[taskKeys.resumeProbe], {
    exitCode: 17,
    stdout: '',
    stderr: 'retry_required\n',
  });

  const runState = {
    runId,
    configPath: planPath,
    workflowLength: 3,
    totalTaskCount: 4,
    totalFailureCount: 1,
    totalRunFailureCount: 1,
    totalLoopIterations: 0,
    runFailureReasons: ['resume_probe exited with code 17 before publish_status could run.'],
    cancelRequested: false,
    updatedAtUtc: '2026-04-01T09:00:08Z',
    groups: {
      verification_fanout: {
        groupId: 'verification_fanout',
        status: 'FAILED',
        nodePath: 'workflow[1]/group:verification_fanout',
        failureReason: 'Child command resume_probe failed before the group could complete.',
      },
    },
    tasks,
  } satisfies Record<string, unknown>;

  const trace = [
    {
      atUtc: '2026-04-01T09:00:03Z',
      type: 'command_completed',
      nodePath: 'workflow[0]/command:prepare_workspace',
      detail: { commandId: 'prepare_workspace', exitCode: 0 },
    },
    {
      atUtc: '2026-04-01T09:00:04Z',
      type: 'group_started',
      nodePath: 'workflow[1]/group:verification_fanout',
      detail: { groupId: 'verification_fanout', parallel: true },
    },
    {
      atUtc: '2026-04-01T09:00:07Z',
      type: 'command_completed',
      nodePath: 'workflow[1]/group:verification_fanout/step_1/command:lint_workspace',
      detail: { commandId: 'lint_workspace', exitCode: 0 },
    },
    {
      atUtc: '2026-04-01T09:00:08Z',
      type: 'command_failed',
      nodePath: 'workflow[1]/group:verification_fanout/step_2/command:resume_probe',
      detail: {
        commandId: 'resume_probe',
        exitCode: 17,
        stderr: 'retry_required',
      },
    },
    {
      atUtc: '2026-04-01T09:00:08Z',
      type: 'run_failed',
      nodePath: 'workflow[1]/group:verification_fanout',
      detail: {
        runId,
        reason: 'resume_probe must be rerun after the resume marker is created.',
      },
    },
  ] satisfies Array<Record<string, unknown>>;

  return finalizeFixture({
    scenario: 'resume_failure',
    workspaceRoot,
    planPath,
    plan,
    runDir,
    runId,
    runState,
    trace,
    taskKeys,
    supportingFiles: [
      {
        kind: 'plan',
        title: 'Resume failure plan JSON',
        path: planPath,
        purpose: 'Inspect the deterministic stop-on-failure plan with one successful setup command, one parallel verification fanout, and one downstream command that never starts.',
      },
      {
        kind: 'command_result',
        title: 'resume_probe command result',
        path: commandResultPath(tasks[taskKeys.resumeProbe]),
        purpose: 'Check the persisted exit code `17` plus `retry_required` stderr that powers the resume-preflight state.',
      },
      {
        kind: 'log',
        title: 'resume_probe execution log',
        path: String(tasks[taskKeys.resumeProbe].logPath),
        purpose: 'Inspect the deterministic failed-command log used by raw-log validation and historical failure copy.',
      },
    ],
  });
}

function createLoopJudgeFailureFixture(rootDir?: string): SampleAgentflowFixture<LoopJudgeFailureTaskKeyMap> {
  const { workspaceRoot, tmpRoot, docsDir } = initWorkspace(rootDir);
  const planPath = path.join(tmpRoot, 'sample-loop-judge-failure-plan.json');
  const runId = `run_sample_loop_judge_failure_${sanitizeName(path.basename(workspaceRoot))}`;
  const runDir = path.join(tmpRoot, 'agentflow_runs', runId);

  writeText(path.join(docsDir, 'loop-judge-failure.md'), '# Loop judge failure fixture\n');

  const plan = {
    setup: 'Historical loop_judge failure fixture for null-score monitor coverage.',
    objective: 'Expose deterministic post-body gate failure with a null score and timeout-style reasons.',
    repos: {
      main: '..',
    },
    on_failure: 'stop',
    options: {
      run_root: 'agentflow_runs',
    },
    limits: {
      worker_timeout_sec: 180,
      timeout_grace_sec: 5,
      max_parallel_tasks: 2,
    },
    flow: [
      {
        type: 'task',
        id: 'seed_brief',
        prompt: 'Draft a one-line launch brief for the local orchestration studio.',
      },
      {
        type: 'loop_judge',
        id: 'monitor_quality_gate',
        max_iterations: 1,
        pass_threshold: 9.2,
        rubric: {
          notes: 'Prefer concise operator copy that names the graph-first monitor and reliable local runs.',
          criteria: [
            { id: 'clarity', label: 'Clarity', weight: 0.5, guidance: 'Explain the operator benefit plainly.' },
            { id: 'confidence', label: 'Confidence', weight: 0.5, guidance: 'Avoid vague platform language.' },
          ],
        },
        body: [
          {
            type: 'task',
            id: 'rewrite_brief',
            prompt: 'Tighten the brief using the latest gate reasons and keep the promise concrete.',
          },
          {
            type: 'command',
            id: 'capture_gate_context',
            command: '/bin/sh',
            args: ['-c', 'printf gate_context_saved'],
          },
        ],
      },
      {
        type: 'task',
        id: 'publish_brief',
        prompt: 'Publish the approved brief.',
      },
    ],
  } satisfies Record<string, unknown>;

  writeJson(planPath, plan);

  const taskKeys: LoopJudgeFailureTaskKeyMap = {
    seedBrief: 'g01:seed_brief#a1',
    rewriteBrief: 'g02:rewrite_brief#a1',
    captureGateContext: 'g03:capture_gate_context#a1',
  };

  const tasks = {
    [taskKeys.seedBrief]: createTaskRow(
      runDir,
      'group_01',
      'seed-brief-a1',
      taskKeys.seedBrief,
      'seed_brief',
      'workflow[0]/task:seed_brief',
      'DONE',
      'Draft a one-line launch brief for the local orchestration studio.',
      'seed_brief started\nseed_brief done',
      '## Report\nDrafted the first launch brief.',
      'Initial launch brief drafted.',
      'Agentflow Studio keeps local orchestration understandable from graph to evidence.',
      {
        startedAtUtc: '2026-04-01T11:00:00Z',
        endedAtUtc: '2026-04-01T11:00:20Z',
        durationSec: 20,
      },
    ),
    [taskKeys.rewriteBrief]: createTaskRow(
      runDir,
      'group_02',
      'rewrite-brief-a1',
      taskKeys.rewriteBrief,
      'rewrite_brief',
      'workflow[1]/while:monitor_quality_gate/body[0]/task:rewrite_brief',
      'DONE',
      'Tighten the brief using the latest gate reasons and keep the promise concrete.',
      'rewrite_brief started\nrewrite_brief done',
      '## Report\nRewrote the brief with a tighter operator promise.',
      'Launch brief rewritten after the first gate result.',
      'Agentflow Studio lets one operator launch, inspect, and resume local graph runs without leaving the browser.',
      {
        startedAtUtc: '2026-04-01T11:00:30Z',
        endedAtUtc: '2026-04-01T11:01:05Z',
        durationSec: 35,
      },
    ),
    [taskKeys.captureGateContext]: createTaskRow(
      runDir,
      'group_03',
      'capture-gate-context-a1',
      taskKeys.captureGateContext,
      'capture_gate_context',
      'workflow[1]/while:monitor_quality_gate/body[1]/command:capture_gate_context',
      'DONE',
      '/bin/sh -c printf gate_context_saved',
      'gate_context_saved',
      '## Report\nPersisted lightweight gate context for later inspection.',
      'Gate context saved before the judge timed out.',
      'gate_context_saved',
      {
        startedAtUtc: '2026-04-01T11:01:06Z',
        endedAtUtc: '2026-04-01T11:01:07Z',
        durationSec: 1,
      },
    ),
  };

  writeCommandResult(tasks[taskKeys.captureGateContext], {
    exitCode: 0,
    stdout: 'gate_context_saved\n',
    stderr: '',
  });

  const runState = {
    runId,
    configPath: planPath,
    workflowLength: 3,
    totalTaskCount: 4,
    totalFailureCount: 1,
    totalRunFailureCount: 1,
    totalLoopIterations: 1,
    runFailureReasons: [
      'monitor_quality_gate exhausted after a post-body gate error: ai gate error: Error: spawnSync codex ETIMEDOUT',
    ],
    cancelRequested: false,
    updatedAtUtc: '2026-04-01T11:01:09Z',
    groups: {},
    tasks,
  } satisfies Record<string, unknown>;

  const trace = [
    {
      atUtc: '2026-04-01T11:00:29Z',
      type: 'while_iteration_started',
      nodePath: 'workflow[1]/while:monitor_quality_gate',
      detail: { whileId: 'monitor_quality_gate', iteration: 1 },
    },
    {
      atUtc: '2026-04-01T11:00:29Z',
      type: 'while_gate_evaluation',
      nodePath: 'workflow[1]/while:monitor_quality_gate',
      detail: {
        whileId: 'monitor_quality_gate',
        iteration: 1,
        phase: 'pre_body',
        score: 8.8,
        passed: false,
        reasons: ['The brief still needs a clearer operator promise before it can ship.'],
      },
    },
    {
      atUtc: '2026-04-01T11:01:07Z',
      type: 'command_completed',
      nodePath: 'workflow[1]/while:monitor_quality_gate/body[1]/command:capture_gate_context',
      detail: { commandId: 'capture_gate_context', exitCode: 0 },
    },
    {
      atUtc: '2026-04-01T11:01:08Z',
      type: 'while_gate_evaluation',
      nodePath: 'workflow[1]/while:monitor_quality_gate',
      detail: {
        whileId: 'monitor_quality_gate',
        iteration: 1,
        phase: 'post_body',
        score: null,
        passed: false,
        reasons: ['ai gate error: Error: spawnSync codex ETIMEDOUT'],
      },
    },
    {
      atUtc: '2026-04-01T11:01:09Z',
      type: 'while_exhausted',
      nodePath: 'workflow[1]/while:monitor_quality_gate',
      detail: {
        whileId: 'monitor_quality_gate',
        iteration: 1,
        maxIterations: 1,
        phase: 'post_body',
      },
    },
    {
      atUtc: '2026-04-01T11:01:09Z',
      type: 'run_failed',
      nodePath: 'workflow[1]/while:monitor_quality_gate',
      detail: {
        runId,
        reason: 'The post-body judge timed out before it could return a score.',
      },
    },
  ] satisfies Array<Record<string, unknown>>;

  return finalizeFixture({
    scenario: 'loop_judge_failure',
    workspaceRoot,
    planPath,
    plan,
    runDir,
    runId,
    runState,
    trace,
    taskKeys,
    supportingFiles: [
      {
        kind: 'plan',
        title: 'Loop judge failure plan JSON',
        path: planPath,
        purpose: 'Inspect the one-iteration loop_judge plan that fails on a post-body gate evaluation with no numeric score.',
      },
      {
        kind: 'report',
        title: 'rewrite_brief worker report',
        path: String(tasks[taskKeys.rewriteBrief].reportPath),
        purpose: 'Verify that the loop body completed and produced a tangible rewrite before the judge timed out.',
      },
      {
        kind: 'command_result',
        title: 'capture_gate_context command result',
        path: commandResultPath(tasks[taskKeys.captureGateContext]),
        purpose: 'Check the stable command-node evidence that lands before the post-body null-score gate failure.',
      },
    ],
  });
}

function createBuilderSnapshotFixture(rootDir?: string): SampleAgentflowFixture<BuilderSnapshotTaskKeyMap> {
  const { workspaceRoot, tmpRoot, docsDir } = initWorkspace(rootDir);
  const runRoot = path.join(tmpRoot, 'agentflow_runs');
  const draftId = 'draft_local_orchestration_studio';
  const draftDir = path.join(tmpRoot, 'web_builder_drafts', draftId);
  const sourcePlanPath = path.join(tmpRoot, 'plans', 'builder-source-plan.json');
  const draftPlanPath = path.join(draftDir, 'draft.plan.json');
  const planPath = path.join(draftDir, 'launches', 'launch-2026-04-01T07-00-00Z.plan.json');
  const runId = `run_builder_snapshot_${sanitizeName(path.basename(workspaceRoot))}`;
  const runDir = path.join(runRoot, runId);

  writeText(path.join(docsDir, 'builder-handoff.md'), '# Builder launch snapshot fixture\n');

  const sourcePlan = {
    setup: 'Source plan before builder edits.',
    objective: 'Capture the pre-builder launch concept before personas and stronger operator copy are applied.',
    repos: {
      main: workspaceRoot,
    },
    provider: 'codex',
    model: 'gpt-5.4-mini',
    options: {
      run_root: runRoot,
    },
    flow: [
      {
        type: 'task',
        id: 'draft_outline',
        prompt: 'Outline the local orchestration studio launch in three short bullets.',
      },
      {
        type: 'group',
        id: 'builder_parallel_checks',
        parallel: true,
        steps: [
          {
            type: 'command',
            id: 'snapshot_metadata',
            command: '/bin/sh',
            args: ['-c', 'printf builder_snapshot_ready'],
          },
          {
            type: 'task',
            id: 'draft_polish',
            prompt: 'Tighten the launch copy while keeping the builder handoff explicit.',
          },
        ],
      },
      {
        type: 'task',
        id: 'publish_summary',
        prompt: 'Summarize the source plan contract in one paragraph.',
      },
    ],
  } satisfies Record<string, unknown>;

  const plan = {
    setup: 'Builder launch snapshot fixture for builder-to-monitor handoff.',
    objective: 'Validate that builder-generated plans stay plain JSON, reopen from launch snapshot paths, and preserve source-to-draft lineage.',
    repos: {
      main: workspaceRoot,
    },
    provider: 'codex',
    model: 'gpt-5.4-mini',
    options: {
      run_root: runRoot,
    },
    flow: [
      {
        type: 'task',
        id: 'draft_outline',
        persona: 'You are a graph-first product strategist focused on monitor clarity.',
        prompt: 'Outline the next-stage orchestration studio launch in four bullets.',
      },
      {
        type: 'group',
        id: 'builder_parallel_checks',
        parallel: true,
        steps: [
          {
            type: 'command',
            id: 'snapshot_metadata',
            command: '/bin/sh',
            args: ['-c', 'printf builder_snapshot_ready'],
          },
          {
            type: 'task',
            id: 'draft_polish',
            persona: 'You are a release copy editor for local orchestration tools.',
            prompt: 'Tighten the builder launch copy without introducing runtime persona references.',
          },
        ],
      },
      {
        type: 'task',
        id: 'publish_summary',
        prompt: 'Summarize the builder launch snapshot contract in one paragraph.',
      },
    ],
  } satisfies Record<string, unknown>;

  writeJson(sourcePlanPath, sourcePlan);
  writeJson(draftPlanPath, plan);
  writeJson(planPath, plan);
  writeJson(path.join(draftDir, 'draft.meta.json'), {
    draftId,
    sourcePlanPath,
    createdAtUtc: '2026-04-01T06:45:00Z',
    updatedAtUtc: '2026-04-01T07:00:00Z',
    archived: false,
  });

  const taskKeys: BuilderSnapshotTaskKeyMap = {
    draftOutline: 'g01:draft_outline#a1',
    snapshotMetadata: 'g02:snapshot_metadata#a1',
    draftPolish: 'g03:draft_polish#a1',
    publishSummary: 'g04:publish_summary#a1',
  };

  const tasks = {
    [taskKeys.draftOutline]: createTaskRow(
      runDir,
      'group_01',
      'draft-outline-a1',
      taskKeys.draftOutline,
      'draft_outline',
      'workflow[0]/task:draft_outline',
      'DONE',
      'Outline the next-stage orchestration studio launch in four bullets.',
      'draft_outline started\ndraft_outline done',
      '## Report\nOutlined the launch in four bullets.',
      'Draft outline completed.',
      'Graph-first monitor, durable builder drafts, reliable fixtures, and operator-grade polish.',
      {
        startedAtUtc: '2026-04-01T07:00:10Z',
        endedAtUtc: '2026-04-01T07:00:40Z',
        durationSec: 30,
      },
    ),
    [taskKeys.snapshotMetadata]: createTaskRow(
      runDir,
      'group_02',
      'snapshot-metadata-a1',
      taskKeys.snapshotMetadata,
      'snapshot_metadata',
      'workflow[1]/group:builder_parallel_checks/step_1/command:snapshot_metadata',
      'DONE',
      '/bin/sh -c printf builder_snapshot_ready',
      'builder_snapshot_ready',
      '## Report\nRecorded snapshot metadata successfully.',
      'Builder snapshot metadata captured.',
      'builder_snapshot_ready',
      {
        startedAtUtc: '2026-04-01T07:00:45Z',
        endedAtUtc: '2026-04-01T07:00:47Z',
        durationSec: 2,
      },
    ),
    [taskKeys.draftPolish]: createTaskRow(
      runDir,
      'group_03',
      'draft-polish-a1',
      taskKeys.draftPolish,
      'draft_polish',
      'workflow[1]/group:builder_parallel_checks/step_2/task:draft_polish',
      'DONE',
      'Tighten the builder launch copy without introducing runtime persona references.',
      'draft_polish started\ndraft_polish done',
      '## Report\nPolished the launch copy and preserved plain persona strings.',
      'Builder launch copy polished.',
      'Builder launches persist local drafts, validate before launch, and hand monitor a concrete snapshot path.',
      {
        startedAtUtc: '2026-04-01T07:00:45Z',
        endedAtUtc: '2026-04-01T07:01:10Z',
        durationSec: 25,
      },
    ),
    [taskKeys.publishSummary]: createTaskRow(
      runDir,
      'group_04',
      'publish-summary-a1',
      taskKeys.publishSummary,
      'publish_summary',
      'workflow[2]/task:publish_summary',
      'DONE',
      'Summarize the builder launch snapshot contract in one paragraph.',
      'publish_summary started\npublish_summary done',
      '## Report\nSummarized the builder launch snapshot contract.',
      'Builder snapshot contract summarized.',
      'Launch snapshots stay runnable as ordinary plans and preserve a concrete path back to the draft lineage.',
      {
        startedAtUtc: '2026-04-01T07:01:15Z',
        endedAtUtc: '2026-04-01T07:01:35Z',
        durationSec: 20,
      },
    ),
  };

  writeCommandResult(tasks[taskKeys.snapshotMetadata], {
    exitCode: 0,
    stdout: 'builder_snapshot_ready',
    stderr: '',
  });

  const runState = {
    runId,
    configPath: planPath,
    workflowLength: 3,
    totalTaskCount: 4,
    totalFailureCount: 0,
    totalRunFailureCount: 0,
    totalLoopIterations: 0,
    runFailureReasons: [],
    cancelRequested: false,
    updatedAtUtc: '2026-04-01T07:01:35Z',
    groups: {
      builder_parallel_checks: {
        groupId: 'builder_parallel_checks',
        status: 'DONE',
        nodePath: 'workflow[1]/group:builder_parallel_checks',
      },
    },
    tasks,
  } satisfies Record<string, unknown>;

  const trace = [
    {
      atUtc: '2026-04-01T07:00:44Z',
      type: 'group_started',
      nodePath: 'workflow[1]/group:builder_parallel_checks',
      detail: { groupId: 'builder_parallel_checks', parallel: true },
    },
    {
      atUtc: '2026-04-01T07:00:47Z',
      type: 'command_completed',
      nodePath: 'workflow[1]/group:builder_parallel_checks/step_1/command:snapshot_metadata',
      detail: { commandId: 'snapshot_metadata', exitCode: 0 },
    },
  ] satisfies Array<Record<string, unknown>>;

  return finalizeFixture({
    scenario: 'builder_snapshot',
    workspaceRoot,
    planPath,
    plan,
    runDir,
    runId,
    runState,
    trace,
    taskKeys,
    supportingFiles: [
      {
        kind: 'command_result',
        title: 'snapshot_metadata command result',
        path: commandResultPath(tasks[taskKeys.snapshotMetadata]),
        purpose: 'Validate deterministic command evidence for the builder-side launch snapshot metadata step.',
      },
      {
        kind: 'report',
        title: 'publish_summary worker report',
        path: String(tasks[taskKeys.publishSummary].reportPath),
        purpose: 'Inspect the summary artifact that the monitor should expose after reopening a builder-generated launch snapshot.',
      },
    ],
    draft: {
      draftId,
      draftDir,
      sourcePlanPath,
      draftPlanPath,
      launchPlanPath: planPath,
    },
  });
}

export function createSampleAgentflowFixture(rootDir?: string): SampleAgentflowFixture<SuccessTaskKeyMap>;
export function createSampleAgentflowFixture(options: { rootDir?: string; scenario?: 'success' }): SampleAgentflowFixture<SuccessTaskKeyMap>;
export function createSampleAgentflowFixture(options: { rootDir?: string; scenario: 'resume_failure' }): SampleAgentflowFixture<ResumeFailureTaskKeyMap>;
export function createSampleAgentflowFixture(options: { rootDir?: string; scenario: 'loop_judge_failure' }): SampleAgentflowFixture<LoopJudgeFailureTaskKeyMap>;
export function createSampleAgentflowFixture(options: { rootDir?: string; scenario: 'builder_snapshot' }): SampleAgentflowFixture<BuilderSnapshotTaskKeyMap>;
export function createSampleAgentflowFixture(arg?: string | SampleFixtureOptions): SampleAgentflowFixture {
  const options = typeof arg === 'string'
    ? { rootDir: arg, scenario: 'success' as const }
    : { rootDir: arg?.rootDir, scenario: arg?.scenario || 'success' };

  if (options.scenario === 'resume_failure') {
    return createResumeFailureFixture(options.rootDir);
  }
  if (options.scenario === 'loop_judge_failure') {
    return createLoopJudgeFailureFixture(options.rootDir);
  }
  if (options.scenario === 'builder_snapshot') {
    return createBuilderSnapshotFixture(options.rootDir);
  }
  return createSuccessFixture(options.rootDir);
}
