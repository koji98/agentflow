# `execute_spec` Workflow

This document defines the authored contract and current first-version compiled behavior for the implemented `execute_spec` managed workflow.

It is implemented now as a generated primitive subgraph lowered during graph normalization.

## Purpose

`execute_spec` turns an implementation-ready spec into a validated code change.

It should sit after:

- `spec_design`

and before:

- `review_change`

The intended lifecycle is:

1. `deep_research` figures out what is true
2. `spec_design` decides what should be built
3. `execute_spec` implements the chosen design
4. `review_change` critiques the resulting implementation

`execute_spec` should also work without `spec_design` when the user already has a strong spec.

## Core Principle

`execute_spec` is spec-driven, not idea-driven.

That means:

- it requires a structured spec source
- it should implement an existing design, not invent one
- it may resolve small local ambiguities from repo conventions
- it should not silently redesign the system when the spec is incomplete

If the spec is too weak to execute safely, the workflow should fail the spec-readiness gate rather than guessing.

## Structured `spec_source`

`execute_spec` should require a `spec_source` object instead of a loose prompt.

That object defines where the implementation contract comes from.

### Supported source modes

#### `managed_node`

Use this when the source is a prior managed workflow node, usually `spec_design`.

```json
{
  "spec_source": {
    "kind": "managed_node",
    "node": "managed_nodes_spec"
  }
}
```

Expected behavior:

- resolve `design_spec` from the referenced node
- also load these supporting outputs when available:
  - `file_plan`
  - `acceptance_criteria`
  - `risks`
  - `open_questions`

This is the default path for:

- `spec_design -> execute_spec`

#### `artifact_bundle`

Use this when the spec already exists in files or other outputs.

```json
{
  "spec_source": {
    "kind": "artifact_bundle",
    "design_spec": {
      "kind": "file",
      "path": "docs/managed-workflows-spec.md"
    },
    "file_plan": {
      "kind": "file",
      "path": "docs/managed-workflows-file-plan.md"
    },
    "acceptance_criteria": {
      "kind": "file",
      "path": "docs/managed-workflows-acceptance.md"
    }
  }
}
```

This is the standalone path for:

- hand-written design docs
- imported planning artifacts
- specs produced outside Agentflow

### Source reference schema

Each reference in an `artifact_bundle` should use one of these forms:

#### File reference

```json
{
  "kind": "file",
  "path": "docs/spec.md"
}
```

#### Managed output reference

```json
{
  "kind": "managed_output",
  "node": "managed_nodes_spec",
  "output": "design_spec"
}
```

### Required `spec_source` content

At minimum, `execute_spec` must resolve:

- `design_spec`

Strongly recommended supporting artifacts:

- `file_plan`
- `acceptance_criteria`
- `risks`
- `open_questions`

The workflow should still run if only `design_spec` exists, but it should mark missing supporting artifacts as risk factors during the completeness gate.

## Authored Contract

Required fields:

- `type: "execute_spec"`
- `id`
- `spec_source`

Optional common execution fields:

- `label`
- `repo`
- `profile`
- `inputs`
- `context_from`
- `outputs`
- `timeout_sec`

Optional workflow fields:

- `objective`
- `scope`
- `execution_policy`
- `validation`
- `implementation_research`
- `delivery`

## Proposed Schema

```json
{
  "type": "execute_spec",
  "id": "implement_managed_nodes",
  "repo": "main",
  "profile": "default",
  "objective": "Implement the first managed workflow nodes in Agentflow.",
  "spec_source": {
    "kind": "managed_node",
    "node": "managed_nodes_spec"
  },
  "scope": {
    "paths": ["src/**", "docs/**", "tests/**", "scripts/**"],
    "areas": ["graph", "runtime", "artifacts"]
  },
  "execution_policy": {
    "max_repair_rounds": 2
  },
  "validation": {
    "commands": [
      "npm run typecheck",
      "npm test",
      "npm run validate -- --graph .tmp/feature-showcase.json"
    ],
    "required": true
  },
  "implementation_research": {
    "allow_official_docs_fallback": true,
    "allow_domains": ["developers.openai.com", "react.dev"],
    "max_external_lookup_tasks": 2
  },
  "delivery": {
    "write_change_summary": true,
    "write_residual_risks": true,
    "write_validation_results": true
  }
}
```

## Field Semantics

### `objective`

A short execution goal for the implementation run.

This is not the spec itself. It is a concise statement of what this execution run is trying to achieve.

### `spec_source`

The required source-of-truth contract for implementation.

This is the most important field in the workflow.

`execute_spec` should not proceed without a resolvable spec source.

### `scope`

Repository paths or system areas the execution should expect to touch.

This should help the planner:

- focus implementation
- detect likely impact areas
- avoid wandering outside the spec

### `execution_policy`

Controls how many repair rounds the workflow may attempt after the initial implementation step.

Recommended fields:

- `max_repair_rounds`

### `validation`

Defines the deterministic checks that must pass before the workflow succeeds.

Recommended fields:

- `commands`
- `required`

### `implementation_research`

