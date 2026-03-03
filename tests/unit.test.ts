import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.ts';
import { parseArgs } from '../src/lib/args.ts';
import { evaluateContract } from '../src/lib/contracts.ts';
import { buildAiGatePrompt, evaluateGateOutcome, parseGateJsonOutput } from '../src/lib/gates.ts';
import { normalizePlan, resolveConfigPaths } from '../src/lib/plan.ts';
import { buildPrompt } from '../src/lib/prompt.ts';
import { buildProviderCommand } from '../src/lib/providers.ts';
import {
  DEFAULT_WORKTREE_BRANCH_TEMPLATE,
  renderWorktreeBranchName,
  validateWorktreeBranchTemplate,
} from '../src/lib/worktree_branch.ts';
import type { EvaluatorGate, Session } from '../src/lib/types.ts';
import {
  excerptText,
  mapSandboxForCursor,
  normalizeProvider,
  normalizeReasoningEffort,
  readText,
  safeSlug,
} from '../src/lib/utils.ts';

test('--help prints TLDR and points to plan help', async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map((v) => String(v)).join(' '));
  };
  try {
    const exitCode = await main(['--help']);
    assert.equal(exitCode, 0);
  } finally {
    console.log = original;
  }

  const out = logs.join('\n');
  assert.match(out, /TLDR:/);
  assert.match(out, /agentflow --plan-help/);
  assert.match(out, /Show detailed plan schema and all supported keys\./);
  assert.match(out, /--skip-git-repo-check/);
  assert.match(out, /--sandbox <mode>/);
});

test('--plan-help prints detailed plan schema guidance', async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map((v) => String(v)).join(' '));
  };
  try {
    const exitCode = await main(['--plan-help']);
    assert.equal(exitCode, 0);
  } finally {
    console.log = original;
  }

  const out = logs.join('\n');
  assert.match(out, /Plan File Help/);
  assert.match(out, /Mental model:/);
  assert.match(out, /Minimal valid plan \(JSON\):/);
  assert.match(out, /Full schema skeleton \(all keys shown\):/);
  assert.match(out, /Flow nodes:/);
  assert.match(out, /unknown keys hard-fail at every object level/);
  assert.match(out, /Common mistakes \(and actual error text\):/);
  assert.match(out, /--skip-git-repo-check/);
  assert.match(out, /--sandbox <mode>/);
});

test('defaults worktrees and cleanup_worktrees to false', () => {
  const plan = normalizePlan({
    setup: 'x',
    repos: { main: '.' },
    flow: [{ type: 'task', id: 'a', prompt: 'b' }],
  });
  assert.equal(plan.worktrees, false);
  assert.equal(plan.options.cleanupWorktrees, false);
  assert.equal(plan.options.worktreeBranchTemplate, DEFAULT_WORKTREE_BRANCH_TEMPLATE);

  const explicit = normalizePlan({
    setup: 'x',
    repos: { main: '.' },
    worktrees: true,
    options: { cleanup_worktrees: true },
    flow: [{ type: 'task', id: 'a', prompt: 'b' }],
  });
  assert.equal(explicit.worktrees, true);
  assert.equal(explicit.options.cleanupWorktrees, true);
  assert.equal(explicit.options.worktreeBranchTemplate, DEFAULT_WORKTREE_BRANCH_TEMPLATE);
});

test('plan normalization accepts custom worktree_branch_template', () => {
  const plan = normalizePlan({
    setup: 'x',
    repos: { main: '.' },
    worktrees: true,
    options: {
      worktree_branch_template: 'agentflow-{run_id}-r{repo}-g{group}-{kind_short}{node}-a{attempt}',
    },
    flow: [{ type: 'task', id: 'a', prompt: 'b' }],
  });
  assert.equal(
    plan.options.worktreeBranchTemplate,
    'agentflow-{run_id}-r{repo}-g{group}-{kind_short}{node}-a{attempt}',
  );
});

test('plan normalization rejects invalid worktree_branch_template placeholders', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { main: '.' },
        options: { worktree_branch_template: 'agentflow-{run_id}-{bogus}-{group}' },
        flow: [{ type: 'task', id: 'a', prompt: 'b' }],
      }),
    /options\.worktree_branch_template contains unknown placeholder "\{bogus\}"/,
  );
});

