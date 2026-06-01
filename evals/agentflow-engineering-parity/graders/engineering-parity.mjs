import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
const DEFAULT_CODEX_TIMEOUT_MS = 600000;
const DEFAULT_JUDGE_TIMEOUT_MS = 300000;

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function walkFiles(root, predicate, acc = []) {
  if (!existsSync(root)) {
    return acc;
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(path, predicate, acc);
    } else if (predicate(path)) {
      acc.push(path);
    }
  }

  return acc;
}

function findNested(value, key, matches = []) {
  if (!value || typeof value !== "object") {
    return matches;
  }

  if (Object.hasOwn(value, key)) {
    matches.push(value[key]);
  }

  for (const child of Object.values(value)) {
    findNested(child, key, matches);
  }

  return matches;
}

function assertion(id, passed, evidence) {
  return { id, passed, ...(evidence ? { evidence } : {}) };
}

function runProcess(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    shell: options.shell ?? false,
    timeout: options.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
    env: {
      ...process.env,
      ...(options.env ?? {})
    }
  });

  return {
    command,
    args,
    cwd: options.cwd,
    exit_code: typeof result.status === "number" ? result.status : 1,
    timed_out: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    duration_ms: Date.now() - startedAt,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : undefined
  };
}

export function materializeWorkspace(options) {
  rmSync(options.destination, { recursive: true, force: true });
  mkdirSync(dirname(options.destination), { recursive: true });
  cpSync(options.sourceRepo, options.destination, { recursive: true, verbatimSymlinks: true });
  rmSync(join(options.destination, ".git"), { recursive: true, force: true });

  if (options.initGit !== false) {
    runProcess("git", ["init"], { cwd: options.destination });
    runProcess("git", ["config", "user.email", "agentflow@example.com"], { cwd: options.destination });
    runProcess("git", ["config", "user.name", "Agentflow Engineering Parity"], { cwd: options.destination });
    runProcess("git", ["add", "."], { cwd: options.destination });
    runProcess("git", ["commit", "-m", "engineering parity fixture init"], { cwd: options.destination });
  }

  return options.destination;
}

function parseStatusPaths(status) {
  return status
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^.* -> /u, ""))
    .sort();
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

export function globMatches(pattern, file) {
  if (pattern === file) {
    return true;
  }

  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegex(char);
    }
  }
  const regex = new RegExp(`^${source}$`, "u");
  return regex.test(file);
}

function anyPatternMatches(patterns, file) {
  return patterns.some((pattern) => globMatches(pattern, file));
}

function runValidationCommands(workspace, commands) {
  return commands.map((command) => runProcess(command, [], {
    cwd: workspace,
    shell: true,
    timeout_ms: DEFAULT_COMMAND_TIMEOUT_MS
  }));
}

function captureGitState(workspace) {
  const status = runProcess("git", ["status", "--short"], { cwd: workspace });
  const diffNameOnly = runProcess("git", ["diff", "--name-only"], { cwd: workspace });
  const diff = runProcess("git", ["diff", "--"], { cwd: workspace });
  const changedFiles = Array.from(new Set([
    ...parseStatusPaths(status.stdout),
    ...diffNameOnly.stdout.split(/\r?\n/u).filter(Boolean)
  ])).sort();

  return {
    status_short: status.stdout,
    changed_files: changedFiles,
    diff: diff.stdout,
    diff_excerpt: diff.stdout.slice(0, 12000)
  };
}

function checkExpectedSubstrings(workspace, checks = []) {
  return checks.map((check) => {
    const filePath = join(workspace, check.path);
    const content = readTextIfExists(filePath);
    const passed = content.includes(check.contains);
    return {
      path: check.path,
      contains: check.contains,
      passed
    };
  });
}

