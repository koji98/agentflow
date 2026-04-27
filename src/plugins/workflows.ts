import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { resolveSubpathWithinRoot } from "../path_rules.js";
import type { CredentialScopeSpec } from "../auth/types.js";
import type { ArtifactDefinition, ContextItem } from "../graph/authored.js";
import {
  readConfigValue as sharedReadConfigValue,
  rewriteConfigPlaceholders,
  validateConfigAgainstSchema as sharedValidateConfigAgainstSchema
} from "../graph/config.js";
import type { GraphDiagnostic } from "../graph/schema.js";
import type { LoweredManagedNode } from "../graph/normalize.js";

const execFileAsync = promisify(execFile);

export const pluginLockFileName = "agentflow.plugins.lock.json";

export type PluginDeclaration = GitPluginDeclaration | LocalPluginDeclaration;

export interface GitPluginDeclaration {
  kind: "git";
  source: string;
  ref: string;
}

export interface LocalPluginDeclaration {
  kind: "local";
  path: string;
}

export interface PluginLockEntry {
  kind: "git" | "local";
  source: string;
  ref: string;
  commit: string;
  manifest_digest: string;
  cache_path: string;
  path?: string;
  tool_digests?: Record<string, string>;
  content_digest?: string;
}

export interface PluginLockFile {
  version: "1";
  plugins: Record<string, PluginLockEntry>;
}

export interface ResolvedPlugin {
  alias: string;
  kind: "git" | "local";
  source: string;
  ref: string;
  commit: string;
  manifest_digest: string;
  root: string;
  manifest: PluginManifest;
}

export interface PluginManifest {
  schema: "agentflow.plugin/1";
  id: string;
  version: string;
  workflows: Record<string, PluginWorkflowExport>;
  tools: Record<string, PluginToolExport>;
  credentials: Record<string, CredentialScopeSpec>;
}

export interface PluginWorkflowExport {
  path: string;
  description?: string;
}

export interface PluginToolExport {
  executable: string;
  capability: "context" | "verification" | "mutation" | "reporting";
  impact: "read" | "write" | "external" | "secret";
  description?: string;
  args?: string[];
  usage?: string;
  config_schema?: Record<string, unknown>;
  credentials?: string[];
}

export interface WorkflowManifest {
  schema: "agentflow.workflow/1";
  id: string;
  config_schema?: string;
  graph: string;
  publish_node: string;
  published_artifacts: Record<string, ArtifactDefinition>;
}

export interface PluginExpansionResult {
  document: unknown;
  diagnostics: GraphDiagnostic[];
  lowered_managed_nodes: LoweredManagedNode[];
  resolved_plugins: ResolvedPlugin[];
}

export interface ResolvePluginsResult {
  graph_path: string;
  lockfile_path: string;
  diagnostics: GraphDiagnostic[];
  resolved_plugins: PluginLockEntryWithAlias[];
}

export interface PluginLockEntryWithAlias extends PluginLockEntry {
  alias: string;
}

const pluginIdentifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function digestFile(path: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function lockfilePathForGraph(graphPath: string): string {
  return join(dirname(graphPath), pluginLockFileName);
}

function pluginCacheRootForGraph(graphPath: string): string {
  return join(dirname(graphPath), ".agentflow", "plugins");
}

async function digestDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === ".agentflow" ||
        entry.name === pluginLockFileName
      ) {
        continue;
      }

      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  await walk(root);
  for (const file of files.sort((left, right) => left.localeCompare(right))) {
    const relativePath = relative(root, file);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }

  return `sha256:${hash.digest("hex")}`;
}

function readStringField(
  record: Record<string, unknown>,
  field: string,
  path: string,
  diagnostics: GraphDiagnostic[]
): string | undefined {
  const value = record[field];

  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push({
      path: `${path}.${field}`,
      message: "Expected a non-empty string."
    });
    return undefined;
  }

  return value;
}

function readEnumField<TValue extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly TValue[],
  path: string,
  diagnostics: GraphDiagnostic[]
): TValue | undefined {
  const value = readStringField(record, field, path, diagnostics);

  if (!value) {
    return undefined;
  }

  if (!allowed.includes(value as TValue)) {
    diagnostics.push({
      path: `${path}.${field}`,
      message: `Expected one of: ${allowed.join(", ")}.`
    });
    return undefined;
  }

  return value as TValue;
}

function pushUnknownFieldDiagnostics(
  record: Record<string, unknown>,
  path: string,
  allowedKeys: readonly string[],
  diagnostics: GraphDiagnostic[]
): void {
  const allowed = new Set(allowedKeys);
  Object.keys(record)
    .filter((key) => !allowed.has(key))
    .sort()
    .forEach((key) => {
      diagnostics.push({
        path: `${path}.${key}`,
        message: `Unknown field "${key}" is not part of the plugin workflow contract.`
      });
    });
}

function isPluginIdentifier(value: string): boolean {
  return pluginIdentifierPattern.test(value);
}