test('plan normalization rejects worktree_branch_template missing {group}', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { main: '.' },
        options: { worktree_branch_template: 'agentflow-{run_id}-{node}' },
        flow: [{ type: 'task', id: 'a', prompt: 'b' }],
      }),
    /options\.worktree_branch_template must include "\{group\}"/,
  );
});

test('renderWorktreeBranchName interpolates known placeholders', () => {
  const branch = renderWorktreeBranchName(
    'agentflow-{run_id}-r{repo}-g{group}-{kind_short}{node}-a{attempt}',
    {
      runId: 'run_20260303T123000Z',
      repoAlias: 'main',
      groupIndex: 4,
      nodeId: 'Build API',
      attempt: 2,
      kind: 'task',
    },
  );
  assert.equal(branch, 'agentflow-run-20260303t123000z-rmain-g4-tbuild-api-a2');
});

test('renderWorktreeBranchName sanitizes static template text predictably', () => {
  const branch = renderWorktreeBranchName(
    'Feature Branch/{run_id}/Repo {repo}/g{group}/{kind_short}{node}',
    {
      runId: 'RUN 123',
      repoAlias: 'Main',
      groupIndex: 7,
      nodeId: 'Build API!',
      attempt: 1,
      kind: 'task',
    },
  );
  assert.equal(branch, 'feature-branch/run-123/repo-main/g7/tbuild-api');
});

test('validateWorktreeBranchTemplate rejects unmatched braces', () => {
  assert.throws(
    () => validateWorktreeBranchTemplate('agentflow-{run_id-{group}', 'options.worktree_branch_template'),
    /unmatched opening brace/,
  );
});

test('unknown plan keys fail schema normalization with field-specific errors', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        flow: [{ type: 'task', id: 'a', prompt: 'b' }],
        unexpected_top_level: true,
      }),
    /plan contains unknown key: "unexpected_top_level"\./,
  );

  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        limits: { unknown_limit: true },
        flow: [{ type: 'task', id: 'a', prompt: 'b' }],
      }),
    /limits contains unknown key: "unknown_limit"\./,
  );

  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { main: '.' },
        flow: [{ type: 'task', id: 'a', prompt: 'b', extra_task_field: true }],
      }),
    /flow\[0\] contains unknown key: "extra_task_field"\./,
  );
});

test('flow uses group nodes and requires explicit parallel boolean', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { main: '.' },
        flow: [{ type: 'parallel', id: 'legacy', steps: [] }],
      }),
    /flow\[0\]\.type must be one of: task, command, group, loop\./,
  );

  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { main: '.' },
        flow: [
          {
            type: 'group',
            id: 'missing_parallel',
            steps: [{ type: 'task', id: 'a', prompt: 'b' }],
          },
        ],
      }),
    /flow\[0\]\.parallel must be a boolean\./,
  );
});

test('plan normalization accepts command nodes with required fields', () => {
  const plan = normalizePlan({
    setup: 'command node test',
    repos: { main: '.' },
    flow: [
      {
        type: 'command',
        id: 'validate_child',
        command: '/bin/sh',
        args: ['-c', 'echo ok'],
        cwd: '.',
        timeout_sec: 30,
        allow_failure: true,
      },
    ],
  });

  assert.equal(plan.workflow[0].type, 'command');
  if (plan.workflow[0].type !== 'command') return;
  assert.equal(plan.workflow[0].id, 'validate_child');
  assert.equal(plan.workflow[0].command, '/bin/sh');
  assert.deepEqual(plan.workflow[0].args, ['-c', 'echo ok']);
  assert.equal(plan.workflow[0].cwd, '.');
  assert.equal(plan.workflow[0].timeoutSec, 30);
  assert.equal(plan.workflow[0].allowFailure, true);
});

test('plan normalization rejects context_from on command nodes', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { main: '.' },
        flow: [
          {
            type: 'command',
            id: 'bad_command_context_from',
            command: '/bin/sh',
            args: ['-c', 'echo bad'],
            context_from: ['task_a'],
          },
        ],
      }),
    /flow\[0\] contains unknown key: "context_from"\./,
  );
});

