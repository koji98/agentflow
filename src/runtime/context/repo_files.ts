import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { normalizeRelativePath } from "./common.js";

const execFileAsync = promisify(execFile);

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
    if (entry.name === ".git") {
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

async function listGitRepoFiles(repoRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    }
  );

  return stdout
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeRelativePath)
    .sort((left, right) => left.localeCompare(right));
}

export async function listRepoFiles(
  repoRoot: string,
  cache?: Map<string, string[]>
): Promise<string[]> {
  const cached = cache?.get(repoRoot);

  if (cached) {
    return cached;
  }

  let files: string[];

  try {
    files = await listGitRepoFiles(repoRoot);
  } catch {
    files = await walkRelativeFilesSorted(repoRoot);
  }

  cache?.set(repoRoot, files);
  return files;
}
