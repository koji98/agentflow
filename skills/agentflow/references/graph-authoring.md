# Graph Authoring

Author graphs as supervised execution contracts. A good graph states what the team wants, what is in scope, what authority the runtime has, what context enters each node, what artifacts must come back, and what evidence proves the work.

## Authoring Checklist

- Add `intent.goal`, `intent.acceptance_criteria`, and `intent.constraints`.
- Add `repos`, `profiles`, and `defaults.launch_profile` explicitly.
- Use `defaults.workspace_backend: "worktree"` for code-writing work unless the operator intentionally wants in-place execution.
- In GitHub repos, choose a rollout strategy before node layout. Prefer small PRs, `establish_base -> parallel_prs`, or `cascading_prs` over one large PR. See `github-rollout.md`.
- Keep substantial agent nodes outcome-sized. Give each one high-signal `context` and named `artifacts`.
- Give every executable node (`agent`, `exec`, `check`, `checkpoint`) a meaningful `goal`, non-empty `acceptance_criteria`, and relevant `constraints`. Deterministic nodes need intent too so the supervisor can diagnose whether a failure is local or upstream.
- Use deterministic `check` nodes for hard facts that should gate control flow or delivery evidence.
- Set `supervision.max_total_interventions` to match task risk. Add `supervision.profile` only when supervisor work should use a dedicated profile instead of the failed node's profile.
- A graph is not complete until required validation passes. Resolve plugins when needed, run `validate`, then run `--review`, `--run-ready`, and `--show-compiled`.

## Agent Mental Model

Treat each agent node like a capable terminal-native engineer with a bounded contract, not like a function that needs every operation wrapped. The graph should provide intent, authority, context, artifacts, and evidence requirements. Inside that boundary, let the agent inspect the repo, discover available commands, read help output, write small helper scripts when appropriate, run validation, and repair its own approach.

Prefer thin, native interfaces:

- Existing repo scripts, package-manager scripts, test runners, linters, build tools, CLIs, and protocol tools are usually enough.
- Add a plugin tool when the workflow needs credential isolation, reusable team capability, stable JSON I/O, external service policy, or a durable tool contract.
- Add a managed pattern when the whole lifecycle is standard, not when a single CLI command would do.
- Avoid helper abstractions that hide native tool behavior and force the model to work around your wrapper.

Do not hand-hold exact implementation steps unless the user, architecture, safety boundary, or acceptance criteria require them. Good node contracts say what must be true and what evidence must come back; they do not usually need to name every file to edit or every command the agent may try.

## Shape Selector

- One accountable agent plus a check: focused implementation, audit, or report where the node can inspect, execute, validate, and repair inside its own boundary.
- `sequence`: later work depends on a durable upstream decision, evidence packet, implementation, or validation result.
- `parallel`: branches are independent and each branch publishes an artifact consumed by a later synthesis/refinement node.
- `repeat`: the graph has a bounded repair/evaluation loop and a descendant `check` or `checkpoint` can decide when to stop. When a later iteration needs output from an earlier one, use explicit artifact selectors such as `iteration: "previous"` or `iteration: "latest_failed"`; otherwise bare refs resolve by the normal latest-attempt rules. Agentflow also injects `repeat_history` into repeat attempts after the first iteration.
- `checkpoint`: the graph needs planned human product, scope, authority, or release judgment. Do not use checkpoints for ordinary runtime failure recovery.
- GitHub rollout pattern: the workflow should produce small reviewable PRs, parallel PR packets from a base, or cascading PR packets. See `github-rollout.md`.
- Common authored pattern: the workflow matches a reusable primitive composition such as design -> implement -> reviewers -> refine. See `common-patterns.md`.
- Managed pattern: the lifecycle matches a compiler-supported `pattern_*` node. See `managed-workflows.md`.
- Plugin-backed workflow: a team capability or external service should be exposed as a plugin CLI tool. Use `agentflow-plugins`.

## Authoring Loop

1. Capture graph intent and scope boundaries first.
2. For GitHub repos, choose rollout strategy before primitive shape.
3. Choose primitive shape, common authored pattern, or managed pattern.
4. Define authority: repos, profiles, workspace backend, sandbox, tools, credentials, and limits.
5. Inventory relevant local CLIs and repo scripts before inventing plugin wrappers.
6. Define node contracts and artifact handoffs.
7. Add checks after the work they validate.
8. Add supervision budgets.
9. Validate and inspect the compiled graph. Do not call the graph complete until the validation commands in `cli-and-validation.md` pass.

## Node Sizing

Prefer nodes like:

- "Implement checkout timeout handling and publish a reviewable change summary."
- "Review the change package for correctness, tests, and maintainability."
- "Design the runtime delivery package contract."

Avoid graphs where every small edit is a separate agent node. Strong harnesses should inspect, plan, implement, run targeted checks, and repair inside the node's accountable boundary.

Split a node when:

- another branch or later node needs a durable artifact from it;
- the work crosses repo, profile, sandbox, credential, or tool authority boundaries;
- independent reviewers should inspect the same completed change across different axes;
- a planned human checkpoint must choose between alternatives.

