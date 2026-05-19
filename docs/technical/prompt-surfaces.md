# Prompt Surfaces

Agentflow prompts are compiled runtime contracts. Treat them like code: each surface has an authority boundary, structured inputs, output expectations, tests, and eval coverage. Do not add alternate prompt shapes, prompt aliases, legacy prompt packs, or compatibility shims.

## Section Model

Prompt sections should appear in this order when applicable:

1. `Role`
2. `Success Contract`
3. `Supervisor Recovery Case` on retries
4. `Attempt Memory` on retries
5. `Contract Priority`
6. `Workspace`
7. `Working Loop`
8. `Graph Context`
9. `Context`
10. `Optional Skills`
11. `Ambient CLI Hints`
12. `Managed Plugin Tools`
13. `Agentflow Runtime CLI`
14. `Declared Artifacts`
15. `Completion Gate`

Role text is useful only when it changes authority, scope, output contract, or evaluation responsibility. Avoid generic persona adjectives unless a prompt-regression eval proves the wording is load-bearing.

For normal worker prompts, `af orient` is both the first operating-picture command and the refresh command. The prompt should tell agents to rerun it whenever the goal, acceptance criteria, context pointers, artifact expectations, retry state, or next action becomes unclear, especially after compaction, long pauses, or long-running task drift. This keeps recovery and progressive disclosure in the runtime-owned orientation surface instead of bloating the base prompt with debug state.

## Inventory

