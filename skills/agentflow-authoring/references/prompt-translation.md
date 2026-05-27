# Prompt Translation Model

Use this when authoring or reviewing a graph for prompt quality. Agentflow graph JSON is not the prompt, but every AI-backed execution surface is compiled from a small set of graph inputs. Write those inputs for the agent that will execute them.

## Universal Mapping

| Authored graph input | Prompt surface it becomes | Authoring implication |
| --- | --- | --- |
| `graph.intent` | Workflow context shared with downstream executable nodes. | State the enduring product/engineering thesis and constraints that should guide every node. Do not narrate graph topology. |
| node `intent.goal` | Top success contract for that node or managed phase. | Make the outcome clear enough that an agent can choose tactics without guessing the product intent. |
| node `intent.acceptance_criteria` | Required success evidence. | Put mandatory behavior, validation evidence, and reviewability requirements here. If a skill/tool must be used, make it acceptance evidence. |
| node `intent.constraints` | Authority and non-goal boundaries. | Use prohibition-style boundaries beginning with `Do not`; avoid positive requirements here. |
| `runtime.repo`, `runtime.profile`, sandbox/profile | Workspace, harness, model, and authority framing. | Pick the repo/profile that actually owns the work. Do not restate model or sandbox in prose unless it changes the task. |
| `support.context` | Context pointer table: name, kind, pointer, what, why. | Every pointer needs `what` and `why`; context is evidence, not authority over intent. |
| `support.skills` and capability skills | Optional skills table with skill name, description, and `SKILL.md` path. | Skills are optional support. Do not rely on skill presence to make a requirement mandatory. |
| capability `cli` | Ambient CLI hints table. | Use for ordinary commands the agent may run; required command evidence belongs in acceptance criteria or managed criteria. |
| managed `tools` | Managed plugin tool table with callable, description, and `--help` reminder. | Use only for reusable audited tools, credential isolation, policy, or stable I/O. |
| declared `artifacts` | Declared artifact table and write contract. | Any downstream or human handoff must be a declared artifact; final response alone is not durable. |

## AI-Backed Node Shapes

| Authored shape | Compiled AI prompt behavior | Write the graph input this way |
| --- | --- | --- |
| `agent` | One worker prompt with role, success contract, work loop, support tables, artifact table, and completion gate. | Use for one bounded outcome. Give outcome-level criteria, context pointers, and declared artifacts. Do not script file-by-file tactics. |
| `check` with `kind: "ai"` | Read-only evaluator prompt with graph/check intent, context/artifact evidence, rubric, and JSON verdict contract. | Use for semantic gates. Make the rubric judge observable artifacts, not private reasoning or implementation preference. |
| plugin-lowered agent node | Plugin workflow config/context is interpolated, then lowered to normal prompt-backed nodes with plugin file context and managed tool grants. | Keep plugin config schema-backed. Add `what`/`why` to plugin file context. Do not hide product intent inside plugin files alone. |
| `pattern_deep_research` | Angle worker prompts, synthesis prompts, then publisher prompt. Each angle sees the parent contract, support, and its assigned angle; synthesis sees accepted reports; publisher writes one complete `research.md`. | Make angles controlling lenses. Put the assigned angle in direct, specific language. Downstream nodes consume `research`; important detail should be in that one report, not hidden in internal angle artifacts. |
| `pattern_deep_work` | Planner, worker/validator, criterion evaluator, scorecard gate, retry, and publisher prompts. Parent intent/support flow into the work loop; criteria become grading prompts and gate weights. Optional `stages.plan`, `stages.execute`, `stages.verify`, and `stages.publish` overrides compile only into their matching phase. | Use for bounded mutation with feedback. Criteria should cover correctness, convention fit, no AI slop, validation evidence, and handoff quality when relevant. Add stage overrides when planning, implementation, judging, or publishing need different directions, support, model, sandbox, or validation focus. |
| `pattern_work_list` | Planner prompt discovers a finite ordered list; runtime freezes it; one managed item prompt executes each frozen item; optional deep-work item criteria and item verifier grade that item; publisher writes stable artifacts. | Use when item count is unknown until discovery. Author `planning_goal`, `what_counts_as_one_item`, and `done_when`; do not pre-bake fake item rows. |

## Per-Node Authoring Guidance

### `agent`

The compiled worker prompt starts with the node role and success contract, then shows the workspace boundary, working loop, support tables, declared artifacts, and completion gate. The agent will see `graph.intent` as workflow context, but the node `intent` controls the task.

Authoring rules:

- Put the actual outcome in `intent.goal`, not a title like "implement the feature."
- Put proof requirements in `acceptance_criteria`: validation commands to cite, reviewable branch or artifact expectations, privacy/access requirements, UX expectations, and handoff evidence.
- Put hard boundaries in `constraints`: `Do not` mutate other repos, call remote services, change generated files by hand, expand scope, or introduce unrelated rewrites.
- Add context pointers for exact docs/specs/artifacts the worker should inspect. Do not expect the worker to infer hidden product context from graph ids.
- Declare every artifact a downstream node or reviewer must consume.

### AI `check`

The compiled AI check prompt is read-only. It receives the graph/check intent, the check rubric, context/artifact pointers, and a JSON verdict contract. It should judge observable evidence, not run implementation.

Authoring rules:

- Use AI checks for semantic review when a deterministic command cannot decide the question.
- Write the check `goal` as the decision the check must make.
- Keep the rubric tied to artifacts, workspace state, and explicit evidence.
- Do not ask the check to infer private reasoning, rewrite code, or enforce a tactic that was not required by the producer node.

### Plugin-Lowered Nodes

