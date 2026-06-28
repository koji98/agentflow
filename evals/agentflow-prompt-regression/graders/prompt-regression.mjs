import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadScenario() {
  const suiteDir = process.cwd();
  const suite = readJson(join(suiteDir, "eval.json"));
  for (const ref of suite.scenarios) {
    const scenario = readJson(join(suiteDir, ref));
    if (scenario.id === process.env.AGENTFLOW_EVAL_SCENARIO_ID) {
      return scenario;
    }
  }
  throw new Error(`Scenario not found: ${process.env.AGENTFLOW_EVAL_SCENARIO_ID}`);
}

function artifactContent(packet, name) {
  const artifact = (packet.artifacts ?? []).find((entry) => entry.name === name);
  return artifact?.content ?? "";
}

function includesNeedle(content, needle) {
  if (typeof needle === "string") {
    return content.includes(needle);
  }
  if (needle && typeof needle === "object" && typeof needle.text === "string") {
    const caseSensitive = needle.case_sensitive !== false;
    return caseSensitive
      ? content.includes(needle.text)
      : content.toLocaleLowerCase().includes(needle.text.toLocaleLowerCase());
  }
  if (needle && typeof needle === "object" && Array.isArray(needle.any)) {
    return needle.any.some((candidate) => includesNeedle(content, candidate));
  }
  return false;
}

function includesAll(content, needles) {
  return (needles ?? []).every((needle) => includesNeedle(content, needle));
}

function excludesAll(content, needles) {
  return (needles ?? []).every((needle) => !includesNeedle(content, needle));
}

