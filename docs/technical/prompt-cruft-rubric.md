# Prompt Cruft Rubric

Prompt text must be behavior-bearing. Reject wording that sounds helpful but cannot be traced to an Agentflow contract, observed failure mode, or eval.

## Required Checks

A prompt change must satisfy every check:

- Names the failure mode it prevents.
- Maps to a graph, runtime, managed-pattern, supervisor, verifier, tool, context, artifact, or eval contract Agentflow owns.
- Has deterministic, trajectory, semantic, or transcript-review coverage.
- Preserves one active contract shape.
- Does not make agents inspect irrelevant surfaces by default.
- Does not teach implementation details that should be owned by `af`, validation, managed compilation, or supervisor recovery.
- Does not hide requirements that belong in graph authoring, artifact descriptions, or eval fixtures.
- Is shorter and more specific than the failure mode warrants.

Alpha rule: do not add backwards-compatible prompt layers, prompt aliases, legacy prompt packs, or tolerated stale schemas. Replace obsolete prompt text directly.

## Accept

- `If an artifact description requires literal labels, copy those labels exactly into the artifact body.`
- `Use af artifact write <name> with stdin content for declared artifacts.`
- `If the same validation tactic fails twice with the same symptom, change strategy or block the active milestone with concrete evidence.`
- `Record validation only after verifying the claim, and attach it to the relevant milestone.`

## Reject

- `Make the report excellent, comprehensive, professional, clear, and robust.`
- `Think deeply and be careful.`
- `Use any available command, helper, API, graph interface, or runtime tool to finish.`
- `Never give up.`
- `You are a world-class expert...`
- `Use both the old and new artifact forms so existing consumers keep working.`

## Review Questions

Before merging prompt text, answer:

- What failure did we observe?
- Why is prompt text the right layer instead of graph validation, `af`, supervisor recovery, managed compilation, or a grader?
- Which test or eval will fail if this text regresses?
- What section owns this instruction?
- What existing sentence can be deleted or narrowed?