export function readPluginDeclarations(
  document: unknown,
  diagnostics: GraphDiagnostic[]
): Record<string, PluginDeclaration> {
  const documentRecord = asRecord(document);
  const pluginsValue = documentRecord?.plugins;

  if (pluginsValue === undefined) {
    return {};
  }

  const pluginsRecord = asRecord(pluginsValue);
  if (!pluginsRecord) {
    diagnostics.push({
      path: "$.plugins",
      message: "plugins must be an object keyed by plugin alias."
    });
    return {};
  }

  const declarations: Record<string, PluginDeclaration> = {};

  Object.entries(pluginsRecord).forEach(([alias, value]) => {
    const path = `$.plugins.${alias}`;
    const record = asRecord(value);

    if (!isPluginIdentifier(alias)) {
      diagnostics.push({
        path,
        message: "Plugin aliases must use letters, numbers, underscores, or hyphens, and must start with a letter or number."
      });
      return;
    }

    if (!record) {
      diagnostics.push({
        path,
        message: "Plugin declaration must be an object."
      });
      return;
    }

    pushUnknownFieldDiagnostics(record, path, ["source", "ref", "path"], diagnostics);
    const hasPath = record.path !== undefined;
    const hasGitSource = record.source !== undefined || record.ref !== undefined;

    if (hasPath && hasGitSource) {
      diagnostics.push({
        path,
        message: "Plugin declaration must use either { path } for a local folder or { source, ref } for a git plugin, not both."
      });
      return;
    }

    if (hasPath) {
      const localPath = readStringField(record, "path", path, diagnostics);
      if (localPath) {
        declarations[alias] = { kind: "local", path: localPath };
      }
      return;
    }

    const source = readStringField(record, "source", path, diagnostics);
    const ref = readStringField(record, "ref", path, diagnostics);

    if (source && ref) {
      declarations[alias] = { kind: "git", source, ref };
    }
  });

  return declarations;
}

async function readLockFile(graphPath: string): Promise<PluginLockFile | undefined> {
  try {
    const parsed = await readJsonFile(lockfilePathForGraph(graphPath));
    const record = asRecord(parsed);
    const plugins = asRecord(record?.plugins);

    if (!record || record.version !== "1" || !plugins) {
      return undefined;
    }

    return parsed as PluginLockFile;
  } catch {
    return undefined;
  }
}

