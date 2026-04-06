import { isAbsolute, relative, resolve } from "node:path";

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function hasWindowsDrivePrefix(value: string): boolean {
  return /^[a-zA-Z]:\//.test(value);
}

export function isRelativeSubpath(value: string): boolean {
  const normalized = normalizeSeparators(value.trim());

  if (normalized.length === 0 || normalized.startsWith("/") || hasWindowsDrivePrefix(normalized)) {
    return false;
  }

  let depth = 0;

  for (const segment of normalized.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (depth === 0) {
        return false;
      }

      depth -= 1;
      continue;
    }

    depth += 1;
  }

  return true;
}

export function resolveSubpathWithinRoot(
  rootPath: string,
  subpath: string,
  label: string
): string {
  if (!isRelativeSubpath(subpath) || isAbsolute(subpath)) {
    throw new Error(`${label} must be a relative path that stays within its repo or workspace root.`);
  }

  const resolvedPath = resolve(rootPath, subpath);
  const relativePath = relative(rootPath, resolvedPath);

  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${label} must stay within its repo or workspace root.`);
  }

  return resolvedPath;
}