## Acceptance Criteria

Acceptance criteria are runtime-enforced for passing `agent` attempts. Write criteria as observable outcomes:

- Good: "The focused regression command passes and the handoff cites it."
- Good: "The change does not modify public payment provider configuration."
- Weak: "Do a good job."
- Weak: "Iterate until done."

Do not repeat boilerplate iteration guidance in `constraints`. The runtime injects a working loop into standard agent prompts, and outcome verification rejects early-bailing.

## Context And Prompt Quality

Context is prompt design. Include enough signal for the node to act, but avoid making the prompt a file dump.

- Prefer task text, relevant docs, narrow source areas, and upstream artifacts over broad workspace globs.
- Use exact files when the user named them or when the graph intentionally constrains scope; otherwise give enough local context for the agent to discover the right files.
- Use `workspace_glob` only when the file set is intentionally bounded.
- Avoid `**/*` and broad terms that can include dependencies, generated output, `.agentflow`, build artifacts, vendored code, or test fixtures unrelated to the task.
- Put version-specific docs, issue text, reproduction notes, and prior decisions into named context entries.
- Pass compact synthesis artifacts downstream instead of large raw research packets unless exact excerpts are needed.
- Run `agentflow validate --graph <path> --run-ready` to see real token cost, glob samples, largest files, ignored roots, and projected context failures.

Use artifacts for durable handoffs that later nodes or reviewers need:

```json
{
  "type": "agent",
  "id": "implement_slice",
  "goal": "Implement the scoped change and leave a reviewable handoff.",
  "acceptance_criteria": [
    "The changed files are summarized.",
    "Validation and residual risks are named."
  ],
  "context": [
    { "name": "task", "from": "text", "text": "Keep the change focused." },
    { "name": "target_files", "from": "workspace_glob", "path": "src/runtime/**/*.ts" }
  ],
  "artifacts": {
    "change_summary": {
      "from": "output_dir",
      "path": "change-summary.md",
      "description": "Implementation summary for downstream review."
    }
  }
}
```

## Checks

Use deterministic checks for hard facts:

```json
{
  "type": "check",
  "id": "test",
  "goal": "Run the focused runtime test file.",
  "acceptance_criteria": [
    "The test command exits successfully.",
    "The output can serve as deterministic validation evidence."
  ],
  "check_kind": "deterministic",
  "command": "npm",
  "args": ["test", "--", "tests/runtime/engine.test.ts"]
}
```

Use AI checks only when another node depends on semantic judgment or a deterministic command is genuinely unavailable. Do not stack an AI `check` after every agent node to re-evaluate the same acceptance criteria.

## Tool Authority

Agents can use ordinary device and repo CLIs through their shell. Graph authors should understand what is already available before creating plugin tools or managed wrappers.

Inventory useful tools with commands such as:

```bash
command -v rg git gh node npm pnpm yarn python uv pytest cargo go docker jq
npm run
pnpm run
python -m pytest --help
gh --help
```

Use ordinary CLI access when:

- the tool is already installed on the target device or repo;
- the agent can discover usage through `--help`, package scripts, or local docs;
- secrets are not exposed directly to the model;
- output can be captured in an artifact or check result.

Use plugin tools when the graph needs:

- credential scoping through Agentflow auth;
- stable JSON output or a reusable team capability;
- policy boundaries for external services or mutations;
- a tool contract shared across graphs.

Plugin tools should still match the node's job.

- Use read/context tools for discovery nodes.
- Use verification/reporting tools for evaluator nodes.
- Use mutation/write tools only on write-capable agents.
- Put high-impact limits in `constraints` before granting credential-backed, external, or mutating tools.
- Use plugin-declared `credentials` plus `agentflow auth` for tools that need auth.

## Anti-Patterns

- Splitting one coherent implementation into many tiny edit nodes.
- Omitting node acceptance criteria and relying on prose goals.
- Putting artifact write mechanics only in the goal instead of declaring `artifacts`.
- Over-prescribing exact edit steps when a capable agent should inspect and choose the implementation path.
- Passing huge context because "the agent might need it."
- Using `parallel` branches that do not publish artifacts.
- Adding AI checks after every agent node as a substitute for good acceptance criteria.
- Wrapping mature local CLIs in custom helpers that remove useful flags, help text, or error messages.
- Creating plugin tools before checking whether existing repo/device commands are enough.
- Modeling supervisor safety pauses as planned workflow steps.
- Depending on generated internal ids from managed pattern expansion.

## Final Review

At terminal state, start with the human entrypoints named by `delivery/manifest.json`: `delivery/reviewer-guide.md`, `delivery/task-brief.md`, `delivery/implementation-summary.md`, `delivery/risk-notes.md`, `delivery/follow-up-items.md`, and `delivery/run-map.md`. Use declared artifacts and evidence files next. Read raw runtime files such as `events.jsonl`, `state.json`, `interventions.jsonl`, and node attempt directories only for resume/debugging or low-level audit.