Plugin workflow nodes compile into ordinary prompt-backed nodes after config interpolation and `plugin://` resource resolution. Plugin file context becomes pointer rows with `what` and `why`; managed plugin tools become the managed-tool table.

Authoring rules:

- Put reusable mechanics in the plugin workflow, but keep product/user intent in the graph node invoking it.
- Use plugin config for stable parameters, not prose instructions hidden in context files.
- Grant managed tools only when the plugin owns reusable audited behavior or credential isolation.

### `pattern_deep_research`

Deep research lowers into angle workers, synthesis workers, and a publisher. Angle prompts put the assigned angle before broader workflow context, so each angle must be a controlling lens. Angle and synthesis helpers treat repo files as read-only evidence: they inspect and validate, then stream Markdown to `af artifact write`, without creating scratch report files or source edits in the repo. Synthesis prompts consolidate accepted Markdown reports without dropping unique findings. The publisher writes one graph-addressable `research.md` and rewrites the findings into a complete, conflict-resolved answer.

Authoring rules:

- Use the parent `intent.goal` to name the decision the research must unblock.
- Make each angle specific enough that two workers would not produce the same report.
- Include evidence authority in the angle or acceptance criteria: repo conventions, current product context, web research, official docs, prior artifacts, or risk register.
- Treat raw angle and synthesis reports as internal run evidence. They may conflict; the final publisher must resolve contradictions before publishing `research.md`.
- Do not ask the research agent for machine JSON unless JSON is the actual user-facing deliverable.

### `pattern_deep_work`

Deep work lowers into planning, work/validation, criteria evaluation, scorecard gate, retry, and publish phases. Parent support and intent flow through the loop. Criteria become independent evaluator prompts and weighted gate inputs, so bad criteria cause bad retries. Stage overrides are additive and phase-local: `plan` affects the planner prompt and policy, `execute` affects the worker/validator, `verify` affects AI criteria prompts and check policy, and `publish` affects the final publisher.

Authoring rules:

- Use the parent `goal` for the bounded outcome, not the implementation recipe.
- Write criteria around evidence that matters: functional correctness, repo conventions, generated-contract integrity, no AI slop, privacy/access, validation evidence, artifact/handoff quality, branch hygiene, or UX quality.
- Weight the criteria by importance; do not use equal weights by default.
- Put command evidence in acceptance criteria or criteria only when the commands are stable and expected to exist.
- Use `stages` only for real phase differences. Do not duplicate the parent goal in every stage.
- Keep downstream handoffs as declared artifacts from the publisher, not draft files from an intermediate cycle.

### `pattern_work_list`

Work list lowers into a planner, runtime freeze, one managed item execution per frozen item, optional item-level deep-work criteria, item-level semantic verification, finalizer, and publisher. The planner writes only `work-list.json` and decides the finite ordered list, but runtime owns item ids and status. Later item prompts receive the frozen list, current ledger, current item, previous accepted handoffs, scorecard/recovery memory when relevant, and parent support context.

Authoring rules:

- Use `planning_goal` to describe how to discover the list, not what the list already is.
- Use `what_counts_as_one_item` to define item boundaries in human-reviewable terms.
- Use `done_when` to define evidence each item must leave behind: validation, changed-output summary, branch/base or batch boundary, risks, and downstream implications.
- Choose `item_worker.kind: "agent"` for one-pass work; choose `deep_work` when each item needs scored feedback and retries.
- Criteria for `deep_work` items should target the item handoff, workspace outcome, and ledger coherence. They should not depend on dynamic ids outside the frozen list.
- Downstream nodes reference stable work-list artifacts such as `summary` and `work_items`, not `w1` or `w3`.

## Runtime-Owned AI Surfaces

Authors do not write these prompts directly, but graph quality determines whether they work well.

| Runtime surface | What it receives from the graph/run | How authors help it succeed |
| --- | --- | --- |
| Outcome verifier | Graph/node intent, completion packet, declared artifacts, milestone evidence, validation evidence, and workspace-change summaries. | Make acceptance criteria observable and artifacts concrete. Avoid vague criteria that require guessing intent. |
| Artifact repair | Original node contract, missing artifact names, agent-facing repair brief, prior response/artifact evidence. | Declare only meaningful artifacts with clear descriptions and paths. |
| Supervisor recovery worker retry | Original contract plus `agent/supervisor-recovery.md` and `agent/attempt-memory.md` with symptom, best resume point, restart boundary, workspace decision, progress to reuse/discard, material delta, forbidden actions, evidence pointers, and validation focus. Runtime also records an `InterventionDecision` so repeated same-fingerprint recovery cannot spin without a new material delta. | Keep graph/node constraints stable and explicit so recovery can preserve useful prior progress, reset unsafe progress, and avoid drifting into a new task. |
| Supervisor diagnostic helper | Read-only case/debug evidence, gather role, required JSON evidence patch. | Prefer structured artifacts and checks so helpers can map failures without reading raw logs as truth. |

## Prompt Engineering Checks

- The top-level graph intent should still be useful if injected into every downstream AI prompt.
- The node goal should answer “what outcome should this agent create?” before “what files might it touch?”
- Acceptance criteria should be evidence-producing and reviewable.
- Constraints should prevent bad work without over-prescribing implementation tactics.
- Context pointers should reduce guessing; if the agent needs a concept, link the exact doc/file/artifact.
- Capabilities should reduce support noise; select only skills/CLI/tools that fit the node’s job.
- Managed pattern criteria should be weighted by importance, not evenly by habit.
- Downstream nodes should consume stable artifacts, not internal prompt/debug files or dynamic item ids.
- Retry-worthy nodes should leave useful milestone and validation evidence; attempt memory can only preserve or reset progress that the runtime can see through events, artifacts, workspace diffs, and validation logs.
