# Managed Patterns

Agentflow has three authoring categories:

- Primitive executable nodes: `agent`, `exec`, `check`, `checkpoint`
- Primitive control-flow containers: `sequence`, `parallel`, `repeat`
- Managed patterns: `pattern_deep_research`, `pattern_spec_design`, `pattern_generate_evaluate_fix`, `pattern_review_change`

Managed patterns are authored shortcuts. They compile into generated primitive subgraphs and run on the same runtime as the rest of the graph.

## Canonical Chain

The intended high-level composition is:

1. `pattern_deep_research`
2. `pattern_spec_design`
3. `pattern_generate_evaluate_fix`
4. `pattern_review_change`

Patterns can also hand off to primitive nodes directly when the graph only needs a narrower follow-on step.

## Shared Model

Every managed pattern uses this base:

- `brief`
- `context_policy`
- `strategy`
- optional `runtime`

Pattern-specific fields are intentional:

- `pattern_deep_research`: optional `approval_policy`, `delivery`
- `pattern_spec_design`: optional `approval_policy`, `delivery`
- `pattern_generate_evaluate_fix`: `task_source`, `evaluation`
- `pattern_review_change`: `review_source`, `delivery`

Shared executable fields still apply:

- `label`
- `repo`
- `profile`
- `inputs`
- `context_from`
- `timeout_sec`

Rules:

- Managed patterns are fixed strategy contracts, not prompt buckets.
- Only the patterns that explicitly define `delivery` accept it. `delivery` can shape format or sections, but it does not toggle core outputs on or off.
- Only `pattern_deep_research` and `pattern_spec_design` expose `approval_policy` in this release.
- Runtime truth lives in run artifacts. Managed patterns do not publish fake runtime-status or workflow-event files.

## Pattern Inventory

### `pattern_deep_research`

Purpose:
- Clarify a research question, plan the investigation, fan out researchers, consolidate findings, and publish a sourced report plus machine-readable packet.

Core outputs:
- `research-report.md`
- `research-packet.json`
- `source-ledger.json`
- `uncertainties.md`
- `interim-findings.jsonl`

Notes:
- Optional plan approval is supported through `approval_policy.require_plan_approval`.
- `runtime.max_concurrency` only caps execution concurrency.

Reference:
- [`PATTERN_DEEP_RESEARCH.md`](PATTERN_DEEP_RESEARCH.md)

### `pattern_spec_design`

Purpose:
- Turn a repo-grounded problem statement into an implementation-ready design package that downstream primitives or patterns can consume.

Core outputs:
- `design-spec.md`
- `design-packet.json`
- `direction-proposal.md`
- `tradeoff-matrix.md`
- `decision-log.md`
- `implementation-readiness.md`
- `critique-merged.md`
- `quality-review.json`

Notes:
- Optional direction approval is supported through `approval_policy.require_direction_approval`.
- The revision loop is bounded by `strategy.max_revision_cycles`.

Reference:
- [`PATTERN_SPEC_DESIGN.md`](PATTERN_SPEC_DESIGN.md)

### `pattern_generate_evaluate_fix`

Purpose:
- Consume a prepared task packet, generate or fix a change, evaluate concrete commands independently, aggregate the evidence, and optionally repeat until the hard evaluation gate passes.

Core outputs:
- `change-summary.md`
- `change-packet.json`
- `evaluation-ledger.json`
- `fix-log.md`

Notes:
- This pattern is intentionally narrow. It does not do spec planning, execution-plan approval, or read-only recon.
- `task_source` replaces the old spec-ingestion surface.
- `strategy.max_fix_cycles` bounds retries after the initial generation pass.
- `evaluation.required = false` runs one non-blocking evaluation pass and records soft evidence without the repeat loop.

Reference:
- [`PATTERN_GENERATE_EVALUATE_FIX.md`](PATTERN_GENERATE_EVALUATE_FIX.md)

### `pattern_review_change`

Purpose:
- Prepare a review packet, plan reviewer focus, fan out specialized reviewers, merge and calibrate findings, and publish a final review package.

Core outputs:
- `review-summary.md`
- `review-bundle.json`
- `raw-findings.json`
- `merged-findings.json`
- `calibrated-findings.json`

Notes:
- This pattern is read-only.
- Reviewer fan-out is task-specific. There is no generic council pattern in this release.

Reference:
- [`PATTERN_REVIEW_CHANGE.md`](PATTERN_REVIEW_CHANGE.md)

## Implementation Surface

Shipped in this release:

- canonical pattern kinds in `src/graph/schema.ts`
- pattern builders in `src/managed/`
- normalization support that lowers managed patterns into primitive subgraphs
- registry metadata in `src/managed/registry.ts`
- example graphs in [`docs/examples/graphs/`](examples/graphs/README.md)

Deferred:

- UI-native collapsed pattern views
- controller-managed orchestration
- a generic debate or council pattern
