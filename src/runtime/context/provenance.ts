import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { InputItem } from "../../graph/authored.js";
import type { CompiledExecutableNode } from "../../graph/compiled.js";
import { resolveSubpathWithinRoot } from "../../path_rules.js";
import { globPatternToRegExp, normalizeRelativePath, splitQualifiedPath } from "./common.js";
import { listRepoFiles, walkRelativeFilesSorted } from "./repo_files.js";
import type {
  ContextDigestEntry,
  ContextHarnessInstructionProvenance,
  ContextInputProvenance,
  ContextProvenance
} from "./packet.js";

interface CachedHarnessInstructionSet {
  files: ContextDigestEntry[];
  digest: string;
}

export interface ContextDiscoveryCache {
  repo_file_lists: Map<string, string[]>;
  file_digests: Map<string, string>;
  harness_instruction_sets: Map<string, CachedHarnessInstructionSet | undefined>;
}

export interface ComputeContextProvenanceOptions {
  node: CompiledExecutableNode;
  repo_workspaces: Record<string, string>;
  cache?: ContextDiscoveryCache;
}

function createDigest(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function aggregateDigest(entries: ContextDigestEntry[]): string {
  return createDigest(entries.map((entry) => `${entry.path}:${entry.digest}`).join("\n"));
}

async function digestFile(
  sourcePath: string,
  cache: ContextDiscoveryCache
): Promise<string> {
  const cached = cache.file_digests.get(sourcePath);

  if (cached) {
    return cached;
  }

  const digest = createDigest(await readFile(sourcePath));
  cache.file_digests.set(sourcePath, digest);
  return digest;
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
      digest: await digestFile(absolutePath, cache)
    });
  }

  const cursorRulesRoot = join(repoRoot, ".cursor", "rules");

  if (await pathExists(cursorRulesRoot)) {
    const relativeFiles = await walkRelativeFilesSorted(cursorRulesRoot);

    for (const relativePath of relativeFiles) {
      const repoRelativePath = normalizeRelativePath(join(".cursor", "rules", relativePath));
      files.push({
        path: repoRelativePath,
        digest: await digestFile(join(cursorRulesRoot, relativePath), cache)
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
    repo_file_lists: new Map(),
    file_digests: new Map(),
    harness_instruction_sets: new Map()
  };
}

export async function computeContextProvenance(
  options: ComputeContextProvenanceOptions
): Promise<ContextProvenance> {
  const cache = options.cache ?? createContextDiscoveryCache();
  const inputs: ContextInputProvenance[] = [];

  for (const [index, input] of (options.node.inputs ?? []).entries()) {
    if (input.kind === "text") {
      continue;
    }

    const key = `input_${index + 1}`;
    const { repo_alias, repo_relative_path } = splitQualifiedPath(input.path, options.node.repo);
    const repoRoot = options.repo_workspaces[repo_alias];

    if (!repoRoot) {
      throw new Error(`Unknown repo alias "${repo_alias}" while resolving input provenance.`);
    }

    if (input.kind === "file") {
      const sourcePath = resolveSubpathWithinRoot(
        repoRoot,
        repo_relative_path,
        `Input path "${input.path}"`
      );

      inputs.push({
        kind: "file",
        key,
        repo_alias,
        path: normalizeRelativePath(repo_relative_path),
        digest: await digestFile(sourcePath, cache)
      });
      continue;
    }

    const repoFiles = await listRepoFiles(repoRoot, cache.repo_file_lists);
    const matcher = globPatternToRegExp(normalizeRelativePath(repo_relative_path));
    const matchedPaths = repoFiles
      .filter((filePath) => matcher.test(filePath))
      .slice(0, input.max_files ?? Number.MAX_SAFE_INTEGER);
    const files: ContextDigestEntry[] = [];

    for (const relativePath of matchedPaths) {
      files.push({
        path: relativePath,
        digest: await digestFile(join(repoRoot, relativePath), cache)
      });
    }

    inputs.push({
      kind: "glob",
      key,
      repo_alias,
      pattern: normalizeRelativePath(repo_relative_path),
      files,
      digest: aggregateDigest(files)
    });
  }

  let harness_instructions: ContextHarnessInstructionProvenance | undefined;

  if (usesHarnessInstructions(options.node)) {
    const repoRoot = options.repo_workspaces[options.node.repo];

    if (!repoRoot) {
      throw new Error(
        `Unknown repo alias "${options.node.repo}" while resolving harness instruction provenance.`
      );
    }

    const instructionSet = await collectHarnessInstructionFiles(repoRoot, cache);

    if (instructionSet) {
      harness_instructions = {
        repo_alias: options.node.repo,
        files: instructionSet.files,
        digest: instructionSet.digest
      };
    }
  }

  return {
    compiled_id: options.node.compiled_id,
    authored_id: options.node.authored_id,
    repo_alias: options.node.repo,
    inputs,
    ...(harness_instructions ? { harness_instructions } : {})
  };
}
