# Grill Questions

Ask only questions that change graph shape, authority, evidence, or assurance.

## Bounded Grill-Me Protocol

- Run at most 3 rounds.
- Ask at most 10 questions per round.
- Do not ask every question in this file by rote. Pick the questions that would change the graph contract, authority model, evidence surface, or assurance profile.
- After each round, summarize the answers into decided facts, remaining uncertainty, and the next highest-value question area.
- Stop early when the workflow brief is coherent enough for authoring, even if fewer than 3 rounds have been used.
- If the user declines more questions, produce the best brief possible and mark unresolved items as open questions.

## Outcome

- What should be true at the end that is not true now?
- Is the desired output a code change, PR stack, decision package, eval result, plugin, report, or run learning?
- What would make the run obviously unsuccessful?

## Scope And Non-Goals

- Which repos, systems, docs, or services are in scope?
- What should the agents not touch?
- Are there compatibility, release, or product boundaries?

## Product And User Context

- Who will use or review the result?
- What workflow, decision, or pain point should the result improve?
- What vocabulary, UX expectations, or existing product patterns should agents preserve?
- What future direction matters enough to shape this slice, even if it is not in scope yet?

## Authority

- What can agents mutate?
- Which tools or credentials are allowed?
- Which external side effects need planned approval, and which authority gaps should fail until the graph/operator supplies credentials or scope?

## Autonomy

- Where should agents inspect and choose the implementation path?
- Which details are hard constraints rather than suggestions?
- Are named files or commands requirements, or just examples?

## Quality Bar

- What would count as AI slop in this workspace?
- Which architecture, style, design, security, or privacy conventions must be preserved?
- What makes the output human-reviewable and incrementally shippable?

## Evidence

- What existing commands prove hard facts?
- What semantic quality needs a rubric or review?
- What durable artifacts should downstream nodes or humans consume?

## Risk And Assurance

- Is speed, balanced confidence, or high assurance preferred?
- What is the cost of a wrong implementation?
- Would a fresh-context review materially reduce risk?
