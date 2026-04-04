# `spec_design` Workflow

This document defines the authored contract and compiled behavior for the current first-version `spec_design` managed workflow.

It is implemented now as a generated primitive subgraph lowered during graph normalization.

## Purpose

`spec_design` turns an idea, problem, or product direction into an implementation-ready design spec.

It should sit between:

- `deep_research`
- `execute_spec`

The intended lifecycle is:

1. `deep_research` figures out what is true
2. `spec_design` decides what should be built
3. `execute_spec` implements the chosen design
4. `review_change` critiques the resulting implementation

## Core Principle

`spec_design` is repo-first, not repo-only.

That means:

- start with the repository
- inspect local code, docs, tests, architecture notes, and conventions
- if the repository is insufficient for a strong design, escalate to targeted web research
- external research fills gaps; it does not override repository conventions

This prevents two common failures:

- weak design because the repo does not contain enough context
- generic design because the system jumps to the web too early and ignores the codebase

## Authored Contract

Required fields:

- `type: "spec_design"`
- `id`
- `problem`
- `goal`

Optional common execution fields:

- `label`
- `repo`
- `profile`
- `inputs`
- `context_from`
- `outputs`
- `timeout_sec`

Optional workflow fields:

- `audience`
- `constraints`
- `decision_drivers`
- `scope`
- `research_policy`
- `deliverable`
- `orchestration`

## Proposed Schema

```json
{
  "type": "spec_design",
  "id": "managed_nodes_spec",
  "repo": "main",
  "profile": "default",
  "problem": "Agentflow's managed aliases are too thin and do not encode real workflows.",
  "goal": "Design a true managed-workflow model for Agentflow.",
  "audience": "engineering",
  "constraints": [
    "Keep primitive graph nodes stable.",
    "Managed workflows must compile into primitive subgraphs.",
    "The UI must support collapsed and expanded managed workflow views."
  ],
  "decision_drivers": [
    "clarity",
    "reliability",
    "extensibility",
    "operator ergonomics"
  ],
  "scope": {
    "paths": ["src/**", "docs/**", "web-app/**"],
    "areas": ["graph", "runtime", "ui"]
  },
  "research_policy": {
    "repo_first": true,
    "allow_web_fallback": true,
    "web_triggers": [
      "missing_pattern",
      "missing_domain_context",
      "missing_library_guidance",
      "missing_product_reference"
    ],
    "allow_domains": [
      "openai.com",
      "help.openai.com",
      "developers.openai.com",
      "react.dev"
    ],
    "max_external_research_tasks": 3
  },
  "deliverable": {
    "format": "design_spec",
    "sections": [
      "problem",
      "current_state",
      "requirements",
      "options",
      "recommendation",
      "architecture",
      "file_plan",
      "acceptance_criteria",
      "risks",
      "open_questions"
    ]
  },
  "orchestration": {
    "option_count": 3,
    "max_parallel_options": 3,
    "critique_roles": ["architecture", "implementation", "ux"],
    "revision_rounds": 2
  }
}
```

## Field Semantics

### `problem`

The current issue, gap, or opportunity being addressed.

This should describe the problem in outcome terms, not implementation terms.

### `goal`

The end state the design should achieve.

### `constraints`

Non-negotiable rules or boundaries that the design must respect.

### `decision_drivers`

The criteria used to judge options.

Examples:

- clarity
- reliability
- extensibility
- implementation cost
- operator ergonomics

### `scope`

Repository areas or product areas the design should inspect or affect.

### `research_policy`

Controls how `spec_design` uses repo context and when it may use the web.

Required behavior:

- inspect repo first
- assess whether information is sufficient
- only perform external research if there is a real gap

### `deliverable`

Defines the final design-spec structure.

### `orchestration`

Controls the internal workflow size:

- how many options to generate
- how many options can be explored in parallel
- which critique roles to use
- how many revision rounds are allowed

## Repo-First With Targeted Web Fallback

The workflow should explicitly decide whether repo context is sufficient before doing external research.

