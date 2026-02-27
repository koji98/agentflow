import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { buildProviderCommand } from './providers.ts';
import { readText, safeSlug } from './utils.ts';
import type {
  AiGate,
  DeterministicGate,
  EvaluatorGate,
  EvaluatorOutput,
  Session,
} from './types.ts';

/**
 * Parses evaluator output into a JSON object from plain text, fenced JSON, or inline object text.
 * @param text Raw evaluator output string.
 * @returns Parsed JSON object or `null` when parsing fails.
 */
export function parseGateJsonOutput(text: string): Record<string, unknown> | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // fall through
  }

  const fenced = /```json\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  const firstObj = trimmed.match(/\{[\s\S]*\}/);
  if (firstObj) {
    try {
      return JSON.parse(firstObj[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Applies gate pass/fail rules to parsed evaluator payload.
 * @param gate Evaluator gate definition with thresholds.
 * @param payload Parsed JSON output from the evaluator, or `null` on parse failure.
 * @returns Normalized evaluator output with pass/fail decision.
 */
export function evaluateGateOutcome(
  gate: EvaluatorGate,
  payload: Record<string, unknown> | null,
): EvaluatorOutput {
  if (!payload) {
    return {
      passed: false,
      score: null,
      reasons: ['gate output is not valid JSON'],
      raw: null,
    };
  }
  const basePassed = payload.passed === true;
  const scoreRaw = payload.score;
  const score = typeof scoreRaw === 'number' ? scoreRaw : null;
  const reasons = Array.isArray(payload.reasons) ? payload.reasons.map((v) => String(v)) : [];

  let passed = true;
  const evaluationReasons = [...reasons];
  if (gate.scoreThreshold !== null) {
    if (score === null || score < gate.scoreThreshold) {
      passed = false;
      evaluationReasons.push(`score below score_threshold (${gate.scoreThreshold})`);
    }
  } else if (!basePassed) {
    passed = false;
    evaluationReasons.push('passed=true not satisfied');
  }

  return {
    passed,
    score,
    reasons: evaluationReasons,
    raw: payload,
  };
}

/**
 * Builds the AI gate evaluation prompt, injecting recent loop group/task summaries.
 * @param session Current run session.
 * @param gate AI gate definition with prompt template.
 * @param nodePath Workflow node path for the enclosing loop.
 * @param iteration Current loop iteration number.
 * @param phase Whether the gate runs before or after the loop body.
 * @returns Complete evaluator prompt string.
 */
export function buildAiGatePrompt(
  session: Session,
  gate: AiGate,
  nodePath: string,
  iteration: number,
  phase: 'pre_body' | 'post_body',
): string {
  const groupRows = Object.values(session.state.groups)
    .filter((row) => row.label.startsWith(nodePath))
    .sort((a, b) => a.groupIndex - b.groupIndex);
  const taskRows = Object.values(session.state.tasks)
    .filter((row) => row.nodePath.startsWith(`${nodePath}/`))
    .sort((a, b) => (a.endedAtUtc || '').localeCompare(b.endedAtUtc || ''));
  const recentLimit = gate.includeRecentTasks || 20;
  const recentGroups = groupRows.slice(-recentLimit);
  const recentRows = taskRows.slice(-recentLimit);

  const groupSummary =
    recentGroups.length === 0
      ? '- (none yet in this loop)'
      : recentGroups
          .map(
            (row) =>
              `- group=${row.groupIndex} label=${row.label} status=${row.status} failures=${row.failureCount}`,
          )
          .join('\n');

  const taskSummary =
    recentRows.length === 0
      ? '- (none yet in this loop)'
      : recentRows
          .map(
            (row) =>
              `- ${row.taskId} attempt=${row.attempt} status=${row.status} exit=${row.exitCode ?? ''} report=${row.reportPath}`,
          )
          .join('\n');

  const sections: string[] = [];

  sections.push('You are an evaluator gate for an agent workflow.');

  sections.push('Evaluate whether the loop objective is satisfied.');

  sections.push(
    `## Loop Metadata\n- loop_node_path: ${nodePath}\n- iteration: ${iteration}\n- phase: ${phase}`,
  );

  if (session.plan.setup) {
    sections.push(`## Run Setup\n${session.plan.setup}`);
  }

  sections.push(`## Objective\n${session.plan.objective || '(not provided)'}`);

  sections.push(`## Gate Instruction\n${gate.prompt}`);

  sections.push(`## Recent Loop Group Context\n${groupSummary}`);

  sections.push(`## Recent Loop Task Context\n${taskSummary}`);

  sections.push(
    `## Output Format Requirements\n- Return JSON only.\n- Schema: { "passed": boolean, "score": number, "reasons": string[] }\n- If uncertain, set passed=false and include reasons.`,
  );

  return sections.join('\n\n') + '\n';
}

