# Intent Writing

Write intent for the agent that will execute the graph, not for a human reading the graph file.

## Graph Intent

Graph intent is injected into every executable node. Keep it globally true and behavior-bearing:

- product, workflow, or operator thesis
- target users, decision need, or review need when relevant
- global acceptance criteria every node should preserve
- global `Do not ...` constraints
- quality bar, including simplicity and no AI slop when relevant

Do not describe graph topology, managed pattern internals, or implementation order unless that is a true global constraint.

No AI slop means: do not introduce broad generic abstractions, unreviewable rewrites, placeholder tests, dead code, invented architecture, generic copy, or code that ignores existing repo patterns.

For product or UI graphs, include the target workflow, user vocabulary, existing design patterns, and simple intuitive UX expectations. This helps every node preserve the product shape without hard-coding a single customer or pilot.

## Node Intent

Node intent is the controlling objective for that node. It should state:

- the outcome the node owns
- the evidence or artifact the node must leave behind
- boundaries that keep the node from solving adjacent work

Use acceptance criteria for positive success requirements. Use constraints only for prohibitions and start each constraint with `Do not`.

## Research Intent

Research nodes should name the decision they unblock, the evidence authority, and uncertainty to preserve. If web research is needed, say so in the goal or acceptance criteria. If repository conventions are primary authority, say that too.

Good research intent produces downstream-ready recommendations, accepted/rejected tradeoffs, and explicit constraints. Weak research intent produces generic background reading.

## Work Intent

Work nodes should name what must be delivered, how validation evidence should be reported, and what must remain unchanged. For code work, include convention fit, reviewability, validation evidence, and no AI slop in acceptance criteria or rubrics when those qualities matter.
