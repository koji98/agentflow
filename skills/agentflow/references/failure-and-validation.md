# Failure And Validation

Agentflow treats failures as evidence for supervision and delivery. Do not hide failures with ad hoc recovery outside the graph contract.

## Failure Classes

Supervisor classification includes:

- `environment`
- `workspace`
- `context`
- `artifact`
- `harness`
- `timeout`
- `deterministic_evaluation`
- `semantic_evaluation`
- `scope_drift`
- `policy_breach`
- `operator`
- `unknown`

## Hard Failures

These remain hard failures even when a verifier uses soft failure behavior:

- spawn errors
- timeouts
- cancellation
- invalid context
- missing required env files
- missing declared artifacts after allowed repair
- workspace cleanup failures
- delivery package creation failure

## Soft Verification

`on_failure: "continue"` records failed deterministic verification evidence while allowing control flow to proceed. Use it for evidence collection, not for required gates.

## Evaluation Lanes

- Graph `check` nodes are in-run sensors.
- Supervisor `semantic_evaluation` is an intervention selected by failure classification and bounded by the supervisor budget.
- Managed pattern evaluation is authored workflow structure that lowers into generated graph nodes.
- `agentflow eval` is offline product/workflow evaluation with file-backed suites.

## Human Gates

`checkpoint` is a planned human gate inside a repeat body. `pause_for_human` is a supervisor safety pause for runtime risk or failure conditions and resumes through structured human input.

## Repeat

`repeat.until.node` must target a descendant `check` or `checkpoint`. The until node decides whether the repeat scope exits or runs another iteration.

Use repeat context selectors for iterative repair evidence:

- `latest`
- `latest_passed`
- `latest_failed`
- `previous`
- positive integer ordinal

## Artifact Repair

When a required agent artifact is missing and policy allows repair, the supervisor can run a bounded repair intervention. The intervention includes graph intent, node task, constraints, acceptance criteria, and the missing artifact contract, then uses the node's same harness authority and sandbox boundary. It writes durable records under the node attempt plus `interventions.jsonl`.

If no harness is available and exactly one missing artifact is a human-readable text handoff, the supervisor may synthesize that artifact from the captured `agent_response`. It does not synthesize JSON, other machine-readable artifacts, or multi-artifact contracts from prose; those remain failed until real artifacts exist.

## Delivery Failure

Terminal delivery is mandatory for serious runs. If Agentflow cannot write the delivery package, the run is marked failed so the operator does not mistake raw logs for a reviewable handoff.
