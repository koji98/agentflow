import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MissingCredentialError } from "../../auth/errors.js";
import { createCredentialStore, defaultCredentialIndexPath } from "../../auth/store.js";
import type { CredentialSpecMap } from "../../auth/types.js";
import type { ArtifactDefinition } from "../../graph/authored.js";
import type { CompiledAgentNode, ResolvedTool } from "../../graph/compiled.js";
import type { SupervisorRecoveryEnvelope } from "../../supervisor/types.js";
import {
  resolveExecutionHumanDebugToolDirectory,
  resolveExecutionRuntimeToolDirectory
} from "../../artifacts/paths.js";
import { createAuthorityRequest, type AuthorityRequest } from "../authority.js";

export interface AgentToolSetupResult {
  bin_dir: string;
  tool_state_path: string;
  env: Record<string, string>;
  resolved_tools: ResolvedTool[];
}

interface PrepareAgentToolsOptions {
  node: CompiledAgentNode;
  execution_dir: string;
  workspace_path: string;
  artifacts_root: string;
  run_root?: string;
  runtime_dir?: string;
  writable_runtime_dir?: string;
  run_id?: string;
  graph_id?: string;
  execution_id?: string;
  parent_agent_id?: string;
  repo_alias?: string;
  harness?: "codex-cli" | "cursor-cli";
  model?: string;
  reasoning_effort?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  timeout_sec?: number;
  context_packet_path?: string;
  context_manifest_path?: string;
  supervisor_recovery_envelope?: SupervisorRecoveryEnvelope;
  credential_specs?: CredentialSpecMap;
  credential_index_path?: string;
  keychain_account?: string;
}

