# Prompt Surfaces

Agentflow prompts are compiled runtime contracts. Treat them like code: each surface has an authority boundary, structured inputs, output expectations, tests, and eval coverage. Do not add alternate prompt shapes, prompt aliases, legacy prompt packs, or compatibility shims.

## Section Model

Prompt sections should appear in this order when applicable:

1. `Role`
2. `Evaluation Target` for evaluator prompts
3. `Success Contract`
4. `Supervisor Recovery Case` on retries
5. `Workspace`
6. `Graph Context`
7. `Context`
8. `Optional Skills`
9. `Ambient CLI Hints`
10. `Managed Plugin Tools`
11. `Declared Artifacts`
12. `Operating Brief`

Role text is useful only when it changes authority, scope, output contract, or evaluation responsibility. Avoid generic persona adjectives unless a prompt-regression eval proves the wording is load-bearing.

For normal worker prompts, keep the launch brief close to the native Codex/Cursor experience: role, node contract, workspace, concise context pointers, declared artifacts, and a short operating brief. Detailed runtime mechanics, retry state, artifact rules, and completion details belong behind `af orient`, `af --help`, and `af complete check`. Retry prompts keep only a compact recovery notice; detailed resume point, preserve/discard, validation gate, do-not-redo guidance, and attempt memory belong in `af orient`.

Managed worker prompts follow the same native-quality contract. They may add phase or item focus, but they should not frame the task as satisfying Agentflow ceremony. Keep graph mechanics, public/private artifact language, lowered-node internals, and retry ledgers in runtime state, verifier context, delivery evidence, or `af orient`.

Evaluator prompts use a target-first packet. The `Evaluation Target` section names what is being judged, the target, allowed evidence, out-of-scope evidence/work, and whether the result controls runtime, managed retry, eval scoring, or human delivery. Shared transport is allowed, but evaluator surfaces keep separate schemas: authored AI checks use `{passed, score, summary, issues}`, managed criteria require strict `{passed, score, summary, issues}` with score from 0 to 1, eval quality judges use `{passed_quality_bar, score, dimension_scores, blockers, rationale, prompt_feedback}`, and outcome verification uses its fenced `{passed, summary, findings}` verdict.

## Inventory

