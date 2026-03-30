import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGateJsonOutput } from './gates.ts';
import { log, logError } from './log.ts';
import { runCommand } from './process_runner.ts';
import { buildProviderCommand } from './providers.ts';
import type {
  CliArgs,
  Provider,
  ReasoningEffort,
  SandboxMode,
} from './types.ts';
import {
  normalizeProvider,
  normalizeReasoningEffort,
  nowRunId,
  optionalString,
  readText,
} from './utils.ts';

const SANDBOX_MODES = new Set<SandboxMode>([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

interface SupervisorAgentConfig {
  provider: Provider;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  profile: string | null;
  sandboxMode: SandboxMode;
  skipGitRepoCheck: boolean;
}

interface SupervisorConfig {
  profile: string;
  prompts: {
    planner: string;
    planQa: string;
  };
  rubrics: {
    planQa: string;
  };
  thresholds: {
    planQaPassScore: number;
    maxPlannerRevisions: number;
  };
  paths: {
    missionState: string;
    planCandidate: string;
    planRationale: string;
    planScore: string;
    runLedger: string;
    runRoot: string;
    stopFlag: string | null;
  };
  executeApprovedPlan: boolean;
  agents: {
    planner: SupervisorAgentConfig;
    planQa: SupervisorAgentConfig;
  };
}

interface SupervisorRunResult {
  attempt: number;
  approved: boolean;
  score: number | null;
  reasons: string[];
  hardFailures: string[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveMaybeRelative(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDir, value);
}

function parseNumberInRange(
  value: unknown,
  fieldName: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return null;
  const out = Number(value);
  if (!Number.isFinite(out) || out < min || out > max) {
    throw new Error(`${fieldName} must be a number between ${min} and ${max}.`);
  }
  return out;
}

function parsePositiveInteger(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null) return null;
  const out = Number(value);
  if (!Number.isInteger(out) || out <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return out;
}

function parseSandboxMode(value: unknown, fieldName: string): SandboxMode | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim() as SandboxMode;
  if (!SANDBOX_MODES.has(normalized)) {
    throw new Error(
      `${fieldName} must be one of: read-only, workspace-write, danger-full-access.`,
    );
  }
  return normalized;
}

function parseBoolean(value: unknown, fieldName: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean.`);
  }
  return value;
}

function parseAgentConfig(
  value: unknown,
  fallback: SupervisorAgentConfig,
  fieldName: string,
): SupervisorAgentConfig {
  const raw = asObject(value);
  if (!raw) return fallback;
  const provider = normalizeProvider(raw.provider) || fallback.provider;
  const model = optionalString(raw.model) ?? fallback.model;
  const reasoningEffort = normalizeReasoningEffort(raw.reasoning) ?? fallback.reasoningEffort;
  const profile = optionalString(raw.profile) ?? fallback.profile;
  const sandboxMode = parseSandboxMode(raw.sandbox_mode, `${fieldName}.sandbox_mode`) || fallback.sandboxMode;
  const skipGitRepoCheck = parseBoolean(raw.skip_git_repo_check, `${fieldName}.skip_git_repo_check`);
  return {
    provider,
    model,
    reasoningEffort,
    profile,
    sandboxMode,
    skipGitRepoCheck: skipGitRepoCheck ?? fallback.skipGitRepoCheck,
  };
}

function defaultSupervisorConfig(packageRoot: string, cwd: string): SupervisorConfig {
  const stateRoot = path.resolve(cwd, 'state');
  const docsRoot = path.resolve(packageRoot, 'docs', 'supervisor');
  const defaultAgent: SupervisorAgentConfig = {
    provider: 'codex',
    model: 'gpt-5-nano',
    reasoningEffort: 'xhigh',
    profile: null,
    sandboxMode: 'workspace-write',
    skipGitRepoCheck: false,
  };
  return {
    profile: 'default',
    prompts: {
      planner: path.resolve(docsRoot, 'planner.default.md'),
      planQa: path.resolve(docsRoot, 'plan_qa.default.md'),
    },
    rubrics: {
      planQa: path.resolve(docsRoot, 'plan_qa_rubric.default.json'),
    },
    thresholds: {
      planQaPassScore: 0.85,
      maxPlannerRevisions: 4,
    },
    paths: {
      missionState: path.resolve(stateRoot, 'mission_state.json'),
      planCandidate: path.resolve(stateRoot, 'plan_candidate.json'),
      planRationale: path.resolve(stateRoot, 'plan_rationale.md'),
      planScore: path.resolve(stateRoot, 'plan_score.json'),
      runLedger: path.resolve(stateRoot, 'run_ledger.jsonl'),
      runRoot: path.resolve(cwd, 'tmp', 'agentflow_supervisor_runs'),
      stopFlag: path.resolve(stateRoot, 'stop.flag'),
    },
    executeApprovedPlan: true,
    agents: {
      planner: defaultAgent,
      planQa: defaultAgent,
    },
  };
}

function mergeWorkspaceOverrides(
  base: SupervisorConfig,
  workspaceOverride: Record<string, unknown> | null,
  cwd: string,
): SupervisorConfig {
  if (!workspaceOverride) return base;
  const out: SupervisorConfig = {
    ...base,
    prompts: { ...base.prompts },
    rubrics: { ...base.rubrics },
    thresholds: { ...base.thresholds },
    paths: { ...base.paths },
    agents: {
      planner: { ...base.agents.planner },
      planQa: { ...base.agents.planQa },
    },
  };

  out.profile = optionalString(workspaceOverride.profile) || out.profile;

  const prompts = asObject(workspaceOverride.prompts);
  if (prompts) {
    const planner = optionalString(prompts.planner);
    const planQa = optionalString(prompts.plan_qa);
    if (planner) out.prompts.planner = resolveMaybeRelative(cwd, planner);
    if (planQa) out.prompts.planQa = resolveMaybeRelative(cwd, planQa);
  }

  const rubrics = asObject(workspaceOverride.rubrics);
  if (rubrics) {
    const planQa = optionalString(rubrics.plan_qa);
    if (planQa) out.rubrics.planQa = resolveMaybeRelative(cwd, planQa);
  }

  const thresholds = asObject(workspaceOverride.thresholds);
  if (thresholds) {
    const planQaPassScore = parseNumberInRange(
      thresholds.plan_qa_pass_score,
      'thresholds.plan_qa_pass_score',
      0,
      1,
    );
    const maxPlannerRevisions = parsePositiveInteger(
      thresholds.max_planner_revisions,
      'thresholds.max_planner_revisions',
    );
    if (planQaPassScore !== null) out.thresholds.planQaPassScore = planQaPassScore;
    if (maxPlannerRevisions !== null) out.thresholds.maxPlannerRevisions = maxPlannerRevisions;
  }

  const paths = asObject(workspaceOverride.paths);
  if (paths) {
    const missionState = optionalString(paths.mission_state);
    const planCandidate = optionalString(paths.plan_candidate);
    const planRationale = optionalString(paths.plan_rationale);
    const planScore = optionalString(paths.plan_score);
    const runLedger = optionalString(paths.run_ledger);
    const runRoot = optionalString(paths.run_root);
    const stopFlag = paths.stop_flag === null ? null : optionalString(paths.stop_flag);

    if (missionState) out.paths.missionState = resolveMaybeRelative(cwd, missionState);
    if (planCandidate) out.paths.planCandidate = resolveMaybeRelative(cwd, planCandidate);
    if (planRationale) out.paths.planRationale = resolveMaybeRelative(cwd, planRationale);
    if (planScore) out.paths.planScore = resolveMaybeRelative(cwd, planScore);
    if (runLedger) out.paths.runLedger = resolveMaybeRelative(cwd, runLedger);
    if (runRoot) out.paths.runRoot = resolveMaybeRelative(cwd, runRoot);
    if (stopFlag !== undefined) {
      out.paths.stopFlag = stopFlag === null ? null : resolveMaybeRelative(cwd, stopFlag);
    }
  }

  const executeApprovedPlan = parseBoolean(
    workspaceOverride.execute_approved_plan,
    'execute_approved_plan',
  );
  if (executeApprovedPlan !== null) {
    out.executeApprovedPlan = executeApprovedPlan;
  }

  const agents = asObject(workspaceOverride.agents);
  if (agents) {
    out.agents.planner = parseAgentConfig(
      agents.planner,
      out.agents.planner,
      'agents.planner',
    );
    out.agents.planQa = parseAgentConfig(
      agents.plan_qa,
      out.agents.planQa,
      'agents.plan_qa',
    );
  }

  return out;
}

function applyCliOverrides(base: SupervisorConfig, args: CliArgs, cwd: string): SupervisorConfig {
  const out: SupervisorConfig = {
    ...base,
    prompts: { ...base.prompts },
    rubrics: { ...base.rubrics },
    thresholds: { ...base.thresholds },
    paths: { ...base.paths },
    agents: {
      planner: { ...base.agents.planner },
      planQa: { ...base.agents.planQa },
    },
  };
  if (args.supervisorProfile) out.profile = args.supervisorProfile;
  if (args.missionStateFile) out.paths.missionState = resolveMaybeRelative(cwd, args.missionStateFile);
  if (args.sandboxMode) {
    out.agents.planner.sandboxMode = args.sandboxMode;
    out.agents.planQa.sandboxMode = args.sandboxMode;
  }
  if (args.skipGitRepoCheck) {
    out.agents.planner.skipGitRepoCheck = true;
    out.agents.planQa.skipGitRepoCheck = true;
  }
  return out;
}

function renderTemplate(templateText: string, values: Record<string, string>): string {
  return templateText.replace(/\{\{([A-Z0-9_]+)\}\}/g, (full, key: string) => values[key] || full);
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile(filePath: string, label: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const obj = asObject(raw);
    if (!obj) throw new Error(`${label} must be a JSON object.`);
    return obj;
  } catch (error) {
    throw new Error(`Failed to read ${label} at ${filePath}: ${String(error)}`);
  }
}

function writeJsonFile(filePath: string, payload: unknown): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonLine(filePath: string, payload: unknown): void {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function stageOutputText(lastMessagePath: string, stdoutCapturePath: string): string {
  const fromLastMessage = readText(lastMessagePath).trim();
  const fromStdout = readText(stdoutCapturePath).trim();
  if (fromLastMessage && fromLastMessage !== 'Task completed successfully.') return fromLastMessage;
  if (fromStdout) return fromStdout;
  return fromLastMessage;
}

async function runSupervisorAgentStage({
  stage,
  attempt,
  promptText,
  workspaceCwd,
  runDir,
  agent,
}: {
  stage: 'planner' | 'plan_qa';
  attempt: number;
  promptText: string;
  workspaceCwd: string;
  runDir: string;
  agent: SupervisorAgentConfig;
}): Promise<{
  exitCode: number;
  outputText: string;
}> {
  const stageBase = `${stage}_attempt_${String(attempt).padStart(2, '0')}`;
  const lastMessagePath = path.resolve(runDir, `${stageBase}.last_message.txt`);
  const stdoutCapturePath = path.resolve(runDir, `${stageBase}.stdout.txt`);
  const logPath = path.resolve(runDir, `${stageBase}.exec.log`);
  const cmd = buildProviderCommand({
    provider: agent.provider,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    profile: agent.profile,
    promptText,
    workspaceCwd,
    lastMessagePath,
    skipGitRepoCheck: agent.skipGitRepoCheck,
    sandboxMode: agent.sandboxMode,
  });
  log(`[supervisor] ${stage} attempt=${attempt} provider=${agent.provider} model=${agent.model || '(default)'}`);
  const result = await runCommand({
    cmd,
    cwd: workspaceCwd,
    stdinText: promptText,
    logPath,
    dryRun: false,
    timeoutSeconds: null,
    timeoutGraceSeconds: 20,
    useStdin: agent.provider !== 'cursor',
    stdoutCapturePath,
    teeOutput: true,
  });
  return {
    exitCode: result.exitCode,
    outputText: stageOutputText(lastMessagePath, stdoutCapturePath),
  };
}

function normalizePlanQaResult(
  payload: Record<string, unknown> | null,
  threshold: number,
): Omit<SupervisorRunResult, 'attempt'> & { requiredFixCount: number } {
  if (!payload) {
    return {
      approved: false,
      score: null,
      reasons: ['plan_qa output is not valid JSON'],
      hardFailures: ['invalid_plan_qa_output'],
      requiredFixCount: 0,
    };
  }

  const score = typeof payload.score === 'number' ? payload.score : null;
  const passed = payload.passed === true;
  const reasons = Array.isArray(payload.reasons)
    ? payload.reasons.map((v) => String(v))
    : ['plan_qa did not provide reasons'];
  const hardFailures = Array.isArray(payload.hard_failures)
    ? payload.hard_failures.map((v) => String(v))
    : [];
  const requiredFixes = Array.isArray(payload.required_fixes)
    ? payload.required_fixes.filter((v) => Boolean(v && typeof v === 'object'))
    : [];
  const hasHighPriorityFix = requiredFixes.some((fix) => {
    const priority = asObject(fix)?.priority;
    return String(priority || '').toLowerCase() === 'high';
  });
  const approved = passed && score !== null && score >= threshold && hardFailures.length === 0 && !hasHighPriorityFix;
  return {
    approved,
    score,
    reasons,
    hardFailures,
    requiredFixCount: requiredFixes.length,
  };
}

function loadWorkspaceSupervisorConfig(args: CliArgs, cwd: string): Record<string, unknown> | null {
  const explicitPath = args.supervisorConfigFile
    ? resolveMaybeRelative(cwd, args.supervisorConfigFile)
    : null;
  const fallbackPath = path.resolve(cwd, 'agentflow.supervisor.json');
  const configPath = explicitPath || fallbackPath;
  if (!fs.existsSync(configPath)) {
    if (explicitPath) {
      throw new Error(`Supervisor config file not found: ${configPath}`);
    }
    return null;
  }
  const payload = readJsonFile(configPath, 'supervisor config');
  log(`[supervisor] config: ${configPath}`);
  return payload;
}

function assertRequiredFiles(config: SupervisorConfig): void {
  const requiredFiles = [
    { label: 'mission_state', path: config.paths.missionState },
    { label: 'planner prompt', path: config.prompts.planner },
    { label: 'plan_qa prompt', path: config.prompts.planQa },
    { label: 'plan_qa rubric', path: config.rubrics.planQa },
  ];
  for (const required of requiredFiles) {
    if (!fs.existsSync(required.path)) {
      throw new Error(`Required ${required.label} file not found: ${required.path}`);
    }
  }
}

function resolveSupervisorConfig(args: CliArgs): SupervisorConfig {
  const cwd = process.cwd();
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const defaults = defaultSupervisorConfig(packageRoot, cwd);
  const workspaceOverrides = loadWorkspaceSupervisorConfig(args, cwd);
  const merged = mergeWorkspaceOverrides(defaults, workspaceOverrides, cwd);
  const config = applyCliOverrides(merged, args, cwd);
  assertRequiredFiles(config);
  return config;
}

export function validateSupervisor(args: CliArgs): number {
  const config = resolveSupervisorConfig(args);
  log('supervisor config is valid');
  log(`  profile:        ${config.profile}`);
  log(`  mission_state:  ${config.paths.missionState}`);
  log(`  planner_prompt: ${config.prompts.planner}`);
  log(`  plan_qa_prompt: ${config.prompts.planQa}`);
  log(`  plan_qa_rubric: ${config.rubrics.planQa}`);
  log(`  run_root:       ${config.paths.runRoot}`);
  return 0;
}

export async function runSupervisor({
  args,
  runPlan,
}: {
  args: CliArgs;
  runPlan: (argv: string[]) => Promise<number>;
}): Promise<number> {
  const cwd = process.cwd();
  const config = resolveSupervisorConfig(args);

  if (config.paths.stopFlag && fs.existsSync(config.paths.stopFlag)) {
    log(`[supervisor] stop flag detected at ${config.paths.stopFlag}; skipping cycle`);
    return 0;
  }

  fs.mkdirSync(config.paths.runRoot, { recursive: true });
  const supervisorRunId = nowRunId();
  const supervisorRunDir = path.resolve(config.paths.runRoot, supervisorRunId);
  fs.mkdirSync(supervisorRunDir, { recursive: true });
  writeJsonFile(path.resolve(supervisorRunDir, 'supervisor_config_resolved.json'), config);

  log(`[supervisor] run_root: ${supervisorRunDir}`);
  log(`[supervisor] profile: ${config.profile}`);

  let approvedResult: SupervisorRunResult | null = null;

  for (let attempt = 1; attempt <= config.thresholds.maxPlannerRevisions; attempt += 1) {
    if (config.paths.stopFlag && fs.existsSync(config.paths.stopFlag)) {
      log(`[supervisor] stop flag detected at ${config.paths.stopFlag}; aborting remaining attempts`);
      break;
    }

    const plannerTemplate = fs.readFileSync(config.prompts.planner, 'utf8');
    const plannerPrompt = renderTemplate(plannerTemplate, {
      MISSION_STATE_PATH: config.paths.missionState,
      PLAN_SCORE_PATH: config.paths.planScore,
      RUN_LEDGER_PATH: config.paths.runLedger,
      OUTPUT_PLAN_PATH: config.paths.planCandidate,
      OUTPUT_RATIONALE_PATH: config.paths.planRationale,
    });
    const plannerStage = await runSupervisorAgentStage({
      stage: 'planner',
      attempt,
      promptText: plannerPrompt,
      workspaceCwd: cwd,
      runDir: supervisorRunDir,
      agent: config.agents.planner,
    });
    if (plannerStage.exitCode !== 0) {
      logError(`[supervisor] planner failed with exit=${plannerStage.exitCode}`);
      return 1;
    }

    if (!fs.existsSync(config.paths.planCandidate)) {
      const parsedPlan = parseGateJsonOutput(plannerStage.outputText);
      if (parsedPlan && Array.isArray(parsedPlan.flow)) {
        writeJsonFile(config.paths.planCandidate, parsedPlan);
      }
    }
    if (!fs.existsSync(config.paths.planCandidate)) {
      writeJsonFile(config.paths.planScore, {
        attempt,
        approved: false,
        score: null,
        reasons: ['planner did not produce plan_candidate.json'],
        hard_failures: ['missing_plan_candidate'],
      });
      continue;
    }
    if (!fs.existsSync(config.paths.planRationale)) {
      ensureParentDir(config.paths.planRationale);
      fs.writeFileSync(
        config.paths.planRationale,
        `${plannerStage.outputText || '(planner did not provide rationale text)'}\n`,
        'utf8',
      );
    }

    const validateExit = await runPlan(['--plan', config.paths.planCandidate, '--validate']);
    if (validateExit !== 0) {
      writeJsonFile(config.paths.planScore, {
        attempt,
        approved: false,
        score: null,
        reasons: ['plan schema validation failed'],
        hard_failures: ['invalid_plan_schema'],
      });
      continue;
    }

    const planQaTemplate = fs.readFileSync(config.prompts.planQa, 'utf8');
    const planQaPrompt = renderTemplate(planQaTemplate, {
      PLAN_CANDIDATE_PATH: config.paths.planCandidate,
      RUBRIC_PATH: config.rubrics.planQa,
      MISSION_STATE_PATH: config.paths.missionState,
      PLAN_RATIONALE_PATH: config.paths.planRationale,
    });
    const planQaStage = await runSupervisorAgentStage({
      stage: 'plan_qa',
      attempt,
      promptText: planQaPrompt,
      workspaceCwd: cwd,
      runDir: supervisorRunDir,
      agent: config.agents.planQa,
    });
    if (planQaStage.exitCode !== 0) {
      logError(`[supervisor] plan_qa failed with exit=${planQaStage.exitCode}`);
      return 1;
    }

    const planQaPayload = parseGateJsonOutput(planQaStage.outputText);
    const normalized = normalizePlanQaResult(planQaPayload, config.thresholds.planQaPassScore);
    writeJsonFile(config.paths.planScore, {
      attempt,
      approved: normalized.approved,
      score: normalized.score,
      pass_threshold: config.thresholds.planQaPassScore,
      reasons: normalized.reasons,
      hard_failures: normalized.hardFailures,
      required_fix_count: normalized.requiredFixCount,
      raw: planQaPayload,
    });

    if (normalized.approved) {
      approvedResult = {
        attempt,
        approved: true,
        score: normalized.score,
        reasons: normalized.reasons,
        hardFailures: normalized.hardFailures,
      };
      break;
    }
    log(
      `[supervisor] attempt ${attempt} not approved (score=${normalized.score ?? 'null'}, threshold=${config.thresholds.planQaPassScore})`,
    );
  }

  if (!approvedResult) {
    appendJsonLine(config.paths.runLedger, {
      at_utc: new Date().toISOString(),
      supervisor_run_id: supervisorRunId,
      approved: false,
      attempts: config.thresholds.maxPlannerRevisions,
      plan_path: config.paths.planCandidate,
      plan_score_path: config.paths.planScore,
      executed: false,
    });
    logError('[supervisor] no approved plan after max planner revisions');
    return 1;
  }

  let childExitCode = 0;
  if (config.executeApprovedPlan) {
    const childArgs = ['--plan', config.paths.planCandidate];
    if (args.dryRunOverride === true) childArgs.push('--dry-run');
    if (args.skipGitRepoCheck) childArgs.push('--skip-git-repo-check');
    if (args.sandboxMode) childArgs.push('--sandbox', args.sandboxMode);
    childExitCode = await runPlan(childArgs);
  } else {
    log('[supervisor] execute_approved_plan=false; skipping child execution');
  }

  appendJsonLine(config.paths.runLedger, {
    at_utc: new Date().toISOString(),
    supervisor_run_id: supervisorRunId,
    approved: true,
    approval_attempt: approvedResult.attempt,
    score: approvedResult.score,
    plan_path: config.paths.planCandidate,
    plan_score_path: config.paths.planScore,
    executed: config.executeApprovedPlan,
    child_exit_code: config.executeApprovedPlan ? childExitCode : null,
  });

  return childExitCode;
}
