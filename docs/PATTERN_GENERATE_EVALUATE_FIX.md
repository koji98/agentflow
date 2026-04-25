# Pattern Generate Evaluate Fix

`pattern_generate_evaluate_fix` implements an accountable change slice, evaluates it independently, and repeats within a bounded repair loop when hard evaluation is required.

Use it when the task source is already clear enough to implement and the success bar can be checked with commands or structured evaluator artifacts.

## Contract

Required fields:

- `type`: `"pattern_generate_evaluate_fix"`
- `id`
- `brief.objective`

Task source options:

- `task_source.kind: "managed_node"` with `node`
- `task_source.kind: "artifact_bundle"` with file or artifact entries

Common fields:

- `repo`
- `profile`
- `context`
- `context_policy`
- `strategy.max_fix_cycles`
- `evaluation.commands`
- `evaluation.required`
- `runtime.max_concurrency`

## Published Artifacts

- `change_summary`: human-readable implementation summary.
- `change_packet`: machine-readable change package.
- `evaluation_ledger`: structured evaluator results.
- `fix_log`: repair attempts and changes made after evaluation.

## Runtime Shape

When `evaluation.required` is true, the pattern lowers into:

1. Prepare task packet.
2. Repeat:
   - generate or fix the change
   - run evaluator panel
   - aggregate evaluations
   - hard-gate the evaluation ledger
3. Publish change package.

When `evaluation.required` is false, the pattern runs one non-blocking evaluation pass and publishes the package without a repair loop.

## Example

```json
{
  "type": "pattern_generate_evaluate_fix",
  "id": "checkout_timeout_impl",
  "repo": "main",
  "profile": "implementation",
  "brief": {
    "objective": "Implement checkout timeout handling from the design packet.",
    "scope": {
      "paths": ["src/checkout/**", "tests/checkout/**"],
      "areas": ["runtime behavior", "tests"]
    }
  },
  "task_source": {
    "kind": "managed_node",
    "node": "checkout_timeout_design"
  },
  "strategy": {
    "max_fix_cycles": 3
  },
  "evaluation": {
    "commands": ["npm test -- tests/checkout"],
    "required": true
  }
}
```

Downstream review nodes should consume `change_summary`, `change_packet`, and `evaluation_ledger` from the public pattern node id.
