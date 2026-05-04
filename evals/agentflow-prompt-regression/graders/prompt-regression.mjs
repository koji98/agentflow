import { readFileSync, existsSync } from "node:fs";
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

function logEntries(runRoot) {
  return readJsonl(join(runRoot, "runtime", "log.jsonl"));
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
const logs = logEntries(process.env.AGENTFLOW_EVAL_RUN_ROOT);
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

for (const required of config.required_logs ?? []) {
  const matched = logs.some((entry) => {
    if (entry.type !== required.type) {
      return false;
    }
    if (required.finding_kind && entry.finding_kind !== required.finding_kind) {
      return false;
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      return false;
    }
    if (required.type === "decision" && (!entry.rationale || !entry.contract_implication)) {
      return false;
    }
    return true;
  });
  check(
    `required_log:${required.type}${required.finding_kind ? `:${required.finding_kind}` : ""}`,
    matched,
    JSON.stringify(logs.map((entry) => ({ type: entry.type, finding_kind: entry.finding_kind, summary: entry.summary }))),
    `required runtime log missing: ${required.type}`
  );
}

if (config.forbid_blocking_logs) {
  check(
    "no_blocking_log",
    !logs.some((entry) => entry.blocking === true),
    JSON.stringify(logs.map((entry) => ({ type: entry.type, blocking: entry.blocking, summary: entry.summary }))),
    "runtime log contained an unsupported blocker"
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

const passed = blockers.length === 0;

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
    runtime_log_count: logs.length,
    simulation_event_count: simulations.length,
    artifact_bytes: Buffer.byteLength(handoff, "utf8")
  }
}));
