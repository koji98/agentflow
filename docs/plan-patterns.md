# Plan Patterns

Reusable plan architectures for common agent orchestration scenarios.

## Pattern 1: Extract → Transform → Validate (ETV)

The foundational pattern for any data-porting or migration task. One agent extracts reference data, another transforms the target, a third validates.

**When to use:** Porting definitions from one system to another, data migrations, schema synchronization.

```json
{
  "repos": { "source": "../source-repo", "target": "../target-repo" },
  "provider": "cursor",
  "model": "claude-4.6-opus-high",
  "worktrees": false,
  "flow": [
    {
      "type": "task",
      "id": "extract_reference",
      "repo": "source",
      "persona": "You are a senior engineer. You are meticulous about extracting complete, accurate data.",
      "prompt": "Parse source files and produce a JSON reference file at scripts/reference.json..."
    },
    {
      "type": "task",
      "id": "write_validator",
      "repo": "target",
      "persona": "You are a senior test engineer who writes robust validation tooling.",
      "prompt": "Write scripts/validate.py that compares target files against the reference..."
    },
    {
      "type": "task",
      "id": "apply_changes",
      "repo": "target",
      "prompt": "Read the reference and apply changes to all target files...",
      "context_files": ["source:scripts/reference.json"],
      "context_from": ["extract_reference"]
    },
    {
      "type": "task",
      "id": "validate",
      "repo": "target",
      "prompt": "Run scripts/validate.py and fix any issues...",
      "context_from": ["apply_changes"]
    }
  ]
}
```

## Pattern 2: Batch + Review

Break large modification sets into sized batches with review steps between them. The first batch gets a dedicated review task (canary); subsequent batches inherit confidence.

**When to use:** Modifying 50+ files with the same pattern, especially when the pattern varies by category or domain.

```json
{
  "flow": [
    {
      "type": "task",
      "id": "batch_1_a_to_g",
      "prompt": "Modify files a.py through g.py (15 files)..."
    },
    {
      "type": "task",
      "id": "canary_review",
      "persona": "You are a meticulous code reviewer focused on correctness.",
      "prompt": "Review 5 specific files from batch 1 for correctness...",
      "context_from": ["batch_1_a_to_g"]
    },
    {
      "type": "task",
      "id": "batch_2_h_to_p",
      "prompt": "Modify files h.py through p.py (20 files)...",
      "context_from": ["canary_review"]
    },
    {
      "type": "task",
      "id": "batch_3_q_to_z",
      "prompt": "Modify files q.py through z.py (15 files)...",
      "context_from": ["canary_review"]
    }
  ]
}
```

**Batch sizing:**

| Uniformity | Recommended size |
|---|---|
| Identical change every file | 60–100 files |
| Same pattern, different values | 15–30 files |
| Varied logic per file | 5–15 files |

## Pattern 3: Loop Until Clean

Use a deterministic gate to repeat a fix task until validation passes or iterations are exhausted. The gate runs a script that outputs `{ "passed": bool, "score": num, "reasons": [...] }`.

**When to use:** Validation-driven convergence — fixing test failures, linter errors, or schema violations.

```json
{
  "type": "loop",
  "id": "fix_until_valid",
  "max_iterations": 4,
  "gate": {
    "type": "deterministic",
    "command": "python3",
    "args": ["scripts/validate.py", "--json"],
    "timeout_sec": 120
  },
  "body": [
    {
      "type": "task",
      "id": "fix_issues",
      "prompt": "Read the gate feedback from the previous iteration. Fix EVERY issue listed in the reasons array. Do not skip any."
    }
  ]
}
```

**Gate feedback:** The gate output (pass/fail, score, reasons) is automatically injected into the next iteration's task prompt. The agent sees exactly what failed and why.

**Important:** Set `max_iterations` per-loop, not globally. Global `max_iterations` applies across ALL loops in the plan and can cause premature exhaustion on resume.

## Pattern 4: Multi-Branch Pipeline

Process multiple git branches sequentially, applying changes to each, validating, and pushing.

**When to use:** Splitting large changes into multiple PRs, operating on feature branches.

```json
{
  "flow": [
    {
      "type": "group",
      "id": "branch_a",
      "parallel": false,
      "steps": [
        {
          "type": "task",
          "id": "a_checkout",
          "prompt": "git checkout branch-a. Copy shared scripts from master..."
        },
        {
          "type": "task",
          "id": "a_modify",
          "prompt": "Apply changes to all files on branch-a..."
        },
        {
          "type": "task",
          "id": "a_validate_push",
          "prompt": "Run validation, amend commit with proof, push..."
        }
      ]
    },
    {
      "type": "group",
      "id": "branch_b",
      "parallel": false,
      "steps": [
        {
          "type": "task",
          "id": "b_checkout",
          "prompt": "git checkout branch-b..."
        },
        {
          "type": "task",
          "id": "b_modify",
          "prompt": "Apply changes..."
        },
        {
          "type": "task",
          "id": "b_validate_push",
          "prompt": "Run validation, amend commit with proof, push..."
        }
      ]
    }
  ]
}
```

