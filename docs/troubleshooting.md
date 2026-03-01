# Troubleshooting

Common issues, root causes, and solutions when running agentflow plans.

## CLI Won't Start

### `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx'`

**Cause:** Node.js version mismatch. agentflow requires Node >= 20 and uses `tsx` for TypeScript execution.

**Fix:** Activate Node 20 before running:

```bash
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20
agentflow --plan plan.json
```

### `node: bad option: --import`

**Cause:** Same Node version issue — `--import` flag requires Node >= 20.

**Fix:** Same as above: `nvm use 20`.

### agentflow works from its install directory but not elsewhere

**Cause:** The global link wasn't set up, or `tsx` isn't resolvable from the target directory.

**Fix:**

```bash
cd /path/to/agentflow
npm run setup:link
```

Then verify: `which agentflow` should point to the npm-linked binary.

## Plan Validation Errors

### `Unknown key "X" in plan/task/gate`

**Cause:** Typo in the plan JSON or using a deprecated/nonexistent field.

**Fix:** Run `agentflow --plan-help` to see all valid keys. Check spelling.

### `repo field required when multiple repos are defined`

**Cause:** Plan has multiple entries in `repos` but a task doesn't specify which repo it targets.

**Fix:** Add `"repo": "<alias>"` to every task node.

### `context file not found: <path>`

**Cause:** The context file path doesn't resolve correctly.

**Fix:** Check path resolution rules:
- `plan:file.md` — resolves from the plan file's directory
- `alias:path` — resolves from the named repo root
- Absolute paths — used as-is
- Bare relative paths — resolve from the plan file's directory

## Run Failures

### `loop exhausted max_iterations without satisfying gate`

**Cause:** A loop ran its maximum iterations but the gate never passed. This is common when the fix task doesn't address all gate failures, or when the gate is too strict.

**What to do:**

1. Read the gate output from the run artifacts:
   ```bash
   cat tmp/agentflow_runs/<run_id>/evaluations/<loop_id>/iter_*_post_body.json
   ```

2. Check the task logs to see what the agent actually fixed:
   ```bash
   cat tmp/agentflow_runs/<run_id>/group_*/task_<id>/worker_exec.log
   ```

3. **Option A — Fix manually and resume:** Make the fixes yourself, then mark the loop as completed in `run_state.json` and resume.

4. **Option B — Increase iterations and resume:** Edit the plan to increase `max_iterations` on the specific loop, then resume.

5. **Option C — Remove the loop:** If the validation is too strict, convert the loop into a simple task + validate pair.

### `Global max_iterations reached`

**Cause:** The plan-level `limits.max_iterations` was set and the total loop iterations across ALL loops hit this cap.

**Fix:** Set `limits.max_iterations` to `null` in the plan. Use per-loop `max_iterations` instead:

```json
{
  "limits": { "max_iterations": null },
  "flow": [
    {
      "type": "loop",
      "max_iterations": 4,
      "..."
    }
  ]
}
```

### Task times out

**Cause:** `worker_timeout_sec` is too low for the task complexity.

**Fix:** Increase `limits.worker_timeout_sec`. Default is 7200 (2 hours). For complex tasks that modify 100+ files, consider 3600–7200.

### Resume skips everything and immediately fails

**Cause:** The run state file marks all tasks (including the failed loop) as completed. On resume, agentflow skips all completed work and hits the same loop gate failure.

**Fix:** Edit `run_state.json` in the run directory:

1. Find the failed node in `completed_nodes`
2. Remove it from `completed_nodes`
3. Optionally fix the underlying issue in the codebase
4. Resume with `--resume`

Or for loops: manually edit `run_state.json` to clear the loop's iteration count.

## Git Issues

### `fatal: not a git repository`

**Cause:** The repo path in the plan doesn't point to a git repository, or the worktree creation failed.

**Fix:** Verify `repos` paths are correct and each points to a valid git repo.

### Force-push rejected

**Cause:** Branch protection rules, or someone else pushed to the branch.

**Fix:** Use `--force-with-lease` (already the recommended default) instead of `--force`. If branch protection is the issue, adjust GitHub settings.

### Wrong branch after resume

**Cause:** A previous task left the repo on the wrong branch. Sequential tasks assume the repo is on `master` or a known branch.

**Fix:** Always start tasks with an explicit `git checkout <branch>`. Never assume branch state.

## Provider Issues

### Cursor: `agent` command not found

**Fix:**
```bash
curl https://cursor.com/install -fsS | bash
```

Then verify: `agent --version`

### Codex: authentication failure

**Fix:** Re-authenticate with:
```bash
codex auth
```

## Reading Run Artifacts

### Task logs

Every task produces artifacts in `<run_root>/<run_id>/group_NN/task_<slug>/`:

| File | What it contains |
|---|---|
| `prompt.md` | The full prompt sent to the agent |
| `worker_exec.log` | The command run + stdout/stderr |
| `worker_last_message.md` | Agent's final response |
| `worker_report.md` | Agent-written report (presence = DONE) |
| `worker_summary.md` | Agent-written summary (for downstream context) |

### Gate logs

Loop evaluations are in `<run_root>/<run_id>/evaluations/<loop_id>/`:

| File | What it contains |
|---|---|
| `iter_NN_pre_body.log` | Pre-body gate evaluation output |
| `iter_NN_pre_body.json` | Pre-body gate JSON result |
| `iter_NN_post_body.log` | Post-body gate evaluation output |
| `iter_NN_post_body.json` | Post-body gate JSON result |

### Run-level state

| File | What it contains |
|---|---|
| `run_state.json` | All completed nodes, failures, and run metadata |
| `run_summary.md` | Human-readable run summary |
| `decision_trace.json` | Gate/retry/termination decision log |

## Performance Tips

### Long plans (20+ tasks)

- Set `on_failure: "continue"` so one failure doesn't block everything
- Set `max_failures` to allow some slack (e.g., 6)
- Use explicit `context_from` to avoid injecting 20 prior summaries into later tasks
- Set `worker_timeout_sec` generously (7200)

### Large file batches

- Split into 15–30 file batches for varied changes
- Add a canary review after the first batch only
- Use glob patterns in the prompt so the agent can discover files

### Multi-repo plans

- Use per-task `context_files` with repo aliases: `"ui:scripts/ref.json"`
- Be explicit about which repo each task targets
- Consider `parallel: true` for independent cross-repo work
