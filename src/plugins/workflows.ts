import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { resolveSubpathWithinRoot } from "../path_rules.js";
import type { ArtifactDefinition, ContextItem } from "../graph/authored.js";
import type { GraphDiagnostic } from "../graph/schema.js";
import type { LoweredManagedNode } from "../graph/normalize.js";

const execFileAsync = promisify(execFile);

export const pluginLockFileName = "agentflow.plugins.lock.json";

export interface PluginDeclaration {
  source: string;
  ref: string;
}

export interface PluginLockEntry extends PluginDeclaration {
  commit: string;
  manifest_digest: string;
  cache_path: string;
}

export interface PluginLockFile {
  version: "1";
  plugins: Record<string, PluginLockEntry>;
}

export interface ResolvedPlugin {
  alias: string;
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
}

export interface PluginWorkflowExport {
  path: string;
  description?: string;
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
  return digestText(await readFile(path, "utf8"));
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

    pushUnknownFieldDiagnostics(record, path, ["source", "ref"], diagnostics);
    const source = readStringField(record, "source", path, diagnostics);
    const ref = readStringField(record, "ref", path, diagnostics);

    if (source && ref) {
      declarations[alias] = { source, ref };
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

  if (schema && schema !== "agentflow.plugin/1") {
    diagnostics.push({ path: `${path}.schema`, message: 'Plugin manifest schema must be "agentflow.plugin/1".' });
  }

  if (!workflowsRecord) {
    diagnostics.push({ path: `${path}.workflows`, message: "Plugin manifest workflows must be an object." });
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

  if (!schema || schema !== "agentflow.plugin/1" || !id || !version || !workflowsRecord) {
    return undefined;
  }

  return {
    schema: "agentflow.plugin/1",
    id,
    version,
    workflows
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
      resolvedPlugins.push({
        alias,
        source: declaration.source,
        ref: declaration.ref,
        commit,
        manifest_digest: manifestDigest,
        cache_path: `.agentflow/plugins/${alias}/${commit}`
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

    if (entry.source !== declaration.source || entry.ref !== declaration.ref) {
      diagnostics.push({
        path: `$.plugins.${alias}`,
        message: `Plugin "${alias}" lockfile entry is stale. Run agentflow plugin resolve --graph ${graphPath}.`
      });
      continue;
    }

    let pluginRoot: string;
    let manifestDigest: string;
    try {
      pluginRoot = resolvePluginSubpath(dirname(graphPath), entry.cache_path, `Plugin "${alias}" cache_path`);
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

    if (manifestDigest !== entry.manifest_digest) {
      diagnostics.push({
        path: `$.plugins.${alias}`,
        message: `Plugin "${alias}" manifest digest changed. Run agentflow plugin resolve --graph ${graphPath}.`
      });
      continue;
    }

    const manifest = await loadManifest(pluginRoot, `$.plugins.${alias}`, diagnostics);
    if (manifest) {
      resolved.push({
        alias,
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
  const value = path.split(".").reduce<unknown>((current, key) => {
    const record = asRecord(current);
    return record ? record[key] : undefined;
  }, config);

  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

function rewriteString(value: string, config: Record<string, unknown>, workflowDir: string): string {
  const withConfig = value.replace(/\{\{config\.([a-zA-Z0-9_.-]+)\}\}/g, (_match, key: string) =>
    readConfigValue(config, key)
  );

  if (withConfig.startsWith("plugin://")) {
    return resolvePluginSubpath(workflowDir, withConfig.slice("plugin://".length), "plugin:// resource");
  }

  return withConfig;
}

async function rewriteContextItems(
  value: unknown,
  workflowDir: string,
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

    const resolvedPath = resolvePluginSubpath(workflowDir, pluginPath, `plugin_file context "${name}"`);
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

async function rewriteWorkflowValue(
  value: unknown,
  workflowDir: string,
  config: Record<string, unknown>,
  internalIds: Set<string>,
  prefix: string,
  resourceDigests: Record<string, string>,
  diagnostics: GraphDiagnostic[],
  publishNode = "",
  outerId = ""
): Promise<unknown> {
  if (typeof value === "string") {
    return rewriteString(value, config, workflowDir);
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) =>
      rewriteWorkflowValue(item, workflowDir, config, internalIds, prefix, resourceDigests, diagnostics, publishNode, outerId)
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

  if (record.from === "artifact") {
    rewritten.node = rewriteArtifactReferenceNode(record.node, internalIds, prefix, publishNode, outerId);
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
  const schemaRecord = asRecord(schema);
  if (!schemaRecord) {
    diagnostics.push({ path, message: "Workflow config schema must be an object." });
    return;
  }

  if (schemaRecord.type !== undefined && schemaRecord.type !== "object") {
    diagnostics.push({ path: `${path}.type`, message: 'Only object config schemas are supported for plugin workflows.' });
    return;
  }

  const properties = asRecord(schemaRecord.properties) ?? {};
  const required = Array.isArray(schemaRecord.required)
    ? schemaRecord.required.filter((item): item is string => typeof item === "string")
    : [];

  required.forEach((key) => {
    if (config[key] === undefined) {
      diagnostics.push({ path: `config.${key}`, message: `Plugin workflow config is missing required property "${key}".` });
    }
  });

  if (schemaRecord.additionalProperties === false) {
    Object.keys(config)
      .filter((key) => properties[key] === undefined)
      .forEach((key) => {
        diagnostics.push({ path: `config.${key}`, message: `Plugin workflow config does not allow property "${key}".` });
      });
  }

  Object.entries(properties).forEach(([key, propertySchema]) => {
    if (config[key] === undefined) {
      return;
    }

    const expectedType = asRecord(propertySchema)?.type;
    const actual = config[key];
    const typeMatches =
      expectedType === undefined ||
      (expectedType === "array" ? Array.isArray(actual) : typeof actual === expectedType);

    if (!typeMatches) {
      diagnostics.push({ path: `config.${key}`, message: `Plugin workflow config property "${key}" must be ${String(expectedType)}.` });
    }
  });
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