test('plan normalization rejects command node when args is missing', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { main: '.' },
        flow: [
          {
            type: 'command',
            id: 'missing_args',
            command: '/bin/sh',
          },
        ],
      }),
    /flow\[0\]\.args is required and must be an array of strings\./,
  );
});

test('plan normalization rejects command node when args is null', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { main: '.' },
        flow: [
          {
            type: 'command',
            id: 'null_args',
            command: '/bin/sh',
            args: null,
          },
        ],
      }),
    /flow\[0\]\.args is required and must be an array of strings\./,
  );
});

test('plan normalization rejects command node with absolute cwd', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { main: '.' },
        flow: [
          {
            type: 'command',
            id: 'bad_cwd',
            command: '/bin/sh',
            args: ['-c', 'echo bad'],
            cwd: '/tmp',
          },
        ],
      }),
    /flow\[0\]\.cwd must be a relative path\./,
  );
});

test('--sandbox rejects unsupported values', async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    errors.push(args.map((v) => String(v)).join(' '));
  };
  try {
    const exitCode = await main(['--sandbox', 'write-all', '--plan', 'example_plan.json']);
    assert.equal(exitCode, 2);
  } finally {
    console.error = original;
  }

  const out = errors.join('\n');
  assert.match(out, /--sandbox must be one of: read-only, workspace-write, danger-full-access\./);
  assert.match(out, /Usage:/);
});

test('normalizeProvider accepts cursor', () => {
  assert.equal(normalizeProvider('cursor'), 'cursor');
  assert.equal(normalizeProvider('CURSOR'), 'cursor');
  assert.equal(normalizeProvider('codex'), 'codex');
  assert.equal(normalizeProvider(null), null);
  assert.throws(() => normalizeProvider('unsupported'), /provider must be one of/);
});

test('mapSandboxForCursor maps 3-tier modes correctly', () => {
  assert.equal(mapSandboxForCursor('read-only'), null);
  assert.equal(mapSandboxForCursor('workspace-write'), null);
  assert.equal(mapSandboxForCursor('danger-full-access'), 'disabled');
});

test('buildProviderCommand builds correct cursor argv', () => {
  const cmd = buildProviderCommand({
    provider: 'cursor',
    model: 'claude-sonnet',
    reasoningEffort: 'high',
    profile: 'my-profile',
    promptText: 'Do the thing.',
    workspaceCwd: '/tmp/test-workspace',
    lastMessagePath: '/tmp/out.md',
    skipGitRepoCheck: true,
    sandboxMode: 'workspace-write',
  });

  assert.equal(cmd[0], 'agent');
  assert.ok(cmd.includes('-p'));
  assert.ok(cmd.includes('--force'));
  assert.ok(cmd.includes('--output-format'));
  assert.ok(cmd.includes('text'));
  assert.ok(cmd.includes('--model'));
  assert.ok(cmd.includes('claude-sonnet'));
  assert.ok(cmd.includes('--workspace'));
  assert.ok(cmd.includes('/tmp/test-workspace'));
  assert.ok(!cmd.includes('--sandbox'), 'sandbox flag omitted for workspace-write');
  assert.ok(cmd.includes('Do the thing.'));
  assert.ok(!cmd.includes('--profile'), 'cursor should not use --profile');
  assert.ok(!cmd.includes('-c'), 'cursor should not use -c for reasoning');
  assert.ok(!cmd.includes('-o'), 'cursor should not use -o');
});

test('buildProviderCommand builds correct codex argv', () => {
  const cmd = buildProviderCommand({
    provider: 'codex',
    model: 'gpt-5-nano',
    reasoningEffort: 'xhigh',
    profile: 'my-profile',
    promptText: 'Do the thing.',
    workspaceCwd: '/tmp/test-workspace',
    lastMessagePath: '/tmp/out.md',
    skipGitRepoCheck: false,
    sandboxMode: 'workspace-write',
  });

  assert.equal(cmd[0], 'codex');
  assert.ok(cmd.includes('exec'));
  assert.ok(cmd.includes('-o'));
  assert.ok(cmd.includes('-m'));
  assert.ok(cmd.includes('gpt-5-nano'));
  assert.ok(cmd.includes('-c'));
  assert.ok(cmd.includes('model_reasoning_effort=xhigh'));
  assert.ok(cmd.includes('--profile'));
  assert.ok(cmd.includes('my-profile'));
  assert.ok(cmd.includes('-'));
});

