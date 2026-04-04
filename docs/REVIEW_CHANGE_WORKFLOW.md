# `review_change` Workflow

This document defines the authored contract and current first-version compiled behavior for the implemented `review_change` managed workflow.

It is implemented now as a generated primitive subgraph lowered during graph normalization.

## Purpose

`review_change` turns a change artifact or upstream implementation handoff into a structured multi-reviewer review result.

It should usually sit after:

- `execute_spec`

The intended lifecycle is:

1. `deep_research` figures out what is true
2. `spec_design` decides what should be built
3. `execute_spec` implements the chosen design
4. `review_change` critiques the resulting implementation

`review_change` should also work without `execute_spec` when the user already has a diff, summary, or validation bundle to review.

## Core Principle

`review_change` is findings-driven, not commentary-driven.

That means:

- it requires a structured `review_source`
- it should prioritize concrete bugs, regressions, and missing tests over low-value style commentary
- it should gather multiple independent review perspectives before merging findings
- it should publish a machine-readable findings artifact, not only prose

## Structured `review_source`

`review_change` requires a `review_source` object.

That object defines where the review target comes from.

### Supported source modes

#### `managed_node`

Use this when the source is a prior managed workflow node, usually `execute_spec`.

```json
{
  "review_source": {
    "kind": "managed_node",
    "node": "implement_managed_nodes"
  }
}
```

Expected behavior:

- load the source node summary
- also load these supporting outputs when available:
  - `change_summary`
  - `validation_results`
  - `residual_risks`
  - `files_touched`
  - `implementation_plan`

This is the default path for:

- `execute_spec -> review_change`

#### `artifact_bundle`

Use this when the review target already exists in files or other outputs.

```json
{
  "review_source": {
    "kind": "artifact_bundle",
    "diff": {
      "kind": "file",
      "path": "artifacts/change.patch"
    },
    "summary": {
      "kind": "file",
      "path": "artifacts/change-summary.md"
    },
    "validation_results": {
      "kind": "managed_output",
      "node": "validation_stage",
      "output": "validation_results"
    }
  }
}
```

This is the standalone path for:

- imported patches
- external review bundles
- pre-existing change summaries

### Source reference schema

Each reference in an `artifact_bundle` uses one of these forms:

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
  "node": "implement_managed_nodes",
  "output": "change_summary"
}
```

### Required `review_source` content

At minimum, an `artifact_bundle` must include one of:

- `diff`
- `summary`
- `additional_context`

`managed_node` sources are valid with only `node`.

## Authored Contract

Required fields:

- `type: "review_change"`
- `id`
- `review_source`

Optional common execution fields:

- `label`
- `repo`
- `profile`
- `inputs`
- `context_from`
- `outputs`
- `timeout_sec`

Optional workflow fields:

- `scope`
- `criteria`
- `orchestration`
- `delivery`

## Current Schema

```json
{
  "type": "review_change",
  "id": "review_managed_nodes",
  "repo": "main",
  "profile": "default",
  "review_source": {
    "kind": "managed_node",
    "node": "implement_managed_nodes"
  },
  "scope": {
    "paths": ["src/**", "docs/**", "tests/**"],
    "areas": ["graph", "managed workflows", "docs"]
  },
  "criteria": {
    "focus": ["correctness", "missing_tests", "maintainability"],
    "require_file_references": true
  },
  "orchestration": {
    "reviewer_roles": ["correctness", "testing", "maintainability"],
    "max_parallel_reviewers": 3
  },
  "delivery": {
    "write_review_report": true,
    "write_findings_json": true,
    "write_findings_markdown": true
  }
}
```

## Field Semantics

### `scope`

Repository paths or system areas the reviewers should pay special attention to.

### `criteria`

Defines what the review should emphasize.

Current fields:

- `focus`
- `require_file_references`

### `orchestration`

Controls the reviewer panel size.

Current fields:

- `reviewer_roles`
- `max_parallel_reviewers`

### `delivery`

Controls the final handoff artifacts.

Current fields:

- `write_review_report`
- `write_findings_json`
- `write_findings_markdown`

## Current Compiled Workflow

`review_change` compiles into an internal primitive workflow shaped like this:

1. `prepare_review_packet`
2. `parallel_reviewer_panel`
3. `merge_findings`
4. `normalize_findings`
5. `publish_review`

## Phase Details

### `prepare_review_packet`

Resolve the structured review source and summarize the target change for the reviewers.

Artifacts:

- `review-packet.md`

This should capture:

- target change summary
- likely affected surfaces
- available validation evidence
- key risk hotspots
- review focus guidance

### `parallel_reviewer_panel`

Run multiple read-only reviewer agents in parallel.

Each reviewer writes:

- `findings-<role>.md`
- `findings-<role>.json`

The current reviewer JSON schema is:

```json
{
  "summary": "short summary",
  "findings": [
    {
      "title": "...",
      "priority": 2,
      "file": "relative/path.ts",
      "start_line": 1,
      "end_line": 1,
      "body": "...",
      "category": "correctness",
      "confidence": 0.8
    }
  ]
}
```

### `merge_findings`

Merge reviewer outputs into one consolidated result.

Artifacts:

- `merged-findings.md`
- `merged-findings.json`

This step should:

- de-duplicate overlap
- preserve the strongest findings
- normalize priority based on actual risk

### `normalize_findings`

Run an AI quality gate on the merged result.

Artifacts:

- `result.json`

This uses the standard AI check result contract and should fail when the merged review is:

- overly duplicative
- poorly severity-calibrated
- missing file references where they should exist
- dominated by low-value commentary

### `publish_review`

Write the final review handoff.

Default artifacts:

- `review.md`
- `findings.json`
- `findings.md`

## Output Contract

The final published node should expose:

- `review_report`
- `findings`

Optional additional output:

- `findings_markdown`

## UI Implications

Collapsed managed-node view should show:

- review source status
- reviewer-panel progress
- normalization status
- final findings count

Expanded view should expose:

- review packet
- each reviewer’s findings
- merged findings
- normalization result
- final review artifacts

## Implementation Notes

1. authored node parsing lives in the normalizer
2. `review_change` lowers into a generated primitive subgraph in `src/managed`
3. the original authored node id maps to the final published review node
4. graph-level tests cover lowering, artifact-bundle source mapping, and downstream dependency behavior
5. the showcase graph under `.tmp/` demonstrates the `execute_spec -> review_change` path

## Summary

`review_change` is not a single reviewer prompt.

It is a managed review workflow with:

- a required structured `review_source`
- a read-only review packet
- parallel role-based reviewers
- merged and normalized findings
- final prose and machine-readable review artifacts