function toEnvSegment(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stringifyToolConfigValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildToolWrapper(launcherPath: string, callableName: string): string {
  const quotedNode = shellSingleQuote(process.execPath);
  const quotedLauncher = shellSingleQuote(launcherPath);
  const quotedCallable = shellSingleQuote(callableName);
  const execLine = ["exec", quotedNode, quotedLauncher, quotedCallable, '"$@"'].join(" ");
  return [
    "#!/usr/bin/env bash",
    "# Agentflow plugin tool wrapper. Generated per execution; do not edit.",
    "set -eu",
    execLine,
    ""
  ].join("\n");
}

function currentPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function currentAfCliPath(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const root = currentPackageRoot();
  return modulePath.endsWith(".ts")
    ? resolve(root, "src/af/index.ts")
    : resolve(root, "dist/af/index.js");
}

function buildAfWrapper(): string {
  const afCliPath = currentAfCliPath();
  const quotedNode = shellSingleQuote(process.execPath);
  const quotedAfCli = shellSingleQuote(afCliPath);
  const tsxPath = resolve(currentPackageRoot(), "node_modules/.bin/tsx");
  const quotedTsx = shellSingleQuote(tsxPath);
  const execLine = afCliPath.endsWith(".ts") && existsSync(tsxPath)
    ? ["exec", quotedTsx, quotedAfCli, '"$@"'].join(" ")
    : ["exec", quotedNode, quotedAfCli, '"$@"'].join(" ");

  return [
    "#!/usr/bin/env bash",
    "# Agentflow runtime CLI wrapper. Generated per execution; do not edit.",
    "set -eu",
    execLine,
    ""
  ].join("\n");
}

function currentAfRunnerPath(): string {
  const afCliPath = currentAfCliPath();
  const tsxPath = resolve(currentPackageRoot(), "node_modules/.bin/tsx");
  return afCliPath.endsWith(".ts") && existsSync(tsxPath)
    ? tsxPath
    : process.execPath;
}

function buildToolLauncher(): string {
  return [
    "import { spawnSync } from 'node:child_process';",
    "import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { userInfo } from 'node:os';",
    "import { fileURLToPath } from 'node:url';",
    "import { dirname, join } from 'node:path';",
    "",
    "const root = dirname(fileURLToPath(import.meta.url));",
    "const config = JSON.parse(readFileSync(join(root, 'credential-config.json'), 'utf8'));",
    "const toolName = process.argv[2];",
    "const tool = config.tools[toolName];",
    "if (!tool) {",
    "  console.error(`Unknown Agentflow tool: ${toolName}`);",
    "  process.exit(127);",
    "}",
    "",
    "function envSegment(value) {",
    "  return String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');",
    "}",
    "",
    "function credentialEnvName(scope, key) {",
    "  return `AGENTFLOW_CREDENTIAL_${envSegment(scope)}_${envSegment(key)}`;",
    "}",
    "",
    "function toolConfigEnvName(toolName, key) {",
    "  return `AGENTFLOW_TOOL_${envSegment(toolName)}_${envSegment(key)}`;",
    "}",
    "",
    "function secretLooking(value) {",
    "  return /(^|[_-])(token|secret|password|passwd|api[_-]?key|credential|authorization|bearer)([_-]|$)/i.test(String(value));",
    "}",
    "",
    "function redactArgv(argv) {",
    "  const redacted = [];",
    "  let redactNext = false;",
    "  for (const arg of argv) {",
    "    if (redactNext) {",
    "      redacted.push('<redacted>');",
    "      redactNext = false;",
    "      continue;",
    "    }",
    "    const [key] = String(arg).split('=', 1);",
    "    if (secretLooking(key)) {",
    "      redacted.push(String(arg).includes('=') ? `${key}=<redacted>` : String(arg));",
    "      redactNext = !String(arg).includes('=');",
    "      continue;",
    "    }",
    "    redacted.push(arg);",
    "  }",
    "  return redacted;",
    "}",
    "",
    "function appendInvocation(record) {",
    "  if (!config.tool_invocations_path) {",
    "    return;",
    "  }",
    "  mkdirSync(dirname(config.tool_invocations_path), { recursive: true });",
    "  appendFileSync(config.tool_invocations_path, `${JSON.stringify(record)}\\n`, 'utf8');",
    "}",
    "",
    "function nextInvocationPrefix() {",
    "  const dir = dirname(config.tool_invocations_path);",
    "  mkdirSync(dir, { recursive: true });",
    "  let count = 0;",
    "  try {",
    "    const contents = readFileSync(config.tool_invocations_path, 'utf8');",
    "    count = contents.split(/\\r?\\n/u).filter((line) => line.trim().length > 0).length;",
    "  } catch {}",
    "  return join(dir, String(count + 1).padStart(4, '0'));",
    "}",
    "",
    "const swiftGetGenericPasswordScript = `",
    "import Darwin",
    "import Foundation",
    "import Security",
    "",
    "let service = CommandLine.arguments[1]",
    "let account = CommandLine.arguments[2]",
    "",
    "let query: [String: Any] = [",
    "  kSecClass as String: kSecClassGenericPassword,",
    "  kSecAttrService as String: service,",
    "  kSecAttrAccount as String: account,",
    "  kSecReturnData as String: true,",
    "  kSecMatchLimit as String: kSecMatchLimitOne",
    "]",
    "",
    "var item: CFTypeRef?",
    "let status = SecItemCopyMatching(query as CFDictionary, &item)",
    "if status == errSecItemNotFound {",
    "  exit(44)",
    "}",
    "if status != errSecSuccess {",
    "  FileHandle.standardError.write(\"SecItemCopyMatching failed with status \\\\(status)\\\\n\".data(using: .utf8)!)",
    "  exit(1)",
    "}",
    "if let data = item as? Data {",
    "  FileHandle.standardOutput.write(data)",
    "}",
    "`;",
    "",
    "function readIndex() {",
    "  try {",
    "    return JSON.parse(readFileSync(config.credential_index_path, 'utf8'));",
    "  } catch {",
    "    return { version: '1', scopes: {} };",
    "  }",
    "}",
    "",
    "function readSecret(scope, key) {",
    "  if (process.platform !== 'darwin') {",
    "    return undefined;",
    "  }",
    "  const account = config.keychain_account || userInfo().username;",
    "  const result = spawnSync('swift', [",
    "    '-e',",
    "    swiftGetGenericPasswordScript,",
    "    `agentflow.${scope}.${key}`,",
    "    account",
    "  ], { encoding: 'utf8' });",
    "  if (result.status !== 0) {",
    "    return undefined;",
    "  }",
    "  return result.stdout.length > 0 ? result.stdout : undefined;",
    "}",
    "",
    "function resolveScope(index, scope, spec) {",
    "  const values = {};",
    "  for (const [key, field] of Object.entries(spec.fields || {})) {",
    "    let value = field.secret",
    "      ? readSecret(scope, key)",
    "      : index.scopes?.[scope]?.fields?.[key]?.value;",
    "    if ((!value || value.length === 0) && field.default !== undefined) {",
    "      value = field.default;",
    "    }",
    "    if ((!value || value.length === 0) && field.required) {",
    "      throw new Error(`Missing required credential \"${scope}.${key}\".`);",
    "    }",
    "    if (value && value.length > 0) {",
    "      values[key] = value;",
    "    }",
    "  }",
    "  return values;",
    "}",
    "",
    "const childEnv = { ...process.env };",
    "for (const key of Object.keys(childEnv)) {",
    "  if (key.startsWith('AGENTFLOW_CREDENTIAL_') || (key.startsWith('AGENTFLOW_TOOL_') && key !== 'AGENTFLOW_TOOL_STATE')) {",
    "    delete childEnv[key];",
    "  }",
    "}",
    "const passthroughArgs = process.argv.slice(3);",
    "const wantsHelp = passthroughArgs.includes('--help') || passthroughArgs.includes('-h');",
    "",
    "if (wantsHelp) {",
    "  for (const [key, value] of Object.entries(tool.config || {})) {",
    "    childEnv[toolConfigEnvName(toolName, key)] = String(value);",
    "  }",
    "  const helpArgs = passthroughArgs;",
    "  const startedAt = Date.now();",
    "  const helpLogBase = nextInvocationPrefix();",
    "  writeFileSync(`${helpLogBase}-input.json`, `${JSON.stringify({ kind: 'plugin_tool', tool: toolName, argv: redactArgv(helpArgs), cwd: process.cwd(), help: true }, null, 2)}\\n`, 'utf8');",
    "  const result = spawnSync(tool.executable_path, helpArgs, {",
    "    encoding: 'utf8',",
    "    maxBuffer: 64 * 1024 * 1024,",
    "    env: childEnv",
    "  });",
    "  if (result.stdout) {",
    "    process.stdout.write(result.stdout);",
    "  }",
    "  if (result.stderr) {",
    "    process.stderr.write(result.stderr);",
    "  }",
    "  process.stdout.write('\\nAgentflow configured defaults:\\n');",
    "  const configEntries = Object.entries(tool.config || {});",
    "  if (configEntries.length === 0) {",
    "    process.stdout.write('  (none)\\n');",
    "  } else {",
    "    for (const [key, value] of configEntries) {",
    "      const rendered = secretLooking(key) ? '<redacted>' : String(value);",
    "      process.stdout.write(`  ${key}: ${rendered}\\n`);",
    "    }",
    "  }",
    "  appendInvocation({",
    "    ts: new Date().toISOString(),",
    "    run_id: config.run_id,",
    "    graph_id: config.graph_id,",
    "    agent_id: config.agent_id,",
    "    execution_id: config.execution_id,",
    "    node_id: config.node_id,",
    "    compiled_id: config.compiled_id,",
    "    kind: 'plugin_tool',",
    "    tool: toolName,",
    "    source: tool.source,",
    "    argv: redactArgv(helpArgs),",
    "    cwd: process.cwd(),",
    "    exit_code: result.status ?? (result.error ? 127 : 1),",
    "    duration_ms: Date.now() - startedAt,",
    "    input_path: `${helpLogBase}-input.json`,",
    "    output_path: `${helpLogBase}-output.json`,",
    "    redaction: 'secret-looking argv values redacted; credential env omitted for help'",
    "  });",
    "  writeFileSync(`${helpLogBase}-output.json`, `${JSON.stringify({ exit_code: result.status ?? (result.error ? 127 : 1), stdout: result.stdout || '', stderr: result.stderr || '', error: result.error ? result.error.message : undefined }, null, 2)}\\n`, 'utf8');",
    "  if (result.error) {",
    "    console.error(result.error.message);",
    "    process.exit(127);",
    "  }",
    "  process.exit(result.status ?? 0);",
    "}",
    "",
    "try {",
    "  const index = readIndex();",
    "  for (const [key, value] of Object.entries(tool.config || {})) {",
    "    childEnv[toolConfigEnvName(toolName, key)] = String(value);",
    "  }",
    "  for (const scope of tool.credentials || []) {",
    "    const spec = config.credential_specs[scope];",
    "    if (!spec) {",
    "      throw new Error(`Tool ${toolName} requires unavailable credential scope \"${scope}\".`);",
    "    }",
    "    const values = resolveScope(index, scope, spec);",
    "    for (const [key, value] of Object.entries(values)) {",
    "      childEnv[credentialEnvName(scope, key)] = value;",
    "    }",
    "  }",
    "} catch (error) {",
    "  const errorMessage = error instanceof Error ? error.message : String(error);",
    "  const failureLogBase = nextInvocationPrefix();",
    "  const failureOutputPath = `${failureLogBase}-output.json`;",
    "  writeFileSync(`${failureLogBase}-input.json`, `${JSON.stringify({ kind: 'plugin_tool', tool: toolName, argv: redactArgv(passthroughArgs), cwd: process.cwd(), credential_resolution: true }, null, 2)}\\n`, 'utf8');",
    "  writeFileSync(failureOutputPath, `${JSON.stringify({ exit_code: 1, stdout: '', stderr: `${errorMessage}\\n`, error: errorMessage, credential_resolution_failed: true }, null, 2)}\\n`, 'utf8');",
    "  appendInvocation({",
    "    ts: new Date().toISOString(),",
    "    run_id: config.run_id,",
    "    graph_id: config.graph_id,",
    "    agent_id: config.agent_id,",
    "    execution_id: config.execution_id,",
    "    node_id: config.node_id,",
    "    compiled_id: config.compiled_id,",
    "    kind: 'plugin_tool',",
    "    tool: toolName,",
    "    source: tool.source,",
    "    argv: redactArgv(passthroughArgs),",
    "    cwd: process.cwd(),",
    "    exit_code: 1,",
    "    duration_ms: 0,",
    "    input_path: `${failureLogBase}-input.json`,",
    "    output_path: failureOutputPath,",
    "    redaction: 'secret-looking argv values redacted; credential env omitted'",
    "  });",
    "  console.error(errorMessage);",
    "  process.exit(1);",
    "}",
    "",
    "const invocationArgs = passthroughArgs;",
    "const startedAt = Date.now();",
    "const logBase = nextInvocationPrefix();",
    "writeFileSync(`${logBase}-input.json`, `${JSON.stringify({ kind: 'plugin_tool', tool: toolName, argv: redactArgv(invocationArgs), cwd: process.cwd() }, null, 2)}\\n`, 'utf8');",
    "const result = spawnSync(tool.executable_path, invocationArgs, {",
    "  encoding: 'utf8',",
    "  maxBuffer: 64 * 1024 * 1024,",
    "  env: childEnv",
    "});",
    "",
    "if (result.stdout) {",
    "  process.stdout.write(result.stdout);",
    "}",
    "if (result.stderr) {",
    "  process.stderr.write(result.stderr);",
    "}",
    "const outputPath = `${logBase}-output.json`;",
    "writeFileSync(outputPath, `${JSON.stringify({ exit_code: result.status ?? (result.error ? 127 : 1), stdout: result.stdout || '', stderr: result.stderr || '', error: result.error ? result.error.message : undefined }, null, 2)}\\n`, 'utf8');",
    "appendInvocation({",
    "  ts: new Date().toISOString(),",
    "  run_id: config.run_id,",
    "  graph_id: config.graph_id,",
    "  agent_id: config.agent_id,",
    "  execution_id: config.execution_id,",
    "  node_id: config.node_id,",
    "  compiled_id: config.compiled_id,",
    "  kind: 'plugin_tool',",
    "  tool: toolName,",
    "  source: tool.source,",
    "  argv: redactArgv(invocationArgs),",
    "  cwd: process.cwd(),",
    "  exit_code: result.status ?? (result.error ? 127 : 1),",
    "  duration_ms: Date.now() - startedAt,",
    "  input_path: `${logBase}-input.json`,",
    "  output_path: outputPath,",
    "  redaction: 'secret-looking argv values redacted; credential env omitted'",
    "});",
    "",
    "if (result.error) {",
    "  console.error(result.error.message);",
    "  process.exit(127);",
    "}",
    "",
    "if (result.signal) {",
    "  process.kill(process.pid, result.signal);",
    "}",
    "",
    "process.exit(result.status ?? 0);",
    ""
  ].join("\n");
}

export async function collectMissingToolCredentialAuthorityRequests(options: {
  tools: ResolvedTool[];
  credential_specs?: CredentialSpecMap;
  execution_id: string;
  credential_index_path?: string;
}): Promise<AuthorityRequest[]> {
  const specs = options.credential_specs ?? {};
  const store = createCredentialStore(options.credential_index_path
    ? { index_path: options.credential_index_path }
    : {});
  const requests: AuthorityRequest[] = [];
  const checked = new Set<string>();

  for (const tool of options.tools) {
    for (const scope of tool.credentials ?? []) {
      const checkedKey = `${tool.callable_name}:${scope}`;
      if (checked.has(checkedKey)) {
        continue;
      }
      checked.add(checkedKey);

      const spec = specs[scope];
      if (!spec) {
        continue;
      }

      try {
        await store.resolveScope(spec, scope);
      } catch (error) {
        if (!(error instanceof MissingCredentialError)) {
          throw error;
        }
        const credential = `${error.scope}.${error.key}`;
        const safeCredential = credential.replace(/[^a-zA-Z0-9_.-]/g, "_");
        requests.push(createAuthorityRequest({
          request_id: `${options.execution_id}__${tool.callable_name}__missing_credential__${safeCredential}`,
          kind: "missing_credential",
          source: "plugin_tool",
          summary: `Plugin tool ${tool.callable_name} requires credential ${credential}.`,
          evidence: {
            tool: tool.callable_name,
            credential,
            ...(tool.source.kind === "plugin" ? { plugin: tool.source.alias } : {})
          }
        }));
      }
    }
  }

  return [...new Map(requests.map((request) => [request.request_id, request])).values()];
}

function serializeDeclaredArtifacts(
  artifacts: Record<string, ArtifactDefinition>
): Record<string, { from: string; path: string; description: string }> {
  const result: Record<string, { from: string; path: string; description: string }> = {};
  for (const [name, definition] of Object.entries(artifacts)) {
    result[name] = {
      from: definition.from,
      path: definition.path,
      description: definition.description
    };
  }
  return result;
}

export async function prepareAgentTools(
  options: PrepareAgentToolsOptions
): Promise<AgentToolSetupResult> {
  const tools_dir = resolveExecutionRuntimeToolDirectory(options.execution_dir);
  const bin_dir = join(tools_dir, "bin");
  const tool_state_path = join(tools_dir, "state.json");
  const launcher_path = join(tools_dir, "launcher.mjs");
  const credential_config_path = join(tools_dir, "credential-config.json");
  const runtime_metadata_path = join(tools_dir, "runtime.json");
  const toolInvocationDir = options.writable_runtime_dir
    ? join(options.writable_runtime_dir, "tools")
    : resolveExecutionHumanDebugToolDirectory(options.execution_dir);
  const tool_invocations_path = join(toolInvocationDir, "index.jsonl");

  await rm(tools_dir, { recursive: true, force: true });
  const runRoot = options.run_root ?? options.execution_dir;
  const runtimeDir = options.runtime_dir ?? join(runRoot, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(bin_dir, { recursive: true });
  await writeFile(launcher_path, buildToolLauncher(), "utf8");
  await writeFile(join(bin_dir, "af"), buildAfWrapper(), "utf8");
  await chmod(join(bin_dir, "af"), 0o755);

  for (const tool of options.node.tools) {
    if (tool.callable_name === "af") {
      throw new Error('Plugin tool callable name "af" is reserved for the Agentflow runtime CLI.');
    }
    const wrapperPath = join(bin_dir, tool.callable_name);
    await writeFile(wrapperPath, buildToolWrapper(launcher_path, tool.callable_name), "utf8");
    await chmod(wrapperPath, 0o755);
  }

  const state = {
    version: "1" as const,
    node_id: options.node.authored_id,
    compiled_id: options.node.compiled_id,
    workspace_path: options.workspace_path,
    artifacts_root: options.artifacts_root,
    declared_artifacts: serializeDeclaredArtifacts(options.node.declared_artifacts)
  };

  await writeFile(tool_state_path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const runId = options.run_id ?? "unknown-run";
  const graphId = options.graph_id ?? "unknown-graph";
  const executionId = options.execution_id ?? options.node.compiled_id;
  const repoAlias = options.repo_alias ?? options.node.repo;
  const sandbox = options.sandbox ?? options.node.effective_policy?.sandbox ?? "workspace-write";
  const timeoutSec = options.timeout_sec ?? options.node.effective_policy?.timeout_sec ?? 0;
  const runtimeMetadata = {
    version: "1",
    run_root: runRoot,
    run_id: runId,
    graph_id: graphId,
    agent_id: executionId,
    ...(options.parent_agent_id ? { parent_agent_id: options.parent_agent_id } : {}),
    execution_id: executionId,
    node_id: options.node.authored_id,
    compiled_id: options.node.compiled_id,
    repo_alias: repoAlias,
    workspace_path: options.workspace_path,
    output_dir: options.artifacts_root,
    runtime_dir: runtimeDir,
    context_packet_path: options.context_packet_path ?? "",
    context_manifest_path: options.context_manifest_path ?? "",
    ...(options.supervisor_recovery_envelope ? { supervisor_recovery_envelope: options.supervisor_recovery_envelope } : {}),
    tool_state_path,
    tool_bin_dir: bin_dir,
    tool_invocations_path,
    credential_index_path: options.credential_index_path ?? defaultCredentialIndexPath,
    ...(options.keychain_account ? { keychain_account: options.keychain_account } : {}),
    credential_specs: options.credential_specs ?? {},
    declared_artifacts: options.node.declared_artifacts,
    tools: options.node.tools,
    ...(options.harness ? { harness: options.harness } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoning_effort ? { reasoning_effort: options.reasoning_effort } : {}),
    sandbox,
    timeout_sec: timeoutSec
  };
  await writeFile(runtime_metadata_path, `${JSON.stringify(runtimeMetadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(runtime_metadata_path, 0o600);
  await writeFile(
    credential_config_path,
    `${JSON.stringify({
      version: "1",
      credential_index_path: options.credential_index_path ?? defaultCredentialIndexPath,
      ...(options.keychain_account ? { keychain_account: options.keychain_account } : {}),
      credential_specs: options.credential_specs ?? {},
      tools: Object.fromEntries(options.node.tools.map((tool) => [
        tool.callable_name,
        {
          executable_path: tool.executable_path,
          config: Object.fromEntries(
            Object.entries(tool.config).map(([key, value]) => [key, stringifyToolConfigValue(value)])
          ),
          credentials: tool.credentials ?? [],
          source: tool.source
        }
      ])),
      run_id: runId,
      graph_id: graphId,
      agent_id: executionId,
      execution_id: executionId,
      node_id: options.node.authored_id,
      compiled_id: options.node.compiled_id,
      tool_invocations_path
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  await chmod(credential_config_path, 0o600);

  const env: Record<string, string> = {
    AGENTFLOW_TOOL_STATE: tool_state_path,
    AGENTFLOW_TOOL_INVOCATIONS: tool_invocations_path,
    AGENTFLOW_RUNTIME_METADATA: runtime_metadata_path,
    AGENTFLOW_AF_CLI: currentAfCliPath(),
    AGENTFLOW_AF_RUNNER: currentAfRunnerPath(),
    AGENTFLOW_AF_BROKER_DIR: await mkdtemp(join(tmpdir(), "agentflow-af-broker-")),
    AGENTFLOW_SPAWN_MODE: "broker",
    AGENTFLOW_RUN_ROOT: runRoot,
    AGENTFLOW_RUNTIME_DIR: runtimeDir,
    AGENTFLOW_RUN_ID: runId,
    AGENTFLOW_GRAPH_ID: graphId,
    AGENTFLOW_AGENT_ID: executionId,
    AGENTFLOW_EXECUTION_ID: executionId,
    AGENTFLOW_NODE_ID: options.node.authored_id,
    AGENTFLOW_COMPILED_ID: options.node.compiled_id,
    AGENTFLOW_REPO_ALIAS: repoAlias
  };
  if (options.parent_agent_id) {
    env.AGENTFLOW_PARENT_AGENT_ID = options.parent_agent_id;
  }

  const pluginRoots = new Map<string, string>();
  for (const tool of options.node.tools) {
    if (tool.source.kind === "plugin") {
      const aliasSegment = toEnvSegment(tool.source.alias);
      if (!pluginRoots.has(aliasSegment)) {
        pluginRoots.set(aliasSegment, tool.source.plugin_root);
      }
    }
  }

  for (const [aliasSegment, pluginRoot] of pluginRoots.entries()) {
    env[`AGENTFLOW_PLUGIN_ROOT_${aliasSegment}`] = pluginRoot;
  }

  return {
    bin_dir,
    tool_state_path,
    env,
    resolved_tools: options.node.tools
  };
}
