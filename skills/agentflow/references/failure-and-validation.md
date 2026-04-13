# Failure And Validation Semantics

Use this reference when a graph contains `exec`, `check`, `checkpoint`, or `repeat`.

## Core rule

Choose node kinds based on control-flow semantics, not just on what tool happens to run.

## Primitive semantics

- `agent`
  Use for model-driven coding, synthesis, planning, or review work.
- `exec`
  Use to run a concrete command and capture its logs, result, and declared outputs.
- deterministic `check`
  Use when pass or fail should immediately decide whether the graph continues.
- AI `check`
  Use when the gate is semantic or judgment-based rather than command-based.
- `checkpoint`
  Use only when an operator intentionally needs to review and decide how the graph proceeds.

## Hard versus soft verification

Use a deterministic `check` when failure should stop the graph:

- fixture reset must succeed before anything meaningful can continue
- a targeted test must pass before merge-ready completion
- a release artifact must exist before deployment handoff

Use an `exec` followed by a review node when failure should be documented rather than terminate the run:

- you want to run Playwright or a long integration test and capture logs either way
- you want an agent to inspect failures and summarize likely root causes
- you want a graph to keep collecting evidence even if one command fails

Good soft-verifier shape:

1. `exec` runs the command and writes status/log artifacts
2. `agent` consumes those artifacts and explains success, failure, or cleanup needed

## `repeat` discipline

Use `repeat` only when:

- there is a bounded implementation, revision, or repair loop
- a descendant `check` or `checkpoint` decides whether to continue
- the loop has a coherent owner and a clear stopping condition

Avoid `repeat` when the graph really wants:

- a one-time retry inside the command itself
- a straight `sequence`
- a managed pattern that already includes bounded revision behavior

## Validation placement

Put validation after the boundary whose quality actually matters:

- after a mutation phase
- after a synthesis phase that produces a handoff artifact
- after a setup phase that must succeed for the rest of the graph to be meaningful

Do not add validation everywhere by reflex. Extra validation nodes add noise, runtime, and more failure surfaces.

## Common mistakes

- using deterministic `check` for a command whose failure should have been inspected later
- using `exec` for a true gate and then forgetting to make downstream control flow depend on it
- inserting `checkpoint` where no operator review is actually wanted
- using `repeat` without a strong convergence signal
- running destructive or environment-sensitive commands without deciding whether their failure should terminate the graph
