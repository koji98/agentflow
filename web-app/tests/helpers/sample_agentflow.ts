import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type SampleTaskKeyMap = {
  setupAgent: string;
  jokeAgent: string;
  echoStatus: string;
  refineAgent: string;
  finalAgent: string;
};

export type SampleAgentflowFixture = {
  workspaceRoot: string;
  planPath: string;
  plan: Record<string, unknown>;
  runDir: string;
  runId: string;
  runState: Record<string, unknown>;
  trace: Array<Record<string, unknown>>;
  taskKeys: SampleTaskKeyMap;
};

function writeText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
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

export function createSampleAgentflowFixture(rootDir?: string): SampleAgentflowFixture {
  const workspaceRoot = rootDir || fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-web-sample-'));
  const tmpRoot = path.join(workspaceRoot, '.tmp');
  const docsDir = path.join(workspaceRoot, 'docs');
  const planPath = path.join(tmpRoot, 'sample-fun-plan.json');
  const runId = `run_sample_fun_${path.basename(workspaceRoot).replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const runDir = path.join(tmpRoot, 'agentflow_runs', runId);

  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  writeText(path.join(workspaceRoot, 'README.md'), '# Sample workspace\n');
  writeText(path.join(docsDir, 'sample-guide.md'), '# Sample guide\n');

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

  writeText(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const taskKeys: SampleTaskKeyMap = {
    setupAgent: 'g01:setup_agent#a1',
    jokeAgent: 'g02:joke_agent#a1',
    echoStatus: 'g03:echo_status#a1',
    refineAgent: 'g04:refine_agent#a1',
    finalAgent: 'g05:final_agent#a1',
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
    [taskKeys.echoStatus]: (() => {
      const row = createTaskRow(
        runDir,
        'group_03',
        'echo-status-a1',
        taskKeys.echoStatus,
        'echo_status',
        'workflow[1]/group:parallel_fun/step_2/command:echo_status',
        'DONE',
        '/bin/sh -c echo pipeline_ready',
        'pipeline_ready',
        '## Report\nCommand completed successfully.',
        'Command emitted pipeline_ready.',
        'pipeline_ready',
      );
      writeText(path.join(path.dirname(String(row.promptPath)), 'command_result.json'), JSON.stringify({
        exitCode: 0,
        stdout: 'pipeline_ready\n',
        stderr: '',
      }, null, 2));
      return row;
    })(),
    [taskKeys.refineAgent]: createTaskRow(
      runDir,
      'group_04',
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
      'group_05',
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

  const runState = {
    runId,
    configPath: planPath,
    workflowLength: 4,
    totalTaskCount: 5,
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

  writeText(path.join(runDir, 'run_state.json'), `${JSON.stringify(runState, null, 2)}\n`);
  writeText(path.join(runDir, 'decision_trace.json'), `${JSON.stringify(trace, null, 2)}\n`);

  return {
    workspaceRoot,
    planPath,
    plan,
    runDir,
    runId,
    runState,
    trace,
    taskKeys,
  };
}