/**
 * Runs a deterministic evaluator command and normalizes its JSON/text output.
 * @param session Current run session.
 * @param gate Deterministic gate definition with command spec.
 * @param gateDir Directory for gate evaluation artifacts.
 * @param evalBase Filename base for log and JSON output files.
 * @returns Normalized evaluator output.
 */
function runDeterministicGate(
  session: Session,
  gate: DeterministicGate,
  gateDir: string,
  evalBase: string,
): EvaluatorOutput {
  const detDefaultRoot = Object.values(session.paths.repoRoots)[0];
  const logPath = path.resolve(gateDir, `${evalBase}.log`);
  const jsonPath = path.resolve(gateDir, `${evalBase}.json`);
  const cwd = gate.exec.cwd ? path.resolve(detDefaultRoot, gate.exec.cwd) : detDefaultRoot;
  const cmd = [gate.exec.command, ...gate.exec.args];
  const timeoutSec = gate.timeoutSec || gate.exec.timeoutSec || 120;
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 20 * 1024 * 1024,
  });

  const logText = [
    `$ (cd ${JSON.stringify(cwd)} && ${cmd.map((c) => JSON.stringify(c)).join(' ')})`,
    '',
    '--- stdout ---',
    result.stdout || '',
    '',
    '--- stderr ---',
    result.stderr || '',
    '',
    `exit_status=${result.status}`,
    `signal=${result.signal || ''}`,
    `error=${result.error ? String(result.error) : ''}`,
  ].join('\n');
  fs.writeFileSync(logPath, logText, 'utf8');

  let out: EvaluatorOutput;
  if (result.error) {
    out = { passed: false, score: null, reasons: [`gate error: ${String(result.error)}`], raw: null };
  } else if (result.status !== 0) {
    out = { passed: false, score: null, reasons: [`gate non-zero exit: ${result.status}`], raw: null };
  } else {
    const parsed = parseGateJsonOutput(String(result.stdout || ''));
    out = evaluateGateOutcome(gate, parsed);
  }
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

/**
 * Runs an AI evaluator gate through provider CLI and normalizes parsed JSON output.
 * @param session Current run session.
 * @param gate AI gate definition with prompt and provider overrides.
 * @param nodePath Workflow node path for the enclosing loop.
 * @param iteration Current loop iteration number.
 * @param phase Whether the gate runs before or after the loop body.
 * @param gateDir Directory for gate evaluation artifacts.
 * @param evalBase Filename base for log and JSON output files.
 * @returns Normalized evaluator output.
 */
