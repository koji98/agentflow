# Pattern Map Reduce

`pattern_map_reduce` discovers a finite independent item set, runs the same item contract over each frozen item with bounded concurrency, and publishes one aggregate artifact.

Use it for read-mostly audits, classifications, inventory checks, review sweeps, or write-partitioned refactors where each frozen item owns exact disjoint files and the final value is aggregate evidence. Do not use it for ordered implementation, cumulative migrations, shared-file edits, unbounded backlogs, or one coherent feature.

## Contract

Required fields:

- `type`: `"pattern_map_reduce"`
- `id`
- `intent.goal`
- `intent.acceptance_criteria`
- `map_reduce.items.intent`
- `map_reduce.map.intent`
- `map_reduce.reduce.intent`

Common fields:

- `intent.constraints`
- `runtime.repo`
- `runtime.profile`
- `support`
- `model`
- `reasoning_effort`
- `sandbox`
- `artifact_repair`
- `map_reduce.items.max_items`
- `map_reduce.map.max_concurrency`

The authoring model is:

```text
items -> map -> reduce
find     judge/process one item   aggregate
```

Each phase uses an `intent` block:

- `items.intent` defines what finite independent units are in scope.
- `map.intent` defines what one worker must determine for exactly one current item.
- `reduce.intent` defines what the aggregate must prove and how it must avoid overclaiming coverage.

V1 does not expose item source modes, item worker modes, reducer modes, or custom public artifacts. Use `map_reduce.map.max_concurrency` for item fan-out; `runtime.max_concurrency` is not part of this pattern.

## Graph-Addressable Artifacts

Default graph-addressable artifact:

- `aggregate`: machine-readable coverage packet with counts, item statuses, evidence, findings, blockers, skipped items, and residual uncertainty.

Downstream graph nodes reference stable artifacts such as `auth_audit.aggregate`. Internal `item-list.json`, `items-frozen.json`, per-item `item-result.json`, and `item-results.json` files remain run evidence, not downstream graph contracts.

## Runtime Shape

The pattern lowers into:

1. An item planner that writes only `item-list.json`.
2. A deterministic freeze step that validates sequential `m1`, `m2`, `m3` ids, item inputs, scope rationale, omissions, and uncertainty.
3. A runtime-owned map phase that launches one managed item execution per frozen item with bounded concurrency.
4. A deterministic reducer that verifies exactly one result per frozen item and writes `aggregate.json`.

Map workers receive the current frozen item as the controlling task. They must not add, remove, split, merge, reorder, or rediscover items. They write one `item-result.json` with status `passed`, `finding`, `skipped`, or `blocked`. Passed, finding, and skipped results require concrete evidence; findings require at least one finding; skipped results require `skip_rationale`; blocked results require `blocker`.

If a map worker publishes malformed item evidence, Agentflow records a managed contract failure with the exact item id, artifact path, retry boundary, and repair instruction. The reducer also rejects duplicate result ids, missing result ids, extra result ids, and coverage claims beyond the frozen item list.

## Write-Partitioned Refactors

Map-reduce can be used for source writes when the work is partitioned by ownership, not when workers mutate shared state. A safe refactor item owns exact disjoint paths, such as one file or one non-overlapping file set, and the map worker may edit only those owned paths.

For write-partitioned use:

- Put the owned paths in each frozen item input.
- Add map constraints such as `Do not edit files outside the current item's owned paths.`
- Add item evidence that names changed paths, validation run, and residual risk.
- Add a downstream deterministic check or review node that verifies no out-of-scope files changed and that global tests still pass.

V1 does not automatically enforce owned-path write boundaries. Treat path ownership as an authored contract plus verification requirement. If items need to edit shared files, coordinate API changes, depend on earlier item outputs, or retry with semantic item criteria, use `pattern_work_list` or `pattern_deep_work` instead.

## Example

```json
{
  "type": "pattern_map_reduce",
  "id": "auth_audit",
  "runtime": {
    "repo": "main",
    "profile": "default"
  },
  "intent": {
    "goal": "Audit route handlers for missing authorization checks.",
    "acceptance_criteria": [
      "Every selected route handler is inspected or recorded with concrete skip/blocker evidence.",
      "The aggregate artifact separates passed, finding, skipped, and blocked items with source evidence.",
      "The coverage summary explains what was selected, omitted, and uncertain."
    ],
    "constraints": [
      "Do not edit source files."
    ]
  },
  "map_reduce": {
    "items": {
      "max_items": 80,
      "intent": {
        "goal": "Find route handlers that should be audited for authorization behavior.",
        "acceptance_criteria": [
          "The item list is finite.",
          "Each item has a stable id, input, title, and scope rationale.",
          "The item list records omitted candidates and uncertainty when relevant."
        ],
        "constraints": [
          "Do not include generated files or dependency directories."
        ]
      }
    },
    "map": {
      "max_concurrency": 6,
      "intent": {
        "goal": "Inspect one frozen route handler for authorization enforcement.",
        "acceptance_criteria": [
          "The item result records passed, finding, skipped, or blocked status.",
          "The item result cites exact source evidence.",
          "Findings include severity, rationale, and evidence."
        ],
        "constraints": [
          "Do not inspect unrelated route handlers except shared middleware needed to judge this item."
        ]
      }
    },
    "reduce": {
      "intent": {
        "goal": "Publish a verified aggregate authorization audit handoff.",
        "acceptance_criteria": [
          "Every frozen item has one terminal accepted result.",
          "The aggregate groups findings, passes, skipped items, blockers, and uncertainty.",
          "The aggregate is sufficient for downstream planning without reading item directories first."
        ],
        "constraints": [
          "Do not claim full repository coverage beyond the frozen item set and recorded discovery evidence."
        ]
      }
    }
  }
}
```

Validate with `agentflow validate --graph <path> --show-compiled` and inspect the item planner, freeze, map, and reduce phases before launch.
