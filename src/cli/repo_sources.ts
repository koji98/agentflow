import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AuthoredGraphDocument } from "../graph/authored.js";

export async function resolveRepoSources(
  absoluteGraphPath: string,
  document: AuthoredGraphDocument
): Promise<{
  repo_sources?: Record<string, string>;
  diagnostics: Array<{
    path: string;
    message: string;
  }>;
}> {
  const graphDirectory = dirname(absoluteGraphPath);
  const repo_sources: Record<string, string> = {};
  const diagnostics: Array<{
    path: string;
    message: string;
  }> = [];

  for (const [repoAlias, repoDefinition] of Object.entries(document.repos)) {
    const absoluteRepoPath = resolve(graphDirectory, repoDefinition.path);

    try {
      const entry = await stat(absoluteRepoPath);

      if (!entry.isDirectory()) {
        diagnostics.push({
          path: `$.repos.${repoAlias}.path`,
          message: `Resolved repo path is not a directory: ${absoluteRepoPath}`
        });
        continue;
      }

      repo_sources[repoAlias] = absoluteRepoPath;
    } catch (error) {
      diagnostics.push({
        path: `$.repos.${repoAlias}.path`,
        message:
          error instanceof Error
            ? `Repo path could not be resolved: ${absoluteRepoPath} (${error.message})`
            : `Repo path could not be resolved: ${absoluteRepoPath}`
      });
    }
  }

  return diagnostics.length > 0
    ? { diagnostics }
    : {
        repo_sources,
        diagnostics
      };
}
