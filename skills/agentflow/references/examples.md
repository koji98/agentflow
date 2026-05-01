# Examples

Repository examples live in `docs/examples/graphs/`.

Use:

```bash
agentflow validate --graph docs/examples/graphs/feature-showcase.json
agentflow validate --graph docs/examples/graphs/feature-showcase.json --show-compiled
```

Plugin tool example:

```bash
agentflow plugin resolve --graph docs/examples/graphs/ship-feature.graph.json
agentflow validate --graph docs/examples/graphs/ship-feature.graph.json --run-ready
```

## Best-Practice Single Agent Graph

Use this as the default copy source for focused implementation work.

```json
{
  "version": "1",
  "graph_id": "focused-change",
  "intent": {
    "goal": "Implement a focused checkout timeout fix.",
    "acceptance_criteria": [
      "Timeout behavior is implemented and covered by a focused validation command.",
      "The final handoff names changed files, validation evidence, and residual risks."
    ],
    "constraints": [
      "Keep public payment provider configuration unchanged.",
      "Do not modify unrelated checkout flows."
    ]
  },
  "repos": {
    "main": {
      "path": "."
    }
  },
  "defaults": {
    "launch_profile": "default",
    "workspace_backend": "worktree"
  },
  "profiles": {
    "default": {
      "harness": "codex-cli",
      "sandbox": "workspace-write",
      "timeout_sec": 1200,
      "input_rules": {
        "max_total_tokens": 128000,
        "max_tokens_per_item": 32000
      }
    }
  },
  "graph": {
    "type": "sequence",
    "id": "root",
    "steps": [
      {
        "type": "agent",
        "id": "implement_timeout",
        "repo": "main",
        "profile": "default",
        "goal": "Implement the timeout fix and publish a reviewable handoff.",
        "acceptance_criteria": [
          "The implementation is scoped to checkout timeout behavior.",
          "A focused validation command is run or a concrete blocker is documented.",
          "The handoff includes changed files, validation, and risks."
        ],
        "context": [
          {
            "name": "task",
            "from": "text",
            "text": "Fix checkout timeout handling without changing payment provider configuration."
          },
          {
            "name": "checkout_area",
            "from": "workspace_glob",
            "path": "src/checkout/**/*.ts"
          }
        ],
        "artifacts": {
          "change_summary": {
            "from": "output_dir",
            "path": "change-summary.md",
            "description": "Implementation handoff with changed files, validation evidence, and residual risks."
          }
        }
      },
      {
        "type": "check",
        "id": "focused_tests",
        "check_kind": "deterministic",
        "command": "npm",
        "args": ["test", "--", "tests/checkout"]
      }
    ]
  },
  "supervision": {
    "actions": {
      "retry_with_guidance": { "max_uses": 2 },
      "repair_artifact": { "max_uses": 1 },
      "rebuild_context": { "max_uses": 1 },
      "run_diagnostic": { "max_uses": 1 },
      "pause_for_human": { "max_uses": 1 },
      "semantic_evaluation": { "max_uses": 1 }
    },
    "max_total_interventions": 4,
    "policy": {
      "pause_on_policy_risk": true,
      "pause_on_repeated_recovery": true,
      "drift_score_threshold": 0.8
    }
  }
}
```

Terminal delivery is automatic. Review `delivery/manifest.json`, `delivery/reviewer-guide.md`, and declared artifacts first.

The `checkout_area` context intentionally gives a bounded area, not an exact edit plan. Let the agent inspect and choose the right implementation path unless the user specified exact files or a required approach.

## Parallel Reviewers Skeleton

Use for the common `design -> implement -> validate -> parallel reviewers -> refine -> validate` pattern. The reviewer nodes should be read-only or constrained to review artifacts, and the refinement node consumes every reviewer artifact.