| Surface | Renderer | Prompt kind | Authority boundary | Contract inputs | Output contract | Coverage |
| --- | --- | --- | --- | --- | --- | --- |
| Standard agent node | `src/runtime/harness/types.ts` | `agent` | Executes one node, not the graph; node task controls graph context. | graph intent, node intent, sandbox, context pointer table, tools, declared artifacts, recovery brief | final response plus declared artifacts after `af complete check` | `tests/runtime/harness_prompt.test.ts`, `evals/agentflow-prompt-regression` |
| Artifact repair | `src/runtime/harness/types.ts` | `artifact_repair` | Repair missing declared artifacts only; no unrelated work. | original task, missing artifact list, agent-facing repair brief, agent context brief | missing artifacts at exact paths | `tests/runtime/harness_prompt.test.ts` |
| AI check | `src/runtime/harness/types.ts` | `ai_check` | Read-only check node; no workspace mutation. | check intent, graph context, agent context brief, output schema | JSON only | `tests/runtime/harness_prompt.test.ts`, runtime check tests |
| Supervisor evidence gatherer | `src/runtime/harness/types.ts` | `supervisor_evidence` | Read-only evidence for a failed attempt; cannot rewrite graph intent. | case file, gather kind, evidence output path, instructions | JSON evidence patch | supervisor recovery tests |
| Fixed supervisor helper | `src/af/index.ts` | `_helper-run` | Read-only bounded helper; no source edits, service mutation, plugin tools, or human-pause decisions. | helper role, brief, case/evidence pointers, parent context manifest, required artifact | Markdown helper artifact | `tests/af/cli.test.ts` |
| Supervisor recovery brief | `src/runtime/harness/types.ts` | agent block | Additive retry evidence; original node contract remains binding. | failure symptom, best resume point, restart boundary, workspace decision, material delta, reuse/discard guidance, required next action, evidence pointers, validation focus | changed tactics inside unchanged task | `tests/runtime/harness_prompt.test.ts`, supervisor tests |
| Attempt memory | `src/runtime/attempt_memory.ts` + `src/runtime/harness/types.ts` | retry prompt block | Runtime-authored memory only; evidence for continuation, not new authority. | prior event timeline, best-resume decision, completed milestones, unfinished work, artifact state, validation evidence, workspace changes, do-not-redo | resume from the best valid boundary without preserving unsafe progress or redoing validated work | `tests/runtime/engine.test.ts`, `tests/af/cli.test.ts`, `tests/runtime/attempt_memory.test.ts` |
| Outcome verifier | `src/runtime/verification/prompt.ts` | verifier | Fresh read-only audit after mechanical completion. | graph/node intent, completion packet, artifacts, milestone evidence, command evidence, diff metadata | one fenced JSON verdict | `tests/runtime/verification/prompt.test.ts`, verifier eval scenarios |
| Runtime CLI block | `src/runtime/harness/types.ts` | prompt block | Normal worker correctness loop only. | granted runtime metadata and current command contract | correct `af` usage, milestone evidence, completion packet | harness prompt tests, prompt-regression trajectory checks |
| Plugin tool block | `src/runtime/harness/types.ts` | prompt block | Select granted plugin CLIs only when useful. | resolved plugin tools, descriptions, usage reminder | tool calls with `--help` just in time | tool tests, prompt-regression tool discipline |
| Context block | `src/runtime/harness/types.ts` | prompt block | Pointer evidence, not authority over node contract. | compact context table from `agent/context.md` | targeted context reads and documented uncertainty | harness prompt tests, context evals |
| Deep work planner | `src/managed/pattern_deep_work.ts` | managed agent | Plan next cycle only; no edits. | workflow contract, criteria, prior scorecard/work notes | `cycle-plan.md` | `tests/graph/deep_work.test.ts` |
| Deep work generator/validator | `src/managed/pattern_deep_work.ts` | managed agent | Execute one managed cycle and publish run-tree drafts. | cycle plan, failed scorecard, criteria, graph-addressable artifact draft contract | `work-notes.md` plus draft artifacts | `tests/graph/deep_work.test.ts`, managed evals |
| Deep work criterion evaluator | `src/managed/pattern_deep_work.ts` | AI check rubric | Grade only current evidence for one criterion. | rubric criterion, draft artifacts/work notes | JSON `{passed, score, summary, issues}` | `tests/graph/deep_work.test.ts` |
| Deep work publisher | `src/managed/pattern_deep_work.ts` | managed agent | Publish graph-addressable artifacts only from latest passing scorecard. | scorecard, work notes, draft artifacts | declared graph-addressable artifacts | `tests/graph/deep_work.test.ts` |
| Deep research angle worker | `src/managed/pattern_deep_research.ts` | managed agent | Research one assigned angle for run-tree evidence without mutating repo files. | final contract, assigned angle, context | `angle-report.md` | `tests/graph/deep_research.test.ts` |
| Deep research synthesis worker | `src/managed/pattern_deep_research.ts` | managed agent | Collapse Markdown reports without losing unique findings or provenance; repo workspace remains read-only. | input reports | `synthesis.md` | `tests/graph/deep_research.test.ts` |
| Deep research publisher | `src/managed/pattern_deep_research.ts` | managed agent | Publishes one complete conflict-resolved research report. | final contract, angle report pointers, synthesis report pointers | `research.md` | `tests/graph/deep_research.test.ts` |
| Work-list planner | `src/managed/pattern_work_list.ts` | managed agent | Discover a finite ordered list; no product/source edits. | node contract, planning goal, item guidance, context | `work-list.md`, `work-list.json` | `tests/graph/work_list.test.ts` |
| Work-list item worker | `src/managed/pattern_work_list.ts` | managed agent | Execute frozen items sequentially without changing the list. | frozen list, ledger, item guidance, prior evidence | `item-handoffs.md`, `item-results.json`, `item-validation.md` | `tests/graph/work_list.test.ts` |
| Work-list criterion evaluator | `src/managed/pattern_work_list.ts` | AI check rubric | Grade only frozen-list item evidence for one criterion. | rubric criterion, item handoffs/results, validation notes, ledger | JSON `{passed, score, summary, issues}` | `tests/graph/work_list.test.ts`, `tests/runtime/work_list.test.ts` |
| Work-list completion gate | `src/managed/pattern_work_list.ts` | deterministic check | Aggregate frozen item completion and criteria results; no workspace mutation. | frozen list, item results, criterion outputs | `scorecard.json`, `verification.json` | `tests/runtime/work_list.test.ts` |
| Work-list publisher | `src/managed/pattern_work_list.ts` | managed agent | Publish stable graph-addressable artifacts from verified item evidence. | verified work-items index, frozen list, item handoffs | `summary`, `packet`, forwarded `work_items` | `tests/graph/work_list.test.ts` |

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