function hasPlaceholder(content) {
  return /\bTODO\b|\bTBD\b|\bFIXME\b|lorem ipsum|\bplaceholder\s+(?:text|content|value|section|here)\b|\[\s*placeholder[^\]]*\]|\{\{[^}]+\}\}|\[[^\]\n]+\]\(\s*\)|\b(?:run|execute|validation|command)\s*:?[\s`]*\\\s+(?:from|in|with|as)\b|\bready\b[^\n.]{0,80}\bonce\b[^\n.]{0,80}\b(?:validation|check|recorded)\b|\b(?:remains|still needs|yet)\s+to\s+be\s+(?:run|recorded|verified|completed)\b|fill this in|to be filled|not implemented|<\s*todo\s*>/iu.test(content);
}

function afCommands(packet) {
  return (packet.trajectory ?? [])
    .filter((event) => event.kind === "af_tool_call")
    .map((event) => String(event.af_command ?? event.command ?? ""));
}

function simulationEvents(packet) {
  return packet.simulation_events ?? [];
}

function milestoneEntries(runRoot) {
  const milestoneDir = join(runRoot, "runtime", "milestones");
  if (!existsSync(milestoneDir)) {
    return [];
  }
  return readdirSync(milestoneDir)
    .filter((entry) => entry.endsWith(".json"))
    .flatMap((entry) => {
      const state = readJson(join(milestoneDir, entry));
      return (state.milestones ?? []).map((milestone) => ({
        ...milestone,
        source_file: entry
      }));
    });
}

function milestoneLogEntries(runRoot) {
  return milestoneEntries(runRoot).flatMap((milestone) =>
    (milestone.logs ?? []).map((entry) => ({
      ...entry,
      milestone_id: milestone.id,
      milestone_title: milestone.title,
      milestone_status: milestone.status
    }))
  );
}

function promptDiagnosticsEntries(runRoot) {
  const entries = [];

  function walk(dir) {
    if (!existsSync(dir)) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.isFile() && entry.name === "prompt-diagnostics.json") {
        try {
          entries.push({
            path,
            diagnostics: readJson(path)
          });
        } catch {
          entries.push({
            path,
            diagnostics: {
              warnings: ["diagnostics_unreadable"]
            }
          });
        }
      }
    }
  }

  walk(runRoot);
  return entries;
}

function trialRootFromOutputDir() {
  return dirname(dirname(process.env.AGENTFLOW_EVAL_OUTPUT_DIR));
}

function workspaceFile(relativePath) {
  const path = join(trialRootFromOutputDir(), "workspace", "repo", relativePath);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function assertion(id, passed, evidence) {
  return { id, passed, ...(evidence ? { evidence } : {}) };
}

const packet = readJson(process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE);
const scenario = loadScenario();
const config = scenario.criteria?.["prompt-regression"] ?? {};
const handoff = artifactContent(packet, config.artifact ?? "handoff");
const commands = afCommands(packet);
const simulations = simulationEvents(packet);
const milestones = milestoneEntries(process.env.AGENTFLOW_EVAL_RUN_ROOT);
const milestoneLogs = milestoneLogEntries(process.env.AGENTFLOW_EVAL_RUN_ROOT);
const promptDiagnostics = promptDiagnosticsEntries(process.env.AGENTFLOW_EVAL_RUN_ROOT);
const assertions = [];
const blockers = [];

function check(id, passed, evidence, blocker) {
  assertions.push(assertion(id, passed, evidence));
  if (!passed) {
    blockers.push(blocker ?? id);
  }
}

check("artifact_present", handoff.trim().length > 0, "handoff artifact content", "handoff artifact was missing or empty");

if (config.required_contains) {
  check(
    "artifact_required_contains",
    includesAll(handoff, config.required_contains),
    `required=${JSON.stringify(config.required_contains)}`,
    "handoff artifact missed required content"
  );
}

if (config.forbidden_contains) {
  check(
    "artifact_forbidden_contains",
    excludesAll(handoff, config.forbidden_contains),
    `forbidden=${JSON.stringify(config.forbidden_contains)}`,
    "handoff artifact included forbidden content"
  );
}

if (config.placeholder_free !== false) {
  check("artifact_placeholder_free", !hasPlaceholder(handoff), "placeholder scan", "handoff artifact contained placeholder text");
}

for (const prefix of config.required_af ?? ["complete check"]) {
  check(
    `required_af:${prefix}`,
    commands.some((command) => command.startsWith(prefix)),
    commands.join(" | "),
    `required af command missing: ${prefix}`
  );
}

for (const forbidden of config.forbidden_af ?? ["diagnose", "learn", "spawn"]) {
  check(
    `forbidden_af:${forbidden}`,
    !commands.some((command) => command === forbidden || command.startsWith(`${forbidden} `)),
    commands.join(" | "),
    `forbidden af command observed: ${forbidden}`
  );
}

for (const required of config.required_milestone_logs ?? []) {
  const matched = milestoneLogs.some((entry) => {
    if (entry.kind !== required.kind) {
      return false;
    }
    if (required.result && entry.result !== required.result) {
      return false;
    }
    if (required.command_contains && !String(entry.command ?? "").includes(required.command_contains)) {
      return false;
    }
    if (!entry.summary) {
      return false;
    }
    return true;
  });
  check(
    `required_milestone_log:${required.kind}${required.result ? `:${required.result}` : ""}`,
    matched,
    JSON.stringify(milestoneLogs.map((entry) => ({ kind: entry.kind, result: entry.result, command: entry.command, summary: entry.summary }))),
    `required milestone log missing: ${required.kind}`
  );
}

if (config.forbid_blocked_milestones) {
  check(
    "no_blocked_milestone",
    !milestones.some((entry) => entry.status === "blocked"),
    JSON.stringify(milestones.map((entry) => ({ id: entry.id, status: entry.status, blocked_on: entry.blocked_on }))),
    "milestone state contained an unsupported blocker"
  );
}

for (const required of config.required_simulation ?? []) {
  const matched = simulations.some((event) =>
    (!required.command || event.command === required.command) &&
    (!required.rule_id || event.rule_id === required.rule_id)
  );
  check(
    `required_simulation:${required.command ?? "any"}:${required.rule_id ?? "any"}`,
    matched,
    JSON.stringify(simulations.map((event) => ({ command: event.command, rule_id: event.rule_id }))),
    "required simulated tool command was not observed"
  );
}

for (const forbidden of config.forbidden_simulation ?? []) {
  const matched = simulations.some((event) =>
    (!forbidden.command || event.command === forbidden.command) &&
    (!forbidden.rule_id || event.rule_id === forbidden.rule_id)
  );
  check(
    `forbidden_simulation:${forbidden.command ?? "any"}:${forbidden.rule_id ?? "any"}`,
    !matched,
    JSON.stringify(simulations.map((event) => ({ command: event.command, rule_id: event.rule_id }))),
    "forbidden simulated tool command was observed"
  );
}

for (const requiredFile of config.required_workspace_files ?? []) {
  const content = workspaceFile(requiredFile.path);
  check(
    `workspace_file:${requiredFile.path}`,
    content !== undefined && includesAll(content, requiredFile.contains ?? []),
    content ?? "missing",
    `required workspace file missing or incomplete: ${requiredFile.path}`
  );
}

if (config.require_completion_ready !== false) {
  const readyPacket = (packet.trajectory ?? []).some((event) =>
    event.kind === "completion_packet" && event.ready_for_verification === true
  );
  check("completion_ready", readyPacket, "trace completion packet", "completion packet was not ready for verification");
}

if (config.require_prompt_diagnostics) {
  check(
    "prompt_diagnostics_present",
    promptDiagnostics.length > 0,
    JSON.stringify(promptDiagnostics.map((entry) => entry.path)),
    "prompt diagnostics were not written"
  );
}

for (const warning of config.required_prompt_warnings ?? []) {
  const matched = promptDiagnostics.some((entry) => (entry.diagnostics.warnings ?? []).includes(warning));
  check(
    `required_prompt_warning:${warning}`,
    matched,
    JSON.stringify(promptDiagnostics.map((entry) => ({ path: entry.path, warnings: entry.diagnostics.warnings ?? [] }))),
    `required prompt diagnostics warning missing: ${warning}`
  );
}

for (const warning of config.forbidden_prompt_warnings ?? []) {
  const matched = promptDiagnostics.some((entry) => (entry.diagnostics.warnings ?? []).includes(warning));
  check(
    `forbidden_prompt_warning:${warning}`,
    !matched,
    JSON.stringify(promptDiagnostics.map((entry) => ({ path: entry.path, warnings: entry.diagnostics.warnings ?? [] }))),
    `forbidden prompt diagnostics warning observed: ${warning}`
  );
}

const passed = blockers.length === 0;
const promptWarnings = [...new Set(promptDiagnostics.flatMap((entry) => entry.diagnostics.warnings ?? []))];

console.log(JSON.stringify({
  passed,
  score: passed ? 5 : 1,
  summary: passed
    ? "Prompt-regression deterministic checks passed."
    : `Prompt-regression deterministic checks failed: ${blockers.join("; ")}`,
  assertions,
  blockers,
  metrics: {
    af_command_count: commands.length,
    milestone_count: milestones.length,
    milestone_log_count: milestoneLogs.length,
    simulation_event_count: simulations.length,
    artifact_bytes: Buffer.byteLength(handoff, "utf8"),
    prompt_diagnostics_count: promptDiagnostics.length,
    prompt_warning_tags: promptWarnings
  }
}));
