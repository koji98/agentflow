import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import ignore, { type Ignore } from "ignore";

import { normalizeRelativePath } from "./common.js";

const hardExcludedDirectories = new Set([".git", ".agentflow", "node_modules"]);

async function readIgnoreFile(rootPath: string, fileName: string): Promise<string | undefined> {
  try {
    return await readFile(join(rootPath, fileName), "utf8");
  } catch {
    return undefined;
  }
}

async function buildIgnoreMatcher(rootPath: string): Promise<Ignore> {
  const matcher = ignore();
  matcher.add([
    ".git",
    ".git/**",
    ".agentflow",
    ".agentflow/**",
    "node_modules",
    "node_modules/**"
  ]);

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
  currentRelativePath = ""
): Promise<string[]> {
  const currentPath =
    currentRelativePath.length > 0 ? join(rootPath, currentRelativePath) : rootPath;
  const entries = await readdir(currentPath, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];

  for (const entry of sortedEntries) {
    if (entry.isDirectory() && hardExcludedDirectories.has(entry.name)) {
      continue;
    }

    const nextRelativePath =
      currentRelativePath.length > 0
        ? join(currentRelativePath, entry.name)
        : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await walkRelativeFilesSorted(rootPath, nextRelativePath)));
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
  cache?: Map<string, string[]>
): Promise<string[]> {
  const cached = cache?.get(repoRoot);

  if (cached) {
    return cached;
  }

  const [allFiles, matcher] = await Promise.all([
    walkRelativeFilesSorted(repoRoot),
    buildIgnoreMatcher(repoRoot)
  ]);
  const files = allFiles.filter((filePath) => !matcher.ignores(filePath));
  cache?.set(repoRoot, files);
  return files;
}
