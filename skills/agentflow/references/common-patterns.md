# Common Authored Patterns

Common authored patterns are graph compositions you write directly with primitive nodes. They are different from managed patterns, which are compiler-supported `pattern_*` nodes documented in `managed-workflows.md`.

Use these patterns when they fit the work better than a single node, but keep nodes outcome-sized. Do not split every small edit into a separate node.

## Pattern Cards

### Design -> Implement -> Validate

Use when the task is scoped but needs a design handoff before mutation.

- Shape: `sequence(design agent -> implement agent -> deterministic check)`.
- Key artifacts: `design_brief`, `change_summary`.
- Checks: one focused deterministic command after implementation.
- Avoid when: design is already settled; use one implementation agent plus a check.

### Design -> Implement -> Validate -> Parallel Reviewers -> Refine -> Validate

Use when the change is important enough to review across independent axes before final handoff.

- Shape: `sequence(design -> implement -> check -> parallel(review_correctness, review_simplicity, review_tests, review_security) -> refine -> final_check)`.
- Key artifacts: design brief, implementation summary, one artifact per reviewer, final handoff.
- Checks: run a focused check before review so reviewers inspect a concrete change; rerun after refinement.
- Reviewer axes: correctness, maintainability, test/regression risk, security/scope risk.
- Avoid when: the task is small and parallel review overhead will add noise.

### Research -> Synthesize -> Implement

Use when local patterns, dependency behavior, or product context are unclear.

- Shape: `sequence(research agent -> synthesis/design agent -> implement agent -> check)`.
- Key artifacts: source-backed research notes, decision summary, change summary.
- Context: pass only the synthesized artifact downstream unless implementation needs exact source excerpts.
- Avoid when: the implementation agent can discover the needed local context inside its node boundary.

### Diagnostic First -> Fix -> Regression Check

Use when the bug report is ambiguous or reproduction is not yet proven.

- Shape: `sequence(diagnostic exec/agent -> implement fix -> deterministic regression check)`.
- Key artifacts: reproduction notes, change summary.
- Checks: start with the smallest command that proves the failure, then reuse it as the regression command.
- Avoid when: the failure is already pinned by a reliable test.

### Parallel Investigation -> Synthesis -> Decision

Use when multiple plausible explanations should be explored independently before choosing direction.

- Shape: `sequence(parallel(investigation agents) -> synthesis agent -> optional checkpoint or implementation)`.
- Key artifacts: one investigation report per branch, final decision record.
- Checks: not required until a branch chooses an executable change.
- Avoid when: investigations share state heavily or would duplicate the same local search.

### Implementation Slice Loop

Use when a larger task can be completed in bounded slices with repeated validation.

- Shape: `repeat(sequence(implement slice -> check -> evaluate/record), until check or checkpoint)`.
- Key artifacts: per-slice summary and cumulative ledger.
- Checks: use deterministic check or checkpoint as the repeat `until` node.
- Avoid when: the loop exit cannot be expressed as a check/checkpoint or the slice boundary is vague.

### No-Edit Audit

Use when the goal is inspection, risk review, architecture review, or readiness assessment.

- Shape: one read-only agent, optionally followed by a semantic or deterministic check.
- Key artifacts: findings report, risk notes, evidence ledger.
- Authority: read-only profile and explicit constraint forbidding workspace edits.
- Avoid when: the user expects implementation.

### Tool-Guided Workflow

Use when a plugin tool or local CLI should provide evidence before the agent acts.

- Shape: `sequence(discovery agent/exec with tool -> implementation agent -> check)`.
- Key artifacts: tool evidence packet, change summary.
- Context: implementation consumes the tool evidence artifact, not hidden terminal output.
- Avoid when: the tool is only a convenience the implementation node can call directly.

### Device Tool Inventory -> Plan -> Execute

Use when success depends on CLIs available on the operator's device or in the repo.

- Shape: `sequence(tool inventory exec/agent -> planning agent -> implementation agent -> check)`.
- Key artifacts: tool inventory, chosen command plan, change summary.
- Inventory: package scripts, `command -v`, `--help`, local docs, and tool versions.
- Avoid when: the implementation node can cheaply discover the tools itself and no later node needs the inventory artifact.

### Native CLI First

Use when the repo already exposes good scripts or a mature CLI exists for the job.

- Shape: one agent with explicit authority and a deterministic check.
- Key artifacts: command evidence and handoff.
- Principle: let the agent use the native CLI directly; add a wrapper only when it provides credential isolation, stable I/O, reuse, or auditability.
- Avoid when: the command requires secrets, external mutations, or policy boundaries that should be mediated by a plugin tool.

### Human Decision Gate

Use when the graph needs planned product, scope, or authority judgment.

- Shape: `repeat(sequence(research/design -> checkpoint -> optional implementation), until checkpoint)`.
- Key artifacts: options brief and selected direction.
- Use checkpoint for planned human decisions; reserve supervisor `pause_for_human` for authority boundaries the runtime must not infer.
- Avoid when: the supervisor can recover with machine evidence or runtime overlay.

### Release Or Delivery Gate

Use when final release readiness needs explicit evidence.

- Shape: `sequence(gather evidence -> deterministic checks -> review risk -> final handoff)`.
- Key artifacts: validation evidence, risk notes, release handoff.
- Checks: include proof URLs or external evidence fields when stable external systems are part of acceptance.
- Avoid when: ordinary delivery package output is enough.

### Establish Base -> Parallel PRs

Use in GitHub repos when multiple independent PRs need shared groundwork.

- Shape: `sequence(establish_base -> parallel(pr_slice_a, pr_slice_b, pr_slice_c) -> integration_review)`.
- Key artifacts: base summary, one PR packet per branch, integration review.
- Checks: branch-level focused checks plus a final consistency/integration review.
- Avoid when: branch slices mutate the same files heavily or must land in strict order.

### Cascading PRs

Use in GitHub repos when each change depends on the previous one.

- Shape: `sequence(pr_1_base -> pr_2_on_pr_1 -> pr_3_on_pr_2 -> stack_review)`.
- Key artifacts: one PR packet per stack level, stack state, stack review.
- Checks: focused validation at each level and a final stack/rebase/merge-order review.
- Avoid when: slices can be reviewed independently from a common base.

For more detail, read `github-rollout.md`.

## Choosing Quickly

- If one accountable agent can inspect, implement, validate, and repair within the node boundary, use one agent plus a check.
- If later work needs a durable decision or evidence packet, add an upstream artifact-producing node.
- If branches are independent and downstream work depends on all of them, use `parallel` with named artifacts.
- If work should repeat until a known condition is true, use `repeat` with a descendant `check` or `checkpoint`.
- If device-specific commands matter, decide whether a tool inventory artifact is worth the extra node.
- If the repo is on GitHub and the change is large, choose one focused PR, `establish_base -> parallel_prs`, or `cascading_prs` before graphing implementation nodes.
- If the pattern is already a compiler-supported `pattern_*` node, consider `managed-workflows.md`.
