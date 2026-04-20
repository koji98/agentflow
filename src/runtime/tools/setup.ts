import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MissingCredentialsError,
  type MissingCredentialsScope
} from "../../auth/errors.js";
import {
  credentialEnvVarName,
  resolveScope,
  type StoreOptions
} from "../../auth/store.js";
import type { ArtifactDefinition } from "../../graph/authored.js";
import type {
  CompiledAgentNode,
  CompiledCredentialSpec,
  ResolvedTool
} from "../../graph/compiled.js";

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
  credential_specs?: Record<string, CompiledCredentialSpec>;
  credential_store_options?: StoreOptions;
  credential_env?: NodeJS.ProcessEnv;
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

function buildToolShim(executablePath: string, manifestArgs: readonly string[]): string {
  const quotedExecutable = shellSingleQuote(executablePath);
  const quotedArgs = manifestArgs.map(shellSingleQuote);
  const execLine = ["exec", quotedExecutable, ...quotedArgs, '"$@"'].join(" ");
  return [
    "#!/usr/bin/env bash",
    "# Agentflow plugin tool shim. Generated per execution; do not edit.",
    "set -eu",
    execLine,
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

  await rm(tools_dir, { recursive: true, force: true });
  await mkdir(bin_dir, { recursive: true });

  for (const tool of options.node.tools) {
    const shimPath = join(bin_dir, tool.callable_name);
    await writeFile(shimPath, buildToolShim(tool.executable_path, tool.args ?? []), "utf8");
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

  for (const tool of options.node.tools) {
    const nameSegment = toEnvSegment(tool.callable_name);
    if (!nameSegment) {
      continue;
    }
    for (const [key, value] of Object.entries(tool.config)) {
      const keySegment = toEnvSegment(key);
      if (!keySegment) {
        continue;
      }
      env[`AGENTFLOW_TOOL_${nameSegment}_${keySegment}`] = stringifyToolConfigValue(value);
    }
  }

  await injectCredentialEnv(env, options);

  return {
    bin_dir,
    tool_state_path,
    env,
    resolved_tools: options.node.tools
  };
}

function collectScopeUsage(node: CompiledAgentNode): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const tool of node.tools) {
    for (const scope of tool.credentials_required ?? []) {
      const callers = usage.get(scope) ?? [];
      const label = `${node.compiled_id} (${tool.callable_name})`;
      if (!callers.includes(label)) {
        callers.push(label);
      }
      usage.set(scope, callers);
    }
  }
  return usage;
}

async function injectCredentialEnv(
  env: Record<string, string>,
  options: PrepareAgentToolsOptions
): Promise<void> {
  const scopeUsage = collectScopeUsage(options.node);
  if (scopeUsage.size === 0) {
    return;
  }

  const specs = options.credential_specs ?? {};
  const storeOptions: StoreOptions = options.credential_store_options ?? {};
  const credentialEnv = options.credential_env ?? process.env;

  const missingScopes: MissingCredentialsScope[] = [];

  for (const [scope, usedBy] of [...scopeUsage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const spec = specs[scope];
    if (!spec) {
      missingScopes.push({
        scope,
        missing_keys: ["*"],
        used_by: usedBy
      });
      continue;
    }

    const result = await resolveScope(
      { scope, fields: spec.fields },
      { ...storeOptions, env: credentialEnv }
    );

    for (const [key, value] of Object.entries(result.resolved)) {
      env[credentialEnvVarName(scope, key)] = value;
    }

    if (result.missing_required.length > 0) {
      missingScopes.push({
        scope,
        missing_keys: [...result.missing_required],
        used_by: usedBy
      });
    }
  }

  if (missingScopes.length > 0) {
    throw new MissingCredentialsError(missingScopes);
  }
}