Controls narrow external lookups during implementation.

This should be much tighter than `spec_design` web fallback.

Allowed use:

- official framework or library docs
- API or behavior lookup needed to implement the spec

Not allowed:

- rethinking the architecture
- broad competitor or product research
- replacing the spec with a new design direction

### `delivery`

Controls which final handoff artifacts should be written.

## Behavior Rules

### Spec completeness gate

Before changing code, `execute_spec` should decide whether the spec is executable.

In the current implementation this is an AI check node.

It consumes the spec packet and produces the standard AI check `result.json` artifact with:

- `passed`
- optional `score`
- `summary`
- `issues`

Common reasons for readiness failure:

- the spec does not define the target behavior clearly enough
- acceptance criteria are missing and cannot be inferred safely
- the file plan or affected surface is too unclear
- the spec contains unresolved contradictions

### Repo grounding

Even when the spec is clear, the workflow should inspect the repo before implementation.

It should extract:

- local conventions
- relevant existing modules
- likely touched files
- test surfaces
- operational constraints

This keeps implementation aligned with the actual codebase.

### Single-writer execution

`execute_spec` should stay single-writer.

Implementation is where parallelism becomes fragile fastest:

- multiple agents editing the same subsystem collide
- multiple agents making implementation decisions drift from the spec
- integration overhead grows faster than the benefit for local code changes

So the first-version workflow intentionally keeps one writing agent and uses the repair loop, not parallel implementers, as the stabilization mechanism.

### Narrow implementation research

`execute_spec` may do targeted external lookup only when blocked on implementation details.

Examples:

- framework syntax
- official API contract
- library behavior required to satisfy the spec

This must stay subordinate to:

- the spec
- the repository

## Current Compiled Workflow

`execute_spec` should compile into an internal primitive workflow shaped roughly like this:

1. `ingest_spec`
2. `assess_spec_readiness`
3. `inspect_repo_for_execution`
4. optional `targeted_implementation_research`
5. `plan_execution`
6. `implement_spec`
7. `repeat` repair loop
8. `publish_handoff`

## Phase Details

### `ingest_spec`

Resolve and normalize the structured spec source into an execution packet.

Artifacts:

- `spec-packet.md`

This should consolidate:

- design spec
- file plan
- acceptance criteria
- risks
- open questions

### `assess_spec_readiness`

Determine whether the spec is executable.

Artifacts:

- `result.json`

This follows the standard AI check result contract and should fail when the spec would force design guessing during implementation.

### `inspect_repo_for_execution`

Inspect the relevant repo surface before implementation begins.

Artifacts:

- `execution-context.md`

This should identify:

- affected modules
- local conventions
- candidate files to change
- test surfaces
- integration risks

### `targeted_implementation_research`

Optional narrow external lookup for missing implementation details.

Artifacts:

- `implementation-findings.md`

### `plan_execution`

Turn the spec packet into a concrete implementation plan.

Artifacts:

- `implementation-plan.md`

The plan should answer:

- what changes need to happen
- where those changes live
- what validation should prove correctness

### `implement_spec`

Apply the code changes from the implementation plan.

Artifacts:

- `implementation-notes.md`

This node should operate in workspace-write mode and stay aligned to:

- the spec packet
- repo conventions
- the implementation plan

### `repeat` repair loop

If validation fails, attempt bounded repairs.

The loop body is:

1. `stabilize_implementation`
2. `validation_gate`

`stabilize_implementation` is a workspace-write agent node that:

- reviews the current workspace against the spec
- runs or inspects the validation commands when useful
- makes only targeted fixes

`validation_gate` is one deterministic check node that runs the authored validation commands and fails the loop iteration if any command fails.

This loop is capped by `execution_policy.max_repair_rounds`.

### `publish_handoff`

Produce the final implementation handoff.

Artifacts:

- `change-summary.md`
- `validation-results.md`
- `residual-risks.md`
- `files-touched.md`

## Output Contract

At minimum, the final published node should expose:

- `change_summary`
- `validation_results`
- `residual_risks`

Recommended additional outputs:

- `files_touched`
- `implementation_plan`

## UI Implications

Collapsed managed-node view should show:

- spec readiness
- repo grounding status
- implementation status
- validation status
- repair attempts
- final outcome

Expanded view should expose:

- spec packet
- implementation plan
- implementation notes
- validation and repair history
- final handoff artifacts

## Recommended Implementation Order

Implementation notes:

1. authored node parsing lives in the normalizer
2. `execute_spec` lowers into a generated primitive subgraph in `src/managed`
3. the original authored node id maps to the final published handoff node
4. graph-level tests cover lowering, artifact-bundle source mapping, and downstream dependency behavior
5. the showcase graph under `.tmp/` demonstrates the `spec_design -> execute_spec` path

## Summary

`execute_spec` should not be a vague “write code” node.

It should be a spec-execution workflow with:

- a required structured `spec_source`
- a spec-readiness gate
- repo-grounded implementation planning
- single-writer implementation
- deterministic validation
- bounded repair
- explicit handoff artifacts