export function collectWorkspaceResult(options) {
  const validation = runValidationCommands(options.workspace, options.oracle.validation_commands ?? []);
  const git = captureGitState(options.workspace);
  const requiredChangedFiles = options.oracle.required_changed_files ?? [];
  const allowedChangedGlobs = options.oracle.allowed_changed_globs ?? [];
  const forbiddenChangedGlobs = options.oracle.forbidden_changed_globs ?? [];
  const expectedSubstrings = checkExpectedSubstrings(options.workspace, options.oracle.expected_file_substrings ?? []);
  const forbiddenChanges = git.changed_files.filter((file) => anyPatternMatches(forbiddenChangedGlobs, file));
  const outOfScopeChanges = allowedChangedGlobs.length === 0
    ? []
    : git.changed_files.filter((file) => !anyPatternMatches(allowedChangedGlobs, file));
  const missingRequiredChanges = requiredChangedFiles.filter((file) => !git.changed_files.includes(file));
  const failedValidation = validation.filter((entry) => entry.exit_code !== 0 || entry.timed_out);
  const missingSubstrings = expectedSubstrings.filter((entry) => !entry.passed);
  const passed =
    failedValidation.length === 0 &&
    forbiddenChanges.length === 0 &&
    outOfScopeChanges.length === 0 &&
    missingRequiredChanges.length === 0 &&
    missingSubstrings.length === 0;

  return {
    label: options.label,
    workspace: options.workspace,
    passed,
    validation,
    git,
    checks: {
      forbidden_changes: forbiddenChanges,
      out_of_scope_changes: outOfScopeChanges,
      missing_required_changes: missingRequiredChanges,
      expected_substrings: expectedSubstrings,
      missing_substrings: missingSubstrings
    },
    handoff: options.handoff ?? ""
  };
}

export function buildDirectCodexPrompt(taskText) {
  return [
    "You are in a local engineering fixture repository.",
    "Read task.md, implement the requested change, run the validation command named in the task, and return a concise handoff.",
    "The handoff should list changed files, validation commands/results, and remaining risks.",
    "Do not modify task.md. Do not use network access.",
    "",
    "Task:",
    taskText.trim()
  ].join("\n");
}

export function supportsCodexGoal(binary) {
  const result = runProcess(binary, ["exec", "--help"], { timeout_ms: 5000 });
  return result.exit_code === 0 && /(?:^|\s)--goal(?:\s|,|$)/u.test(result.stdout);
}

export function runDirectCodexBaseline(options) {
  const workspace = join(options.outputDir, options.label, "workspace");
  const lastMessagePath = join(options.outputDir, options.label, "last-message.txt");
  const promptPath = join(options.outputDir, options.label, "prompt.md");
  materializeWorkspace({ sourceRepo: options.sourceRepo, destination: workspace });
  const taskText = readTextIfExists(join(workspace, "task.md"));
  const prompt = buildDirectCodexPrompt(taskText);
  mkdirSync(dirname(lastMessagePath), { recursive: true });
  writeFileSync(promptPath, prompt, "utf8");

  const args = [
    "--cd",
    workspace,
    "--sandbox",
    "workspace-write",
    "exec",
    "--output-last-message",
    lastMessagePath
  ];

  if (options.goalMode) {
    args.push(
      "--goal",
      [
        "Complete the local engineering task in task.md.",
        "",
        "Acceptance criteria:",
        "- Requested tests pass.",
        "- Changes stay in scope.",
        "- Final handoff names changed files and validation evidence."
      ].join("\n")
    );
  }

  args.push("-");
  const execution = runProcess(options.binary, args, {
    input: prompt,
    timeout_ms: options.timeout_ms ?? DEFAULT_CODEX_TIMEOUT_MS
  });
  const lastMessage = readTextIfExists(lastMessagePath) || execution.stdout;
  const workspaceResult = collectWorkspaceResult({
    label: options.label,
    workspace,
    oracle: options.oracle,
    handoff: lastMessage
  });
  const payload = {
    label: options.label,
    command: options.binary,
    args,
    exit_code: execution.exit_code,
    timed_out: execution.timed_out,
    duration_ms: execution.duration_ms,
    stdout_excerpt: execution.stdout.slice(0, 2000),
    stderr_excerpt: execution.stderr.slice(0, 4000),
    last_message: lastMessage,
    workspace_result: workspaceResult
  };
  writeJson(join(options.outputDir, `${options.label}.json`), payload);
  return payload;
}

function sanitizeJudgeText(text) {
  return String(text ?? "")
    .replace(/agentflow/giu, "candidate")
    .replace(/direct\s+codex/giu, "candidate")
    .replace(/direct-codex/giu, "candidate");
}