test('plan normalization accepts cursor as provider', () => {
  const plan = normalizePlan({
    setup: 'cursor provider test',
    repos: { main: '.' },
    provider: 'cursor',
    model: 'claude-sonnet',
    flow: [{ type: 'task', id: 'a', prompt: 'do it' }],
  });
  assert.equal(plan.provider, 'cursor');

  const taskPlan = normalizePlan({
    setup: 'task level cursor test',
    repos: { main: '.' },
    flow: [{ type: 'task', id: 'b', prompt: 'do it', provider: 'cursor' }],
  });
  assert.equal(taskPlan.workflow[0].type, 'task');
  if (taskPlan.workflow[0].type === 'task') {
    assert.equal(taskPlan.workflow[0].provider, 'cursor');
  }
});

test('setup is optional and prompt omits Background when empty', () => {
  const plan = normalizePlan({
    repos: { main: '.' },
    flow: [{ type: 'task', id: 'a', prompt: 'do it' }],
  });
  assert.equal(plan.setup, '');

  const prompt = buildPrompt({
    persona: null,
    objective: null,
    setup: '',
    task: { taskId: 'a', task: 'do it' },
    contextFiles: [],
    reportPath: '/tmp/report.md',
    summaryPath: '/tmp/summary.md',
    priorTaskSummaries: [],
  });
  assert.ok(!prompt.includes('## Background'), 'empty setup should not produce Background section');
  assert.match(prompt, /do it/);

  const promptWithSetup = buildPrompt({
    persona: null,
    objective: null,
    setup: 'some context',
    task: { taskId: 'b', task: 'do it' },
    contextFiles: [],
    reportPath: '/tmp/report.md',
    summaryPath: '/tmp/summary.md',
    priorTaskSummaries: [],
  });
  assert.match(promptWithSetup, /## Background\nsome context/);
});

test('prompt includes both report and summary paths in completion instructions', () => {
  const prompt = buildPrompt({
    persona: null,
    objective: null,
    setup: 'test',
    task: { taskId: 'a', task: 'do it' },
    contextFiles: [],
    reportPath: '/tmp/report.md',
    summaryPath: '/tmp/summary.md',
    priorTaskSummaries: [],
  });
  assert.match(prompt, /Write a detailed report to: \/tmp\/report\.md/);
  assert.match(prompt, /Write a brief summary to: \/tmp\/summary\.md/);
});

test('prompt includes gate feedback section when provided', () => {
  const prompt = buildPrompt({
    persona: null,
    objective: null,
    setup: '',
    task: { taskId: 'a', task: 'do it' },
    contextFiles: [],
    reportPath: '/tmp/report.md',
    summaryPath: '/tmp/summary.md',
    priorTaskSummaries: [],
    gateFeedbackToAddress: ['Reason: lint is failing on src/lib/file.ts'],
  });
  assert.match(prompt, /## Gate Feedback To Address/);
  assert.match(prompt, /lint is failing/);
});

test('per-task persona overrides plan-level persona in prompt', () => {
  const prompt = buildPrompt({
    persona: 'task-level persona',
    objective: null,
    setup: '',
    task: { taskId: 'a', task: 'do it' },
    contextFiles: [],
    reportPath: '/tmp/report.md',
    summaryPath: '/tmp/summary.md',
    priorTaskSummaries: [],
  });
  assert.match(prompt, /task-level persona/);
  assert.ok(!prompt.includes('senior software engineer'));
});

test('plan normalization accepts context_from on task nodes', () => {
  const plan = normalizePlan({
    setup: 'test',
    repos: { main: '.' },
    flow: [
      { type: 'task', id: 'a', prompt: 'do a' },
      { type: 'task', id: 'b', prompt: 'do b', context_from: ['a'] },
    ],
  });
  const taskB = plan.workflow[1];
  assert.equal(taskB.type, 'task');
  if (taskB.type === 'task') {
    assert.deepEqual(taskB.contextFrom, ['a']);
  }
});

test('plan normalization accepts persona on task nodes', () => {
  const plan = normalizePlan({
    setup: 'test',
    repos: { main: '.' },
    flow: [
      { type: 'task', id: 'a', prompt: 'do a', persona: 'You are a QA engineer.' },
      { type: 'task', id: 'b', prompt: 'do b' },
    ],
  });
  const taskA = plan.workflow[0];
  const taskB = plan.workflow[1];
  assert.equal(taskA.type, 'task');
  assert.equal(taskB.type, 'task');
  if (taskA.type === 'task') {
    assert.equal(taskA.persona, 'You are a QA engineer.');
  }
  if (taskB.type === 'task') {
    assert.equal(taskB.persona, null);
  }
});

test('buildAiGatePrompt uses section-based format', () => {
  const mockSession = {
    plan: { setup: 'test setup', objective: 'test objective' },
    state: { groups: {}, tasks: {} },
  } as Session;
  const gate = {
    type: 'ai' as const,
    id: 'test_gate',
    repo: null,
    prompt: 'evaluate this',
    persona: null,
    provider: null,
    model: null,
    reasoningEffort: null,
    profile: null,
    includeRecentTasks: null,
    scoreThreshold: null,
    timeoutSec: null,
    requiredArtifacts: [],
  };
  const prompt = buildAiGatePrompt(mockSession, gate, 'loop_1', 1, 'post_body');
  assert.match(prompt, /## Loop Metadata/);
  assert.match(prompt, /## Run Setup/);
  assert.match(prompt, /## Objective/);
  assert.match(prompt, /## Gate Instruction/);
  assert.match(prompt, /## Output Format Requirements/);
  assert.ok(!prompt.includes('\\n\\n'), 'should not have literal escaped newlines');
});

test('buildAiGatePrompt omits Run Setup when setup is empty', () => {
  const mockSession = {
    plan: { setup: '', objective: null },
    state: { groups: {}, tasks: {} },
  } as Session;
  const gate = {
    type: 'ai' as const,
    id: 'test_gate',
    repo: null,
    prompt: 'evaluate this',
    persona: null,
    provider: null,
    model: null,
    reasoningEffort: null,
    profile: null,
    includeRecentTasks: null,
    scoreThreshold: null,
    timeoutSec: null,
    requiredArtifacts: [],
  };
  const prompt = buildAiGatePrompt(mockSession, gate, 'loop_1', 1, 'post_body');
  assert.ok(!prompt.includes('## Run Setup'), 'empty setup should not produce Run Setup section');
  assert.match(prompt, /\(not provided\)/);
});

test('buildAiGatePrompt includes gate persona when provided', () => {
  const mockSession = {
    plan: { setup: '', objective: null, persona: 'plan persona' },
    state: { groups: {}, tasks: {} },
  } as Session;
  const gate = {
    type: 'ai' as const,
    id: 'test_gate',
    repo: null,
    prompt: 'evaluate this',
    persona: 'gate persona',
    provider: null,
    model: null,
    reasoningEffort: null,
    profile: null,
    includeRecentTasks: null,
    scoreThreshold: null,
    timeoutSec: null,
    requiredArtifacts: [],
  };
  const prompt = buildAiGatePrompt(mockSession, gate, 'loop_1', 1, 'post_body');
  assert.match(prompt, /## Evaluator Persona/);
  assert.match(prompt, /gate persona/);
  assert.ok(!prompt.includes('plan persona'), 'gate persona should override plan persona');
});

test('buildAiGatePrompt falls back to plan persona when gate persona is missing', () => {
  const mockSession = {
    plan: { setup: '', objective: null, persona: 'plan persona' },
    state: { groups: {}, tasks: {} },
  } as Session;
  const gate = {
    type: 'ai' as const,
    id: 'test_gate',
    repo: null,
    prompt: 'evaluate this',
    persona: null,
    provider: null,
    model: null,
    reasoningEffort: null,
    profile: null,
    includeRecentTasks: null,
    scoreThreshold: null,
    timeoutSec: null,
    requiredArtifacts: [],
  };
  const prompt = buildAiGatePrompt(mockSession, gate, 'loop_1', 1, 'post_body');
  assert.match(prompt, /## Evaluator Persona/);
  assert.match(prompt, /plan persona/);
});

test('parseArgs parses --validate flag', () => {
  const args = parseArgs(['--plan', 'my_plan.json', '--validate']);
  assert.equal(args.validate, true);
  assert.equal(args.planFile, 'my_plan.json');
});

test('parseArgs parses --resume flag with value', () => {
  const args = parseArgs(['--plan', 'my_plan.json', '--resume', 'tmp/runs/run_001']);
  assert.equal(args.resumeDir, 'tmp/runs/run_001');
  assert.equal(args.planFile, 'my_plan.json');
});

test('parseArgs throws when --resume has no value', () => {
  assert.throws(() => parseArgs(['--plan', 'my_plan.json', '--resume']), /--resume requires a value/);
});

// --- evaluateContract ---

test('evaluateContract returns DONE when exit 0 and report exists', () => {
  const result = evaluateContract({ exitCode: 0, timedOut: false, reportExists: true });
  assert.equal(result.status, 'DONE');
  assert.equal(result.reason, null);
});

test('evaluateContract returns FAILED/timed_out when timedOut is true', () => {
  const result = evaluateContract({ exitCode: 0, timedOut: true, reportExists: true });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.reason, 'timed_out');
});

test('evaluateContract returns FAILED/nonzero_exit when exit code is not 0', () => {
  const result = evaluateContract({ exitCode: 1, timedOut: false, reportExists: true });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.reason, 'nonzero_exit');
});

test('evaluateContract returns FAILED/missing_report when report does not exist', () => {
  const result = evaluateContract({ exitCode: 0, timedOut: false, reportExists: false });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.reason, 'missing_report');
});

// --- parseGateJsonOutput ---

test('parseGateJsonOutput parses raw JSON', () => {
  const result = parseGateJsonOutput('{"passed":true,"score":1,"reasons":[]}');
  assert.ok(result);
  assert.equal(result.passed, true);
  assert.equal(result.score, 1);
});

test('parseGateJsonOutput parses fenced markdown JSON', () => {
  const input = 'Some explanation\n```json\n{"passed":false,"score":0.5,"reasons":["needs work"]}\n```\nMore text';
  const result = parseGateJsonOutput(input);
  assert.ok(result);
  assert.equal(result.passed, false);
  assert.equal(result.score, 0.5);
});

test('parseGateJsonOutput extracts inline JSON object from prose', () => {
  const input = 'The evaluation result is {"passed":true,"score":0.9,"reasons":["looks good"]} and that is final.';
  const result = parseGateJsonOutput(input);
  assert.ok(result);
  assert.equal(result.passed, true);
  assert.equal(result.score, 0.9);
});

test('parseGateJsonOutput returns null for empty or non-JSON input', () => {
  assert.equal(parseGateJsonOutput(''), null);
  assert.equal(parseGateJsonOutput('no json here'), null);
  assert.equal(parseGateJsonOutput('   '), null);
});

// --- evaluateGateOutcome ---

test('evaluateGateOutcome passes when passed=true and no threshold', () => {
  const gate = { scoreThreshold: null } as EvaluatorGate;
  const result = evaluateGateOutcome(gate, { passed: true, score: null, reasons: [] });
  assert.equal(result.passed, true);
});

test('evaluateGateOutcome fails when passed=false and no threshold', () => {
  const gate = { scoreThreshold: null } as EvaluatorGate;
  const result = evaluateGateOutcome(gate, { passed: false, score: null, reasons: [] });
  assert.equal(result.passed, false);
  assert.ok(result.reasons.some((r) => r.includes('passed=true not satisfied')));
});

test('evaluateGateOutcome passes when score meets threshold', () => {
  const gate = { scoreThreshold: 0.8 } as EvaluatorGate;
  const result = evaluateGateOutcome(gate, { passed: false, score: 0.9, reasons: [] });
  assert.equal(result.passed, true);
  assert.equal(result.score, 0.9);
});

test('evaluateGateOutcome fails when score is below threshold', () => {
  const gate = { scoreThreshold: 0.8 } as EvaluatorGate;
  const result = evaluateGateOutcome(gate, { passed: true, score: 0.5, reasons: [] });
  assert.equal(result.passed, false);
  assert.ok(result.reasons.some((r) => r.includes('score below score_threshold')));
});

test('evaluateGateOutcome fails when payload is null', () => {
  const gate = { scoreThreshold: null } as EvaluatorGate;
  const result = evaluateGateOutcome(gate, null);
  assert.equal(result.passed, false);
  assert.ok(result.reasons.some((r) => r.includes('not valid JSON')));
});

// --- resolveConfigPaths ---

test('resolveConfigPaths resolves alias: prefix from repo root', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-resolve-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const projectRoot = path.resolve(tmpDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.resolve(projectRoot, 'src.ts'), 'code', 'utf8');

  const planPath = path.resolve(tmpDir, 'plan.json');
  const repoRoots = { main: projectRoot };
  const resolved = resolveConfigPaths(planPath, repoRoots, ['main:src.ts']);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0], path.resolve(projectRoot, 'src.ts'));
});

test('resolveConfigPaths resolves plan: prefix from plan directory', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-resolve-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const planDir = path.resolve(tmpDir, 'plans');
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.resolve(planDir, 'context.md'), 'ctx', 'utf8');

  const planPath = path.resolve(planDir, 'plan.json');
  const repoRoots = { main: tmpDir };
  const resolved = resolveConfigPaths(planPath, repoRoots, ['plan:context.md']);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0], path.resolve(planDir, 'context.md'));
});