```json
{
  "type": "sequence",
  "id": "root",
  "steps": [
    {
      "type": "agent",
      "id": "design",
      "goal": "Design the scoped change and publish an implementation-ready brief.",
      "acceptance_criteria": ["The design names scope, file plan, validation plan, and risks."],
      "artifacts": {
        "design_brief": {
          "from": "output_dir",
          "path": "design.md",
          "description": "Implementation-ready design brief."
        }
      }
    },
    {
      "type": "agent",
      "id": "implement",
      "goal": "Implement the accepted design and publish a change summary.",
      "acceptance_criteria": ["The implementation follows the design brief.", "Validation evidence or blockers are recorded."],
      "context": [{ "ref": "design.design_brief", "name": "design_brief" }],
      "artifacts": {
        "change_summary": {
          "from": "output_dir",
          "path": "change-summary.md",
          "description": "Implementation summary for review."
        }
      }
    },
    { "type": "check", "id": "pre_review_tests", "check_kind": "deterministic", "command": "npm", "args": ["test", "--", "tests/focused"] },
    {
      "type": "parallel",
      "id": "parallel_reviewers",
      "steps": [
        {
          "type": "agent",
          "id": "review_correctness",
          "goal": "Review correctness risks and publish findings.",
          "context": [{ "ref": "implement.change_summary", "name": "change_summary" }],
          "artifacts": {
            "correctness_review": {
              "from": "output_dir",
              "path": "correctness-review.md",
              "description": "Correctness-focused review findings."
            }
          }
        },
        {
          "type": "agent",
          "id": "review_tests",
          "goal": "Review test and regression risk and publish findings.",
          "context": [{ "ref": "implement.change_summary", "name": "change_summary" }],
          "artifacts": {
            "test_review": {
              "from": "output_dir",
              "path": "test-review.md",
              "description": "Test and regression review findings."
            }
          }
        },
        {
          "type": "agent",
          "id": "review_maintainability",
          "goal": "Review maintainability and simplicity and publish findings.",
          "context": [{ "ref": "implement.change_summary", "name": "change_summary" }],
          "artifacts": {
            "maintainability_review": {
              "from": "output_dir",
              "path": "maintainability-review.md",
              "description": "Maintainability-focused review findings."
            }
          }
        }
      ]
    },
    {
      "type": "agent",
      "id": "refine",
      "goal": "Refine the implementation using all reviewer artifacts and publish the final handoff.",
      "context": [
        { "ref": "review_correctness.correctness_review", "name": "correctness_review" },
        { "ref": "review_tests.test_review", "name": "test_review" },
        { "ref": "review_maintainability.maintainability_review", "name": "maintainability_review" }
      ],
      "artifacts": {
        "final_handoff": {
          "from": "output_dir",
          "path": "final-handoff.md",
          "description": "Final handoff after reviewer-driven refinement."
        }
      }
    },
    { "type": "check", "id": "final_tests", "check_kind": "deterministic", "command": "npm", "args": ["test", "--", "tests/focused"] }
  ]
}
```

## Tool Inventory Preflight

Use this when later nodes need explicit evidence about device-local commands or repo scripts.

```json
{
  "type": "exec",
  "id": "tool_inventory",
  "repo": "main",
  "command": "bash",
  "args": [
    "-lc",
    "printf 'PATH tools:\\n'; for cmd in rg git gh node npm pnpm python uv pytest jq; do command -v \"$cmd\" >/dev/null 2>&1 && printf '%s %s\\n' \"$cmd\" \"$(command -v \"$cmd\")\"; done; printf '\\nPackage scripts:\\n'; npm run --silent 2>/dev/null || true"
  ],
  "artifacts": {
    "tool_inventory": {
      "from": "output_dir",
      "path": "stdout.log",
      "description": "Available local CLI and package-script inventory for downstream planning."
    }
  }
}
```

Most graphs do not need this as a separate node. Prefer letting an implementation agent inspect CLIs inside its node unless downstream planning or audit needs a durable inventory artifact.

## Codex And Cursor

Use the same graph and switch launch profiles:

```json
{
  "profiles": {
    "codex": { "harness": "codex-cli", "sandbox": "workspace-write" },
    "cursor": { "harness": "cursor-cli", "sandbox": "workspace-write" }
  },
  "defaults": { "launch_profile": "codex" }
}
```

Both harnesses receive the same Agentflow context, artifacts, tools, timeout, and delivery contract.

## Eval Examples

Eval examples live in `docs/examples/evals/`. The committed fake-workflow dogfood suite lives in `evals/agentflow-workflow-quality/`, and the larger generated local-repo capability suite lives in `evals/agentflow-capability-workflows/` after running `npm run setup:eval-repos`.

Use `agentflow-evals` for suite layout, scenario environments, variants, criteria, environment simulation, trajectory checks, scorecards, and benchmark reports.