function candidateFromResult(result) {
  return {
    validation_passed: result.passed,
    validation: result.validation.map((entry) => ({
      command: entry.command,
      exit_code: entry.exit_code,
      timed_out: entry.timed_out,
      stdout_excerpt: sanitizeJudgeText(entry.stdout).slice(0, 2000),
      stderr_excerpt: sanitizeJudgeText(entry.stderr).slice(0, 2000)
    })),
    changed_files: result.git.changed_files,
    diff_excerpt: sanitizeJudgeText(result.git.diff_excerpt).slice(0, 12000),
    handoff_excerpt: sanitizeJudgeText(result.handoff).slice(0, 4000),
    checks: result.checks
  };
}

function stableHash(value) {
  let hash = 0;
  for (const char of value) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

export function buildPairwiseJudgePacket(options) {
  const agentflowCandidate = candidateFromResult(options.agentflow);
  const directCandidate = candidateFromResult(options.direct);
  const agentflowIsA = stableHash(`${options.scenarioId}:${options.trialId}`) % 2 === 0;
  const candidateA = agentflowIsA ? agentflowCandidate : directCandidate;
  const candidateB = agentflowIsA ? directCandidate : agentflowCandidate;
  const mapping = {
    A: agentflowIsA ? "agentflow" : "direct-codex",
    B: agentflowIsA ? "direct-codex" : "agentflow"
  };
  const judgePacket = {
    task: options.taskText,
    quality_anchors: options.oracle.quality_anchors ?? [],
    candidate_a: candidateA,
    candidate_b: candidateB,
    instructions: [
      "Choose the better implementation attempt.",
      "Validation failures and out-of-scope edits are blockers.",
      "If implementation quality is tied, prefer better evidence and handoff quality."
    ]
  };

  return { judge_packet: judgePacket, mapping };
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }

  const match = trimmed.match(/\{[\s\S]*\}/u);
  if (!match) {
    throw new Error("Judge output did not contain a JSON object.");
  }
  return JSON.parse(match[0]);
}

