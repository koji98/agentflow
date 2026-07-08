# Runtime Prose Field Guide

Use this before assembling graph JSON. Agentflow graph prose is not all the same. Some prose explains authoring decisions to the graph author; that prose belongs outside the graph. Prompt-facing fields are read by runtime agents, verifiers, researchers, planners, item workers, and reviewers.

Rule: authoring rationale belongs outside graph JSON; runtime-facing fields must speak only to the executing agent, verifier, researcher, planner, item worker, or reviewer.

Rule: graph-construction semantics never belong in prompt-facing graph fields. Do not explain why the author chose Agentflow, a node type, a managed pattern, a publisher, or a downstream handoff inside runtime prose. Those decisions belong in the authoring plan, review notes, or PR text, not in Graph JSON.

## Authoring Flow

1. Write an authoring plan outside the graph: topology, pattern choice, dependencies, assurance profile, and rationale.
2. Write a runtime prose table: field path, runtime audience, exact field text, and evidence it should produce.
3. Assemble JSON only after every prompt-facing field is free of graph-construction language.
4. Run `agentflow validate --graph <path>` and inspect `authoring_review` findings.

## Graph-Semantics Leak Review

Before writing JSON, read every prompt-facing field as if an LLM worker will see it without the authoring conversation. Remove:

- graph topology narration;
- node ids, node ordering, or downstream-node mechanics;
- managed-pattern lifecycle explanation;
- publisher/private-artifact/public-artifact mechanics unless they are the user's actual product terms;
- `af` command instructions unless the graph is specifically teaching Agentflow operation;
- authoring rationale such as "we use this pattern because...";
- review notes about how the graph should compile.

Replace leaked semantics with the runtime reader's actual contract: outcome, evidence, authority boundary, context reason, artifact meaning, or rubric standard.

## Field Taxonomy

| Field | Runtime audience | Allowed content | Forbidden content |
| --- | --- | --- | --- |
| `intent.goal` | all executable nodes or one executing node | The outcome, decision, or deliverable the runtime reader owns. | Graph topology, pattern choice, node mechanics, file-by-file recipes. |
| `intent.acceptance_criteria` | worker and verifier | Observable success evidence, validation expectations, quality bars. | Generic working-loop instructions, authoring rationale, hidden implementation preferences. |
| `intent.constraints` | worker and supervisor | Prohibition-style boundaries beginning with `Do not`. | Positive requirements, topology explanations, or "this graph should..." prose. |
| `research.angles[].prompt` | one research angle worker | A controlling evidence lens, decision boundary, sources, uncertainty to preserve. | "Angle 1", deep-research mechanics, private reports, internal synthesis mechanics, final artifact choices. |
| `work_list.planning_goal` | work-list planner | How to discover the finite ordered list. | Pre-baked item rows, managed-pattern rationale, "use this node to..." phrasing. |
| `what_counts_as_one_item` | work-list planner and item worker | Item boundary in reviewable outcome terms. | Dynamic graph ids, downstream-node mechanics, implementation-step scripts. |
| `done_when` | item worker and verifier | Evidence each item must leave behind. | Artifact command instructions or graph-addressability mechanics. |
| `map_reduce.items.intent` | map-reduce item planner | What finite independent units are in scope, evidence needed to select them, and coverage uncertainty to preserve. | Map-reduce rationale, item worker mechanics, reducer internals, or final aggregate formatting. |
| `map_reduce.map.intent` | map-reduce item worker | What to judge or change for exactly one current frozen item and what evidence one item result must leave behind. For write-partitioned refactors, name the owned-path boundary and prohibit edits outside it. | Whole-list discovery, aggregate counts, downstream routing, instructions to process unrelated items, or permission to edit shared/unowned paths. |
| `map_reduce.reduce.intent` | deterministic reducer and reviewers | Aggregate coverage standard and overclaim boundaries. | LLM publisher instructions, reducer mode choices, internal item-result paths, or custom public artifact mechanics. |
| `selection.candidates[].intent` | candidate strategy worker | The strategy lane, evidence expected in that candidate packet, and lane-specific boundaries. | Candidate discovery, selector mechanics, downstream implementation instructions, or wording-only variants. |
| `selection.criteria[].rubric` | candidate criterion evaluator | Observable evidence standard applied identically to every candidate. | Private reasoning, pairwise tournament judging, selector policy, command execution, or producer work. |
| AI check `rubric` | read-only evaluator | Observable judgment standard tied to artifacts, workspace state, and evidence. | Private reasoning, implementation preference, compiled-prompt judgment, or producer work. |
| deep-work criterion `rubric` | criterion evaluator | Scored evidence standard for the current candidate or artifact. | Authoring plan, graph topology, or retry mechanics. |
| deep-work `phases.*.intent` | one managed phase | Additive phase-specific objective, evidence, or boundary. | Replacement parent contract, lifecycle explanation, or generic guidance repeated in every phase. |
| work-list deep-work `item_worker.phases.*.intent` | one managed item phase | Additive item-phase objective, evidence, or boundary for the current frozen item. | Duplicated parent/item goals, lifecycle explanation, graph mechanics, or text that weakens frozen-item constraints. |
| context `what` / `why` | worker reading a pointer | What the pointer contains and why it matters for this node's task. | Provenance/debug chatter, "required by this graph", or downstream-node explanations. |
| artifact `description` | publisher, verifier, reviewer | Durable output contract and what the artifact proves. | Internal lowering details, graph-addressable mechanics, or write-command instructions. |

## Bad -> Good Examples

Bad research angle:

```json
{
  "id": "api",
  "prompt": "Use the deep-research pattern to route a private report into internal synthesis."
}
```

Good research angle:

```json
{
  "id": "api",
  "prompt": "Evaluate whether the planned API contract supports the required UI workflow, including route ownership, generated type coverage, privacy boundaries, validation evidence, and unresolved risks."
}
```

Bad work-list planning goal:

```json
"planning_goal": "Use this node to create items for the managed pattern."
```

Good work-list planning goal:

```json
"planning_goal": "Discover the finite ordered implementation slices needed to deliver assignment authoring, release, protected student access, submissions, scoring, and tutor evidence while preserving reviewable item boundaries."
```

Bad context pointer:

```json
{
  "what": "Context for the downstream node.",
  "why": "This graph should pass the final review."
}
```

Good context pointer:

```json
{
  "what": "Existing API route conventions and generated OpenAPI workflow.",
  "why": "The worker must keep new assignment routes consistent with local route, schema, and type-generation patterns."
}
```

Bad artifact description:

```json
"description": "Graph-addressable artifact for downstream nodes."
```

Good artifact description:

```json
"description": "Markdown handoff summarizing accepted route contracts, validation evidence, risks, and follow-up decisions for reviewer handoff."
```

Bad AI rubric:

```json
"rubric": "Judge whether the compiled prompt makes the downstream node pass."
```

Good AI rubric:

```json
"rubric": "The published handoff cites concrete artifact, validation, and workspace evidence for each accepted API contract decision, and separates active risks from resolved findings."
```

## Self-Check

- Could the runtime reader act on this field without knowing how the graph was built?
- Does it describe an outcome, evidence, or boundary instead of a node, pattern, prompt, or graph mechanism?
- If the product under discussion is Agentflow itself, does the prose still avoid saying "this graph", "compiled prompt", "use this node", or managed-pattern mechanics as task instructions?
- Would this field still be valid if Agentflow lowered the managed pattern differently tomorrow?
