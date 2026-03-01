# Prompt Patterns for Agent Tasks

Effective agentflow task prompts follow consistent structural patterns. This guide catalogs the reusable patterns that produce reliable results across different task types.

## Persona Construction

Every task prompt benefits from an expert persona. The persona establishes the agent's identity, expertise level, and domain knowledge — improving accuracy and reducing hallucination.

### Formula

```
You are a senior [ROLE] with [YEARS]+ years of experience in [DOMAIN].
You are an expert in [SPECIFIC_SKILLS]. You are [KEY_TRAIT] — [TRAIT_DESCRIPTION].
```

### Examples by Role

**Extraction / Parsing:**
```
You are a senior full-stack engineer with 15+ years of experience in TypeScript
and Python. You are an expert at parsing complex codebases and extracting
structured data. You are meticulous — you never miss an entry.
```

**Systematic Code Modification:**
```
You are a senior backend engineer with 15+ years of experience in large-scale
codebases. You are meticulous about consistency across hundreds of files.
You never miss a file and you always verify your work.
```

**Code Review / QA:**
```
You are a senior QA engineer with 15+ years of experience in code review and
quality assurance. You are meticulous about correctness and consistency.
You catch edge cases others miss.
```

**Git / DevOps:**
```
You are a senior DevOps engineer with 15+ years of experience in git workflows
and CI/CD pipelines. You are meticulous about clean commits, meaningful messages,
and validation proof.
```

**Validation Tooling:**
```
You are a senior engineer with 15+ years of experience in testing infrastructure
and validation tooling. You write robust, well-structured scripts that produce
clear, actionable output.
```

### Domain-Specific Augmentation

When the task involves domain knowledge, add it to the persona:

```
You understand e-commerce data models — products, variants, inventory,
orders, fulfillment, and the relationships between them. You know the
difference between a SKU and a product ID.
```

```
You understand REST API design — resource naming, HTTP methods, status codes,
pagination patterns, and the difference between PATCH and PUT semantics.
```

The domain context prevents the agent from making naive assumptions about your business logic.

## Task Prompt Structure

### The Five-Part Prompt

Every task prompt should include these sections:

```
1. CONTEXT       — What branch, what state, what happened before
2. SCOPE         — Exactly which files to modify (and which NOT to)
3. PATTERN       — The exact code change, with before/after examples
4. VERIFICATION  — How to check the work
5. OUTPUT        — What to report in summary.md
```

### Pattern: Batch Modification

For tasks that apply the same change to many files:

