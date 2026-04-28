import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  diffNodeSnapshots,
  persistNodeWorkspaceChanges,
  resolveNodeWorkspaceChangePaths,
  snapshotWorkspaceForNode
} from "../../../src/runtime/workspace/node-snapshot.js";

const execFileAsync = promisify(execFile);

async function gitInit(repo: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Agentflow Tests"], { cwd: repo });
  await writeFile(join(repo, "seed.txt"), "seed\n");
  await execFileAsync("git", ["add", "seed.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo });
}

async function setupRepo(label: string): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `agentflow-node-snapshot-${label}-`));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await gitInit(repo);
  return {
    repo,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe("snapshotWorkspaceForNode + diffNodeSnapshots", () => {
  let repo: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const setup = await setupRepo("base");
    repo = setup.repo;
    cleanup = setup.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("returns an empty diff when the workspace is clean and unchanged", async () => {
    const before = await snapshotWorkspaceForNode(repo);
    const after = await snapshotWorkspaceForNode(repo);
    const diff = await diffNodeSnapshots(repo, before, after);

    expect(diff.capture_error).toBeUndefined();
    expect(diff.diff_patch).toBe("");
    expect(diff.changed_files).toEqual([]);
    expect(diff.deleted_untracked).toEqual([]);
  });

  it("captures only the new edit when the baseline is dirty", async () => {
    await writeFile(join(repo, "seed.txt"), "seed\nbaseline edit\n");

    const before = await snapshotWorkspaceForNode(repo);
    expect(before.stash_sha.length).toBeGreaterThan(0);

    await writeFile(join(repo, "seed.txt"), "seed\nbaseline edit\nnode edit\n");

    const after = await snapshotWorkspaceForNode(repo);
    const diff = await diffNodeSnapshots(repo, before, after);

    expect(diff.diff_patch).toContain("node edit");
    expect(diff.diff_patch).not.toContain("+seed");
    expect(diff.changed_files.map((entry) => entry.path)).toEqual(["seed.txt"]);
    expect(diff.changed_files[0]?.change_kind).toBe("tracked");
  });

  it("captures a tracked file modified between snapshots", async () => {
    const before = await snapshotWorkspaceForNode(repo);
    await writeFile(join(repo, "seed.txt"), "seed\nmodified\n");
    const after = await snapshotWorkspaceForNode(repo);
    const diff = await diffNodeSnapshots(repo, before, after);

    expect(diff.diff_patch).toContain("+modified");
    expect(diff.changed_files).toEqual([{ path: "seed.txt", change_kind: "tracked" }]);
  });

  it("captures a brand new untracked file", async () => {
    const before = await snapshotWorkspaceForNode(repo);
    await writeFile(join(repo, "fresh.txt"), "fresh content\n");
    const after = await snapshotWorkspaceForNode(repo);
    const diff = await diffNodeSnapshots(repo, before, after);

    expect(diff.diff_patch).toContain("fresh content");
    expect(diff.changed_files).toEqual([
      { path: "fresh.txt", change_kind: "untracked_added" }
    ]);
    expect(diff.deleted_untracked).toEqual([]);
  });

  it("reports a tracked file deleted between snapshots", async () => {
    const before = await snapshotWorkspaceForNode(repo);
    await rm(join(repo, "seed.txt"));
    const after = await snapshotWorkspaceForNode(repo);
    const diff = await diffNodeSnapshots(repo, before, after);

    expect(diff.diff_patch).toContain("-seed");
    expect(diff.changed_files.map((entry) => entry.path)).toContain("seed.txt");
    const trackedEntry = diff.changed_files.find((entry) => entry.path === "seed.txt");
    expect(trackedEntry?.change_kind).toBe("tracked");
  });

  it("detects a rename via tracked diff", async () => {
    const before = await snapshotWorkspaceForNode(repo);
    await execFileAsync("git", ["mv", "seed.txt", "renamed.txt"], { cwd: repo });
    const after = await snapshotWorkspaceForNode(repo);
    const diff = await diffNodeSnapshots(repo, before, after);

    const paths = diff.changed_files.map((entry) => entry.path).sort();
    expect(paths).toEqual(["renamed.txt", "seed.txt"]);
  });

  it("captures a binary file modification", async () => {
    const binaryPath = join(repo, "binary.bin");
    await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await execFileAsync("git", ["add", "binary.bin"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "add binary"], { cwd: repo });

    const before = await snapshotWorkspaceForNode(repo);
    await writeFile(binaryPath, Buffer.from([0x10, 0x11, 0x12, 0x13, 0x14]));
    const after = await snapshotWorkspaceForNode(repo);
    const diff = await diffNodeSnapshots(repo, before, after);

    expect(diff.changed_files.map((entry) => entry.path)).toEqual(["binary.bin"]);
    expect(diff.diff_patch.length).toBeGreaterThan(0);
  });

  it("captures a large file diff without throwing", async () => {
    const before = await snapshotWorkspaceForNode(repo);
    const large = Buffer.alloc(1024 * 1024 + 1, "a");
    await writeFile(join(repo, "large.txt"), large);
    const after = await snapshotWorkspaceForNode(repo);
    const diff = await diffNodeSnapshots(repo, before, after);

    expect(diff.changed_files.map((entry) => entry.path)).toEqual(["large.txt"]);
    expect(diff.diff_patch.length).toBeGreaterThan(0);
    expect(diff.capture_error).toBeUndefined();
  });

  it("returns a captureError for a corrupt repository instead of throwing", async () => {
    const broken = await mkdtemp(join(tmpdir(), "agentflow-node-snapshot-broken-"));
    try {
      const snapshot = await snapshotWorkspaceForNode(broken);
      expect(snapshot.capture_error).toBeDefined();
      expect(snapshot.head_sha).toBe("");

      const after = await snapshotWorkspaceForNode(broken);
      const diff = await diffNodeSnapshots(broken, snapshot, after);
      expect(diff.capture_error).toBeDefined();
      expect(diff.diff_patch).toBe("");
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });
});

describe("persistNodeWorkspaceChanges", () => {
  let repo: string;
  let cleanup: () => Promise<void>;
  let attemptDir: string;

  beforeEach(async () => {
    const setup = await setupRepo("persist");
    repo = setup.repo;
    cleanup = setup.cleanup;
    attemptDir = join(setup.repo, "..", "attempt");
    await mkdir(attemptDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanup();
  });

  it("writes baseline, after, status, diff, and changed-files artifacts", async () => {
    const before = await snapshotWorkspaceForNode(repo);
    await writeFile(join(repo, "added.txt"), "added\n");
    const after = await snapshotWorkspaceForNode(repo);
    const diff = await diffNodeSnapshots(repo, before, after);
    const artifacts = await persistNodeWorkspaceChanges(attemptDir, before, after, diff);

    const paths = resolveNodeWorkspaceChangePaths(attemptDir);
    expect(artifacts).toMatchObject({
      baseline_path: paths.baseline_path,
      after_path: paths.after_path,
      status_path: paths.status_path,
      diff_patch_path: paths.diff_patch_path,
      changed_files_path: paths.changed_files_path,
      changed_file_count: 1,
      status: "captured"
    });
    expect(artifacts.capture_error_path).toBeUndefined();

    const baseline = JSON.parse(await readFile(paths.baseline_path, "utf8"));
    expect(baseline.head_sha).toBe(before.head_sha);

    const changed = JSON.parse(await readFile(paths.changed_files_path, "utf8"));
    expect(changed).toEqual([{ path: "added.txt", change_kind: "untracked_added" }]);

    expect((await stat(paths.diff_patch_path)).size).toBeGreaterThan(0);
  });

  it("records degraded status and writes capture-error.txt when capture fails", async () => {
    const broken = await mkdtemp(join(tmpdir(), "agentflow-node-snapshot-persist-broken-"));
    try {
      const before = await snapshotWorkspaceForNode(broken);
      const after = await snapshotWorkspaceForNode(broken);
      const diff = await diffNodeSnapshots(broken, before, after);
      const artifacts = await persistNodeWorkspaceChanges(attemptDir, before, after, diff);

      expect(artifacts.status).toBe("degraded");
      expect(artifacts.capture_error_path).toBeDefined();
      const errorContent = await readFile(artifacts.capture_error_path!, "utf8");
      expect(errorContent.length).toBeGreaterThan(0);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });
});
