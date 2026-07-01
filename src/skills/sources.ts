import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { resolveSubpathWithinRoot } from "../path_rules.js";
import type { SkillSourceDeclaration } from "../graph/authored.js";
import type { GraphDiagnostic } from "../graph/schema.js";
import { staleAgentflowDirectoryName, taskRuntimeDirectoryName } from "../generated_state.js";

const execFileAsync = promisify(execFile);

export const skillLockFileName = "task-runtime.skills.lock.json";

export interface SkillLockEntry {
  kind: "git" | "local";
  source: string;
  ref: string;
  commit: string;
  cache_path: string;
  path?: string;
  content_digest?: string;
}

export interface SkillLockFile {
  version: "1";
  skill_sources: Record<string, SkillLockEntry>;
}

export interface ResolvedSkillMetadata {
  name: string;
  description: string;
  path: string;
}

export interface ResolvedSkillSource {
  alias: string;
  kind: "git" | "local";
  source: string;
  ref: string;
  commit: string;
  root: string;
  skills: Map<string, ResolvedSkillMetadata>;
}

export interface ResolveSkillSourcesResult {
  graph_path: string;
  lockfile_path: string;
  diagnostics: GraphDiagnostic[];
  resolved_skill_sources: Array<SkillLockEntry & { alias: string }>;
}

const sourceAliasPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
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
        entry.name === taskRuntimeDirectoryName ||
        entry.name === staleAgentflowDirectoryName
      ) {
        continue;
      }

      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  await walk(root);
  for (const file of files.sort((left, right) => left.localeCompare(right))) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function lockfilePathForGraph(graphPath: string): string {
  return join(dirname(graphPath), skillLockFileName);
}

function skillCacheRootForGraph(graphPath: string): string {
  return join(dirname(graphPath), taskRuntimeDirectoryName, "skills");
}

function resolveLocalSkillSourcePath(graphPath: string, localPath: string): string {
  return isAbsolute(localPath) ? localPath : resolve(dirname(graphPath), localPath);
}

function cachePathForAliasCommit(alias: string, commitOrDigest: string): string {
  return `${taskRuntimeDirectoryName}/skills/${alias}/${commitOrDigest.replace(/^sha256:/u, "sha256-")}`;
}

function normalizeGitSkillSource(source: string): string {
  const match = /^github:([^/\s]+)\/([^/\s]+)$/u.exec(source);
  if (!match) {
    return source;
  }

  return `https://github.com/${match[1]}/${match[2]}.git`;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, cwd ? { cwd } : undefined);
  return String(result.stdout).trim();
}

export function readSkillSourceDeclarations(
  document: unknown,
  diagnostics: GraphDiagnostic[]
): Record<string, SkillSourceDeclaration> {
  const documentRecord = asRecord(document);
  const sourcesValue = documentRecord?.skill_sources;

  if (sourcesValue === undefined) {
    return {};
  }

  const sourcesRecord = asRecord(sourcesValue);
  if (!sourcesRecord) {
    diagnostics.push({
      path: "$.skill_sources",
      message: "skill_sources must be an object keyed by source alias."
    });
    return {};
  }

  const declarations: Record<string, SkillSourceDeclaration> = {};
  Object.entries(sourcesRecord).forEach(([alias, value]) => {
    const path = `$.skill_sources.${alias}`;
    const record = asRecord(value);
    if (!sourceAliasPattern.test(alias)) {
      diagnostics.push({
        path,
        message: "Skill source aliases must use letters, numbers, underscores, or hyphens, and must start with a letter or number."
      });
      return;
    }
    if (!record) {
      diagnostics.push({ path, message: "Skill source declaration must be an object." });
      return;
    }

    const hasPath = typeof record.path === "string";
    const hasGit = typeof record.source === "string" || typeof record.ref === "string";
    if (hasPath && hasGit) {
      diagnostics.push({
        path,
        message: "Skill source declaration must use either { path } or { source, ref }, not both."
      });
      return;
    }
    if (hasPath) {
      declarations[alias] = { path: String(record.path) };
      return;
    }
    if (typeof record.source === "string" && typeof record.ref === "string") {
      declarations[alias] = { source: record.source, ref: record.ref };
      return;
    }
    diagnostics.push({
      path,
      message: "Skill source declaration requires either path or source/ref."
    });
  });

  return declarations;
}

