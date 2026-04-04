import { access } from "node:fs/promises";

import type { WorkspaceBackendOptions, WorkspaceSetup } from "./types.js";

export async function initializeInplaceWorkspace(
  options: WorkspaceBackendOptions
): Promise<WorkspaceSetup> {
  const repo_workspaces = Object.fromEntries(
    await Promise.all(
      Object.entries(options.repo_sources).map(async ([repo_alias, source_path]) => {
        await access(source_path);

        return [
          repo_alias,
          {
            repo_alias,
            source_path,
            workspace_path: source_path,
            backend: "inplace" as const
          }
        ];
      })
    )
  );

  return {
    backend: "inplace",
    repo_workspaces,
    async cleanup() {
      return;
    }
  };
}
