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
- `outcome_verification`
- `scope_drift`
- `policy_breach`
- `operator`
- `unknown`

`outcome_verification` failures come from the runtime outcome verifier (see "Outcome Verification" below) and route through the `retry_with_guidance` action. The verifier's findings are written into the next attempt's retry brief so the agent reacts to the rubric, not just a vague "it failed" signal.

Harness failures preserve the harness's own diagnostic first. Structured `result.error` or metadata errors win, then stderr, then the captured final response/stdout. This keeps failures like Cursor authentication errors (`cursor agent login` or missing `CURSOR_API_KEY`) classified as `harness` pauses instead of being hidden behind missing declared artifacts.

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
- Outcome verification is an always-on runtime contract that grades every passing `agent` attempt against graph and node intent.
- Supervisor `semantic_evaluation` is an intervention selected by failure classification and bounded by the supervisor budget.
- Managed pattern evaluation is authored workflow structure that lowers into generated graph nodes.
- `agentflow eval` is offline product/workflow evaluation with file-backed suites.

## Outcome Verification

The standard agent prompt already includes a `## Working Loop` section that tells the agent to drive the node to completion: inspect, plan, execute, validate, fix, revalidate; investigate ambiguity instead of guessing; and stop only when criteria are met or a concrete blocker is documented. Outcome verification then grades the result, so authors should not repeat that iteration framing in node `constraints`.

Every `agent` node attempt that exits cleanly with all declared artifacts is sent to a fresh-context outcome verifier before it is allowed to remain `passed`. The verifier:

- Uses the same harness and same model as the executor, but in a fresh session with a `read-only` sandbox and no plugin tools.
- Receives the graph and node intent (goal, acceptance criteria, constraints), the agent's captured response, the declared artifact contents, and the attempt's workspace diff.
- Must respond with a single fenced JSON block matching the documented schema. Malformed responses are retried with a bounded budget; persistent malformed output is treated as a `verifier_unparseable` blocker and fails the attempt closed.
- Produces `verify-outcome.json` (machine) and `verify-outcome.md` (human) under the attempt directory, plus an `outcome.verified` runtime event.

When the verifier rejects an attempt, the engine reclassifies it as `outcome_verification` and routes it through `retry_with_guidance`. The supervisor's retry brief includes the verifier's findings (blockers first) so the next attempt's prompt cites the failed acceptance criteria with concrete recommendations. Verification is skipped for `check`, `checkpoint`, and `pattern_*` nodes (their contracts already exist) and for `exec` nodes (their exit code is the contract).

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

When a successful agent attempt is missing a required artifact and policy allows repair, the supervisor can run a bounded repair intervention. The intervention includes graph intent, node task, constraints, acceptance criteria, and the missing artifact contract, then uses the node's same harness authority and sandbox boundary. It writes durable records under the node attempt plus `interventions.jsonl`.

Failed harness attempts do not publish declared artifacts, even if they wrote files before failing. Existing prior output files may appear in later repair prompts as evidence, but the current retry or repair must still write the declared artifacts at the current attempt's expected paths.

If no harness is available and exactly one missing artifact is a human-readable text handoff, the supervisor may synthesize that artifact from the captured `agent_response`. It does not synthesize JSON, other machine-readable artifacts, or multi-artifact contracts from prose; those remain failed until real artifacts exist.

## Delivery Failure

Terminal delivery is mandatory for serious runs. If Agentflow cannot write the delivery package, the run is marked failed so the operator does not mistake raw logs for a reviewable handoff.
