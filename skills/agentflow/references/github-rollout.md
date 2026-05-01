# GitHub Rollout Strategy

When authoring graphs for GitHub repositories, consider review and merge strategy before node layout. Very large PRs are usually harder to review, riskier to merge, and harder to recover. Unless the user asks for one large PR, prefer small reviewable PRs or an explicit stacked rollout.

## Default Decision

- Small scoped change: one implementation node and one PR-ready handoff is fine.
- Shared foundation plus independent work: use `establish_base -> parallel_prs`.
- Dependent changes that build on each other: use `cascading_prs`.
- Unclear architecture: design first, then choose parallel or cascading rollout.

## Pattern: Establish Base -> Parallel PRs

Use when several independent PRs need the same foundation.

- Shape: `sequence(establish_base -> parallel(pr_slice_a, pr_slice_b, pr_slice_c) -> integration_review)`.
- Base node: creates shared scaffolding, interfaces, tests, migration hooks, or docs that unblock every branch.
- Parallel nodes: each owns a disjoint feature slice or package area and publishes a PR packet.
- Integration review: checks conflicts, consistency, naming, test coverage, and merge order.
- Artifacts: `base_summary`, one `pr_packet` per branch, `integration_review`.
- Avoid when branches mutate the same files heavily or need strict sequencing.

Authoring notes:

- Make branch ownership explicit in node `intent.constraints`.
- Require each branch to publish changed files, validation, risks, and intended base/head branch.
- Use deterministic checks per branch when possible.
- Include a final node that explains merge order and cross-PR risk.

## Pattern: Cascading PRs

Use when changes must land in sequence.

- Shape: `sequence(pr_1_base -> pr_2_on_pr_1 -> pr_3_on_pr_2 -> stack_review)`.
- Each node consumes the previous PR packet and treats it as its base.
- Good for migrations, API evolution, staged refactors, and dependency-changing work.
- Artifacts: one `pr_packet` per stack level, plus `stack_state` and `stack_review`.
- Avoid when slices can be reviewed independently from a common base.

Authoring notes:

- Each node should state its parent branch or upstream PR artifact.
- Each PR packet should include base branch, head branch, changed files, focused validation, risks, and reviewer notes.
- Add a stack review node to validate descendants, rebase needs, CI state, and merge sequence.
- Keep each stack level useful on its own; avoid a chain where only the final PR is meaningful.

## Graph Guidance

- Prefer branch/slice artifacts over hidden assumptions about git state.
- Use `workspace_backend: "worktree"` for code-writing PR workflows unless in-place execution is intentional.
- Use `gh` directly when installed and appropriate; use plugin tools only when credential scoping, stable JSON, policy, or reuse requires them.
- Do not over-prescribe exact edits. Give each PR node ownership, acceptance criteria, context, artifacts, and validation expectations.
- If external PR creation/push is out of scope, have nodes produce PR packets instead of mutating remotes.

## Common PR Packet Artifact

Each PR-producing node should publish a handoff with:

- objective and scope;
- intended base and head branch;
- changed files;
- validation commands and results;
- risks and follow-up items;
- reviewer focus;
- dependency on earlier PRs, if any.

## Anti-Patterns

- One huge implementation node for many unrelated review areas.
- Parallel PR nodes that edit the same files without a base coordination node.
- Cascading PRs where each level cannot be reviewed independently.
- Letting downstream nodes infer branch state from raw git logs instead of consuming explicit artifacts.
