import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import ignore, { type Ignore } from "ignore";

import {
  staleAgentflowDirectoryName,
  staleAgentflowRuntimeDirectoryName,
  taskRuntimeDirectoryName
} from "../../generated_state.js";
import { normalizeRelativePath } from "./common.js";

export const defaultContextIgnoredRoots = [
  ".git",
  taskRuntimeDirectoryName,
  staleAgentflowDirectoryName,
  staleAgentflowRuntimeDirectoryName,
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "coverage",
  "target",
  "vendor",
  "vendors",
  "third_party",
  "generated",
  "gen",
  "__generated__",
  "bazel-bin",
  "bazel-out"
] as const;

const hardExcludedDirectories = new Set<string>(defaultContextIgnoredRoots);

async function readIgnoreFile(rootPath: string, fileName: string): Promise<string | undefined> {
  try {
    return await readFile(join(rootPath, fileName), "utf8");
  } catch {
    return undefined;
  }
}

async function buildIgnoreMatcher(rootPath: string, includeIgnoredRoot?: string): Promise<Ignore> {
  const matcher = ignore();
  matcher.add(
    defaultContextIgnoredRoots
      .filter((root) => root !== includeIgnoredRoot)
      .flatMap((root) => [root, `${root}/**`])
  );

  const [gitignore, dotIgnore] = await Promise.all([
    readIgnoreFile(rootPath, ".gitignore"),
    readIgnoreFile(rootPath, ".ignore")
  ]);

  if (gitignore) {
    matcher.add(gitignore);
  }

  if (dotIgnore) {
    matcher.add(dotIgnore);
  }

  return matcher;
}

export async function walkRelativeFilesSorted(
  rootPath: string,
  currentRelativePath = "",
  includeIgnoredRoot?: string
): Promise<string[]> {
  const currentPath =
    currentRelativePath.length > 0 ? join(rootPath, currentRelativePath) : rootPath;
  const entries = await readdir(currentPath, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];

  for (const entry of sortedEntries) {
    const isExplicitlyIncludedIgnoredRoot =
      currentRelativePath.length === 0
      && includeIgnoredRoot !== undefined
      && entry.name === includeIgnoredRoot;
    if (
      entry.isDirectory()
      && hardExcludedDirectories.has(entry.name)
      && !isExplicitlyIncludedIgnoredRoot
    ) {
      continue;
    }

    const nextRelativePath =
      currentRelativePath.length > 0
        ? join(currentRelativePath, entry.name)
        : entry.name;

    if (entry.isDirectory()) {
      for (const file of await walkRelativeFilesSorted(rootPath, nextRelativePath, includeIgnoredRoot)) {
        files.push(file);
      }
      continue;
    }

    if (entry.isFile()) {
      files.push(normalizeRelativePath(nextRelativePath));
    }
  }

  return files;
}

export async function listRepoFiles(
  repoRoot: string,
  cache?: Map<string, string[]>,
  options: {
    include_ignored_root?: string;
  } = {}
): Promise<string[]> {
  const cacheKey = options.include_ignored_root ? `${repoRoot}\0${options.include_ignored_root}` : repoRoot;
  const cached = cache?.get(cacheKey);

  if (cached) {
    return cached;
  }

  const [allFiles, matcher] = await Promise.all([
    walkRelativeFilesSorted(repoRoot, "", options.include_ignored_root),
    buildIgnoreMatcher(repoRoot, options.include_ignored_root)
  ]);
  const files = allFiles.filter((filePath) => !matcher.ignores(filePath));
  cache?.set(cacheKey, files);
  return files;
}

export async function listRepoFilesDetailed(
  repoRoot: string,
  options: {
    include_ignored_root?: string;
  } = {}
): Promise<{
  files: string[];
  ignored_roots: string[];
}> {
  return {
    files: await listRepoFiles(repoRoot, undefined, options),
    ignored_roots: defaultContextIgnoredRoots.filter((root) => root !== options.include_ignored_root)
  };
}
