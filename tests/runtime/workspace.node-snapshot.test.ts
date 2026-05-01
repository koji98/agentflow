import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  diffNodeSnapshots,
  persistNodeWorkspaceChanges,
  restoreNodeWorkspaceChangesFromSnapshot,
  snapshotWorkspaceForNode
} from "../../src/runtime/workspace/node-snapshot.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("node workspace snapshots", () => {
  it("restores failed-attempt tracked and untracked changes from a baseline snapshot", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-workspace-restore-"));
    const repoDir = join(tempRoot, "repo");
    const attemptDir = join(tempRoot, "attempt");
    await mkdir(repoDir, { recursive: true });
    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "agentflow@example.com"]);
    await git(repoDir, ["config", "user.name", "Agentflow Test"]);
    await writeFile(join(repoDir, "kept.txt"), "baseline\n", "utf8");
    await git(repoDir, ["add", "kept.txt"]);
    await git(repoDir, ["commit", "-m", "initial"]);

    const before = await snapshotWorkspaceForNode(repoDir);
    await writeFile(join(repoDir, "kept.txt"), "polluted\n", "utf8");
    await writeFile(join(repoDir, "noise.txt"), "failed attempt output\n", "utf8");
    const after = await snapshotWorkspaceForNode(repoDir);
    const diff = await diffNodeSnapshots(repoDir, before, after);
    await persistNodeWorkspaceChanges(attemptDir, before, after, diff);

    const restored = await restoreNodeWorkspaceChangesFromSnapshot({
      workspacePath: repoDir,
      attemptDir
    });

    expect(restored.status).toBe("passed");
    expect(restored.cleaned_files).toEqual(["kept.txt", "noise.txt"]);
    expect(await readFile(join(repoDir, "kept.txt"), "utf8")).toBe("baseline\n");
    await expect(readFile(join(repoDir, "noise.txt"), "utf8")).rejects.toThrow();

    await rm(tempRoot, { recursive: true, force: true });
  });
});