export function runPairwiseJudge(options) {
  const packetPath = join(options.outputDir, "pairwise-judge-packet.json");
  const responsePath = join(options.outputDir, "pairwise-judge-response.txt");
  writeJson(packetPath, options.judgePacket);

  const prompt = [
    "You are an implementation quality judge.",
    "Read pairwise-judge-packet.json in the current directory.",
    "Return only strict JSON with keys preferred_candidate, scores, rationale, and blockers.",
    "preferred_candidate must be \"A\", \"B\", or \"tie\".",
    "scores must contain integer 1-5 quality scores for A and B.",
    "rationale must be short and evidence-backed.",
    "blockers must be an array of short strings.",
    "Do not mention Agentflow, direct Codex, variant names, or hidden mapping labels."
  ].join("\n");
  const execution = runProcess(options.binary, [
    "--cd",
    options.outputDir,
    "--sandbox",
    "read-only",
    "exec",
    "--output-last-message",
    responsePath,
    "-"
  ], {
    input: prompt,
    timeout_ms: options.timeout_ms ?? DEFAULT_JUDGE_TIMEOUT_MS
  });
  const responseText = readTextIfExists(responsePath) || execution.stdout;
  let parsed;
  let parseError;

  try {
    parsed = extractJsonObject(responseText);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  const payload = {
    exit_code: execution.exit_code,
    timed_out: execution.timed_out,
    stdout_excerpt: execution.stdout.slice(0, 2000),
    stderr_excerpt: execution.stderr.slice(0, 2000),
    response: responseText,
    parsed,
    parse_error: parseError
  };
  writeJson(join(options.outputDir, "pairwise-judge-result.json"), payload);
  return payload;
}

export function buildParityVerdict(options) {
  const directPassed = options.direct.workspace_result.passed && options.direct.exit_code === 0;
  const agentflowPassed = options.agentflow.passed;
  const agentflowOutOfScope = options.agentflow.checks.out_of_scope_changes.length > 0 ||
    options.agentflow.checks.forbidden_changes.length > 0;
  const blockers = [];

  if (!agentflowPassed) {
    blockers.push("Agentflow failed deterministic implementation checks.");
  }

  if (directPassed && !agentflowPassed) {
    blockers.push("Direct Codex passed deterministic checks while Agentflow did not.");
  }

  if (agentflowOutOfScope) {
    blockers.push("Agentflow changed files outside the allowed task scope.");
  }

  const parsedJudge = options.pairwiseJudge?.parsed;
  let pairwise = {
    available: Boolean(parsedJudge),
    agentflow_score: null,
    direct_score: null,
    preferred: null,
    passed: false
  };

  if (parsedJudge) {
    const scoreA = Number(parsedJudge.scores?.A);
    const scoreB = Number(parsedJudge.scores?.B);
    const agentflowLabel = Object.entries(options.mapping).find((entry) => entry[1] === "agentflow")?.[0];
    const directLabel = Object.entries(options.mapping).find((entry) => entry[1] === "direct-codex")?.[0];
    const agentflowScore = agentflowLabel === "A" ? scoreA : scoreB;
    const directScore = directLabel === "A" ? scoreA : scoreB;
    const preferredMapped = parsedJudge.preferred_candidate === "tie"
      ? "tie"
      : options.mapping[parsedJudge.preferred_candidate] ?? "unknown";
    pairwise = {
      available: true,
      agentflow_score: Number.isFinite(agentflowScore) ? agentflowScore : null,
      direct_score: Number.isFinite(directScore) ? directScore : null,
      preferred: preferredMapped,
      passed: Number.isFinite(agentflowScore) && Number.isFinite(directScore) && agentflowScore >= directScore
    };

    if (!pairwise.passed) {
      blockers.push("Pairwise quality judge scored Agentflow below direct Codex.");
    }
  } else {
    blockers.push(`Pairwise quality judge failed: ${options.pairwiseJudge?.parse_error ?? "missing result"}`);
  }

  const verdict = {
    passed: blockers.length === 0,
    blockers,
    direct_passed: directPassed,
    agentflow_passed: agentflowPassed,
    pairwise
  };
  writeJson(join(options.outputDir, "parity-verdict.json"), verdict);
  return verdict;
}

export function detectPromptDiagnostics(options) {
  const promptEntries = Array.isArray(options.agentflowPrompts)
    ? options.agentflowPrompts
    : [{ path: "agentflow-prompt", content: options.agentflowPrompt ?? "" }];
  const firstPrompt = promptEntries[0]?.content ?? "";
  const combinedPrompt = promptEntries.map((entry) => entry.content ?? "").join("\n\n--- prompt boundary ---\n\n");
  const directPrompt = options.directPrompt ?? "";
  const neutralTask = options.taskText ?? "";
  const noisyPhrases = [
    "managed pattern",
    "managed workflow",
    "runtime coordinator",
    "graph template",
    "native parity",
    "direct codex baseline",
    "private helper node",
    "public artifact",
    "public artifact shape",
    "downstream graph node"
  ];
  const lowerPrompt = combinedPrompt.toLowerCase();
  const diagnostics = {
    neutral_task_length: neutralTask.length,
    direct_prompt_length: directPrompt.length,
    agentflow_prompt_length: firstPrompt.length,
    agentflow_combined_prompt_length: combinedPrompt.length,
    agentflow_prompt_count: promptEntries.length,
    agentflow_prompt_paths: promptEntries.map((entry) => entry.path),
    agentflow_has_task_contract: combinedPrompt.includes("task.md") && /engineering change|requested engineering change|requested implementation change/iu.test(combinedPrompt),
    agentflow_has_orient_refresh: combinedPrompt.includes("af orient"),
    noisy_sections: noisyPhrases.filter((phrase) => lowerPrompt.includes(phrase)),
    missing_task_intent: !firstPrompt.includes("complete the requested engineering change"),
    prompt_bloat: promptEntries.some((entry) => (entry.content ?? "").length > 4200),
    failure_taxonomy: []
  };

  if (diagnostics.prompt_bloat) {
    diagnostics.failure_taxonomy.push("prompt bloat");
  }
  if (diagnostics.missing_task_intent) {
    diagnostics.failure_taxonomy.push("task contract distortion");
  }
  if (diagnostics.noisy_sections.length > 0) {
    diagnostics.failure_taxonomy.push("Graph/Agentflow meta leakage");
  }

  return diagnostics;
}

function loadAgentflowPrompt(runRoot) {
  const promptPaths = walkFiles(join(runRoot, "nodes"), (path) => path.endsWith("/agent/prompt.md"));
  const prompts = promptPaths.map((path) => ({
    path,
    content: readTextIfExists(path)
  }));
  return {
    paths: promptPaths,
    prompts,
    first_prompt: prompts[0]?.content ?? ""
  };
}

function loadNativeHarnessRecords(runRoot) {
  const resultPaths = walkFiles(join(runRoot, "nodes"), (path) => path.endsWith("/runtime/result.json"));
  const results = resultPaths.map((path) => readJson(path));
  return {
    results,
    records: results.flatMap((entry) => findNested(entry, "native_harness"))
  };
}

function loadAgentflowHandoff(tracePacket) {
  const artifact = tracePacket.artifacts.find((entry) => entry.name === "handoff");
  if (typeof artifact?.content === "string") {
    return artifact.content;
  }
  if (typeof artifact?.path === "string" && existsSync(artifact.path)) {
    return readTextIfExists(artifact.path);
  }
  return "";
}

function scenarioDirectory(suiteDir, scenarioId) {
  return join(suiteDir, "scenarios", scenarioId);
}

function loadScenarioSourceRepo(suiteDir, scenarioId) {
  const scenarioJson = readJson(join(scenarioDirectory(suiteDir, scenarioId), "scenario.json"));
  const scenarioDir = scenarioDirectory(suiteDir, scenarioId);
  return join(scenarioDir, scenarioJson.environment.repo);
}

function buildOutputSummary(options) {
  return {
    passed: options.verdict.passed,
    score: options.verdict.passed ? 5 : 1,
    summary: options.verdict.passed
      ? "Agentflow matched or beat direct Codex on the engineering parity task."
      : `Engineering parity failed: ${options.verdict.blockers.join("; ")}`,
    assertions: options.assertions,
    metrics: {
      direct_codex_passed: options.direct.workspace_result.passed && options.direct.exit_code === 0,
      codex_goal_supported: options.codexGoalSupported,
      direct_codex_goal_passed: options.directGoal
        ? options.directGoal.workspace_result.passed && options.directGoal.exit_code === 0
        : null,
      agentflow_prompt_length: options.promptDiagnostics.agentflow_prompt_length,
      direct_prompt_length: options.promptDiagnostics.direct_prompt_length,
      agentflow_changed_files: options.agentflow.git.changed_files.length,
      direct_changed_files: options.direct.workspace_result.git.changed_files.length,
      pairwise: options.verdict.pairwise
    }
  };
}

export function runEngineeringParityCriterion(env = process.env, suiteDir = process.cwd()) {
  const scenarioId = env.AGENTFLOW_EVAL_SCENARIO_ID;
  const trialId = env.AGENTFLOW_EVAL_TRIAL_ID;
  const outputDir = env.AGENTFLOW_EVAL_OUTPUT_DIR;
  const runRoot = env.AGENTFLOW_EVAL_RUN_ROOT;
  const tracePacketFile = env.AGENTFLOW_EVAL_TRACE_PACKET_FILE;
  const codexBinary = env.AGENTFLOW_CODEX_CLI_BIN || "codex";

  if (!scenarioId || !trialId || !outputDir || !runRoot || !tracePacketFile) {
    throw new Error("Missing Agentflow eval criterion environment.");
  }

  const scenarioDir = scenarioDirectory(suiteDir, scenarioId);
  const sourceRepo = loadScenarioSourceRepo(suiteDir, scenarioId);
  const oracle = readJson(join(scenarioDir, "oracle.json"));
  const tracePacket = readJson(tracePacketFile);
  const trialRoot = dirname(dirname(outputDir));
  const agentflowWorkspace = join(trialRoot, "workspace", "repo");
  const taskText = readTextIfExists(join(sourceRepo, "task.md"));
  const promptInfo = loadAgentflowPrompt(runRoot);
  const nativeInfo = loadNativeHarnessRecords(runRoot);
  const agentflowHandoff = loadAgentflowHandoff(tracePacket);
  const agentflowResult = collectWorkspaceResult({
    label: "agentflow",
    workspace: agentflowWorkspace,
    oracle,
    handoff: agentflowHandoff
  });
  const direct = runDirectCodexBaseline({
    binary: codexBinary,
    sourceRepo,
    outputDir,
    label: "direct-codex",
    oracle
  });
  const codexGoalSupported = supportsCodexGoal(codexBinary);
  const directGoal = codexGoalSupported
    ? runDirectCodexBaseline({
        binary: codexBinary,
        sourceRepo,
        outputDir,
        label: "direct-codex-goal",
        oracle,
        goalMode: true
      })
    : undefined;
  const directPrompt = readTextIfExists(join(outputDir, "direct-codex", "prompt.md"));
  const promptDiagnostics = detectPromptDiagnostics({
    taskText,
    directPrompt,
    agentflowPrompt: promptInfo.first_prompt,
    agentflowPrompts: promptInfo.prompts
  });
  writeJson(join(outputDir, "agentflow-prompts.json"), promptInfo.prompts);
  writeJson(join(outputDir, "prompt-diagnostics.json"), promptDiagnostics);

  const comparisonPacket = {
    scenario_id: scenarioId,
    trial_id: trialId,
    task: taskText,
    oracle: {
      validation_commands: oracle.validation_commands,
      required_changed_files: oracle.required_changed_files,
      allowed_changed_globs: oracle.allowed_changed_globs,
      forbidden_changed_globs: oracle.forbidden_changed_globs,
      quality_anchors: oracle.quality_anchors
    },
    agentflow: agentflowResult,
    direct_codex: direct,
    direct_codex_goal: directGoal,
    native_harness_records: nativeInfo.records
  };
  writeJson(join(outputDir, "comparison-packet.json"), comparisonPacket);

  const pairwisePacket = buildPairwiseJudgePacket({
    scenarioId,
    trialId,
    taskText,
    oracle,
    agentflow: agentflowResult,
    direct: direct.workspace_result
  });
  writeJson(join(outputDir, "pairwise-judge-mapping.json"), pairwisePacket.mapping);
  const pairwiseJudge = runPairwiseJudge({
    binary: codexBinary,
    outputDir,
    judgePacket: pairwisePacket.judge_packet
  });
  const verdict = buildParityVerdict({
    outputDir,
    direct,
    agentflow: agentflowResult,
    pairwiseJudge,
    mapping: pairwisePacket.mapping
  });
  const serializedNative = JSON.stringify(nativeInfo.results);
  const argsLists = nativeInfo.records.flatMap((record) => findNested(record, "args"));
  const assertions = [
    assertion("agentflow_run_passed", tracePacket.outcome.status === "passed", tracePacket.outcome.status),
    assertion("agentflow_validation_passed", agentflowResult.passed, JSON.stringify(agentflowResult.checks)),
    assertion("direct_codex_probe_ran", direct.exit_code === 0, JSON.stringify({ exit_code: direct.exit_code, timed_out: direct.timed_out })),
    assertion("direct_codex_validation_captured", direct.workspace_result.validation.length > 0, JSON.stringify(direct.workspace_result.validation)),
    assertion("agentflow_matches_or_beats_direct_codex", verdict.passed, JSON.stringify(verdict)),
    assertion("pairwise_quality_judge", verdict.pairwise.available && verdict.pairwise.passed, JSON.stringify(verdict.pairwise)),
    assertion("prompt_diagnostics_written", existsSync(join(outputDir, "prompt-diagnostics.json")), JSON.stringify(promptDiagnostics)),
    assertion("no_ambiguous_native_resume", !serializedNative.includes("--last") && !serializedNative.includes("--continue"), argsLists.map((args) => JSON.stringify(args)).join("\n")),
    assertion("no_codex_goal_inside_agentflow", !serializedNative.includes("--goal"), argsLists.map((args) => JSON.stringify(args)).join("\n")),
    assertion("codex_goal_baseline_optional", !codexGoalSupported || Boolean(directGoal), codexGoalSupported ? "goal baseline ran" : "goal mode unavailable")
  ];
  const blockers = [
    ...verdict.blockers,
    ...assertions.filter((entry) => !entry.passed).map((entry) => entry.id)
  ];
  const summary = buildOutputSummary({
    verdict: {
      ...verdict,
      passed: blockers.length === 0,
      blockers
    },
    assertions,
    direct,
    directGoal,
    agentflow: agentflowResult,
    codexGoalSupported,
    promptDiagnostics
  });
  console.log(JSON.stringify(summary));
  return summary;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    runEngineeringParityCriterion();
  } catch (error) {
    console.log(JSON.stringify({
      passed: false,
      score: 1,
      summary: error instanceof Error ? error.message : String(error),
      assertions: [
        {
          id: "engineering_parity_crashed",
          passed: false,
          evidence: error instanceof Error ? error.stack : String(error)
        }
      ]
    }));
    process.exitCode = 0;
  }
}
