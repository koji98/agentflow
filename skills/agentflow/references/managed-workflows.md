# Managed Workflows

Managed patterns are compiler-supported `pattern_*` nodes. They are not the same as common authored primitive compositions in `common-patterns.md`.

Use a managed pattern when the operator wants a known lifecycle with standard public artifacts and inspectable lowered nodes. Use primitive nodes or common authored patterns when the workflow is one-off or needs exact custom control.

## Shared Rules

- Managed patterns use normal node fields: `goal`, `acceptance_criteria`, `constraints`, `context`, and `artifacts`.
- Default public artifacts are `summary` and `packet`; authored artifacts merge with those defaults.
- Downstream nodes reference artifacts from the public authored pattern id.
- Never depend on generated internal ids from the compiled graph.
- The runtime supervisor still handles internal node failures; pattern loops handle normal criterion feedback.
- Agents running inside managed patterns do not need to know Agentflow internals. The compiler explains that internal helper artifacts are private working material and public artifacts are the durable downstream contract.

## Pattern Selection

### `pattern_deep_research`

Use when the task is “go learn enough and report back.”

- Good for product research, architecture research, implementation research, and review across authored angles.
- Special key: `research.angles`.
- Angles should be sentence-style prompts, not single-word axes.
- Public artifacts: `summary`, `packet`, and any authored extras.
- Angle workers may use local repo files, provided context, local CLIs, docs, or web research, whichever best serves the angle.
- More than three research packets are synthesized in balanced batches of at most three inputs. Seven angles become `2`, `2`, and `3`, then final synthesis.
- Synthesis preserves major findings, collapses redundancy, keeps provenance, and carries uncertainty or conflicts forward.
- Angle and synthesis artifacts are private evidence packets. The final publisher owns the authored public artifact shape, including required handoff fields or labels.

```json
{
  "type": "pattern_deep_research",
  "id": "checkout_research",
  "goal": "Recommend whether the checkout timeout implementation is ready to ship.",
  "acceptance_criteria": [
    "The recommendation covers architecture fit, correctness risk, and rollout risk."
  ],
  "research": {
    "angles": [
      "Investigate whether the implementation follows existing checkout architecture.",
      "Identify correctness and edge-case risks in timeout behavior.",
      "Assess test coverage, release risk, and follow-up work."
    ]
  }
}
```

### `pattern_deep_work`

Use when the task is “work, validate, critique, and fix until done.”

- Good for implementation, migration, cleanup, docs+code changes, and bounded repair loops.
- Special key: `completion`.
- Criteria weights must sum to `1`.
- Criteria can be marked as hard blockers when failure must prevent success.
- Failed criteria become loop feedback; runtime failures still go to the supervisor.
- Each cycle is `plan -> generate_and_validate -> completion criteria -> deterministic score gate`.
- The planning agent does not edit; it writes the smallest credible plan from task context and prior feedback.
- The generate-and-validate agent does the work, uses available CLIs naturally, runs focused validation when feasible, fixes clear validation failures, and writes draft public artifacts before the criteria panel grades them.

```json
{
  "type": "pattern_deep_work",
  "id": "checkout_timeout_impl",
  "goal": "Implement a typed checkout timeout path and publish validation evidence.",
  "acceptance_criteria": [
    "Focused checkout tests pass.",
    "The final summary explains changes, validation, and residual risks."
  ],
  "completion": {
    "max_cycles": 3,
    "pass_threshold": 0.85,
    "criteria": [
      {
        "id": "focused_tests",
        "kind": "command",
        "command": "npm test -- tests/checkout",
        "weight": 0.4
      },
      {
        "id": "acceptance_rubric",
        "kind": "rubric",
        "rubric": "The workspace satisfies the goal and acceptance criteria without violating constraints.",
        "weight": 0.4
      },
      {
        "id": "handoff_quality",
        "kind": "artifact_rubric",
        "artifact": "summary",
        "rubric": "The summary clearly describes changes, validation evidence, and residual risks.",
        "weight": 0.2
      }
    ]
  }
}
```

## Validation

Run:

```bash
agentflow validate --graph agentflow.graph.json --show-compiled
agentflow validate --graph agentflow.graph.json --diagram-output compiled-graph.mmd
agentflow validate --graph agentflow.graph.json --diagram-image-output compiled-graph.svg
```

Inspect `lowered_managed_nodes`, generated scopes, balanced deep research synthesis layers, deep work repeat limits, completion criteria, public artifacts, and delivery compatibility.