**Branch hygiene:** Each group should:
1. Start with `git checkout <branch>`
2. Copy any shared scripts/tooling from another branch
3. End with `git checkout master`

## Pattern 5: AI-Gated Quality Review

Use an AI gate to evaluate subjective quality (code readability, naming conventions, documentation quality) that can't be measured by scripts alone.

**When to use:** Evaluating semantic correctness, reviewing natural-language descriptions, judging code quality beyond syntax.

```json
{
  "type": "loop",
  "id": "quality_review",
  "max_iterations": 3,
  "gate": {
    "type": "ai",
    "prompt": "Review the last 5 tasks. Are all changes correct, consistent, and complete? Return { \"passed\": true/false, \"score\": 0.0-1.0, \"reasons\": [...] }",
    "model": "claude-4.6-opus-high",
    "score_threshold": 0.9,
    "include_recent_tasks": 5
  },
  "body": [
    {
      "type": "task",
      "id": "refine_quality",
      "prompt": "Based on the quality feedback, improve the identified issues..."
    }
  ]
}
```

## Pattern 6: Preparation Fan-Out

Multiple independent preparation tasks run before the main execution. If they operate on different repos, they can safely run in parallel.

**When to use:** Extracting reference data from multiple sources, setting up tooling in both repos.

```json
{
  "flow": [
    {
      "type": "group",
      "id": "preparation",
      "parallel": true,
      "steps": [
        {
          "type": "task",
          "id": "extract_from_ui",
          "repo": "ui",
          "prompt": "Extract field descriptions into a JSON file..."
        },
        {
          "type": "task",
          "id": "extract_from_api",
          "repo": "api",
          "prompt": "Extract API field mappings into a JSON file..."
        }
      ]
    },
    {
      "type": "task",
      "id": "merge_references",
      "repo": "target",
      "prompt": "Read both JSON files and merge into a combined reference...",
      "context_files": [
        "ui:scripts/field_descriptions.json",
        "api:scripts/field_mappings.json"
      ],
      "context_from": ["extract_from_ui", "extract_from_api"]
    }
  ]
}
```

## Pattern 7: Cascading PRs

Create multiple PRs from one plan, each building on the previous. Use `command` nodes to deterministically run child plans and git/gh operations.

**When to use:** Changes too large for a single PR, where each PR should be independently reviewable.

```json
{
  "repos": { "main": "." },
  "flow": [
    {
      "type": "command",
      "id": "validate_child_01",
      "repo": "main",
      "command": "/bin/zsh",
      "args": ["-lc", "agentflow --plan ./plans/child_01.json --validate"],
      "timeout_sec": 600
    },
    {
      "type": "command",
      "id": "run_child_01",
      "repo": "main",
      "command": "/bin/zsh",
      "args": ["-lc", "agentflow --plan ./plans/child_01.json"],
      "timeout_sec": 7200
    },
    {
      "type": "command",
      "id": "push_child_01",
      "repo": "main",
      "command": "/bin/zsh",
      "args": ["-lc", "git add -A && git commit -m 'chore: child 01' && git push -u origin HEAD"]
    },
    {
      "type": "command",
      "id": "pr_child_01",
      "repo": "main",
      "command": "/bin/zsh",
      "args": ["-lc", "gh pr create --base stack/parent --title 'child 01' --body 'Automated by agentflow'"]
    }
  ]
}
```

## Composing Patterns

Real-world plans combine multiple patterns. A large codebase migration might use:

1. **Preparation Fan-Out** (extract references from UI + API in parallel)
2. **ETV** for the core transformation
3. **Batch + Review** within the transformation phase
4. **Loop Until Clean** for post-transformation validation
5. **Multi-Branch Pipeline** to split into PRs

```
Preparation Fan-Out          Batch + Review        Multi-Branch Pipeline
┌─────────┐ ┌─────────┐    ┌─────────────────┐    ┌──────────────────┐
│ Extract  │ │ Extract │    │ Batch 1 → Review│    │ Branch A: push   │
│ from UI  │ │ from API│ ──▶│ Batch 2         │ ──▶│ Branch B: push   │
└─────────┘ └─────────┘    │ Batch 3         │    │ Branch C: push   │
                            │ Validate Loop   │    └──────────────────┘
                            └─────────────────┘
```
