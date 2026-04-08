import { access } from "node:fs/promises";
import { join } from "node:path";

import type { CompiledExecutableNode } from "../../graph/compiled.js";
import { normalizeRelativePath } from "./common.js";
import { aggregateDigest, digestFile } from "./digests.js";
import type {
  ContextDigestEntry,
  ContextHarnessInstructionProvenance
} from "./packet.js";
import { walkRelativeFilesSorted } from "./repo_files.js";

interface CachedHarnessInstructionSet {
  files: ContextDigestEntry[];
  digest: string;
}

export interface ContextDiscoveryCache {
  file_digests: Map<string, string>;
  harness_instruction_sets: Map<string, CachedHarnessInstructionSet | undefined>;
  repo_files: Map<string, string[]>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collectHarnessInstructionFiles(
  repoRoot: string,
  cache: ContextDiscoveryCache
): Promise<CachedHarnessInstructionSet | undefined> {
  const cached = cache.harness_instruction_sets.get(repoRoot);

  if (cache.harness_instruction_sets.has(repoRoot)) {
    return cached;
  }

  const files: ContextDigestEntry[] = [];
  const fixedRelativePaths = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];

  for (const relativePath of fixedRelativePaths) {
    const absolutePath = join(repoRoot, relativePath);

    if (!(await pathExists(absolutePath))) {
      continue;
    }

    files.push({
      path: normalizeRelativePath(relativePath),
      digest: await digestFile(absolutePath, cache.file_digests)
    });
  }

  const cursorRulesRoot = join(repoRoot, ".cursor", "rules");

  if (await pathExists(cursorRulesRoot)) {
    const relativeFiles = await walkRelativeFilesSorted(cursorRulesRoot);

    for (const relativePath of relativeFiles) {
      const repoRelativePath = normalizeRelativePath(join(".cursor", "rules", relativePath));
      files.push({
        path: repoRelativePath,
        digest: await digestFile(join(cursorRulesRoot, relativePath), cache.file_digests)
      });
    }
  }

  const instructionSet =
    files.length > 0
      ? {
          files,
          digest: aggregateDigest(files)
        }
      : undefined;

  cache.harness_instruction_sets.set(repoRoot, instructionSet);
  return instructionSet;
}

function usesHarnessInstructions(node: CompiledExecutableNode): boolean {
  return (
    node.kind === "agent"
    || node.kind === "checkpoint"
    || (node.kind === "check" && node.check_kind === "ai")
  );
}

export function createContextDiscoveryCache(): ContextDiscoveryCache {
  return {
    file_digests: new Map(),
    harness_instruction_sets: new Map(),
    repo_files: new Map()
  };
}

export async function computeHarnessInstructionProvenance(options: {
  node: CompiledExecutableNode;
  repo_workspaces: Record<string, string>;
  cache?: ContextDiscoveryCache;
}): Promise<ContextHarnessInstructionProvenance | undefined> {
  const cache = options.cache ?? createContextDiscoveryCache();

  if (!usesHarnessInstructions(options.node)) {
    return undefined;
  }

  const repoRoot = options.repo_workspaces[options.node.repo];

  if (!repoRoot) {
    throw new Error(
      `Unknown repo alias "${options.node.repo}" while resolving harness instruction provenance.`
    );
  }

  const instructionSet = await collectHarnessInstructionFiles(repoRoot, cache);

  return instructionSet
    ? {
        repo_alias: options.node.repo,
        files: instructionSet.files,
        digest: instructionSet.digest
      }
    : undefined;
}
