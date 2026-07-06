# Loop Model

Agentflow is a supervised loop runtime. The graph is the contract, but the runtime value comes from the loops around each substantial unit of work: an agent acts, records evidence, gets checked, and either advances, retries with concrete feedback, pauses at an authority boundary, or fails with reviewable evidence.

This page explains the product model. For launch and inspection commands, see `operations.md`. For implementation details, see `../technical/runtime-lifecycle.md`, `../technical/runtime-tooling.md`, and `../technical/outcome-verification.md`.

## Contract To Evidence

An Agentflow run follows this shape:

1. Validate the authored graph and compile it into primitive runtime nodes.
2. Start each reachable node with explicit intent, authority, context pointers, tools, artifacts, and sandbox policy.
3. Require the worker to publish durable evidence instead of relying on final chat text.
4. Check the result mechanically and semantically.
5. Recover from failures only when the runtime can attach a material delta.
6. Write delivery evidence so a human can review the terminal run.

The graph is not a prompt transcript or hidden memory layer. Runtime state, context packets, milestones, artifacts, verifier verdicts, supervisor interventions, and delivery files are the durable record.

## Inner Worker Loop

Agent nodes receive the normal harness prompt plus the `af` runtime CLI. The intended worker loop is:

1. Run `af orient` to read the current node contract, workspace boundary, context pointers, artifact expectations, support tools, and retry state.
2. Add milestones for meaningful phases of work.
3. Log findings, decisions, and validation evidence against those milestones.
4. Publish declared artifacts with `af artifact write`.
5. Run `af complete check` before finishing so the runtime can verify mechanical readiness.

This keeps the worker focused on the node outcome while making progress, evidence, and completion state inspectable.

## Verifier Loop

Every passing `agent` attempt goes through outcome verification before the engine can mark it passed. The verifier is a fresh read-only harness invocation with no edit authority and no plugin tools. It judges the captured response, declared artifacts, milestone evidence, validation evidence, and workspace-change provenance against the graph and node intent.

If the completion packet is incomplete, the node routes to recovery without semantic verification. If the verifier rejects a mechanically ready attempt, the rejection becomes structured evidence for supervisor recovery.

## Supervisor Loop

The supervisor observes executable checkpoints at runtime boundaries. It is not a standing background agent. When a node fails or is rejected, Agentflow treats that node as the symptom, builds an upstream causal view, chooses a recovery target inside the existing authority contract, records a recovery plan, and retries only with a material delta.

Material deltas include evidence maps, repaired context, artifact repair, workspace cleanup, safe environment repair, changed validation strategy, or a better-supported recovery target. Repeating the same fingerprint, tactic, and boundary without a material delta is not progress.

Human pauses are reserved for trusted typed authority requests such as missing credentials, missing harness authentication, planned checkpoints, external side-effect approval, or explicit operator pause.

## Managed Loops

Managed patterns package common loop shapes while still compiling into normal Agentflow execution.

- `pattern_deep_work`: plan, execute, validate, grade criteria, write a scorecard, and retry until required criteria and threshold pass or the cycle budget is exhausted.
- `pattern_work_list`: discover and freeze a bounded ordered list, execute each item, verify item evidence, retry item-local failures, and publish stable work-list artifacts.
- `pattern_map_reduce`: discover and freeze a bounded independent item set, map the same item contract over each item with bounded concurrency, and publish stable aggregate evidence.
- `pattern_deep_research`: run research angles, synthesize evidence, and publish one graph-addressable research artifact.

Managed-loop feedback stays inside the pattern while the pattern can still make progress. When a managed boundary exhausts its allowed cycles, normal supervisor recovery gets one chance to recover if it can produce a real material delta.

## Eval Loop

`agentflow eval` is the outer confidence loop. It runs normal graphs against local scenario environments, compares variants, repeats trials, records trajectories, applies required criteria and quality criteria, supports deterministic simulation, and writes benchmark reports.

Use evals to answer questions such as:

- Did this graph or prompt pack improve pass rate?
- Did a supervisor change reduce blockers without hiding failures?
- Did a managed pattern preserve trajectory discipline?
- Did a plugin or tool contract remain usable across realistic scenarios?

Evals do not mutate the graph contract. They provide evidence for changing graphs, prompts, tools, plugins, docs, and tests intentionally.

## Boundary

Agentflow v1 runs explicit graph executions. It is not an always-on daemon, issue watcher, queue worker, autonomous PR factory, or remote development environment. Those systems can invoke Agentflow, but the Agentflow contract starts at graph validation and run launch, and ends with durable run artifacts, resume state, and delivery evidence.
