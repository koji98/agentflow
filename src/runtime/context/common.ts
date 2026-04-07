export function normalizeRelativePath(value: string): string {
  return value.split("\\").join("/");
}

export function globPatternToRegExp(pattern: string): RegExp {
  const escaped = normalizeRelativePath(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ":::DOUBLE_STAR:::")
    .replace(/\*/g, "[^/]*")
    .replace(/:::DOUBLE_STAR:::/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`);
}

export function splitQualifiedPath(
  value: string,
  fallbackRepo: string
): {
  repo_alias: string;
  repo_relative_path: string;
} {
  const separatorIndex = value.indexOf(":");

  if (separatorIndex <= 0) {
    return {
      repo_alias: fallbackRepo,
      repo_relative_path: value
    };
  }

  return {
    repo_alias: value.slice(0, separatorIndex),
    repo_relative_path: value.slice(separatorIndex + 1)
  };
}