```
[CONTEXT]
Add the `@audit_log` decorator to all service classes in `src/services/`.
We're on the `feat/add-audit-logging` branch.

First, verify you're on `feat/add-audit-logging`.

[SCOPE — explicit file listing]
## Files to modify (~20 files)

All .py files in `src/services/` EXCEPT:
- `__init__.py`
- `base_service.py` (already has it)

To find all target files:
```bash
ls src/services/*.py | grep -v __init__ | grep -v base_service
```

[PATTERN — exact code change with before/after]
## What to change in each file

Before:
```python
class OrderService(BaseService):
    def create(self, data):
```

After:
```python
from app.decorators import audit_log

@audit_log
class OrderService(BaseService):
    def create(self, data):
```

1. Add the import at the top if not present: `from app.decorators import audit_log`
2. Add `@audit_log` on the line directly before the class definition

[VERIFICATION]
## Verify
```bash
# All service files should have the decorator
grep -rL '@audit_log' src/services/*.py | grep -v __init__ | grep -v base_service
```
Expected: 0 results (no files missing)

[OUTPUT]
In your summary.md: list every file modified, confirm import + decorator
added, total count, any files skipped and why.
```

### Pattern: Extraction

For tasks that parse source code into structured data:

```
[CONTEXT]
Extract all API endpoint definitions from the backend into a JSON reference file.

[SCOPE — what to read]
## Source files

1. `src/routes/*.ts` — each file defines route handlers
   Focus on: `router.get()`, `router.post()`, etc.

2. `src/middleware/auth.ts` — some routes have computed descriptions

[PATTERN — extraction rules]
## How to extract

For each route handler:
- **Route path**: The first argument (e.g., `/api/users/:id`)
- **HTTP method**: The router method name (get, post, put, delete)
- **Description**: The JSDoc comment above the handler, if present
- **Auth required**: `true` if `requireAuth` middleware is applied

[VERIFICATION — format and completeness]
## Output format

Write `scripts/api_reference.json`:
```json
{
  "endpoints": [
    {
      "path": "/api/users/:id",
      "method": "GET",
      "description": "Fetch a user by ID",
      "auth_required": true
    }
  ],
  "_metadata": { "total_count": 45, "source_files": 12 }
}
```

Target: 40+ endpoints.

[OUTPUT]
In your summary.md: total count, breakdown by HTTP method,
any ambiguous cases, and confirm the output file path.
```

### Pattern: Review / Canary

For tasks that validate a prior batch of changes:

```
[CONTEXT]
Review the `@audit_log` decorator changes from the previous batch.

[SCOPE — specific files to review]
## Review checklist

Read and verify these 5 specific files:

1. `src/services/order_service.py` — should have decorator + import
2. `src/services/payment_service.py` — should have decorator + import
3. `src/services/user_service.py` — should have decorator + import
4. `src/services/notification_service.py` — should have decorator + import
5. `src/services/base_service.py` — should NOT have decorator (excluded)

[PATTERN — what to check]
## For each file, verify:
1. Import `from app.decorators import audit_log` exists
2. `@audit_log` is on the line directly before the class definition
3. No duplicate imports were added
4. No syntax errors were introduced

## Verify untouched files
`base_service.py` and `__init__.py` should be unchanged.

[ACTION]
## Fix any issues found
If any file is missing the decorator, has a wrong import, or has a
syntax error, fix it directly.

[OUTPUT]
In your summary.md: pass/fail per file, list any fixes applied,
confirm excluded files are clean.
```

### Pattern: Validate and Deliver

For tasks that run validation, commit with proof, and push:

```
[CONTEXT]
Run validation and push the branch with proof that all changes are correct.

Verify you're on `feat/add-audit-logging`.

[VALIDATION — run checks, capture output]
## Step 1: Run automated validation
```bash
python3 scripts/validate_decorators.py --json
```
Capture the FULL JSON output. If there are failures, FIX them first.

## Step 2: Run tests
```bash
python3 -m pytest tests/services/ -v 2>&1 | tail -20
```

[PROOF — embed in commit]
## Step 3: Commit with validation proof
```bash
git add -A
git commit -m "feat: add audit logging decorators to all services

Changes:
- Added @audit_log decorator to 20 service classes
- Added import to each file

Validation:
$(python3 scripts/validate_decorators.py --json 2>/dev/null)

Tests: all passing"
git push origin feat/add-audit-logging
```

[CLEANUP]
## Step 4: Return to main
```bash
git checkout main
```

[OUTPUT]
In your summary.md: validation results, test results, push confirmation.
```

### Pattern: Script Authoring

For tasks that write validation or tooling scripts:

```
[CONTEXT]
Write a validation script that checks the audit logging migration.

[SPECIFICATION]
## Script location
Write to: `scripts/validate_decorators.py`

## Usage
```bash
python3 scripts/validate_decorators.py [--json]
```

## What it should check
1. Find all .py files in `src/services/` (excluding __init__.py, base_service.py)
2. For each file: verify `@audit_log` decorator is present on the class
3. For each file: verify the import exists
4. Verify excluded files do NOT have the decorator

## Output format (gate-compatible JSON to stdout when --json is passed)
```json
{
  "passed": true,
  "score": 1.0,
  "reasons": [],
  "summary": { "files_checked": 20, "decorated": 20, "issues": 0 }
}
```
Without --json, print a human-readable summary.

[CONSTRAINTS]
## Important
- Use only stdlib (no external dependencies)
- Use regex or AST parsing — do NOT import application modules
- Make it runnable from the repo root
- Add `#!/usr/bin/env python3` shebang
- Exit code 0 when all checks pass, 1 otherwise

[VERIFICATION]
## Test it
```bash
python3 scripts/validate_decorators.py
python3 scripts/validate_decorators.py --json
```

[OUTPUT]
In your summary.md: script path, what it validates, and baseline results.
```

## Scoping Tactics

### Explicit Inclusion

List the files or patterns the task should modify:

```
These files need the migration applied:
- src/services/order_service.py
- src/services/payment_service.py
- src/services/user_service.py
- src/services/inventory_service.py
...
```

### Explicit Exclusion

Tell the agent what NOT to touch:

```
## DO NOT modify
- __init__.py files
- base_service.py (already migrated)
- test files in tests/ (separate task)
- Files in src/services/deprecated/ (being removed)
```

### Glob-Based Discovery

For formulaic batches, use shell commands to find targets:

```
To find all files that need updating:
```bash
find src/services -name "*.py" -not -name "__init__.py" -not -name "base_*"
```
```

## Branch Safety

Always start tasks on a specific branch with a verification:

```
First, verify you're on `feat/add-audit-logging`.
If not, run `git checkout feat/add-audit-logging`.
```

Always end branch-specific tasks with a return:

```
## Final step
```bash
git checkout main
```
```

## Summary.md Guidance

Always tell the agent exactly what to report:

```
In your summary.md: list every file modified, every file skipped
with the reason, total counts, and any issues encountered.
```

The summary feeds into downstream tasks via `context_from`, so it must contain the information those tasks need. Think of it as the handoff document to the next agent in the pipeline.
