#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { access, appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { resolveSubpathWithinRoot } from "../path_rules.js";
import { readRunExecutionAttempts, readRunState } from "../artifacts/reader.js";
import type { ArtifactDefinition } from "../graph/authored.js";
import type { ResolvedTool } from "../graph/compiled.js";
import type { CredentialSpecMap } from "../auth/types.js";
import { prepareAgentTools } from "../runtime/tools/setup.js";
import { buildHarnessSpawnEnv } from "../runtime/harness/types.js";
import type { AgentInvocation } from "../runtime/harness/types.js";

type JsonRecord = Record<string, unknown>;

interface RuntimeMetadata {
  version: "1";
  run_root: string;
  run_id: string;
  graph_id: string;
  agent_id: string;
  parent_agent_id?: string;
  execution_id: string;
  node_id: string;
  compiled_id: string;
  repo_alias: string;
  workspace_path: string;
  output_dir: string;
  runtime_dir?: string;
  context_packet_path: string;
  context_manifest_path: string;
  tool_state_path: string;
  tool_bin_dir: string;
  tool_invocations_path?: string;
  credential_specs?: CredentialSpecMap;
  credential_index_path?: string;
  keychain_account?: string;
  declared_artifacts: Record<string, ArtifactDefinition>;
  tools: ResolvedTool[];
  harness?: "codex-cli" | "cursor-cli";
  model?: string;
  reasoning_effort?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  timeout_sec: number;
}

interface RuntimeMessage {
  message_id: string;
  run_id: string;
  from_agent_id: string;
  to: string;
  type: string;
  summary: string;
  body?: string;
  artifact_refs?: string[];
  created_at: string;
}

interface HelperSession {
  agent_id: string;
  parent_agent_id: string;
  run_id: string;
  status: "starting" | "running" | "completed" | "failed" | "canceled";
  brief: string;
  skills: string[];
  allowed_tools: string[];
  output_dir: string;
  log_path: string;
  result_path: string;
  parent_metadata_path?: string;
  artifacts: Record<string, string>;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  exit_code?: number;
}

interface AfResult {
  exitCode: number;
  stdout?: string;
  output?: unknown;
}

function redactArgv(argv: string[]): string[] {
  const secretPattern = /(^|[_-])(token|secret|password|passwd|api[_-]?key|credential|authorization|bearer)([_-]|$)/i;
  const redacted: string[] = [];
  let redactNext = false;

  for (const arg of argv) {
    if (redactNext) {
      redacted.push("<redacted>");
      redactNext = false;
      continue;
    }

    const [key] = arg.split("=", 1);
    if (secretPattern.test(key ?? arg)) {
      redacted.push(arg.includes("=") ? `${key}=<redacted>` : arg);
      redactNext = !arg.includes("=");
      continue;
    }

    redacted.push(arg);
  }

  return redacted;
}

async function appendAfInvocation(options: {
  metadata: RuntimeMetadata;
  argv: string[];
  exitCode: number;
  durationMs: number;
  error?: string;
}): Promise<void> {
  const path = options.metadata.tool_invocations_path ?? process.env.AGENTFLOW_TOOL_INVOCATIONS;
  if (!path) {
    return;
  }

  await appendJsonl(path, {
    ts: new Date().toISOString(),
    run_id: options.metadata.run_id,
    graph_id: options.metadata.graph_id,
    agent_id: options.metadata.agent_id,
    execution_id: options.metadata.execution_id,
    node_id: options.metadata.node_id,
    compiled_id: options.metadata.compiled_id,
    kind: "af",
    tool: "af",
    argv: redactArgv(options.argv),
    cwd: process.cwd(),
    exit_code: options.exitCode,
    duration_ms: options.durationMs,
    ...(options.error ? { error: options.error } : {}),
    redaction: "secret-looking argv values redacted"
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, jsonLine(value), "utf8");
}

async function readJsonl<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runtimeDir(runRoot: string): string {
  return join(runRoot, "runtime");
}

function metadataRuntimeDir(metadata: RuntimeMetadata): string {
  return metadata.runtime_dir ?? runtimeDir(metadata.run_root);
}

function channelPath(metadata: RuntimeMetadata): string {
  return join(metadataRuntimeDir(metadata), "channel.jsonl");
}

function mailboxPath(metadata: RuntimeMetadata, agentId: string): string {
  return join(metadataRuntimeDir(metadata), "mailboxes", `${agentId}.jsonl`);
}

function supervisorRequestsPath(metadata: RuntimeMetadata): string {
  return join(metadataRuntimeDir(metadata), "supervisor-requests.jsonl");
}

function helperPath(metadata: RuntimeMetadata, helperId: string): string {
  return join(metadataRuntimeDir(metadata), "helpers", helperId, "session.json");
}

function helpersDir(metadata: RuntimeMetadata): string {
  return join(metadataRuntimeDir(metadata), "helpers");
}

function requireRuntimeMetadata(): RuntimeMetadata {
  const metadataPath = process.env.AGENTFLOW_RUNTIME_METADATA;
  if (!metadataPath) {
    throw new Error("af must run inside an Agentflow agent node with AGENTFLOW_RUNTIME_METADATA set.");
  }

  return JSON.parse(readFileSync(metadataPath, "utf8")) as RuntimeMetadata;
}

function parseArgs(argv: string[]): {
  positionals: string[];
  options: Record<string, string | boolean | string[]>;
} {
  const positionals: string[] = [];
  const options: Record<string, string | boolean | string[]> = {};

  function setOption(name: string, value: string | boolean): void {
    const existing = options[name];
    if (existing === undefined) {
      options[name] = value;
      return;
    }
    if (Array.isArray(existing)) {
      existing.push(String(value));
      return;
    }
    options[name] = [String(existing), String(value)];
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex !== -1) {
      setOption(token.slice(2, equalsIndex), token.slice(equalsIndex + 1));
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      setOption(name, true);
      continue;
    }

    setOption(name, next);
    index += 1;
  }

  return { positionals, options };
}