test('resolveConfigPaths resolves plain relative paths from plan directory', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-resolve-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.writeFileSync(path.resolve(tmpDir, 'readme.md'), 'hi', 'utf8');
  const planPath = path.resolve(tmpDir, 'plan.json');
  const repoRoots = { main: tmpDir };
  const resolved = resolveConfigPaths(planPath, repoRoots, ['readme.md']);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0], path.resolve(tmpDir, 'readme.md'));
});

test('resolveConfigPaths throws for missing files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-resolve-'));
  const planPath = path.resolve(tmpDir, 'plan.json');
  const repoRoots = { main: tmpDir };
  assert.throws(
    () => resolveConfigPaths(planPath, repoRoots, ['nonexistent.md']),
    /Configured context file\(s\) not found/,
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- safeSlug ---

test('safeSlug converts text to filesystem-safe slug', () => {
  assert.equal(safeSlug('Hello World'), 'hello-world');
  assert.equal(safeSlug('  --special chars!!  '), 'special-chars');
  assert.equal(safeSlug('already-safe'), 'already-safe');
  assert.equal(safeSlug(''), 'x');
  assert.equal(safeSlug('!!!'), 'x');
});

// --- normalizeReasoningEffort ---

test('normalizeReasoningEffort accepts valid values and aliases', () => {
  assert.equal(normalizeReasoningEffort('high'), 'high');
  assert.equal(normalizeReasoningEffort('xhigh'), 'xhigh');
  assert.equal(normalizeReasoningEffort('extra_high'), 'xhigh');
  assert.equal(normalizeReasoningEffort('extra-high'), 'xhigh');
  assert.equal(normalizeReasoningEffort(null), null);
  assert.equal(normalizeReasoningEffort(undefined), null);
  assert.throws(() => normalizeReasoningEffort('invalid'), /reasoning_effort must be one of/);
});

// --- readText / excerptText ---

test('readText reads file contents and returns empty on missing', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-readtext-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const filePath = path.resolve(tmpDir, 'test.txt');
  fs.writeFileSync(filePath, 'hello world', 'utf8');
  assert.equal(readText(filePath), 'hello world');
  assert.equal(readText(path.resolve(tmpDir, 'nope.txt')), '');
});

