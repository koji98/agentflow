import type { CompiledGraph } from "./compiled.js";
import { splitQualifiedPath } from "../runtime/context/common.js";

export function collectReferencedRepoAliases(graph: CompiledGraph): string[] {
  const repoAliases = new Set<string>();

  for (const node of graph.nodes) {
    repoAliases.add(node.repo);

    for (const item of node.context) {
      if ("ref" in item) {
        continue;
      }

      if (item.from !== "plugin_file") {
        repoAliases.add(splitQualifiedPath(item.path, node.repo).repo_alias);
      }
    }
  }

  return [...repoAliases].sort((left, right) => left.localeCompare(right));
}