function optionString(options: Record<string, string | boolean | string[]>, name: string): string | undefined {
  const value = options[name];
  if (Array.isArray(value)) {
    return value.at(-1);
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionList(options: Record<string, string | boolean | string[]>, name: string): string[] {
  const value = options[name];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function optionNumber(
  options: Record<string, string | boolean | string[]>,
  name: string,
  fallback: number
): number {
  const raw = optionString(options, name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function currentArtifactPath(metadata: RuntimeMetadata, name: string): string {
  const definition = metadata.declared_artifacts[name];
  if (!definition) {
    throw new Error(`Artifact "${name}" is not declared on this agent node.`);
  }

  return definition.from === "output_dir"
    ? resolveSubpathWithinRoot(metadata.output_dir, definition.path, `Artifact "${name}" path`)
    : resolveSubpathWithinRoot(metadata.workspace_path, definition.path, `Artifact "${name}" path`);
}

async function readStdin(): Promise<string> {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += String(chunk);
  }
  return value;
}

function renderHelp(): string {
  return [
    "Agentflow runtime CLI (`af`)",
    "",
    "Agent commands:",
    "  af status",
    "  af tools list",
    "  af context show",
    "  af artifact list",
    "  af artifact write <name> (--file <path> | --content <text> | --stdin)",
    "  af artifact read <artifact | node.artifact | helper.artifact>",
    "  af channel post --type <type> --summary <text> [--body <text>] [--artifact <name>]",
    "  af channel read [--latest N]",
    "  af agents list",
    "  af inbox read [--latest N]",
    "  af send --to <agent-id> --type <type> --summary <text> [--body <text>]",
    "  af parent post --type <type> --summary <text> [--body <text>]",
    "  af supervisor request --action <action> --reason <text>",
    "  af spawn --brief <text> [--skills a,b] [--tools tool-a,tool-b] [--artifact name] [--wait]",
    "  af wait --agent <agent-id> [--artifact <name>] [--timeout-sec N]"
  ].join("\n");
}

async function commandStatus(metadata: RuntimeMetadata): Promise<AfResult> {
  const state = await readRunState(metadata.run_root).catch(() => undefined);
  return {
    exitCode: 0,
    output: {
      command: "af status",
      status: "passed",
      agent: {
        agent_id: metadata.agent_id,
        parent_agent_id: metadata.parent_agent_id ?? null,
        node_id: metadata.node_id,
        compiled_id: metadata.compiled_id,
        execution_id: metadata.execution_id,
        repo_alias: metadata.repo_alias,
        workspace_path: metadata.workspace_path,
        output_dir: metadata.output_dir,
        sandbox: metadata.sandbox,
        harness: metadata.harness ?? null
      },
      run: state
        ? {
            run_id: state.run_id,
            graph_id: state.graph_id,
            status: state.status,
            counts: state.counts,
            supervisor: state.supervisor
          }
        : {
            run_id: metadata.run_id,
            graph_id: metadata.graph_id,
            status: "unknown"
          },
      required_artifacts: metadata.declared_artifacts,
      tools: metadata.tools.map((tool) => ({
        callable_name: tool.callable_name,
        capability: tool.capability,
        impact: tool.impact,
        description: tool.description ?? null
      }))
    }
  };
}

async function commandTools(metadata: RuntimeMetadata): Promise<AfResult> {
  return {
    exitCode: 0,
    output: {
      command: "af tools list",
      status: "passed",
      tools: metadata.tools.map((tool) => ({
        callable_name: tool.callable_name,
        capability: tool.capability,
        impact: tool.impact,
        description: tool.description ?? null,
        usage: tool.usage ?? null,
        credentials: tool.credentials ?? []
      }))
    }
  };
}

async function commandContext(metadata: RuntimeMetadata): Promise<AfResult> {
  const manifest = await readFile(metadata.context_manifest_path, "utf8").catch(() => "");
  return {
    exitCode: 0,
    output: {
      command: "af context show",
      status: "passed",
      context_packet_path: metadata.context_packet_path,
      context_manifest_path: metadata.context_manifest_path,
      manifest
    }
  };
}

async function commandArtifactList(metadata: RuntimeMetadata): Promise<AfResult> {
  const artifacts = await Promise.all(
    Object.entries(metadata.declared_artifacts).map(async ([name, definition]) => {
      const path = currentArtifactPath(metadata, name);
      return {
        name,
        from: definition.from,
        path,
        description: definition.description,
        exists: await exists(path)
      };
    })
  );

  return {
    exitCode: 0,
    output: {
      command: "af artifact list",
      status: "passed",
      artifacts
    }
  };
}

async function commandArtifactWrite(
  metadata: RuntimeMetadata,
  positionals: string[],
  options: Record<string, string | boolean | string[]>
): Promise<AfResult> {
  const name = positionals[2];
  if (!name) {
    throw new Error("af artifact write requires an artifact name.");
  }

  const destination = currentArtifactPath(metadata, name);
  await mkdir(dirname(destination), { recursive: true });

  const sourceFile = optionString(options, "file");
  const content = optionString(options, "content");
  const useStdin = options.stdin === true;
  const modes = [sourceFile !== undefined, content !== undefined, useStdin].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error("af artifact write requires exactly one of --file, --content, or --stdin.");
  }

  if (sourceFile) {
    await copyFile(resolve(process.cwd(), sourceFile), destination);
  } else {
    await writeFile(destination, content ?? await readStdin(), "utf8");
  }

  return {
    exitCode: 0,
    output: {
      command: "af artifact write",
      status: "passed",
      artifact: name,
      path: destination
    }
  };
}

async function latestArtifactPathFromAttempts(
  metadata: RuntimeMetadata,
  nodeOrAgent: string,
  artifact: string
): Promise<string | undefined> {
  const helperSession = await readHelperSessionForMetadata(metadata, nodeOrAgent).catch(() => undefined);
  if (helperSession?.artifacts[artifact]) {
    return helperSession.artifacts[artifact];
  }

  const attempts = await readRunExecutionAttempts(metadata.run_root);
  return attempts
    .filter((attempt) => attempt.status === "passed" && attempt.authored_id === nodeOrAgent && attempt.artifacts[artifact])
    .sort((left, right) => Date.parse(right.ended_at ?? right.started_at) - Date.parse(left.ended_at ?? left.started_at))
    .at(0)?.artifacts[artifact];
}

async function commandArtifactRead(metadata: RuntimeMetadata, positionals: string[]): Promise<AfResult> {
  const ref = positionals[2];
  if (!ref) {
    throw new Error("af artifact read requires an artifact name or node.artifact reference.");
  }

  const dotIndex = ref.indexOf(".");
  let artifactPath: string | undefined;
  if (dotIndex === -1) {
    artifactPath = currentArtifactPath(metadata, ref);
  } else {
    artifactPath = await latestArtifactPathFromAttempts(metadata, ref.slice(0, dotIndex), ref.slice(dotIndex + 1));
  }

  if (!artifactPath) {
    throw new Error(`Artifact reference "${ref}" could not be resolved.`);
  }

  return {
    exitCode: 0,
    stdout: await readFile(artifactPath, "utf8")
  };
}

function createMessage(
  metadata: RuntimeMetadata,
  to: string,
  options: Record<string, string | boolean | string[]>
): RuntimeMessage {
  const type = optionString(options, "type") ?? "status";
  const summary = optionString(options, "summary");
  if (!summary) {
    throw new Error("Message commands require --summary.");
  }

  const body = optionString(options, "body");
  const artifact_refs = optionList(options, "artifact");
  return {
    message_id: `msg_${randomUUID()}`,
    run_id: metadata.run_id,
    from_agent_id: metadata.agent_id,
    to,
    type,
    summary,
    ...(body ? { body } : {}),
    ...(artifact_refs.length > 0 ? { artifact_refs } : {}),
    created_at: new Date().toISOString()
  };
}

async function commandChannelPost(
  metadata: RuntimeMetadata,
  options: Record<string, string | boolean | string[]>
): Promise<AfResult> {
  const message = createMessage(metadata, "channel", options);
  await appendJsonl(channelPath(metadata), message);
  return {
    exitCode: 0,
    output: {
      command: "af channel post",
      status: "passed",
      message_id: message.message_id,
      stored: true
    }
  };
}

async function commandChannelRead(
  metadata: RuntimeMetadata,
  options: Record<string, string | boolean | string[]>
): Promise<AfResult> {
  const latest = optionNumber(options, "latest", 50);
  const messages = await readJsonl<RuntimeMessage>(channelPath(metadata));
  return {
    exitCode: 0,
    output: {
      command: "af channel read",
      status: "passed",
      messages: messages.slice(-latest)
    }
  };
}

async function readHelperSessionForMetadata(metadata: RuntimeMetadata, helperId: string): Promise<HelperSession> {
  return readJsonFile<HelperSession>(helperPath(metadata, helperId));
}

async function listHelperSessions(metadata: RuntimeMetadata): Promise<HelperSession[]> {
  let entries: string[];
  try {
    entries = await readdir(helpersDir(metadata));
  } catch {
    return [];
  }

  const sessions = await Promise.all(
    entries.map((entry) => readHelperSessionForMetadata(metadata, entry).catch(() => undefined))
  );
  return sessions.filter((session): session is HelperSession => session !== undefined);
}

async function isRecipientRunning(metadata: RuntimeMetadata, agentId: string): Promise<boolean> {
  if (agentId === "supervisor") {
    return true;
  }
  if (agentId === metadata.agent_id) {
    return true;
  }

  const state = await readRunState(metadata.run_root).catch(() => undefined);
  if (state && state.active_executions[agentId]) {
    return true;
  }

  const helper = await readHelperSessionForMetadata(metadata, agentId).catch(() => undefined);
  return helper?.status === "running" || helper?.status === "starting";
}

async function deliverMessage(
  metadata: RuntimeMetadata,
  to: string,
  options: Record<string, string | boolean | string[]>
): Promise<AfResult> {
  const message = createMessage(metadata, to, options);
  const delivered = await isRecipientRunning(metadata, to);
  await appendJsonl(mailboxPath(metadata, to), message);
  await appendJsonl(channelPath(metadata), {
    ...message,
    to: `mailbox:${to}`,
    delivery: {
      delivered,
      stored: true
    }
  });

  return {
    exitCode: 0,
    output: {
      command: "af send",
      status: "passed",
      message_id: message.message_id,
      to,
      delivered,
      stored: true,
      reason: delivered ? "recipient_running" : "recipient_not_running"
    }
  };
}

async function commandInboxRead(
  metadata: RuntimeMetadata,
  options: Record<string, string | boolean | string[]>
): Promise<AfResult> {
  const latest = optionNumber(options, "latest", 50);
  const messages = await readJsonl<RuntimeMessage>(mailboxPath(metadata, metadata.agent_id));
  return {
    exitCode: 0,
    output: {
      command: "af inbox read",
      status: "passed",
      agent_id: metadata.agent_id,
      messages: messages.slice(-latest)
    }
  };
}

async function commandAgentsList(metadata: RuntimeMetadata): Promise<AfResult> {
  const state = await readRunState(metadata.run_root).catch(() => undefined);
  const helpers = await listHelperSessions(metadata);
  const graphAgents = state
    ? Object.values(state.latest_execution_by_compiled_id)
        .filter((execution) => execution.kind === "agent")
        .map((execution) => ({
          agent_id: execution.execution_id,
          node_id: execution.authored_id,
          compiled_id: execution.compiled_id,
          status: state.active_executions[execution.execution_id] ? "running" : execution.status,
          relationship:
            execution.execution_id === metadata.agent_id
              ? "self"
              : "graph-agent",
          can_receive_messages: Boolean(state.active_executions[execution.execution_id])
        }))
    : [];

  return {
    exitCode: 0,
    output: {
      command: "af agents list",
      status: "passed",
      agents: [
        ...graphAgents,
        ...helpers.map((helper) => ({
          agent_id: helper.agent_id,
          parent_agent_id: helper.parent_agent_id,
          status: helper.status,
          relationship:
            helper.agent_id === metadata.agent_id
              ? "self"
              : helper.parent_agent_id === metadata.agent_id
                ? "child"
                : helper.parent_agent_id === metadata.parent_agent_id
                  ? "sibling"
                  : "helper",
          can_receive_messages: helper.status === "running" || helper.status === "starting"
        }))
      ]
    }
  };
}

async function commandSupervisorRequest(
  metadata: RuntimeMetadata,
  options: Record<string, string | boolean | string[]>
): Promise<AfResult> {
  const action = optionString(options, "action");
  const reason = optionString(options, "reason");
  if (!action || !reason) {
    throw new Error("af supervisor request requires --action and --reason.");
  }

  const request = {
    request_id: `sup_${randomUUID()}`,
    run_id: metadata.run_id,
    from_agent_id: metadata.agent_id,
    action,
    reason,
    created_at: new Date().toISOString(),
    status: "recorded"
  };
  await appendJsonl(supervisorRequestsPath(metadata), request);
  await appendJsonl(channelPath(metadata), {
    message_id: request.request_id,
    run_id: metadata.run_id,
    from_agent_id: metadata.agent_id,
    to: "supervisor",
    type: "supervisor-request",
    summary: `${action}: ${reason}`,
    created_at: request.created_at
  });

  return {
    exitCode: 0,
    output: {
      command: "af supervisor request",
      status: "passed",
      request
    }
  };
}

function helperIdFromBrief(brief: string): string {
  return `helper_${createHash("sha1").update(`${Date.now()}-${brief}-${randomUUID()}`).digest("hex").slice(0, 12)}`;
}

function currentAfCliPath(): string {
  return fileURLToPath(import.meta.url);
}

function currentAfRunner(): { command: string; args: string[] } {
  const configuredRunner = process.env.AGENTFLOW_AF_RUNNER;
  const configuredCli = process.env.AGENTFLOW_AF_CLI;
  if (configuredRunner && configuredCli) {
    return { command: configuredRunner, args: [configuredCli] };
  }

  const cliPath = currentAfCliPath();
  if (!cliPath.endsWith(".ts")) {
    return { command: process.execPath, args: [cliPath] };
  }

  const packageRoot = resolve(dirname(cliPath), "../..");
  const tsxPath = resolve(packageRoot, "node_modules/.bin/tsx");
  return existsSync(tsxPath)
    ? { command: tsxPath, args: [cliPath] }
    : { command: process.execPath, args: [cliPath] };
}

function spawnHelperRunner(metadata: RuntimeMetadata, helperId: string, artifactName: string): void {
  const metadataPath = process.env.AGENTFLOW_RUNTIME_METADATA;
  if (!metadataPath) {
    throw new Error("af spawn requires AGENTFLOW_RUNTIME_METADATA.");
  }
  const runner = currentAfRunner();
  const args = [
    ...runner.args,
    "_helper-run",
    "--metadata",
    metadataPath,
    "--helper",
    helperId,
    "--artifact",
    artifactName
  ];

  const child = spawn(runner.command, args, {
    cwd: metadata.workspace_path,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AGENTFLOW_RUNTIME_METADATA: metadataPath
    }
  });
  child.unref();
}

async function commandSpawn(
  metadata: RuntimeMetadata,
  options: Record<string, string | boolean | string[]>
): Promise<AfResult> {
  const brief = optionString(options, "brief");
  if (!brief) {
    throw new Error("af spawn requires --brief.");
  }
  if (!metadata.harness) {
    throw new Error("af spawn requires a current harness.");
  }

  const helperId = helperIdFromBrief(brief);
  const helperRoot = join(helpersDir(metadata), helperId);
  const outputDir = join(helperRoot, "artifacts");
  const logPath = join(helperRoot, "logs", "harness.log");
  const resultPath = join(helperRoot, "result.json");
  const artifactName = optionString(options, "artifact") ?? "helper-report.md";
  const allowedTools = optionList(options, "tools");
  const grantedToolNames = new Set(metadata.tools.map((tool) => tool.callable_name));
  const unknownTools = allowedTools.filter((tool) => !grantedToolNames.has(tool));
  if (unknownTools.length > 0) {
    throw new Error(`af spawn requested tools not granted to this agent: ${unknownTools.join(", ")}`);
  }
  const session: HelperSession = {
    agent_id: helperId,
    parent_agent_id: metadata.agent_id,
    run_id: metadata.run_id,
    status: "starting",
    brief,
    skills: optionList(options, "skills"),
    allowed_tools: allowedTools,
    output_dir: outputDir,
    log_path: logPath,
    result_path: resultPath,
    ...(process.env.AGENTFLOW_RUNTIME_METADATA
      ? { parent_metadata_path: process.env.AGENTFLOW_RUNTIME_METADATA }
      : {}),
    artifacts: {
      [artifactName]: join(outputDir, artifactName)
    },
    created_at: new Date().toISOString()
  };

  await writeJsonFile(helperPath(metadata, helperId), session);
  await appendJsonl(channelPath(metadata), {
    message_id: `msg_${randomUUID()}`,
    run_id: metadata.run_id,
    from_agent_id: metadata.agent_id,
    to: "channel",
    type: "helper-spawned",
    summary: `Spawned helper ${helperId}: ${brief}`,
    artifact_refs: [artifactName],
    created_at: new Date().toISOString()
  });

  if (process.env.AGENTFLOW_SPAWN_MODE !== "broker") {
    spawnHelperRunner(metadata, helperId, artifactName);
  }

  if (options.wait === true) {
    return waitForHelper(metadata, helperId, artifactName, optionNumber(options, "timeout-sec", metadata.timeout_sec));
  }

  return {
    exitCode: 0,
    output: {
      command: "af spawn",
      status: "passed",
      agent_id: helperId,
      output_dir: outputDir,
      artifact: artifactName
    }
  };
}

async function writeHelperSession(metadata: RuntimeMetadata, session: HelperSession): Promise<void> {
  await writeJsonFile(helperPath(metadata, session.agent_id), session);
}

async function helperRun(options: Record<string, string | boolean | string[]>): Promise<AfResult> {
  const metadataPath = optionString(options, "metadata");
  const helperId = optionString(options, "helper");
  const artifactName = optionString(options, "artifact") ?? "helper-report.md";
  if (!metadataPath || !helperId) {
    throw new Error("_helper-run requires --metadata and --helper.");
  }

  const parentMetadata = await readJsonFile<RuntimeMetadata>(metadataPath);
  const session = await readHelperSessionForMetadata(parentMetadata, helperId);
  const outputDir = session.output_dir;
  const contextManifest = await readFile(parentMetadata.context_manifest_path, "utf8").catch(() => "");
  await mkdir(outputDir, { recursive: true });
  await mkdir(dirname(session.log_path), { recursive: true });
  const selectedTools = session.allowed_tools.length > 0
    ? parentMetadata.tools.filter((tool) => session.allowed_tools.includes(tool.callable_name))
    : [];

  const updated: HelperSession = {
    ...session,
    status: "running",
    started_at: new Date().toISOString()
  };
  await writeHelperSession(parentMetadata, updated);

  const prompt = [
    "## Role",
    "You are an Agentflow helper agent spawned by another agent during the same run.",
    "Do the focused helper work. Produce the requested helper artifact, then finish with a concise handoff.",
    "",
    "## Brief",
    session.brief,
    "",
    "## Skills",
    session.skills.length > 0 ? session.skills.map((skill) => `- ${skill}`).join("\n") : "- No additional skills requested.",
    "",
    "## Workspace",
    `- Workspace path: ${parentMetadata.workspace_path}`,
    `- Output directory: ${outputDir}`,
    `- Parent agent: ${session.parent_agent_id}`,
    "",
    "## Agentflow Runtime CLI",
    "Use `af status` to inspect your session, `af artifact write` to publish the required artifact, and `af parent post` to notify the parent. Use `af tools list` before invoking plugin tools.",
    "",
    "## Allowed Plugin Tools",
    selectedTools.length > 0
      ? selectedTools.map((tool) => `- ${tool.callable_name}: ${tool.description ?? tool.capability}`).join("\n")
      : "- No plugin tools were granted to this helper.",
    "",
    "## Required Artifact",
    `Publish \`${artifactName}\` before finishing.`,
    "Do not create helper-only artifact drafts in the workspace. Use `af artifact write --content`, `af artifact write --stdin`, or write a temporary file under the output directory.",
    `Preferred file path for drafts: ${join(outputDir, artifactName)}`,
    `Example: af artifact write ${artifactName} --file ${join(outputDir, artifactName)}`,
    "",
    "## Context",
    contextManifest || "_No context manifest was available._"
  ].join("\n");

  const logChunks: Buffer[] = [];
  const harnessBin =
    parentMetadata.harness === "cursor-cli"
      ? (process.env.AGENTFLOW_CURSOR_CLI_BIN?.trim() || "agent")
      : (process.env.AGENTFLOW_CODEX_CLI_BIN?.trim() || "codex");
  const args =
    parentMetadata.harness === "cursor-cli"
      ? [
          "-p",
          "--output-format",
          "json",
          "--workspace",
          parentMetadata.workspace_path,
          "--sandbox",
          parentMetadata.sandbox === "danger-full-access" ? "disabled" : "enabled",
          ...(parentMetadata.sandbox !== "read-only" ? ["--force"] : []),
          ...(parentMetadata.model && parentMetadata.model !== "auto" ? ["--model", parentMetadata.model] : []),
          prompt
        ]
      : [
          "exec",
          "--sandbox",
          parentMetadata.sandbox,
          "--add-dir",
          outputDir,
          "--add-dir",
          metadataRuntimeDir(parentMetadata),
          ...(parentMetadata.model && parentMetadata.model !== "auto" ? ["-m", parentMetadata.model] : []),
          ...(parentMetadata.reasoning_effort ? ["-c", `model_reasoning_effort="${parentMetadata.reasoning_effort}"`] : []),
          "-"
        ];

  const helperArtifacts: Record<string, ArtifactDefinition> = {
    [artifactName]: {
      from: "output_dir",
      path: artifactName,
      description: "Helper output artifact."
    }
  };
  const helperToolSetup = await prepareAgentTools({
    node: {
      authored_id: helperId,
      compiled_id: helperId,
      declared_artifacts: helperArtifacts,
      tools: selectedTools
    } as unknown as Parameters<typeof prepareAgentTools>[0]["node"],
    execution_dir: dirname(helperPath(parentMetadata, helperId)),
    workspace_path: parentMetadata.workspace_path,
    artifacts_root: outputDir,
    run_root: parentMetadata.run_root,
    runtime_dir: metadataRuntimeDir(parentMetadata),
    run_id: parentMetadata.run_id,
    graph_id: parentMetadata.graph_id,
    execution_id: helperId,
    parent_agent_id: session.parent_agent_id,
    repo_alias: parentMetadata.repo_alias,
    ...(parentMetadata.harness ? { harness: parentMetadata.harness } : {}),
    ...(parentMetadata.model ? { model: parentMetadata.model } : {}),
    ...(parentMetadata.reasoning_effort ? { reasoning_effort: parentMetadata.reasoning_effort } : {}),
    sandbox: parentMetadata.sandbox,
    timeout_sec: parentMetadata.timeout_sec,
    context_packet_path: parentMetadata.context_packet_path,
    context_manifest_path: parentMetadata.context_manifest_path,
    credential_specs: parentMetadata.credential_specs ?? {},
    ...(parentMetadata.credential_index_path ? { credential_index_path: parentMetadata.credential_index_path } : {}),
    ...(parentMetadata.keychain_account ? { keychain_account: parentMetadata.keychain_account } : {})
  });
  const helperMetadataPath = helperToolSetup.env.AGENTFLOW_RUNTIME_METADATA;
  if (!helperMetadataPath) {
    throw new Error("Failed to prepare Agentflow runtime metadata for helper.");
  }
  const helperInvocation = {
    toolBinDir: helperToolSetup.bin_dir,
    toolEnv: helperToolSetup.env,
    repoPath: parentMetadata.workspace_path,
    runtimeDir: metadataRuntimeDir(parentMetadata),
    outputDir,
    contextPacketPath: parentMetadata.context_packet_path,
    contextManifestPath: parentMetadata.context_manifest_path
  } as unknown as AgentInvocation;
  const basePath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && entry !== parentMetadata.tool_bin_dir)
    .join(delimiter);
  const helperEnv = buildHarnessSpawnEnv(helperInvocation, {
    ...process.env,
    PATH: basePath
  });
  Object.assign(helperEnv, {
    AGENTFLOW_RUN_ROOT: parentMetadata.run_root,
    AGENTFLOW_RUNTIME_DIR: metadataRuntimeDir(parentMetadata),
    AGENTFLOW_RUN_ID: parentMetadata.run_id,
    AGENTFLOW_GRAPH_ID: parentMetadata.graph_id,
    AGENTFLOW_AGENT_ID: helperId,
    AGENTFLOW_PARENT_AGENT_ID: session.parent_agent_id,
    AGENTFLOW_EXECUTION_ID: helperId,
    AGENTFLOW_NODE_ID: helperId,
    AGENTFLOW_COMPILED_ID: helperId,
    AGENTFLOW_REPO_ALIAS: parentMetadata.repo_alias,
    AGENTFLOW_RUNTIME_METADATA: helperMetadataPath,
    AGENTFLOW_WORKSPACE: parentMetadata.workspace_path,
    AGENTFLOW_OUTPUT_DIR: outputDir,
    AGENTFLOW_CONTEXT_PACKET: parentMetadata.context_packet_path,
    AGENTFLOW_CONTEXT_MANIFEST: parentMetadata.context_manifest_path
  });

  const exitCode = await new Promise<number>((resolveExit) => {
    const child = spawn(harnessBin, args, {
      cwd: parentMetadata.workspace_path,
      env: helperEnv,
      stdio: parentMetadata.harness === "cursor-cli" ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk: Buffer) => logChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => logChunks.push(chunk));
    if (parentMetadata.harness !== "cursor-cli" && child.stdin) {
      child.stdin.end(prompt);
    }
    child.on("error", (error) => {
      logChunks.push(Buffer.from(error.message));
      resolveExit(127);
    });
    child.on("close", (code) => resolveExit(typeof code === "number" ? code : 1));
  });

  await writeFile(session.log_path, Buffer.concat(logChunks));
  const artifactPath = join(outputDir, artifactName);
  const artifactExists = await exists(artifactPath);
  const completed: HelperSession = {
    ...updated,
    status: exitCode === 0 && artifactExists ? "completed" : "failed",
    ended_at: new Date().toISOString(),
    exit_code: exitCode,
    artifacts: artifactExists ? { [artifactName]: artifactPath } : {}
  };
  await writeHelperSession(parentMetadata, completed);
  await writeJsonFile(session.result_path, {
    status: completed.status,
    exit_code: exitCode,
    artifact_exists: artifactExists
  });
  await appendJsonl(mailboxPath(parentMetadata, session.parent_agent_id), {
    message_id: `msg_${randomUUID()}`,
    run_id: parentMetadata.run_id,
    from_agent_id: helperId,
    to: session.parent_agent_id,
    type: "helper-completed",
    summary: `Helper ${helperId} ${completed.status}.`,
    artifact_refs: Object.keys(completed.artifacts),
    created_at: completed.ended_at ?? new Date().toISOString()
  });

  return {
    exitCode: completed.status === "completed" ? 0 : 1,
    output: completed
  };
}

async function waitForHelper(
  metadata: RuntimeMetadata,
  agentId: string,
  artifactName: string | undefined,
  timeoutSec: number
): Promise<AfResult> {
  const started = Date.now();
  while (Date.now() - started <= timeoutSec * 1000) {
    const session = await readHelperSessionForMetadata(metadata, agentId).catch(() => undefined);
    if (session && !["starting", "running"].includes(session.status)) {
      const artifactPath = artifactName ? session.artifacts[artifactName] : undefined;
      return {
        exitCode: session.status === "completed" ? 0 : 1,
        output: {
          command: "af wait",
          status: session.status === "completed" ? "passed" : "failed",
          agent: session,
          ...(artifactPath ? { artifact: artifactPath } : {})
        }
      };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }

  return {
    exitCode: 1,
    output: {
      command: "af wait",
      status: "failed",
      message: `Timed out waiting for ${agentId}.`
    }
  };
}

async function commandWait(
  metadata: RuntimeMetadata,
  options: Record<string, string | boolean | string[]>
): Promise<AfResult> {
  const agentId = optionString(options, "agent");
  if (!agentId) {
    throw new Error("af wait requires --agent.");
  }
  return waitForHelper(metadata, agentId, optionString(options, "artifact"), optionNumber(options, "timeout-sec", metadata.timeout_sec));
}

export async function executeAfCli(argv: string[]): Promise<AfResult> {
  const { positionals, options } = parseArgs(argv);
  if (positionals.length === 0 || options.help === true) {
    return { exitCode: 0, stdout: renderHelp() };
  }

  if (positionals[0] === "_helper-run") {
    return helperRun(options);
  }

  const metadata = requireRuntimeMetadata();
  const [command, subcommand] = positionals;

  if (command === "status") {
    return commandStatus(metadata);
  }
  if (command === "tools" && subcommand === "list") {
    return commandTools(metadata);
  }
  if (command === "context" && subcommand === "show") {
    return commandContext(metadata);
  }
  if (command === "artifact" && subcommand === "list") {
    return commandArtifactList(metadata);
  }
  if (command === "artifact" && subcommand === "write") {
    return commandArtifactWrite(metadata, positionals, options);
  }
  if (command === "artifact" && subcommand === "read") {
    return commandArtifactRead(metadata, positionals);
  }
  if (command === "channel" && subcommand === "post") {
    return commandChannelPost(metadata, options);
  }
  if (command === "channel" && subcommand === "read") {
    return commandChannelRead(metadata, options);
  }
  if (command === "inbox" && subcommand === "read") {
    return commandInboxRead(metadata, options);
  }
  if (command === "agents" && subcommand === "list") {
    return commandAgentsList(metadata);
  }
  if (command === "send") {
    const to = optionString(options, "to");
    if (!to) {
      throw new Error("af send requires --to.");
    }
    return deliverMessage(metadata, to, options);
  }
  if (command === "parent" && subcommand === "post") {
    if (!metadata.parent_agent_id) {
      return {
        exitCode: 0,
        output: {
          command: "af parent post",
          status: "passed",
          delivered: false,
          stored: false,
          reason: "agent_has_no_parent"
        }
      };
    }
    return deliverMessage(metadata, metadata.parent_agent_id, options);
  }
  if (command === "supervisor" && subcommand === "request") {
    return commandSupervisorRequest(metadata, options);
  }
  if (command === "spawn") {
    return commandSpawn(metadata, options);
  }
  if (command === "wait") {
    return commandWait(metadata, options);
  }

  return {
    exitCode: 2,
    stdout: [`Unknown af command: ${positionals.join(" ")}`, "", renderHelp()].join("\n")
  };
}

export async function runAfCli(argv = process.argv.slice(2)): Promise<number> {
  const startedAt = Date.now();
  try {
    const result = await executeAfCli(argv);
    if (process.env.AGENTFLOW_RUNTIME_METADATA && argv[0] !== "_helper-run") {
      await appendAfInvocation({
        metadata: requireRuntimeMetadata(),
        argv,
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt
      }).catch(() => undefined);
    }
    process.stdout.write(result.stdout ?? `${JSON.stringify(result.output ?? {}, null, 2)}\n`);
    process.exitCode = result.exitCode;
    return result.exitCode;
  } catch (error) {
    if (process.env.AGENTFLOW_RUNTIME_METADATA && argv[0] !== "_helper-run") {
      const message = error instanceof Error ? error.message : String(error);
      await appendAfInvocation({
        metadata: requireRuntimeMetadata(),
        argv,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        error: message
      }).catch(() => undefined);
    }
    const output = {
      command: "af",
      status: "failed",
      message: error instanceof Error ? error.message : String(error)
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = 1;
    return 1;
  }
}

function isDirectCliInvocation(argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    return (
      pathToFileURL(realpathSync(argvPath)).href
      === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
    );
  } catch {
    return false;
  }
}

if (isDirectCliInvocation(process.argv[1])) {
  await runAfCli();
}