function runAiGate(
  session: Session,
  gate: AiGate,
  nodePath: string,
  iteration: number,
  phase: 'pre_body' | 'post_body',
  gateDir: string,
  evalBase: string,
): EvaluatorOutput {
  const provider = gate.provider || session.plan.provider;
  const model = gate.model || session.plan.model;

  if (provider !== 'codex' && provider !== 'cursor') {
    const out: EvaluatorOutput = {
      passed: false,
      score: null,
      reasons: [`ai gate provider '${provider}' is not implemented`],
      raw: null,
    };
    fs.writeFileSync(path.resolve(gateDir, `${evalBase}.json`), JSON.stringify(out, null, 2), 'utf8');
    return out;
  }

  const aiDefaultRoot = Object.values(session.paths.repoRoots)[0];
  const messagePath = path.resolve(gateDir, `${evalBase}.last_message.md`);
  const logPath = path.resolve(gateDir, `${evalBase}.log`);
  const jsonPath = path.resolve(gateDir, `${evalBase}.json`);
  const prompt = buildAiGatePrompt(session, gate, nodePath, iteration, phase);
  const timeoutSec = gate.timeoutSec || 120;

  const cmd = buildProviderCommand({
    provider,
    model,
    reasoningEffort: gate.reasoningEffort || session.plan.reasoningEffort,
    profile: gate.profile || session.plan.profile,
    promptText: prompt,
    workspaceCwd: aiDefaultRoot,
    lastMessagePath: messagePath,
    skipGitRepoCheck: session.plan.options.skipGitRepoCheck,
    sandboxMode: session.plan.options.sandboxMode,
  });

  const useStdin = provider === 'codex';
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: aiDefaultRoot,
    input: useStdin ? prompt : undefined,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 30 * 1024 * 1024,
  });

  const logText = [
    `$ (cd ${JSON.stringify(aiDefaultRoot)} && ${cmd.map((c) => JSON.stringify(c)).join(' ')})`,
    '',
    '--- stdout ---',
    result.stdout || '',
    '',
    '--- stderr ---',
    result.stderr || '',
    '',
    `exit_status=${result.status}`,
    `signal=${result.signal || ''}`,
    `error=${result.error ? String(result.error) : ''}`,
  ].join('\n');
  fs.writeFileSync(logPath, logText, 'utf8');

  if (provider === 'cursor' && result.stdout) {
    fs.writeFileSync(messagePath, result.stdout, 'utf8');
  }

  let out: EvaluatorOutput;
  if (result.error) {
    out = { passed: false, score: null, reasons: [`ai gate error: ${String(result.error)}`], raw: null };
  } else if (result.status !== 0) {
    out = { passed: false, score: null, reasons: [`ai gate non-zero exit: ${result.status}`], raw: null };
  } else {
    const text = readText(messagePath) || String(result.stdout || '');
    const parsed = parseGateJsonOutput(text);
    out = evaluateGateOutcome(gate, parsed);
  }
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

/**
 * Evaluates a while gate (deterministic or AI) and returns normalized evaluator output.
 * @param session Current run session.
 * @param gate Evaluator gate definition (deterministic or AI).
 * @param nodePath Workflow node path for the enclosing loop.
 * @param iteration Current loop iteration number.
 * @param phase Whether the gate runs before or after the loop body.
 * @returns Normalized evaluator output with pass/fail and optional score.
 */
export function evaluateGate(
  session: Session,
  gate: EvaluatorGate,
  nodePath: string,
  iteration: number,
  phase: 'pre_body' | 'post_body',
): EvaluatorOutput {
  if (session.dryRun) {
    return {
      passed: phase === 'post_body',
      score: phase === 'post_body' ? 1 : 0,
      reasons: [`dry_run simulated ${phase}`],
      raw: { simulated: true, phase },
    };
  }

  const defaultRoot = Object.values(session.paths.repoRoots)[0];
  const missingArtifacts: string[] = [];
  for (const artifact of gate.requiredArtifacts) {
    const artifactPath = path.isAbsolute(artifact)
      ? path.resolve(artifact)
      : path.resolve(defaultRoot, artifact);
    if (!fs.existsSync(artifactPath)) missingArtifacts.push(artifact);
  }
  if (missingArtifacts.length > 0) {
    return {
      passed: false,
      score: null,
      reasons: [`missing required artifacts: ${missingArtifacts.join(', ')}`],
      raw: { missingArtifacts },
    };
  }

  const evalDir = path.resolve(session.paths.runRoot, 'evaluations', safeSlug(gate.id));
  const evalBase = `iter_${String(iteration).padStart(2, '0')}_${phase}`;
  fs.mkdirSync(evalDir, { recursive: true });

  if (gate.type === 'deterministic') {
    return runDeterministicGate(session, gate, evalDir, evalBase);
  }
  return runAiGate(session, gate, nodePath, iteration, phase, evalDir, evalBase);
}