async function readLockFile(graphPath: string): Promise<SkillLockFile | undefined> {
  try {
    const parsed = await readJsonFile(lockfilePathForGraph(graphPath));
    const record = asRecord(parsed);
    const skillSources = asRecord(record?.skill_sources);
    if (!record || record.version !== "1" || !skillSources) {
      return undefined;
    }
    return parsed as SkillLockFile;
  } catch {
    return undefined;
  }
}

function parseSkillFrontmatter(contents: string, path: string, diagnostics: GraphDiagnostic[]): { name: string; description: string } | undefined {
  if (!contents.startsWith("---\n")) {
    diagnostics.push({ path, message: "Skill SKILL.md must start with YAML-style frontmatter." });
    return undefined;
  }

  const endIndex = contents.indexOf("\n---", 4);
  if (endIndex === -1) {
    diagnostics.push({ path, message: "Skill SKILL.md frontmatter is not closed." });
    return undefined;
  }

  const fields: Record<string, string> = {};
  for (const line of contents.slice(4, endIndex).split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^["']|["']$/gu, "");
  }

  if (!fields.name) {
    diagnostics.push({ path, message: "Skill frontmatter requires name." });
  }
  if (!fields.description) {
    diagnostics.push({ path, message: "Skill frontmatter requires description." });
  }
  return fields.name && fields.description
    ? { name: fields.name, description: fields.description }
    : undefined;
}

async function discoverSkills(root: string, alias: string, diagnostics: GraphDiagnostic[]): Promise<Map<string, ResolvedSkillMetadata>> {
  const skills = new Map<string, ResolvedSkillMetadata>();

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const skillPath = join(directory, "SKILL.md");
      const contents = await readFile(skillPath, "utf8");
      const frontmatter = parseSkillFrontmatter(contents, `$.skill_sources.${alias}`, diagnostics);
      if (frontmatter) {
        const refPath = relative(root, directory).replace(/\\/gu, "/") || frontmatter.name;
        skills.set(refPath, {
          name: frontmatter.name,
          description: frontmatter.description,
          path: skillPath
        });
      }
      return;
    }

    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        entry.name !== ".git" &&
        entry.name !== "node_modules" &&
        entry.name !== taskRuntimeDirectoryName &&
        entry.name !== staleAgentflowDirectoryName
      ) {
        await visit(join(directory, entry.name));
      }
    }
  }

  await visit(root);
  return skills;
}