function normalizeManifest(value: unknown, path: string, diagnostics: GraphDiagnostic[]): PluginManifest | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({ path, message: "Plugin manifest must be an object." });
    return undefined;
  }

  const schema = readStringField(record, "schema", path, diagnostics);
  const id = readStringField(record, "id", path, diagnostics);
  const version = readStringField(record, "version", path, diagnostics);
  const workflowsRecord = asRecord(record.workflows);
  const credentialsRecord = record.credentials === undefined ? {} : asRecord(record.credentials);
  const toolsValue = record.tools;
  const toolsRecord = toolsValue === undefined ? {} : asRecord(toolsValue);

  if (schema && schema !== "agentflow.plugin/1") {
    diagnostics.push({ path: `${path}.schema`, message: 'Plugin manifest schema must be "agentflow.plugin/1".' });
  }

  if (!workflowsRecord) {
    diagnostics.push({ path: `${path}.workflows`, message: "Plugin manifest workflows must be an object." });
  }

  if (toolsValue !== undefined && !toolsRecord) {
    diagnostics.push({ path: `${path}.tools`, message: "Plugin manifest tools must be an object when provided." });
  }

  if (record.credentials !== undefined && !credentialsRecord) {
    diagnostics.push({ path: `${path}.credentials`, message: "Plugin manifest credentials must be an object when provided." });
  }

  const workflows: Record<string, PluginWorkflowExport> = {};
  Object.entries(workflowsRecord ?? {}).forEach(([workflowId, workflowValue]) => {
    const workflowRecord = asRecord(workflowValue);
    if (!workflowRecord) {
      diagnostics.push({ path: `${path}.workflows.${workflowId}`, message: "Workflow export must be an object." });
      return;
    }
    if (!isPluginIdentifier(workflowId)) {
      diagnostics.push({
        path: `${path}.workflows.${workflowId}`,
        message: "Workflow ids must use letters, numbers, underscores, or hyphens, and must start with a letter or number."
      });
      return;
    }

    const workflowPath = readStringField(workflowRecord, "path", `${path}.workflows.${workflowId}`, diagnostics);
    const description =
      typeof workflowRecord.description === "string" && workflowRecord.description.trim().length > 0
        ? workflowRecord.description
        : undefined;
    if (workflowPath) {
      workflows[workflowId] = {
        path: workflowPath,
        ...(description ? { description } : {})
      };
    }
  });

  const credentials: Record<string, CredentialScopeSpec> = {};
  Object.entries(credentialsRecord ?? {}).forEach(([scopeName, scopeValue]) => {
    const scopePath = `${path}.credentials.${scopeName}`;
    const scopeRecord = asRecord(scopeValue);
    if (!scopeRecord) {
      diagnostics.push({ path: scopePath, message: "Credential scope must be an object." });
      return;
    }
    if (!isPluginIdentifier(scopeName)) {
      diagnostics.push({
        path: scopePath,
        message: "Credential scope ids must use letters, numbers, underscores, or hyphens, and must start with a letter or number."
      });
      return;
    }

    const fieldsRecord = asRecord(scopeRecord.fields);
    if (!fieldsRecord) {
      diagnostics.push({ path: `${scopePath}.fields`, message: "Credential scope fields must be an object." });
      return;
    }

    const fields: CredentialScopeSpec["fields"] = {};
    for (const [fieldName, fieldValue] of Object.entries(fieldsRecord)) {
      const fieldPath = `${scopePath}.fields.${fieldName}`;
      const fieldRecord = asRecord(fieldValue);
      if (!fieldRecord) {
        diagnostics.push({ path: fieldPath, message: "Credential field must be an object." });
        continue;
      }
      if (!isPluginIdentifier(fieldName)) {
        diagnostics.push({
          path: fieldPath,
          message: "Credential field ids must use letters, numbers, underscores, or hyphens, and must start with a letter or number."
        });
        continue;
      }

      const secret = fieldRecord.secret === undefined ? true : fieldRecord.secret;
      const required = fieldRecord.required === undefined ? true : fieldRecord.required;
      if (typeof secret !== "boolean") {
        diagnostics.push({ path: `${fieldPath}.secret`, message: "Credential field secret must be a boolean." });
        continue;
      }
      if (typeof required !== "boolean") {
        diagnostics.push({ path: `${fieldPath}.required`, message: "Credential field required must be a boolean." });
        continue;
      }
      if (secret && fieldRecord.default !== undefined) {
        diagnostics.push({ path: `${fieldPath}.default`, message: "Secret credential fields cannot declare default values." });
        continue;
      }

      fields[fieldName] = {
        secret,
        required,
        ...(typeof fieldRecord.description === "string" && fieldRecord.description.trim().length > 0
          ? { description: fieldRecord.description }
          : {}),
        ...(typeof fieldRecord.default === "string" ? { default: fieldRecord.default } : {})
      };
    }

    credentials[scopeName] = {
      ...(typeof scopeRecord.description === "string" && scopeRecord.description.trim().length > 0
        ? { description: scopeRecord.description }
        : {}),
      fields
    };
  });

  const tools: Record<string, PluginToolExport> = {};
  Object.entries(toolsRecord ?? {}).forEach(([toolName, toolValue]) => {
    const toolRecord = asRecord(toolValue);
    if (!toolRecord) {
      diagnostics.push({ path: `${path}.tools.${toolName}`, message: "Tool export must be an object." });
      return;
    }

    const executable = readStringField(toolRecord, "executable", `${path}.tools.${toolName}`, diagnostics);
    const capability = readEnumField(
      toolRecord,
      "capability",
      ["context", "verification", "mutation", "reporting"],
      `${path}.tools.${toolName}`,
      diagnostics
    );
    const impact = readEnumField(
      toolRecord,
      "impact",
      ["read", "write", "external", "secret"],
      `${path}.tools.${toolName}`,
      diagnostics
    );
    const description =
      typeof toolRecord.description === "string" && toolRecord.description.trim().length > 0
        ? toolRecord.description
        : undefined;
    if (!description) {
      diagnostics.push({
        path: `${path}.tools.${toolName}.description`,
        message: "Tool description is required so agents can choose the right CLI before reading --help."
      });
    }
    const usage =
      typeof toolRecord.usage === "string" && toolRecord.usage.trim().length > 0
        ? toolRecord.usage
        : undefined;
    if (!usage) {
      diagnostics.push({
        path: `${path}.tools.${toolName}.usage`,
        message: "Tool usage is required as a concise prompt hint; the executable --help output remains the authoritative detailed contract."
      });
    }
    let args: string[] | undefined;
    if (toolRecord.args !== undefined) {
      if (!Array.isArray(toolRecord.args) || toolRecord.args.some((entry) => typeof entry !== "string")) {
        diagnostics.push({ path: `${path}.tools.${toolName}.args`, message: "Tool args must be an array of strings." });
      } else {
        args = toolRecord.args as string[];
      }
    }
    let config_schema: Record<string, unknown> | undefined;
    if (toolRecord.config_schema !== undefined) {
      const schemaRecord = asRecord(toolRecord.config_schema);
      if (!schemaRecord) {
        diagnostics.push({ path: `${path}.tools.${toolName}.config_schema`, message: "Tool config_schema must be an object." });
      } else {
        config_schema = schemaRecord;
      }
    }
    let credentialScopes: string[] | undefined;
    if (toolRecord.credentials !== undefined) {
      if (!Array.isArray(toolRecord.credentials) || toolRecord.credentials.some((entry) => typeof entry !== "string")) {
        diagnostics.push({ path: `${path}.tools.${toolName}.credentials`, message: "Tool credentials must be an array of credential scope strings." });
      } else {
        credentialScopes = [...new Set(toolRecord.credentials as string[])];
        credentialScopes.forEach((scopeName, credentialIndex) => {
          if (!credentials[scopeName]) {
            diagnostics.push({
              path: `${path}.tools.${toolName}.credentials[${credentialIndex}]`,
              message: `Tool credential reference uses unknown credential scope "${scopeName}".`
            });
          }
        });
      }
    }

    if (executable && capability && impact) {
      tools[toolName] = {
        executable,
        capability,
        impact,
        ...(description ? { description } : {}),
        ...(args ? { args } : {}),
        ...(usage ? { usage } : {}),
        ...(config_schema ? { config_schema } : {}),
        ...(credentialScopes && credentialScopes.length > 0 ? { credentials: credentialScopes } : {})
      };
    }
  });

  if (!schema || schema !== "agentflow.plugin/1" || !id || !version || !workflowsRecord) {
    return undefined;
  }

  return {
    schema: "agentflow.plugin/1",
    id,
    version,
    workflows,
    tools,
    credentials
  };
}

function normalizeWorkflowManifest(value: unknown, path: string, diagnostics: GraphDiagnostic[]): WorkflowManifest | undefined {
  const record = asRecord(value);

  if (!record) {
    diagnostics.push({ path, message: "Workflow manifest must be an object." });
    return undefined;
  }

  const schema = readStringField(record, "schema", path, diagnostics);
  const id = readStringField(record, "id", path, diagnostics);
  const graph = readStringField(record, "graph", path, diagnostics);
  const publish_node = readStringField(record, "publish_node", path, diagnostics);
  const config_schema =
    record.config_schema === undefined
      ? undefined
      : readStringField(record, "config_schema", path, diagnostics);
  const published_artifacts = asRecord(record.published_artifacts);

  if (schema && schema !== "agentflow.workflow/1") {
    diagnostics.push({ path: `${path}.schema`, message: 'Workflow manifest schema must be "agentflow.workflow/1".' });
  }

  if (!published_artifacts) {
    diagnostics.push({ path: `${path}.published_artifacts`, message: "Workflow published_artifacts must be an object." });
  }

  if (!schema || schema !== "agentflow.workflow/1" || !id || !graph || !publish_node || !published_artifacts) {
    return undefined;
  }

  return {
    schema: "agentflow.workflow/1",
    id,
    graph,
    publish_node,
    ...(config_schema ? { config_schema } : {}),
    published_artifacts: published_artifacts as Record<string, ArtifactDefinition>
  };
}

