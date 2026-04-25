import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultCredentialIndexPath } from "../../auth/store.js";
import type { CredentialSpecMap } from "../../auth/types.js";
import type { ArtifactDefinition } from "../../graph/authored.js";
import type { CompiledAgentNode, ResolvedTool } from "../../graph/compiled.js";

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

function buildToolShim(launcherPath: string, callableName: string): string {
  const quotedNode = shellSingleQuote(process.execPath);
  const quotedLauncher = shellSingleQuote(launcherPath);
  const quotedCallable = shellSingleQuote(callableName);
  const execLine = ["exec", quotedNode, quotedLauncher, quotedCallable, '"$@"'].join(" ");
  return [
    "#!/usr/bin/env bash",
    "# Agentflow plugin tool shim. Generated per execution; do not edit.",
    "set -eu",
    execLine,
    ""
  ].join("\n");
}

function buildToolLauncher(): string {
  return [
    "import { spawnSync } from 'node:child_process';",
    "import { readFileSync } from 'node:fs';",
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
    "  console.error(error instanceof Error ? error.message : String(error));",
    "  process.exit(1);",
    "}",
    "",
    "const result = spawnSync(tool.executable_path, [",
    "  ...(tool.args || []),",
    "  ...process.argv.slice(3)",
    "], {",
    "  stdio: 'inherit',",
    "  env: childEnv",
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
  const tools_dir = join(options.execution_dir, "agentflow-tools");
  const bin_dir = join(tools_dir, "bin");
  const tool_state_path = join(tools_dir, "state.json");
  const launcher_path = join(tools_dir, "launcher.mjs");
  const credential_config_path = join(tools_dir, "credential-config.json");

  await rm(tools_dir, { recursive: true, force: true });
  await mkdir(bin_dir, { recursive: true });
  await writeFile(launcher_path, buildToolLauncher(), "utf8");

  for (const tool of options.node.tools) {
    const shimPath = join(bin_dir, tool.callable_name);
    await writeFile(shimPath, buildToolShim(launcher_path, tool.callable_name), "utf8");
    await chmod(shimPath, 0o755);
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
          args: tool.args ?? [],
          config: Object.fromEntries(
            Object.entries(tool.config).map(([key, value]) => [key, stringifyToolConfigValue(value)])
          ),
          credentials: tool.credentials ?? []
        }
      ]))
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  await chmod(credential_config_path, 0o600);

  const env: Record<string, string> = {
    AGENTFLOW_TOOL_STATE: tool_state_path
  };

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

  if (pluginRoots.size === 1) {
    const [singleRoot] = pluginRoots.values();
    if (singleRoot) {
      env.AGENTFLOW_PLUGIN_ROOT = singleRoot;
    }
  }

  return {
    bin_dir,
    tool_state_path,
    env,
    resolved_tools: options.node.tools
  };
}
