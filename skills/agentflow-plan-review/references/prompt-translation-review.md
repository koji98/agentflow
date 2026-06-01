# Prompt Translation Review

Use this to review whether a graph will compile into strong AI prompts. Each skill is standalone, so this file repeats the prompt-translation checks needed during plan review.

## What To Check

| Authored input | Compiled prompt effect | Review question |
| --- | --- | --- |
| `graph.intent` | Shared workflow context for downstream executable prompts. | Would this still help every AI node, or does it narrate topology/internal process? |
| node `intent.goal` | Top node success contract. | Does it name the outcome and decision boundary clearly enough for the executing agent? |
| node `acceptance_criteria` | Required success evidence and verifier basis. | Are success requirements observable through artifacts, validation, workspace state, or review evidence? |
| node `constraints` | Authority and non-goal boundaries. | Do they start with `Do not` and avoid positive requirements or implementation recipes? |
| `support.context` | Context pointer table with `what` and `why`. | Does each pointer reduce guessing, and is it node-local rather than a global dump? |
| skills/capabilities/CLI/tools | Optional support tables. | Are selected supports relevant to this node, or will they add prompt noise? |
| declared artifacts | Artifact table, byte-safe artifact contract, and reviewer/verifier evidence row. | Are all durable handoffs declared, described, content-typed when format-sensitive, and referenced by later consumers? |

## Node-Type Checks

| Node shape | What the compiled prompt does | Common review finding |
| --- | --- | --- |
| `agent` | Runs one worker with role, success contract, work loop, support tables, artifacts, and completion gate. | Goal is too procedural, acceptance criteria lack evidence, or context is too broad. |
| AI `check` | Runs a read-only evaluator with rubric and JSON verdict. | Rubric asks for private reasoning, implementation preference, or a producer task instead of judging evidence. |
| Plugin-lowered node | Interpolates plugin config/resources, then lowers to ordinary prompt-backed nodes with plugin context/tools. | Product intent is hidden inside plugin files, or plugin tools are granted for plain local CLI work. |
| `pattern_deep_research` | Runs angle workers, synthesis, and publisher; assigned angle controls each worker. | Angles overlap, are too generic, lack evidence authority, or expose raw artifacts unnecessarily. |
| `pattern_deep_work` | Runs planner, worker/validator, criteria evaluators, scorecard gate, retries, and publisher while keeping each worker prompt task-first. Retry prompts stay compact and `af orient` owns attempt memory and resume guidance. | Criteria are equally weighted by habit, too vague, command-dependent without stable commands, miss code quality/no-slop evidence, or leave no milestone/validation evidence for the supervisor to choose the best retry boundary. |
| `pattern_work_list` | Plans a finite list, freezes it, launches one execution per item, grades optional deep-work item evidence, verifies item outcomes, and publishes stable artifacts while keeping item prompts current-task focused. Retry prompts stay compact and `af orient` owns the frozen ledger, item attempt memory, and resume guidance. | The graph pre-bakes item count, weakly defines item boundaries, downstream nodes depend on dynamic item ids, or item handoffs do not preserve enough evidence to retry the right item without redoing the whole list. |

## Prompt-Facing Prose Purity

Review authored prose before judging the lowered prompt. Authoring rationale belongs outside the graph. Runtime-facing fields must speak only to the executing agent, verifier, researcher, planner, item worker, or reviewer.

| Field family | Review for |
| --- | --- |
| `intent.goal`, acceptance criteria, and constraints | Outcome, evidence, and `Do not` boundaries. Flag graph topology, pattern choice, node mechanics, and file-by-file recipes. |
| Research angle prompts | Controlling evidence lenses. Flag angle-report mechanics, synthesis-node mechanics, public/private artifact choices, and generic angle labels. |
| Work-list planning fields | Discovery method, item boundary, and item evidence. Flag pre-baked item rows, dynamic graph ids, managed-pattern rationale, and downstream-node mechanics. |
| AI check rubrics and deep-work criteria | Observable judgment standards. Flag compiled-prompt judgment, private reasoning, or producer-work instructions. |
| Context `what` / `why` | What the pointer contains and why this node needs it. Flag provenance/debug chatter and graph-construction rationale. |
| Artifact descriptions | Durable output contract and what the artifact proves. Flag write-command instructions or runtime lowering details. |
| Deep-work `phases.*.intent` | Additive phase-specific objective, evidence, or boundary. Flag replacement parent contracts or generic instructions repeated across every phase. |
| Work-list deep-work `item_worker.phases.*.intent` | Additive item-phase objective, evidence, or boundary. Flag duplicated parent/item goals, graph mechanics, or phase text that weakens frozen-item constraints. |

## Approval Bar

- Graph intent should be useful context, not a duplicate of the node list.
- Every AI-backed node should have a prompt-readable success contract: outcome, evidence, constraints, support, and artifacts.
- Research nodes should name the decision being unblocked and the evidence authority.
- Work nodes should preserve agent autonomy while requiring validation, convention fit, no AI slop, and reviewable handoff evidence when relevant.
- Review/fix nodes should consume prior findings as context artifacts and require closure evidence, not re-litigate broad scope.
- Runtime-owned prompts such as outcome verification, artifact repair, attempt memory, and supervisor recovery should have enough structured artifacts, milestones, validation logs, events, and criteria to avoid guessing from raw logs.