export async function resolveSkillSourcesForGraph(
  currentWorkingDirectory: string,
  graphPath: string
): Promise<ResolveSkillSourcesResult> {
  const absoluteGraphPath = resolve(currentWorkingDirectory, graphPath);
  const diagnostics: GraphDiagnostic[] = [];
  const parsed = await readJsonFile(absoluteGraphPath);
  const declarations = readSkillSourceDeclarations(parsed, diagnostics);
  const cacheRoot = skillCacheRootForGraph(absoluteGraphPath);
  const resolvedSkillSources: Array<SkillLockEntry & { alias: string }> = [];

  if (diagnostics.length > 0 || Object.keys(declarations).length === 0) {
    return {
      graph_path: absoluteGraphPath,
      lockfile_path: lockfilePathForGraph(absoluteGraphPath),
      diagnostics,
      resolved_skill_sources: resolvedSkillSources
    };
  }

  await mkdir(cacheRoot, { recursive: true });

  for (const [alias, declaration] of Object.entries(declarations)) {
    const aliasRoot = join(cacheRoot, alias);
    const tempRoot = join(aliasRoot, "_resolving");

    try {
      if ("path" in declaration) {
        const sourceRoot = resolveLocalSkillSourcePath(absoluteGraphPath, declaration.path);
        const contentDigest = await digestDirectory(sourceRoot);
        const cachePath = cachePathForAliasCommit(alias, contentDigest);
        const finalRoot = resolveSubpathWithinRoot(dirname(absoluteGraphPath), cachePath, `Skill source "${alias}" cache_path`);
        await mkdir(aliasRoot, { recursive: true });
        await rm(finalRoot, { recursive: true, force: true });
        await cp(sourceRoot, finalRoot, {
          recursive: true,
          filter: (source) => !/(^|[/\\])(?:\.git|node_modules|\.task-runtime|\.agentflow)(?:[/\\]|$)/u.test(source)
        });
        resolvedSkillSources.push({
          alias,
          kind: "local",
          source: declaration.path,
          ref: "local",
          commit: contentDigest,
          path: declaration.path,
          cache_path: cachePath,
          content_digest: contentDigest
        });
        continue;
      }

      await mkdir(aliasRoot, { recursive: true });
      await rm(tempRoot, { recursive: true, force: true });
      await git(["clone", normalizeGitSkillSource(declaration.source), tempRoot]);
      await git(["checkout", declaration.ref], tempRoot);
      const commit = await git(["rev-parse", "HEAD"], tempRoot);
      const finalRoot = join(aliasRoot, commit);
      await rm(finalRoot, { recursive: true, force: true });
      await rename(tempRoot, finalRoot);
      resolvedSkillSources.push({
        alias,
        kind: "git",
        source: declaration.source,
        ref: declaration.ref,
        commit,
        cache_path: cachePathForAliasCommit(alias, commit)
      });
    } catch (error) {
      await rm(tempRoot, { recursive: true, force: true });
      diagnostics.push({
        path: `$.skill_sources.${alias}`,
        message: error instanceof Error ? `Failed to resolve skill source: ${error.message}` : "Failed to resolve skill source."
      });
    }
  }

  if (diagnostics.length === 0) {
    const lockfile: SkillLockFile = {
      version: "1",
      skill_sources: Object.fromEntries(resolvedSkillSources.map((source) => {
        const { alias, ...entry } = source;
        return [alias, entry];
      }))
    };
    await writeFile(lockfilePathForGraph(absoluteGraphPath), `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
  }

  return {
    graph_path: absoluteGraphPath,
    lockfile_path: lockfilePathForGraph(absoluteGraphPath),
    diagnostics,
    resolved_skill_sources: resolvedSkillSources
  };
}

export async function loadResolvedSkillSources(
  graphPath: string,
  declarations: Record<string, SkillSourceDeclaration>,
  diagnostics: GraphDiagnostic[]
): Promise<ResolvedSkillSource[]> {
  const lockfile = await readLockFile(graphPath);
  const resolved: ResolvedSkillSource[] = [];

  for (const [alias, declaration] of Object.entries(declarations)) {
    const entry = lockfile?.skill_sources[alias];
    if (!entry) {
      diagnostics.push({
        path: `$.skill_sources.${alias}`,
        message: `Skill source "${alias}" is not resolved. Run agentflow plugin resolve --graph ${graphPath}.`
      });
      continue;
    }

    let sourceRoot: string;
    if ("path" in declaration) {
      if (entry.kind !== "local" || entry.path !== declaration.path) {
        diagnostics.push({
          path: `$.skill_sources.${alias}`,
          message: `Skill source "${alias}" lockfile entry is stale. Run agentflow plugin resolve --graph ${graphPath}.`
        });
        continue;
      }
      const sourcePath = resolveLocalSkillSourcePath(graphPath, declaration.path);
      if (entry.content_digest && await digestDirectory(sourcePath) !== entry.content_digest) {
        diagnostics.push({
          path: `$.skill_sources.${alias}`,
          message: `Skill source "${alias}" local folder digest changed. Run agentflow plugin resolve --graph ${graphPath}.`
        });
        continue;
      }
      sourceRoot = resolveSubpathWithinRoot(dirname(graphPath), entry.cache_path, `Skill source "${alias}" cache_path`);
    } else {
      if (entry.kind !== "git" || entry.source !== declaration.source || entry.ref !== declaration.ref) {
        diagnostics.push({
          path: `$.skill_sources.${alias}`,
          message: `Skill source "${alias}" lockfile entry is stale. Run agentflow plugin resolve --graph ${graphPath}.`
        });
        continue;
      }
      sourceRoot = resolveSubpathWithinRoot(dirname(graphPath), entry.cache_path, `Skill source "${alias}" cache_path`);
    }

    const skills = await discoverSkills(sourceRoot, alias, diagnostics);
    resolved.push({
      alias,
      kind: entry.kind,
      source: entry.source,
      ref: entry.ref,
      commit: entry.commit,
      root: sourceRoot,
      skills
    });
  }

  return resolved;
}
