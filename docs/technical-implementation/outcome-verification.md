# Outcome Verification

Outcome verification is the runtime contract that grades every passing `agent` node attempt against the graph and node intent before the engine is allowed to mark the attempt `passed`. It is always on; there is no per-profile flag and no per-node opt-out.

## Why It Exists

Without an external grader, an agent that "claims" to satisfy the acceptance criteria is the only authority that says it did. Outcome verification turns acceptance criteria into a real runtime contract: the agent does the work, then a fresh-context judge with no edit authority audits the captured response, declared artifacts, decision log, and supporting workspace-change provenance against the authored intent.

## Where It Runs

Outcome verification runs only for `agent` nodes that:

- exited with `status === "passed"` and `outcome === "passed"`,
- materialized every declared artifact, and
- were not canceled mid-attempt.

It is skipped for `check`, `checkpoint`, and `pattern_*` nodes (their contracts already exist) and for `exec` nodes (their exit code is the contract). The per-attempt workspace snapshot still runs for `exec` nodes so review and apply workflows have the diff.

## Inputs

The verifier receives:

- Graph intent: goal, acceptance criteria, constraints.
- Node intent: authored id, compiled id, execution id, attempt and iteration indices, goal, acceptance criteria, constraints.
- Workspace path and a per-node workspace-change summary with paths to full audit artifacts (see `node-workspace-snapshots.md`).
- Decision log entries recorded by the node with `af log --type decision`, each containing a decision, rationale, and evidence list.
- The agent's captured response (`agent-response.md`) as an inline snippet.
- Each declared artifact's content as an inline snippet, with size truncation guards and explicit `(truncated)` markers.

Per-artifact prompt contents are truncated above a fixed byte budget. Truncation is reported in the verifier metadata via `truncated_artifacts` so reviewers know the verifier judged from a partial view. Workspace diffs are not inlined by default; the verifier receives the changed-file count and artifact paths, and should read the full diff only when investigating a concrete contradiction.

## Verification Posture

The verifier leans passing unless it has strong, concrete, actionable blocker evidence. Ambiguous, incomplete, or lower-confidence evidence should usually become a non-blocker finding rather than a retry.

Primary supervision evidence is:

1. Declared artifacts.
2. Decision log entries.
3. The final response.
4. Deterministic command/tool evidence cited by those records.
5. Workspace-change artifacts as audit/provenance evidence.

Workspace diffs are useful for debugging and manual review, but they are not the default source of truth for intent. They should not be the sole reason for `passed=false` unless they are the only authoritative evidence for the node's required change and show a concrete contract violation.

## Verifier Invocation

The verifier reuses the same `HarnessAdapter` and the same `model` as the executor of the agent node. Differences:

- `promptKind` is `"outcome_verification"`.
- The harness session is fresh (`executionId` is suffixed with `__verifier`) so verifier and executor never share working memory.
- `sandbox` is `"read-only"`. Cursor and Codex adapters add `Write`, `Shell`, `WebFetch`, and `Mcp` to their deny lists when this prompt kind is set.
- `tools` is empty. The verifier has filesystem read access via the harness default but no plugin tools.
- `nodeAcceptanceCriteria` and `nodeConstraints` on the verifier invocation enforce JSON-only output.
- `rubric` carries the rendered verifier prompt, which is what the harness sees verbatim.

## Output Schema

The verifier must respond with a single fenced JSON block:

```json
{
  "passed": true,
  "summary": "Short rationale.",
  "findings": [
    {
      "severity": "blocker" | "high" | "medium" | "low",
      "category": "stable_short_label",
      "evidence": "What was observed in the captured artifacts or diff.",
      "recommendation": "What to change next attempt.",
      "references": ["optional/path:lines"]
    }
  ]
}
```

The parser tolerates the JSON block being surrounded by an opening or closing fence and recovers from missing fences. It rejects:

- Prose-only responses with no JSON.
- JSON that does not validate against the schema (wrong types, missing required fields, invalid `severity` values).
- Semantically inconsistent verdicts (e.g. `passed: true` while `findings` contain a `blocker`).

When the parser rejects a response, the verifier is invoked again up to a bounded retry budget. If it still cannot parse, the engine writes a fail-closed result with a `verifier_unparseable` blocker and surfaces the raw response excerpt in the verifier metadata.

## Persistence

Per-attempt artifacts live under `<attempt_dir>`:

- `verify-outcome.prompt.md` — exact prompt sent to the verifier.
- `verify-outcome.raw-response.md` — last raw verifier response received.
- `verify-outcome.json` — final verdict, summary, findings, blockers, and verifier metadata.
- `verify-outcome.md` — human-readable rendering of the verdict and findings.

The attempt's metadata records the verifier result as `outcome_verification` so the supervisor classifier and downstream consumers can read it without re-parsing the disk artifacts.

## Engine Wiring

After an `agent` attempt's harness exits clean and declared artifacts are materialized, the engine calls `runOutcomeVerification` and emits an `outcome.verified` event with `passed`, `findings_count`, `blockers_count`, `verifier_harness`, `parse_status`, `duration_ms`, and the on-disk `verify_outcome_path`.

If the verifier rejects, the engine sets `result.outcome = "failed"`, attaches the verifier payload to `result.result.outcome_verification`, and falls through to the existing failure path. The supervisor classifier detects `result.result.outcome_verification.passed === false`, returns class `outcome_verification`, and recommends `retry_with_guidance`. The retry brief embeds the verifier's blockers (and remaining findings) into `retry-guidance.md` so the next attempt's prompt cites the failed acceptance criteria with concrete recommendations.

If the supervisor budget for `retry_with_guidance` is exhausted, the run fails with the `outcome_verification` classification and the failed verifier verdict in the delivery package.

## Resume Safety

Verifier verdicts are file-backed under the attempt directory. Resumed runs reuse a previously verified attempt's verdict directly; the verifier is not re-invoked for an attempt that already produced `verify-outcome.json`.

## What This Replaces

Authors no longer need to add an AI `check` after every substantive agent node solely to evaluate the same acceptance criteria — the runtime already grades the attempt against `acceptance_criteria` on the agent node. Use `check` nodes for in-run sensors (deterministic facts, downstream gating) and managed pattern evaluation for authored repair loops; outcome verification covers the rubric grade.
