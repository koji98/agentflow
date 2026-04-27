# Agentflow Plan

## Ideal End State

Agentflow becomes a supervised execution runtime for long-running coding work.

It lets a team hand off a feature, refactor, migration, or review-sized task to powerful external agent harnesses and team-specific tools, while preserving human understanding, control, and trust throughout the run.

The core promise is simple:

- humans define the intended work in a readable DAG
- agents do large, meaningful chunks of execution
- a supervisor keeps the run healthy, aligned, and recoverable
- the system returns not just code, but a trustworthy delivery package

Agentflow should feel like the reliability, traceability, and comprehension layer on top of Codex-, Cursor-, and team-tool-driven execution.

## Product Thesis

Agentflow is not valuable because it can run many nodes.

Agentflow is valuable because it can delegate large engineering tasks without losing:

- intent
- scope control
- evidence
- reviewability
- maintainability

The ideal end state is a system where teams can trust long-running agent work because the runtime makes that work understandable and recoverable.

## What Agentflow Is

Agentflow is:

- a graph-native system where the authored DAG remains the human-facing source of intent
- a compiled runtime that executes primitive nodes with durable state, artifacts, and event logs
- a supervision layer that operates behind the scenes to prevent avoidable failures and recover safely from bounded ones
- a plugin-driven integration surface for team tools, internal CLIs, evaluators, and workflow-specific capabilities
- a delivery system that produces code plus the artifacts required for humans to review and maintain that code

## What Agentflow Is Not

Agentflow is not:

- a free-form planner that silently rewrites the user’s intent
- a generic multi-agent choreography framework optimized for agent-to-agent theater
- a graph of tiny micromanaged steps that fight the natural workflow of strong coding agents
- a diff generator with some logs attached

The authored DAG should remain readable and stable. The supervisor should improve execution, not replace the plan.

## Human Contract

Humans should define:

- the goal
- the major accountable phases or outcomes
- the constraints
- the acceptance criteria
- the approval boundaries

Humans should not need to define every micro-step.

The graph should represent major responsibility boundaries, not every small action an agent might take internally.

In the ideal end state, nodes are fewer and larger. Each node owns a meaningful outcome.

## Execution Model

The ideal execution model has four layers:

1. Authored intent
2. Compiled runtime contract
3. Supervised execution
4. Delivery package

### Authored intent

The authored DAG is the source of truth for what should happen.

It captures:

- major outcomes
- dependencies
- required checks
- review points
- allowed tools and repos

### Compiled runtime contract

The runtime compiles authored graphs into executable primitive nodes and explicit control-flow semantics.

This contract remains inspectable before launch and durable after launch.

### Supervised execution

The runtime supervises execution continuously.

The supervisor:

- classifies failures
- repairs bounded environment and artifact issues
- rebuilds context when needed
- retries nodes with guidance when policy allows
- detects drift from scope or acceptance criteria
- enforces action, time, and intervention budgets
- pauses for human input when policy or ambiguity thresholds are crossed

The supervisor does not silently change the user’s objective or widen authority.

### Delivery package

Every serious run should produce a package that lets a human understand what happened quickly and confidently.

## Supervisor Model

The supervisor is a runtime governor, not a creative manager.

Its job is to keep execution on track, not to invent a new plan.

It may:

- repair missing artifacts
- retry failed nodes with guidance
- inject typed diagnostic or repair steps where policy allows
- request additional evaluation
- stop unhealthy loops
- pause for a human with evidence

It may not:

- silently redefine the task
- silently expand scope
- silently widen sandbox, network, or secret permissions
- bypass required checks or approval gates
- hide interventions from the run trace

All interventions must be durable, inspectable, and attributable.

## Node Philosophy

Nodes should become larger and more outcome-oriented.

Agentflow should prefer:

- fewer nodes
- stronger node contracts
- richer artifacts
- better final reviewability

Agent nodes should be allowed to inspect, plan locally, implement, run targeted validation, and repair within their assigned outcome boundary.

The graph should not force unnatural prompt handoffs unless the boundary is meaningful.

A good node is not “edit file A.”

A good node is “implement this accountable slice and leave enough evidence behind for a human or downstream evaluator to trust it.”

## Evaluation Model

Evaluators are sensors, not the whole governance model.

The ideal system uses both:

- deterministic evaluation for hard facts
- semantic evaluation for alignment, architecture fit, and risk

Evaluators should feed the supervisor with structured evidence.

They should help answer:

- did the code work
- did it stay in scope
- did it match architectural expectations
- did it create hidden risk
- is the output understandable enough for a team to review

## Comprehension Debt

Avoiding comprehension debt is a first-class product objective.

Agentflow should not treat “tests passed” as the end of the job.

It should also preserve:

- why the change exists
- what was changed
- which decisions were made
- where the risky parts are
- what reviewers should look at first
- what follow-up work remains

The ideal end state is that large agent-generated changes are easier to understand than a typical rushed human-generated feature branch.

## Delivery Artifacts

For substantial work, the ideal output includes:

- feature or task brief
- implementation summary
- grouped change map
- decision log
- evaluation ledger
- reviewer guide
- risk notes
- follow-up items
- operational trace of retries, repairs, and interventions

The system should return a reviewable package, not just a diff and raw logs.

## Tool And Plugin Model

Teams should be able to plug in their own tools easily.

Agentflow should treat plugin-distributed capabilities as first-class runtime building blocks.

Team tools should be easy to expose for:

- context gathering
- verification
- mutation
- reporting

The runtime should understand the difference between a read-only context tool and a high-impact mutation tool, and supervision policy should reflect that difference.

## Harness Model

External coding agents remain adapters, not hidden control planes.

Codex CLI, Cursor CLI, and future CLIs are execution backends that Agentflow supervises through a stable adapter contract.

Continuity should come from durable state and artifacts, not from assuming a persistent chat session exists inside the harness.

## Ideal Operator Experience

In the ideal end state, a team can:

- author a readable graph that expresses major outcomes
- attach team tools through plugins
- launch long-running work confidently
- inspect exactly what happened while the run is in progress
- see when the supervisor intervened and why
- resume failed or interrupted runs safely
- review a concise, high-signal delivery package at the end

The system should make long-running agent work feel governable rather than opaque.

## Final Direction

Agentflow should become the trusted runtime for delegating large engineering tasks to agent harnesses without losing understanding.

The authored DAG stays.

The nodes get fewer and more meaningful.

The supervisor becomes real.

The plugin surface becomes team-powerful.

The output becomes a delivery package, not just code.

That is the ideal end state.