async function loadManifest(pluginRoot: string, path: string, diagnostics: GraphDiagnostic[]): Promise<PluginManifest | undefined> {
  const manifestPath = join(pluginRoot, "agentflow.plugin.json");
  try {
    return normalizeManifest(await readJsonFile(manifestPath), path, diagnostics);
  } catch (error) {
    diagnostics.push({
      path,
      message: error instanceof Error ? `Failed to read plugin manifest: ${error.message}` : "Failed to read plugin manifest."
    });
    return undefined;
  }
}

function resolvePluginSubpath(root: string, subpath: string, label: string): string {
  return resolveSubpathWithinRoot(root, subpath, label);
}

function resolveLocalPluginPath(graphPath: string, localPath: string): string {
  return isAbsolute(localPath) ? localPath : resolve(dirname(graphPath), localPath);
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, cwd ? { cwd } : undefined);
  return String(result.stdout).trim();
}

export async function resolvePluginsForGraph(
  currentWorkingDirectory: string,
  graphPath: string
): Promise<ResolvePluginsResult> {
  const absoluteGraphPath = resolve(currentWorkingDirectory, graphPath);
  const diagnostics: GraphDiagnostic[] = [];
  const parsed = await readJsonFile(absoluteGraphPath);
  const declarations = readPluginDeclarations(parsed, diagnostics);
  const cacheRoot = pluginCacheRootForGraph(absoluteGraphPath);
  const resolvedPlugins: PluginLockEntryWithAlias[] = [];

  if (diagnostics.length > 0) {
    return {
      graph_path: absoluteGraphPath,
      lockfile_path: lockfilePathForGraph(absoluteGraphPath),
      diagnostics,
      resolved_plugins: resolvedPlugins
    };
  }

  await mkdir(cacheRoot, { recursive: true });

  for (const [alias, declaration] of Object.entries(declarations)) {
    const aliasRoot = join(cacheRoot, alias);
    const tempRoot = join(aliasRoot, "_resolving");

    try {
      if (declaration.kind === "local") {
        const pluginRoot = resolveLocalPluginPath(absoluteGraphPath, declaration.path);
        const manifestPath = join(pluginRoot, "agentflow.plugin.json");
        const manifestDigest = await digestFile(manifestPath);
        const manifestForDigest = normalizeManifest(
          await readJsonFile(manifestPath),
          `$.plugins.${alias}`,
          diagnostics
        );
        const toolDigests: Record<string, string> = {};
        if (manifestForDigest) {
          for (const [toolName, tool] of Object.entries(manifestForDigest.tools)) {
            try {
              const toolPath = resolvePluginSubpath(
                pluginRoot,
                tool.executable,
                `Plugin tool "${alias}/${toolName}" executable`
              );
              toolDigests[toolName] = await digestFile(toolPath);
            } catch (toolError) {
              diagnostics.push({
                path: `$.plugins.${alias}.tools.${toolName}`,
                message: toolError instanceof Error
                  ? `Failed to digest tool executable: ${toolError.message}`
                  : "Failed to digest tool executable."
              });
            }
          }
        }

        resolvedPlugins.push({
          alias,
          kind: "local",
          source: declaration.path,
          ref: "local",
          commit: "local",
          path: declaration.path,
          manifest_digest: manifestDigest,
          cache_path: declaration.path,
          content_digest: await digestDirectory(pluginRoot),
          ...(Object.keys(toolDigests).length > 0 ? { tool_digests: toolDigests } : {})
        });
        continue;
      }

      await mkdir(aliasRoot, { recursive: true });
      await rm(tempRoot, { recursive: true, force: true });
      await git(["clone", declaration.source, tempRoot]);
      await git(["checkout", declaration.ref], tempRoot);
      const commit = await git(["rev-parse", "HEAD"], tempRoot);
      const finalRoot = join(aliasRoot, commit);
      await rm(finalRoot, { recursive: true, force: true });
      await rename(tempRoot, finalRoot);

      const manifestPath = join(finalRoot, "agentflow.plugin.json");
      const manifestDigest = await digestFile(manifestPath);
      const manifestForDigest = normalizeManifest(
        await readJsonFile(manifestPath),
        `$.plugins.${alias}`,
        diagnostics
      );
      const toolDigests: Record<string, string> = {};
      if (manifestForDigest) {
        for (const [toolName, tool] of Object.entries(manifestForDigest.tools)) {
          try {
            const toolPath = resolvePluginSubpath(
              finalRoot,
              tool.executable,
              `Plugin tool "${alias}/${toolName}" executable`
            );
            toolDigests[toolName] = await digestFile(toolPath);
          } catch (toolError) {
            diagnostics.push({
              path: `$.plugins.${alias}.tools.${toolName}`,
              message: toolError instanceof Error
                ? `Failed to digest tool executable: ${toolError.message}`
                : "Failed to digest tool executable."
            });
          }
        }
      }
      resolvedPlugins.push({
        alias,
        kind: "git",
        source: declaration.source,
        ref: declaration.ref,
        commit,
        manifest_digest: manifestDigest,
        cache_path: `.agentflow/plugins/${alias}/${commit}`,
        ...(Object.keys(toolDigests).length > 0 ? { tool_digests: toolDigests } : {})
      });
    } catch (error) {
      await rm(tempRoot, { recursive: true, force: true });
      diagnostics.push({
        path: `$.plugins.${alias}`,
        message: error instanceof Error ? `Failed to resolve plugin: ${error.message}` : "Failed to resolve plugin."
      });
    }
  }

  if (diagnostics.length > 0) {
    return {
      graph_path: absoluteGraphPath,
      lockfile_path: lockfilePathForGraph(absoluteGraphPath),
      diagnostics,
      resolved_plugins: resolvedPlugins
    };
  }

  const lockfile: PluginLockFile = {
    version: "1",
    plugins: Object.fromEntries(resolvedPlugins.map((plugin) => {
      const { alias, ...entry } = plugin;
      return [alias, entry];
    }))
  };
  await writeFile(lockfilePathForGraph(absoluteGraphPath), `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");

  return {
    graph_path: absoluteGraphPath,
    lockfile_path: lockfilePathForGraph(absoluteGraphPath),
    diagnostics,
    resolved_plugins: resolvedPlugins
  };
}

async function loadResolvedPlugins(
  graphPath: string,
  declarations: Record<string, PluginDeclaration>,
  diagnostics: GraphDiagnostic[]
): Promise<ResolvedPlugin[]> {
  const lockfile = await readLockFile(graphPath);
  const resolved: ResolvedPlugin[] = [];

  for (const [alias, declaration] of Object.entries(declarations)) {
    const entry = lockfile?.plugins[alias];

    if (!entry) {
      diagnostics.push({
        path: `$.plugins.${alias}`,
        message: `Plugin "${alias}" is not resolved. Run agentflow plugin resolve --graph ${graphPath}.`
      });
      continue;
    }

    if (entry.kind !== declaration.kind) {
      diagnostics.push({
        path: `$.plugins.${alias}`,
        message: `Plugin "${alias}" lockfile entry is stale. Run agentflow plugin resolve --graph ${graphPath}.`
      });
      continue;
    }

    if (
      declaration.kind === "git" &&
      (entry.source !== declaration.source || entry.ref !== declaration.ref)
    ) {
      diagnostics.push({
        path: `$.plugins.${alias}`,
        message: `Plugin "${alias}" lockfile entry is stale. Run agentflow plugin resolve --graph ${graphPath}.`
      });
      continue;
    }

    if (declaration.kind === "local" && entry.path !== declaration.path) {
      diagnostics.push({
        path: `$.plugins.${alias}`,
        message: `Plugin "${alias}" lockfile entry is stale. Run agentflow plugin resolve --graph ${graphPath}.`
      });
      continue;
    }

    let pluginRoot: string;
    let manifestDigest: string;
    try {
      pluginRoot = entry.kind === "local"
        ? resolveLocalPluginPath(graphPath, entry.path ?? entry.cache_path)
        : resolvePluginSubpath(dirname(graphPath), entry.cache_path, `Plugin "${alias}" cache_path`);
      manifestDigest = await digestFile(join(pluginRoot, "agentflow.plugin.json"));
    } catch (error) {
      diagnostics.push({
        path: `$.plugins.${alias}`,
        message: error instanceof Error
          ? `Plugin "${alias}" cache is unavailable. Run agentflow plugin resolve --graph ${graphPath}. ${error.message}`
          : `Plugin "${alias}" cache is unavailable. Run agentflow plugin resolve --graph ${graphPath}.`
      });
      continue;
    }

    if (entry.kind === "local" && entry.content_digest) {
      try {
        const contentDigest = await digestDirectory(pluginRoot);
        if (contentDigest !== entry.content_digest) {
          diagnostics.push({
            path: `$.plugins.${alias}`,
            message: `Plugin "${alias}" local folder digest changed. Run agentflow plugin resolve --graph ${graphPath}.`
          });
          continue;
        }
      } catch (error) {
        diagnostics.push({
          path: `$.plugins.${alias}`,
          message: error instanceof Error
            ? `Plugin "${alias}" local folder is unavailable. Run agentflow plugin resolve --graph ${graphPath}. ${error.message}`
            : `Plugin "${alias}" local folder is unavailable. Run agentflow plugin resolve --graph ${graphPath}.`
        });
        continue;
      }
    }

    if (manifestDigest !== entry.manifest_digest) {
      diagnostics.push({
        path: `$.plugins.${alias}`,
        message: `Plugin "${alias}" manifest digest changed. Run agentflow plugin resolve --graph ${graphPath}.`
      });
      continue;
    }

    const manifest = await loadManifest(pluginRoot, `$.plugins.${alias}`, diagnostics);
    if (manifest) {
      let toolDigestsValid = true;
      for (const [toolName, tool] of Object.entries(manifest.tools)) {
        const expected = entry.tool_digests?.[toolName];
        if (!expected) {
          diagnostics.push({
            path: `$.plugins.${alias}.tools.${toolName}`,
            message: `Plugin "${alias}" tool "${toolName}" is missing from lockfile. Run agentflow plugin resolve --graph ${graphPath}.`
          });
          toolDigestsValid = false;
          continue;
        }

        try {
          const toolPath = resolvePluginSubpath(
            pluginRoot,
            tool.executable,
            `Plugin tool "${alias}/${toolName}" executable`
          );
          const actual = await digestFile(toolPath);
          if (actual !== expected) {
            diagnostics.push({
              path: `$.plugins.${alias}.tools.${toolName}`,
              message: `Plugin "${alias}" tool "${toolName}" executable digest changed. Run agentflow plugin resolve --graph ${graphPath}.`
            });
            toolDigestsValid = false;
          }
        } catch (toolError) {
          diagnostics.push({
            path: `$.plugins.${alias}.tools.${toolName}`,
            message: toolError instanceof Error
              ? `Plugin "${alias}" tool "${toolName}" is unavailable: ${toolError.message}`
              : `Plugin "${alias}" tool "${toolName}" is unavailable.`
          });
          toolDigestsValid = false;
        }
      }

      if (!toolDigestsValid) {
        continue;
      }

      resolved.push({
        alias,
        kind: entry.kind,
        source: entry.source,
        ref: entry.ref,
        commit: entry.commit,
        manifest_digest: entry.manifest_digest,
        root: pluginRoot,
        manifest
      });
    }
  }

  return resolved;
}

function splitUses(value: string): { alias: string; workflow: string } | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf("/", separator + 1) !== -1) {
    return undefined;
  }

  const alias = value.slice(0, separator);
  const workflow = value.slice(separator + 1);
  if (!isPluginIdentifier(alias) || !isPluginIdentifier(workflow)) {
    return undefined;
  }

  return {
    alias,
    workflow
  };
}

function isExecutableType(value: unknown): boolean {
  return value === "agent" || value === "exec" || value === "check" || value === "checkpoint";
}

function collectNodeIds(node: unknown, ids: Set<string>): void {
  const record = asRecord(node);
  if (!record) {
    return;
  }

  if (typeof record.id === "string") {
    ids.add(record.id);
  }

  if (Array.isArray(record.steps)) {
    record.steps.forEach((child) => collectNodeIds(child, ids));
  }

  if (record.body) {
    collectNodeIds(record.body, ids);
  }
}

function readConfigValue(config: Record<string, unknown>, path: string): string {
  return sharedReadConfigValue(config, path);
}

function resolveWorkflowResourcePath(
  workflowDir: string,
  pluginRoot: string,
  resourcePath: string,
  label: string
): string {
  if (resourcePath.startsWith("plugin://")) {
    return resolvePluginSubpath(pluginRoot, resourcePath.slice("plugin://".length), label);
  }

  return resolvePluginSubpath(workflowDir, resourcePath, label);
}

function rewriteString(
  value: string,
  config: Record<string, unknown>,
  workflowDir: string,
  pluginRoot: string
): string {
  const withConfig = rewriteConfigPlaceholders(value, config);

  if (withConfig.startsWith("plugin://")) {
    return resolvePluginSubpath(pluginRoot, withConfig.slice("plugin://".length), "plugin:// resource");
  }

  return withConfig;
}

async function rewriteContextItems(
  value: unknown,
  workflowDir: string,
  pluginRoot: string,
  config: Record<string, unknown>,
  internalIds: Set<string>,
  prefix: string,
  publishNode: string,
  outerId: string,
  resourceDigests: Record<string, string>,
  diagnostics: GraphDiagnostic[]
): Promise<unknown[] | undefined> {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    diagnostics.push({ path: "$.workflow.context", message: "Workflow node context must be an array." });
    return undefined;
  }

  const rewritten: unknown[] = [];

  for (const item of value) {
    const record = asRecord(item);
    if (!record || record.from !== "plugin_file") {
      rewritten.push(await rewriteWorkflowValue(
        item,
        workflowDir,
        pluginRoot,
        config,
        internalIds,
        prefix,
        resourceDigests,
        diagnostics,
        publishNode,
        outerId
      ));
      continue;
    }

    const name = typeof record.name === "string" ? record.name : undefined;
    const pluginPath = typeof record.path === "string" ? record.path : undefined;
    if (!name || !pluginPath) {
      diagnostics.push({ path: "$.workflow.context", message: "plugin_file context requires name and path." });
      continue;
    }

    const resolvedPath = resolveWorkflowResourcePath(
      workflowDir,
      pluginRoot,
      pluginPath,
      `plugin_file context "${name}"`
    );
    const text = await readFile(resolvedPath, "utf8");
    resourceDigests[pluginPath] = digestText(text);
    rewritten.push({
      name,
      from: "text",
      text
    });
  }

  return rewritten;
}

function rewriteArtifactReferenceNode(value: unknown, internalIds: Set<string>, prefix: string, publishNode: string, outerId: string): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (value === publishNode) {
    return outerId;
  }

  return internalIds.has(value) ? `${prefix}${value}` : value;
}

function rewriteArtifactReferenceRef(
  ref: string,
  internalIds: Set<string>,
  prefix: string,
  publishNode: string,
  outerId: string
): string {
  const dotIndex = ref.indexOf(".");
  const node = dotIndex === -1 ? ref : ref.slice(0, dotIndex);
  const remainder = dotIndex === -1 ? "" : ref.slice(dotIndex);
  const rewrittenNode = rewriteArtifactReferenceNode(node, internalIds, prefix, publishNode, outerId);
  if (typeof rewrittenNode !== "string") {
    return ref;
  }
  return `${rewrittenNode}${remainder}`;
}

async function rewriteWorkflowValue(
  value: unknown,
  workflowDir: string,
  pluginRoot: string,
  config: Record<string, unknown>,
  internalIds: Set<string>,
  prefix: string,
  resourceDigests: Record<string, string>,
  diagnostics: GraphDiagnostic[],
  publishNode = "",
  outerId = ""
): Promise<unknown> {
  if (typeof value === "string") {
    return rewriteString(value, config, workflowDir, pluginRoot);
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) =>
      rewriteWorkflowValue(item, workflowDir, pluginRoot, config, internalIds, prefix, resourceDigests, diagnostics, publishNode, outerId)
    ));
  }

  const record = asRecord(value);
  if (!record) {
    return value;
  }

  const rewritten: Record<string, unknown> = {};

  for (const [key, itemValue] of Object.entries(record)) {
    if (key === "context") {
      const context = await rewriteContextItems(
        itemValue,
        workflowDir,
        pluginRoot,
        config,
        internalIds,
        prefix,
        publishNode,
        outerId,
        resourceDigests,
        diagnostics
      );
      if (context !== undefined) {
        rewritten.context = context;
      }
      continue;
    }

    rewritten[key] = await rewriteWorkflowValue(
      itemValue,
      workflowDir,
      pluginRoot,
      config,
      internalIds,
      prefix,
      resourceDigests,
      diagnostics,
      publishNode,
      outerId
    );
  }

  if (typeof record.id === "string") {
    rewritten.id = record.id === publishNode ? outerId : `${prefix}${record.id}`;
  }

  if (typeof record.ref === "string") {
    const rewrittenRef = rewriteArtifactReferenceRef(record.ref, internalIds, prefix, publishNode, outerId);
    rewritten.ref = rewrittenRef;
    if (typeof record.node === "string") {
      rewritten.node = rewriteArtifactReferenceNode(record.node, internalIds, prefix, publishNode, outerId);
    }
  }

  if (asRecord(record.until)) {
    const untilRecord = rewritten.until && asRecord(rewritten.until) ? rewritten.until : {};
    rewritten.until = {
      ...untilRecord,
      node: rewriteArtifactReferenceNode(asRecord(record.until)?.node, internalIds, prefix, publishNode, outerId)
    };
  }

  if (asRecord(record.review_from)) {
    const reviewRecord = rewritten.review_from && asRecord(rewritten.review_from) ? rewritten.review_from : {};
    rewritten.review_from = {
      ...reviewRecord,
      node: rewriteArtifactReferenceNode(asRecord(record.review_from)?.node, internalIds, prefix, publishNode, outerId)
    };
  }

  return rewritten;
}

function contextNames(context: unknown[]): Set<string> {
  return new Set(context
    .map((item) => asRecord(item)?.name)
    .filter((name): name is string => typeof name === "string"));
}

function addContextToExecutables(
  node: unknown,
  extraContext: unknown[],
  inherited: {
    repo?: unknown;
    profile?: unknown;
    timeout_sec?: unknown;
  },
  diagnostics: GraphDiagnostic[]
): unknown {
  const record = asRecord(node);
  if (!record) {
    return node;
  }

  const rewritten: Record<string, unknown> = { ...record };

  if (Array.isArray(record.steps)) {
    rewritten.steps = record.steps.map((child) => addContextToExecutables(child, extraContext, inherited, diagnostics));
  }

  if (record.body) {
    rewritten.body = addContextToExecutables(record.body, extraContext, inherited, diagnostics);
  }

  if (isExecutableType(record.type)) {
    const currentContext = Array.isArray(record.context) ? record.context : [];
    const currentNames = contextNames(currentContext);
    const duplicates = extraContext
      .map((item) => asRecord(item)?.name)
      .filter((name): name is string => typeof name === "string" && currentNames.has(name));

    if (duplicates.length > 0) {
      diagnostics.push({
        path: "$.graph",
        message: `Plugin workflow generated duplicate forwarded context name(s): ${duplicates.join(", ")}.`
      });
    }

    rewritten.context = [...extraContext, ...currentContext] as ContextItem[];

    if (!rewritten.repo && inherited.repo) {
      rewritten.repo = inherited.repo;
    }
    if (!rewritten.profile && inherited.profile) {
      rewritten.profile = inherited.profile;
    }
    if (!rewritten.timeout_sec && inherited.timeout_sec) {
      rewritten.timeout_sec = inherited.timeout_sec;
    }
  }

  return rewritten;
}

function validateConfigAgainstSchema(
  config: Record<string, unknown>,
  schema: unknown,
  path: string,
  diagnostics: GraphDiagnostic[]
): void {
  sharedValidateConfigAgainstSchema(config, schema, path, diagnostics);
}

async function expandPluginNode(
  record: Record<string, unknown>,
  pluginsByAlias: Map<string, ResolvedPlugin>,
  lowered: LoweredManagedNode[],
  diagnostics: GraphDiagnostic[]
): Promise<unknown | undefined> {
  const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id : undefined;
  const uses = typeof record.uses === "string" && record.uses.trim().length > 0 ? record.uses : undefined;
  const config = record.config === undefined ? {} : asRecord(record.config);
  pushUnknownFieldDiagnostics(
    record,
    "$.graph",
    ["type", "id", "label", "uses", "config", "context", "repo", "profile", "timeout_sec"],
    diagnostics
  );

  if (!id) {
    diagnostics.push({ path: "$.graph.id", message: "Plugin workflow node requires id." });
  }
  if (!uses) {
    diagnostics.push({ path: "$.graph.uses", message: "Plugin workflow node requires uses." });
  }
  if (!config) {
    diagnostics.push({ path: "$.graph.config", message: "Plugin workflow config must be an object when provided." });
  }
  if (record.context !== undefined && !Array.isArray(record.context)) {
    diagnostics.push({ path: "$.graph.context", message: "Plugin workflow context must be an array when provided." });
  }
  if (!id || !uses || !config) {
    return undefined;
  }

  const parsedUses = splitUses(uses);
  if (!parsedUses) {
    diagnostics.push({ path: "$.graph.uses", message: 'Plugin workflow uses must be in "plugin_alias/workflow_id" form.' });
    return undefined;
  }

  const plugin = pluginsByAlias.get(parsedUses.alias);
  if (!plugin) {
    diagnostics.push({ path: "$.graph.uses", message: `Plugin "${parsedUses.alias}" is not declared or resolved.` });
    return undefined;
  }

  const workflowExport = plugin.manifest.workflows[parsedUses.workflow];
  if (!workflowExport) {
    diagnostics.push({ path: "$.graph.uses", message: `Plugin "${parsedUses.alias}" does not export workflow "${parsedUses.workflow}".` });
    return undefined;
  }

  const workflowManifestPath = resolvePluginSubpath(plugin.root, workflowExport.path, `workflow "${uses}"`);
  const workflowDir = dirname(workflowManifestPath);
  const workflowManifest = normalizeWorkflowManifest(
    await readJsonFile(workflowManifestPath),
    `workflow:${uses}`,
    diagnostics
  );

  if (!workflowManifest) {
    return undefined;
  }
  const manifest = workflowManifest;

  if (manifest.config_schema) {
    const schemaPath = resolvePluginSubpath(workflowDir, manifest.config_schema, `workflow "${uses}" config_schema`);
    validateConfigAgainstSchema(config, await readJsonFile(schemaPath), `workflow:${uses}.config_schema`, diagnostics);
  }

  const workflowGraphPath = resolvePluginSubpath(workflowDir, manifest.graph, `workflow "${uses}" graph`);
  const workflowGraph = await readJsonFile(workflowGraphPath);
  const internalIds = new Set<string>();
  collectNodeIds(workflowGraph, internalIds);

  if (!internalIds.has(manifest.publish_node)) {
    diagnostics.push({
      path: `workflow:${uses}.publish_node`,
      message: `Plugin workflow publish_node "${manifest.publish_node}" does not exist in workflow graph.`
    });
    return undefined;
  }

  const internalPrefix = `${id}__managed__plugin__${parsedUses.alias}__${parsedUses.workflow}__`;
  const resourceDigests: Record<string, string> = {};
  const rewritten = await rewriteWorkflowValue(
    workflowGraph,
    workflowDir,
    plugin.root,
    config,
    internalIds,
    internalPrefix,
    resourceDigests,
    diagnostics,
    manifest.publish_node,
    id
  );

  const pluginConfigContext = {
    name: "plugin_config",
    from: "text",
    text: `${JSON.stringify(config, null, 2)}\n`
  };
  const forwardedContext = Array.isArray(record.context) ? record.context : [];
  const withContext = addContextToExecutables(
    rewritten,
    [pluginConfigContext, ...forwardedContext],
    {
      repo: record.repo,
      profile: record.profile,
      timeout_sec: record.timeout_sec
    },
    diagnostics
  );

  function attachPublishedArtifacts(node: unknown): unknown {
    const nodeRecord = asRecord(node);
    if (!nodeRecord) {
      return node;
    }

    const next: Record<string, unknown> = { ...nodeRecord };
    if (nodeRecord.id === id) {
      if (typeof record.label === "string" && next.label === undefined) {
        next.label = record.label;
      }
      next.artifacts = {
        ...(asRecord(nodeRecord.artifacts) ?? {}),
        ...manifest.published_artifacts
      };
    }
    if (Array.isArray(nodeRecord.steps)) {
      next.steps = nodeRecord.steps.map(attachPublishedArtifacts);
    }
    if (nodeRecord.body) {
      next.body = attachPublishedArtifacts(nodeRecord.body);
    }
    return next;
  }

  lowered.push({
    authored_id: id,
    managed_kind: `plugin:${uses}`,
    lowered_to: "sequence",
    internal_id_prefix: internalPrefix,
    plugin: {
      alias: parsedUses.alias,
      workflow: parsedUses.workflow,
      source: plugin.source,
      ref: plugin.ref,
      commit: plugin.commit,
      manifest_digest: plugin.manifest_digest,
      ...(Object.keys(resourceDigests).length > 0 ? { resources: resourceDigests } : {})
    }
  });

  return attachPublishedArtifacts(withContext);
}

async function expandGraphNode(
  node: unknown,
  pluginsByAlias: Map<string, ResolvedPlugin>,
  lowered: LoweredManagedNode[],
  diagnostics: GraphDiagnostic[]
): Promise<unknown> {
  const record = asRecord(node);
  if (!record) {
    return node;
  }

  if (record.type === "plugin") {
    return await expandPluginNode(record, pluginsByAlias, lowered, diagnostics);
  }

  const rewritten: Record<string, unknown> = { ...record };
  if (Array.isArray(record.steps)) {
    rewritten.steps = await Promise.all(record.steps.map((child) =>
      expandGraphNode(child, pluginsByAlias, lowered, diagnostics)
    ));
  }
  if (record.body) {
    rewritten.body = await expandGraphNode(record.body, pluginsByAlias, lowered, diagnostics);
  }
  return rewritten;
}

export async function expandPluginWorkflows(
  graphPath: string,
  document: unknown
): Promise<PluginExpansionResult> {
  const diagnostics: GraphDiagnostic[] = [];
  const declarations = readPluginDeclarations(document, diagnostics);
  const lowered: LoweredManagedNode[] = [];
  const cloned = JSON.parse(JSON.stringify(document)) as unknown;
  const documentRecord = asRecord(cloned);

  if (!documentRecord || Object.keys(declarations).length === 0) {
    return {
      document,
      diagnostics,
      lowered_managed_nodes: lowered,
      resolved_plugins: []
    };
  }

  const resolvedPlugins = await loadResolvedPlugins(graphPath, declarations, diagnostics);
  const pluginsByAlias = new Map(resolvedPlugins.map((plugin) => [plugin.alias, plugin]));

  if (diagnostics.length > 0) {
    return {
      document: cloned,
      diagnostics,
      lowered_managed_nodes: lowered,
      resolved_plugins: resolvedPlugins
    };
  }

  documentRecord.graph = await expandGraphNode(documentRecord.graph, pluginsByAlias, lowered, diagnostics);
  delete documentRecord.plugins;

  return {
    document: cloned,
    diagnostics,
    lowered_managed_nodes: lowered,
    resolved_plugins: resolvedPlugins
  };
}