That decision point is critical.

Examples of valid web-fallback triggers:

- the repo does not show enough precedent for the pattern being designed
- the repo lacks current library or framework guidance
- the design depends on external product behavior or competitive patterns
- the problem requires domain context that does not exist locally

Examples of invalid web-fallback behavior:

- browsing the web before checking the repo
- using external patterns to override explicit local conventions
- broad unfocused browsing instead of targeted gap-filling

## Planned Compiled Workflow

`spec_design` should compile into an internal primitive workflow shaped roughly like this:

1. `clarify_problem`
2. `inspect_repo`
3. `assess_information_gap`
4. optional `parallel_external_research`
5. `synthesize_constraints`
6. `parallel_option_generation`
7. `compare_tradeoffs`
8. `draft_spec`
9. `parallel_critique_panel`
10. `merge_critiques`
11. `repeat` revision loop
12. `finalize_spec`

### Phase Details

#### `clarify_problem`

Restate the problem, goal, audience, constraints, and decision drivers as a design brief.

Artifact:

- `design-brief.md`

#### `inspect_repo`

Inspect the repository for:

- existing conventions
- relevant modules
- architecture constraints
- code patterns
- docs/tests/operational assumptions

Artifact:

- `current-state.md`

#### `assess_information_gap`

Decide whether the repository provides enough context for a strong design.

Artifact:

- `information-gap.json`

This should answer:

- is repo context sufficient?
- which gaps remain?
- what external research is needed?

#### `parallel_external_research`

Only runs if `assess_information_gap` says it is needed.

This is not broad research. It is targeted gap-filling.

Artifacts:

- `external-findings-01.md`
- `external-findings-02.md`
- `external-findings-03.md`

#### `synthesize_constraints`

Merge repository constraints and any external findings into one design constraint brief.

Artifact:

- `constraints-brief.md`

#### `parallel_option_generation`

Generate `N` distinct design options.

The options must be materially different, not paraphrases.

Artifacts:

- `option-01.md`
- `option-02.md`
- `option-03.md`

#### `compare_tradeoffs`

Compare the options against:

- constraints
- decision drivers
- implementation feasibility
- repo fit

Artifacts:

- `tradeoff-matrix.md`
- `recommendation.md`

#### `draft_spec`

Write the first full design spec.

Artifacts:

- `spec-draft.md`
- `file-plan.md`
- `acceptance-criteria.md`

#### `parallel_critique_panel`

Run named critique roles in parallel.

Default roles:

- architecture
- implementation
- ux

Artifacts:

- `critique-architecture.md`
- `critique-implementation.md`
- `critique-ux.md`

#### `merge_critiques`

Merge critique findings into a single revision brief.

Artifact:

- `critique-merged.md`

#### `repeat` revision loop

Revise the draft and run a quality check until:

- the spec is concrete enough
- the revision rounds are exhausted

Artifacts:

- `spec-revision.md`
- `quality-check.json`

#### `finalize_spec`

Publish the final implementation-ready spec.

Artifacts:

- `design-spec.md`
- `open-questions.md`
- `risks.md`

## Downstream Contract

Like `deep_research`, the original authored node id should become the final published node in the lowered workflow.

That means downstream nodes can reference the managed node normally through `context_from`.

Recommended default final output names:

- `design_spec`
- `file_plan`
- `acceptance_criteria`
- `open_questions`
- `risks`

## Output Expectations

The final `design_spec` should be implementation-ready.

That means it should include:

- a crisp problem statement
- current-state findings
- clear requirements
- distinct options with tradeoffs
- one recommended direction
- architecture and graph/runtime/UI implications
- file-level implementation plan
- acceptance criteria
- risks and open questions

It should not stop at generic brainstorming.

## Implementation Notes

When this is implemented, the safest path is the same one used for `deep_research`:

- parse structured `spec_design` fields in the graph normalizer
- lower the node into a generated primitive subgraph
- preserve the original authored id for the final synthesized output node
- reuse the existing compiler/runtime instead of adding a separate execution path
