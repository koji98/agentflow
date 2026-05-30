# Pattern Deep Work

`pattern_deep_work` performs work, grades completion, and loops with feedback until the weighted completion scorecard passes or the cycle budget is exhausted.

Use it when the team wants an agent to design, implement, validate, critique, and fix within one managed lifecycle. It is the managed pattern for “keep working until the job is actually done.”

## Contract

Required fields:

- `type`: `"pattern_deep_work"`
- `id`
- `intent.goal`
- `intent.acceptance_criteria`
- `completion.criteria`

Common fields:

- `intent.constraints`
- `runtime`
- `support`
- `artifacts`
- `completion.max_cycles`
- `completion.pass_threshold`
- `phases`

## Completion Criteria

Supported criteria:

- `command`: deterministic shell command. Passes with score `1` when the command passes and score `0` when it fails.
- `rubric`: AI score from `0` to `1` against a declared target. Use `target: "workspace"` for the current candidate as a whole, or `target: "artifact:<name>"` for one draft graph-addressable artifact.

Criteria weights must sum to `1`. Required criteria are hard blockers. Passing requires no required blockers and `total_score >= pass_threshold`.

For code work, use criteria that reflect the real review bar: correctness, existing repo conventions, privacy/security when relevant, no AI slop, validation evidence, and handoff quality. Do not spread weights evenly by habit; higher-risk criteria should carry higher weight.

## Graph-Addressable Artifacts

Default graph-addressable artifacts:

- `summary`: final human-readable handoff.
- `packet`: final machine-readable scorecard, criterion results, validation evidence, residual risks, and next actions.

Authors can add or override artifacts with the normal `artifacts` field. Targeted rubric criteria can grade default artifacts or authored artifacts.

## Runtime Shape

The pattern lowers into:

1. A repeat loop.
2. A planning agent that reads task context, prior scorecards, criterion feedback, and command output, then writes `cycle-plan.md` without editing the workspace.
3. A generate-and-validate agent that follows the plan, edits the workspace when needed, uses available CLIs naturally, runs focused validation when feasible, and writes work notes plus draft graph-addressable artifacts.
4. Parallel completion criteria.
5. A deterministic scorecard gate.
6. A final graph-addressable artifact publisher from the latest passing cycle.

The normal supervisor still handles internal runtime failures. Criterion misses are loop feedback and do not spend supervisor budget while cycles remain. If the repeat exhausts, Agentflow persists the latest completion scorecard into the attempt completion packet, emits supervisor-visible managed completion evidence, and lets the supervisor drive a causal recovery only when it can make a real material delta.

The completion criteria panel is not the first validation attempt. The generate-and-validate agent should already have tried to validate the candidate and fix clear validation failures before yielding to the criteria panel.

## Phase Overrides

Use `phases` when planning, execution, verification, and publication need different additive intent, support, or runtime policy. Supported phase keys are `plan`, `execute`, `verify`, and `publish`. Each phase is optional and may set:

- `intent.goal`: extra phase objective appended to the built-in phase objective.
- `intent.acceptance_criteria`: extra observable evidence expectations for that phase.
- `intent.constraints`: extra phase constraints that cannot weaken parent constraints.
- `support`: additional support/context available only to that phase.
- `runtime.profile`: phase-specific profile; phase-level repo switching is not supported.
- `model`, `reasoning_effort`, `sandbox`: phase-specific prompt-backed execution policy.

Phase overrides inherit the parent managed contract. They append to the built-in phase contract and do not create separate graph-addressable artifacts, change completion criteria, weaken constraints, or switch repos. Keep them narrow: planning improves the next plan, execution completes and validates the selected plan, verification judges current evidence, and publication only publishes claims supported by the passing scorecard.

## Example

```json
{
  "type": "pattern_deep_work",
  "id": "checkout_timeout_impl",
  "runtime": {
    "repo": "main",
    "profile": "default"
  },
  "intent": {
    "goal": "Implement a typed checkout timeout path and publish validation evidence.",
    "acceptance_criteria": [
      "Focused checkout tests pass.",
      "The implementation follows existing error-handling conventions.",
      "The final handoff documents validation and residual risk."
    ],
    "constraints": [
      "Do not change public API names.",
      "Do not edit lockfiles."
    ]
  },
  "support": {
    "context": [
      {
        "name": "task",
        "kind": "workspace_file",
        "path": "AGENTFLOW_TASK.md",
        "what": "The scoped task brief.",
        "why": "It defines the implementation goal and constraints for the work loop."
      }
    ]
  },
  "completion": {
    "max_cycles": 3,
    "pass_threshold": 0.85,
    "criteria": [
      {
        "id": "focused_tests",
        "kind": "command",
        "command": "npm test -- tests/checkout",
        "weight": 0.4,
        "required": true
      },
      {
        "id": "acceptance_rubric",
        "kind": "rubric",
        "target": "workspace",
        "rubric": "The workspace satisfies the goal and acceptance criteria without violating constraints.",
        "weight": 0.4
      },
      {
        "id": "handoff_quality",
        "kind": "rubric",
        "target": "artifact:summary",
        "rubric": "The summary clearly describes changes, validation evidence, and residual risks.",
        "weight": 0.2
      }
    ]
  },
  "phases": {
    "plan": {
      "intent": {
        "goal": "Plan from the latest scorecard and avoid designing unrelated architecture.",
        "acceptance_criteria": [
          "Name the smallest credible validation command."
        ]
      }
    },
    "execute": {
      "intent": {
        "goal": "Implement only the selected plan and keep diffs narrow.",
        "acceptance_criteria": [
          "Record exact command output in work notes."
        ]
      },
      "sandbox": "workspace-write"
    },
    "verify": {
      "intent": {
        "acceptance_criteria": [
          "Penalize missing validation evidence."
        ]
      }
    },
    "publish": {
      "intent": {
        "goal": "Publish only claims supported by the passing scorecard."
      }
    }
  }
}
```

Validate with `agentflow validate --graph <path> --show-compiled` and inspect the completion criteria, repeat limit, scorecard gate, and graph-addressable artifacts before launch.