test('excerptText truncates long files', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-excerpt-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const filePath = path.resolve(tmpDir, 'long.txt');
  fs.writeFileSync(filePath, 'x'.repeat(100), 'utf8');
  const excerpt = excerptText(filePath, 20);
  assert.ok(excerpt.length <= 40);
  assert.ok(excerpt.includes('...[truncated]'));

  const short = excerptText(filePath, 200);
  assert.ok(!short.includes('...[truncated]'));
});

// --- multi-repo validation ---

test('normalizePlan rejects plan with no repos', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        flow: [{ type: 'task', id: 'a', prompt: 'b' }],
      }),
    /plan\.repos must define at least one repository alias\./,
  );
});

test('normalizePlan rejects task with missing repo when multiple repos exist', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { api: '.', web: '../web' },
        flow: [{ type: 'task', id: 'a', prompt: 'b' }],
      }),
    /flow\[0\]\.repo is required when multiple repos are defined\./,
  );
});

test('normalizePlan rejects command with missing repo when multiple repos exist', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { api: '.', web: '../web' },
        flow: [{ type: 'command', id: 'cmd', command: '/bin/sh', args: ['-c', 'echo ok'] }],
      }),
    /flow\[0\]\.repo is required when multiple repos are defined\./,
  );
});

test('normalizePlan rejects task with invalid repo alias', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { api: '.', web: '../web' },
        flow: [{ type: 'task', id: 'a', prompt: 'b', repo: 'nonexistent' }],
      }),
    /flow\[0\]\.repo "nonexistent" does not match any key in repos/,
  );
});