| Surface | Renderer | Prompt kind | Authority boundary | Contract inputs | Output contract | Coverage |
| --- | --- | --- | --- | --- | --- | --- |
| Standard agent node | `src/runtime/harness/types.ts` | `agent` | Executes one node, not the graph; node task controls graph context. | graph intent, node intent, sandbox, context pointer table, tools, declared artifacts, compact recovery notice | final response plus declared artifacts after `af complete check` | `tests/runtime/harness_prompt.test.ts`, `evals/agentflow-prompt-regression`, direct-parity evals |
| Artifact repair | `src/runtime/harness/types.ts` | `artifact_repair` | Repair missing declared artifacts only; no unrelated work. | original task, missing artifact list, agent-facing repair brief, agent context brief | missing artifacts at exact paths | `tests/runtime/harness_prompt.test.ts` |
| AI check | `src/runtime/harness/types.ts` | `ai_check` | Read-only check node; no workspace mutation. | evaluation target, check intent, graph context, agent context brief, output schema | JSON only | `tests/runtime/harness_prompt.test.ts`, runtime check tests |
| Supervisor evidence gatherer | `src/runtime/harness/types.ts` | `supervisor_evidence` | Read-only evidence for a failed attempt; cannot rewrite graph intent. | case file, gather kind, evidence output path, instructions | JSON evidence patch | supervisor recovery tests |
| Fixed supervisor helper | `src/af/index.ts` | `_helper-run` | Read-only bounded helper; no source edits, service mutation, plugin tools, or human-pause decisions. | helper role, brief, case/evidence pointers, parent context manifest, required artifact | Markdown helper artifact | `tests/af/cli.test.ts` |
| Supervisor recovery brief | `src/runtime/harness/types.ts` | agent block | Compact retry notice; original node contract remains binding. | failure symptom, best resume point, restart boundary, workspace decision, required next action | run `af orient` for detailed recovery state, then change tactics inside unchanged task | `tests/runtime/harness_prompt.test.ts`, supervisor tests |
| Attempt memory | `src/runtime/attempt_memory.ts` + `src/af/index.ts` | `af orient` block | Runtime-authored memory only; evidence for continuation, not new authority. | prior event timeline, best-resume decision, completed milestones, unfinished work, artifact state, validation evidence, workspace changes, do-not-redo | resume from the best valid boundary without preserving unsafe progress or redoing validated work | `tests/runtime/engine.test.ts`, `tests/af/cli.test.ts`, `tests/runtime/attempt_memory.test.ts` |
| Outcome verifier | `src/runtime/verification/prompt.ts` | verifier | Fresh read-only audit after mechanical completion. | graph/node intent, completion packet, artifacts, milestone evidence, command evidence, diff metadata | one fenced JSON verdict | `tests/runtime/verification/prompt.test.ts`, verifier eval scenarios |
| Operating brief | `src/runtime/harness/types.ts` | prompt block | Normal worker correctness loop only. | concise reminders for `af orient`, milestones, artifacts, `af --help`, and `af complete check` | use `af orient` for detailed state and finish only after `af complete check` | harness prompt tests, prompt-regression trajectory checks |
| Plugin tool block | `src/runtime/harness/types.ts` | prompt block | Select granted plugin CLIs only when useful. | resolved plugin tools, descriptions, usage reminder | tool calls with `--help` just in time | tool tests, prompt-regression tool discipline |
| Context block | `src/runtime/harness/types.ts` | prompt block | Pointer evidence, not authority over node contract. | priority sections from `agent/context.md`; generated glob indexes for broad file sets | read first/current-work pointers before broad search; use reference sets selectively | harness prompt tests, context evals |
| Deep work planner | `src/managed/pattern_deep_work.ts` | managed agent | Plan work needed to satisfy the full task from current state; no edits. | task contract, criteria, prior scorecard/work notes, optional additive `phases.plan` intent/support/runtime | `plan.md` | `tests/graph/deep_work.test.ts` |
| Deep work generator/validator | `src/managed/pattern_deep_work.ts` | managed agent | Satisfy the full task from current state and publish evidence after doing the work. | `plan.md` guidance, failed scorecard, criteria, final artifact draft contract, optional additive `phases.execute` intent/support/runtime | `work-notes.md` plus draft artifacts | `tests/graph/deep_work.test.ts`, managed evals |
| Deep work criterion evaluator | `src/managed/pattern_deep_work.ts` | AI check rubric with managed-criterion surface | Grade only current evidence for one criterion. Required criteria below threshold block even if the evaluator returned `passed: true`. | evaluation target, rubric criterion, draft artifacts/work notes, optional additive `phases.verify` intent/support/runtime | strict JSON `{passed, score, summary, issues}` | `tests/graph/deep_work.test.ts`, runtime check tests |
| Deep work finalizer | `src/managed/pattern_deep_work.ts` | deterministic exec | Write the runtime-owned `packet` and promote accepted user-authored drafts after the latest passing scorecard. | scorecard, work notes, accepted draft user artifacts, optional additive `phases.publish` intent metadata | `packet` plus user-authored final artifacts | `tests/graph/deep_work.test.ts` |
| Deep research angle worker | `src/managed/pattern_deep_research.ts` | managed agent | Research one assigned angle in a disposable investigation workspace; source workspace is protected. | final contract, assigned angle, context | `angle-report.md` | `tests/graph/deep_research.test.ts` |
| Deep research synthesis worker | `src/managed/pattern_deep_research.ts` | managed agent | Collapse Markdown reports without losing unique findings or provenance in a disposable investigation workspace. | input reports | `synthesis.md` | `tests/graph/deep_research.test.ts` |
| Deep research publisher | `src/managed/pattern_deep_research.ts` | managed agent | Publishes one complete conflict-resolved research report from disposable investigation workspace evidence. | final contract, angle report pointers, synthesis report pointers | `research.md` | `tests/graph/deep_research.test.ts` |
| Work-list planner | `src/managed/pattern_work_list.ts` | managed agent | Discover a finite ordered list; no product/source edits. | node contract, planning goal, item guidance, context | `work-list.json` | `tests/graph/work_list.test.ts` |
| Work-list item worker | `src/runtime/core/engine.ts` + `src/managed/pattern_work_list.ts` | runtime-managed agent per item | Execute one frozen item without changing the list. For deep-work item workers, plan and execute are item-phase agent prompts; accepted draft results are finalized deterministically. | parent contract, current item, frozen list, ledger, item guidance, prior completed item results, scorecard/recovery memory, optional additive `item_worker.phases.plan/execute/verify/publish` metadata | simple: `item-result.json`; deep-work: item-scoped `plan.md`, `item-work-notes.md`, `draft-item-result.json`, then promoted `item-result.json` | `tests/runtime/work_list.test.ts` |
| Work-list item criterion evaluator | `src/runtime/core/engine.ts` | command or AI check with managed-criterion surface | Grade only current-item evidence for one criterion. Required criteria below item threshold block even if the evaluator returned `passed: true`. | evaluation target, current item result or draft result, ledger, prior evidence as relevant, optional additive `item_worker.phases.verify` intent/support/runtime | criterion `verification.json`, optional `scorecard.json` evidence | `tests/runtime/work_list.test.ts`, runtime check tests |
| Work-list finalizer/publisher | `src/managed/pattern_work_list.ts` | deterministic exec by default; managed agent only for user-authored final artifacts | Verify every frozen item completed and expose stable final graph artifacts. | verified item results, frozen list, optional user-authored final artifact contract | default `work_items`; optional user-authored artifacts with forwarded `work_items` | `tests/graph/work_list.test.ts` |

Context pointer tables preserve the static/runtime split. `workspace_file`, `workspace_glob`, and `plugin_file` pointers are static launch prerequisites that must exist before `validate`, `run`, or `resume` proceeds. Context created by earlier nodes reaches later prompts only through declared artifacts and authored `ref` pointers. Runtime may group pointers into `Read First`, `Current Work`, `Task Context`, `Progress State`, and `Reference Sets`; those buckets are advisory read-order guidance, not new authoring fields or authority expansion.

## Known Failure Modes

- Agent treats Agentflow docs, skills, or harness text as the work target.
- Agent treats `af orient` as a one-time startup step and continues after compaction, drift, or unclear context without refreshing the node operating picture.
- Agent publishes only a final response and misses declared artifacts.
- Agent writes placeholder or stale artifacts.
- Agent claims validation without command/tool evidence.
- Agent records milestone evidence before verifying the claim.
- Agent uses recovery commands as a normal worker.
- Retry prompt preserves contaminated or wrong-direction progress instead of resetting to the best valid boundary.
- Retry prompt causes a fresh rerun when event history, artifacts, and workspace diffs show a narrower safe boundary.
- Verification substrate failure reruns a completed worker instead of retrying verification locally.
- Agent follows stale context over authored contract or provenance.
- Verifier marks an inlined artifact missing because a side-channel search is incomplete.
- Managed publisher claims beyond passing scorecard evidence.
