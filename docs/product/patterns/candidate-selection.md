# Pattern Candidate Selection

`pattern_candidate_selection` compares user-authored candidate strategies, scores each candidate against one shared rubric contract, and publishes one deterministic `selection` artifact.

Use it when the strategies to compare are already known and choosing well matters before implementation. Use `pattern_deep_research` first when the workflow still needs to discover plausible strategies. Use `pattern_deep_work` after selection when the chosen strategy should be implemented.

V1 is non-mutating. Candidate workers produce implementation-ready strategy packets only; source edits belong in downstream work that consumes the selected strategy.

## Contract

Required fields:

- `type`: `"pattern_candidate_selection"`
- `id`
- `intent.goal`
- `intent.acceptance_criteria`
- `selection.candidates`
- `selection.criteria`

Common fields:

- `intent.constraints`
- `runtime.repo`
- `runtime.profile`
- `support`
- `model`
- `reasoning_effort`
- `sandbox`
- `artifact_repair`
- `selection.pass_threshold`

The public authoring model is:

```text
candidates -> diversity -> criteria -> selection
develop      ensure distinct  score       choose deterministically
```

The small V1 `selection` object accepts only:

- `candidates`: required array, 2 to 8 entries. Each candidate has `id` and full `intent`.
- `criteria`: required array, at least 1 entry. Each criterion has `id`, `weight`, optional `required`, and `rubric`.
- `pass_threshold`: optional number from 0 to 1. Default is `0.8`.

Criterion weights must sum to `1`. Unknown fields are validation errors. V1 does not support generated strategies, `candidate_count`, `candidate_kind`, `selection_policy`, command criteria, custom public artifacts, source mutation, patch promotion, pairwise tournament judging, or candidate worker modes.

## Graph-Addressable Artifacts

Default graph-addressable artifact:

- `selection`: machine-readable selection packet written at `selection.json`.

Downstream graph nodes reference stable artifacts such as `checkout_strategy.selection`. Internal candidate packets, diversity results, and criterion scorecards remain run evidence, not downstream graph contracts.

The selected packet includes:

- `schema_version: 1`
- `status`: `selected`, `no_eligible_candidate`, `diversity_failed`, or `invalid_candidate_packets`
- `selected_candidate_id`
- `selected`
- `ranking`
- `rejected`
- `criteria`
- `diversity`
- `pass_threshold`
- `generated_at`
- optional `tie_breaker`

## Runtime Shape

The pattern lowers into:

1. Parallel candidate agents, one per authored candidate.
2. One AI diversity check across all candidate artifacts.
3. Parallel AI criterion checks for every candidate and criterion pair.
4. A deterministic selector exec using the authored node id that writes `selection.json`.

Candidate agents publish only `candidate_json` with this contract:

```json
{
  "schema_version": 1,
  "id": "minimal_patch",
  "title": "Minimal Patch",
  "summary": "Short summary.",
  "approach": "Primary approach.",
  "implementation_outline": ["Step or design element."],
  "validation_plan": ["Validation evidence."],
  "risks": ["Risk."],
  "assumptions": ["Assumption."],
  "evidence": [
    {
      "ref": "src/checkout.ts",
      "summary": "What this evidence supports."
    }
  ],
  "residual_uncertainty": []
}
```

The diversity check passes only when candidate packets differ materially in primary strategy, tradeoff profile, and implementation outline. Wording variants and duplicated plans fail.

Each criterion check evaluates exactly one candidate against one criterion and returns the managed criterion JSON shape:

```json
{
  "passed": true,
  "score": 0.9,
  "summary": "Evidence-backed rationale.",
  "issues": []
}
```

The selector is deterministic. It validates every candidate and criterion result, blocks a candidate when a required criterion is not passed or scores below `pass_threshold`, computes weighted totals, filters eligible candidates by blockers and threshold, and selects the highest eligible total. Equal scores use authored candidate order and record a tie-breaker.

If no candidate is eligible, the selector still writes `selection.json` with `status: "no_eligible_candidate"` and exits nonzero so downstream work is blocked with evidence.

## Example

```json
{
  "type": "pattern_candidate_selection",
  "id": "checkout_timeout_strategy",
  "runtime": {
    "repo": "main",
    "profile": "default"
  },
  "intent": {
    "goal": "Select the checkout timeout strategy that best fits this repository.",
    "acceptance_criteria": [
      "Each candidate is compared against the same criteria.",
      "The selected candidate is implementation-ready and evidence-backed.",
      "Rejected candidates include concrete rationale."
    ],
    "constraints": [
      "Do not edit source files."
    ]
  },
  "selection": {
    "candidates": [
      {
        "id": "minimal_patch",
        "intent": {
          "goal": "Develop the smallest safe timeout strategy using existing architecture.",
          "acceptance_criteria": [
            "The candidate explains implementation, validation, risk, and assumptions."
          ],
          "constraints": [
            "Do not introduce new infrastructure."
          ]
        }
      },
      {
        "id": "central_policy",
        "intent": {
          "goal": "Develop a centralized timeout policy strategy.",
          "acceptance_criteria": [
            "The candidate defines the shared boundary and migration path."
          ],
          "constraints": [
            "Do not assume every caller can migrate at once."
          ]
        }
      }
    ],
    "pass_threshold": 0.8,
    "criteria": [
      {
        "id": "repo_fit",
        "weight": 0.4,
        "required": true,
        "rubric": "The candidate fits existing repository architecture and conventions."
      },
      {
        "id": "risk",
        "weight": 0.35,
        "rubric": "The candidate minimizes implementation and rollout risk."
      },
      {
        "id": "testability",
        "weight": 0.25,
        "rubric": "The candidate has a clear focused validation path."
      }
    ]
  }
}
```

Validate with `agentflow validate --graph <path> --show-compiled` and inspect the candidate fan-out, diversity check, criterion checks, and authored-id selector before launch.