test('normalizePlan rejects command with invalid repo alias', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { api: '.', web: '../web' },
        flow: [{ type: 'command', id: 'cmd', repo: 'nonexistent', command: '/bin/sh', args: ['-c', 'echo ok'] }],
      }),
    /flow\[0\]\.repo "nonexistent" does not match any key in repos/,
  );
});

test('normalizePlan accepts task without repo when single repo', () => {
  const plan = normalizePlan({
    setup: 'x',
    repos: { main: '.' },
    flow: [{ type: 'task', id: 'a', prompt: 'b' }],
  });
  assert.equal(plan.workflow[0].type, 'task');
  if (plan.workflow[0].type === 'task') {
    assert.equal(plan.workflow[0].repo, null);
  }
});

test('normalizePlan stores repo on task when specified', () => {
  const plan = normalizePlan({
    setup: 'x',
    repos: { api: '.', web: '../web' },
    flow: [
      { type: 'task', id: 'a', prompt: 'do a', repo: 'api' },
      { type: 'task', id: 'b', prompt: 'do b', repo: 'web' },
    ],
  });
  assert.equal(plan.workflow[0].type, 'task');
  assert.equal(plan.workflow[1].type, 'task');
  if (plan.workflow[0].type === 'task') assert.equal(plan.workflow[0].repo, 'api');
  if (plan.workflow[1].type === 'task') assert.equal(plan.workflow[1].repo, 'web');
});

