# Node Workspace Snapshots

Agentflow captures a per-attempt git snapshot for every `agent` and `exec` node so the runtime has audit evidence for what the workspace looked like before and after an attempt. These snapshots feed delivery, resume, apply, debugging, and outcome verification, but they are provenance evidence rather than a perfect statement of node intent.

## Goals

- Preserve before/after workspace evidence for a node attempt, including when the workspace was already dirty before the node ran.
- Work for both `inplace` and `worktree` workspace backends without backend-specific code paths.
- Capture untracked, modified, deleted, renamed, binary, and large files.
- Survive git/IO failures by recording a `capture_error` field rather than aborting the attempt.

## Algorithm

For every snapshot the engine runs:

1. `git rev-parse HEAD` — current head SHA.
2. `git stash create` — produces a transient commit object representing the working tree and index without modifying state. Empty when the working tree is clean.
3. `git ls-files --others --exclude-standard -z` — list of untracked-but-not-ignored files.
4. `git status --porcelain=v1 --untracked-files=all` — human-readable status text persisted alongside the snapshot.

The snapshot is the tuple `{ head_sha, stash_sha, untracked_files, status_text }`. If any git command fails, the snapshot returns with an empty SHA pair and `capture_error` set; the engine treats that as a degraded but non-fatal signal.

The engine snapshots once before invoking the harness (the baseline), then snapshots again after the harness returns (the after-state). The diff is a tree delta between those two captured states and is computed as:

- Tracked diff: `git diff --binary --no-renames <baselineRef> <afterRef>` where `Ref = stash_sha || head_sha`. `--no-renames` is intentional so renames surface as both a delete and an addition; the verifier sees both paths.
- New untracked files: set difference `(after.untracked - baseline.untracked)`. For each new file the engine runs `git diff --binary --no-index -- /dev/null <path>` so the diff patch contains the new content.
- Deleted untracked files: set difference `(baseline.untracked - after.untracked)`; reported as path-only deletes since the content is no longer present.

## Persistence Layout

Per-attempt artifacts live under `<attempt_dir>/workspace-changes/`:

- `baseline.json` — snapshot taken before the harness ran.
- `after.json` — snapshot taken after the harness returned (always written, even on failure paths).
- `status.txt` — human-readable `git status` output captured with the after snapshot.
- `diff.patch` — combined tracked + untracked unified diff in patch format.
- `changed-files.json` — list of changed file paths (tracked diff names plus added and removed untracked files).
- `capture_error.txt` — present only when capture failed; contains the error message.

These artifacts are referenced from the attempt's metadata as `node_workspace_changes` so resume, delivery, apply, debugging, and the outcome verifier can find them without re-running git. The verifier receives a short summary and paths to these artifacts by default, not the full patch inline.

## Interpretation

The captured diff is not always the same thing as "what this node intentionally authored." It can become ambiguous when:

- the baseline was already dirty,
- the node switches branches or rebases onto a newer base,
- upstream commits are incorporated during the attempt,
- hooks or generators rewrite files,
- `inplace` parallel nodes share a repo,
- work spans repos outside the node's primary workspace.

In those cases, the diff remains useful for audit and investigation, but declared artifacts, decision logs, command evidence, commit ranges, or PR base/head facts are usually stronger supervision evidence.

## Resume Safety

Snapshot files are created during attempt execution and are immutable once written. On resume, the engine does not re-snapshot or recompute the diff for an attempt that already completed; it re-reads the `after.json` if needed.

If a previously interrupted attempt is restarted, a fresh attempt directory is allocated and the snapshot pair is captured anew against the live workspace state.

## Inplace + Parallel Caveat

`inplace` workspaces share the repository directory across nodes. When two `agent` or `exec` nodes execute against the same repo concurrently, their diffs may overlap. Agentflow does not lock the workspace; users running parallel inplace nodes should treat the per-node diff as best-effort provenance rather than a strict per-node ledger. `worktree` backends do not have this caveat because each node gets its own working tree.

## Limits And Failure Modes

- Large files (multi-megabyte) are diffed; the patch is written without loading the entire workspace into memory.
- Binary files are recorded with `--binary` so the patch can be applied later if needed.
- If `git stash create` itself fails (corrupt repo, no commits), the snapshot still records `head_sha`, status text, and untracked files, with `capture_error` set so downstream consumers know the diff is degraded.
- Persistence failures are best-effort: if the engine cannot write the `workspace-changes/` artifacts, the in-memory snapshot is still available for that attempt and node completion is not blocked.