test('normalizePlan stores repos map on plan', () => {
  const plan = normalizePlan({
    repos: { api: '.', web: '../web' },
    flow: [
      { type: 'task', id: 'a', prompt: 'do a', repo: 'api' },
    ],
  });
  assert.deepEqual(plan.repos, { api: '.', web: '../web' });
});

test('normalizePlan rejects BLOCKED in limits.retry_on', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { main: '.' },
        limits: { retry_on: ['BLOCKED'] },
        flow: [{ type: 'task', id: 'a', prompt: 'b' }],
      }),
    /limits.retry_on contains unsupported value: BLOCKED/,
  );
});

test('normalizePlan stores loop gate repo and persona when configured', () => {
  const plan = normalizePlan({
    setup: 'x',
    repos: { api: '.', web: '../web' },
    flow: [
      {
        type: 'loop',
        id: 'quality_loop',
        gate: {
          type: 'ai',
          repo: 'web',
          prompt: 'evaluate quality',
          persona: 'You are a strict QA gate.',
        },
        body: [
          { type: 'task', id: 'fix', repo: 'api', prompt: 'fix issues' },
        ],
      },
    ],
  });
  assert.equal(plan.workflow[0].type, 'while');
  if (plan.workflow[0].type !== 'while') return;
  assert.equal(plan.workflow[0].until.repo, 'web');
  assert.equal(plan.workflow[0].until.type, 'ai');
  if (plan.workflow[0].until.type === 'ai') {
    assert.equal(plan.workflow[0].until.persona, 'You are a strict QA gate.');
  }
});

test('normalizePlan rejects loop gate with invalid repo alias', () => {
  assert.throws(
    () =>
      normalizePlan({
        setup: 'x',
        repos: { api: '.', web: '../web' },
        flow: [
          {
            type: 'loop',
            id: 'quality_loop',
            gate: {
              type: 'deterministic',
              repo: 'bad_repo',
              command: 'echo',
              args: ['{"passed":true,"score":1,"reasons":[]}'],
            },
            body: [{ type: 'task', id: 'fix', repo: 'api', prompt: 'fix issues' }],
          },
        ],
      }),
    /flow\[0\]\.gate\.repo "bad_repo" does not match any key in repos/,
  );
});
