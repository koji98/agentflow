# Agentflow Sentinel Quality Rubric

Return strict JSON using the eval judge schema.

Grade whether the trace packet and artifacts prove Agentflow completed the workflow rather than merely producing plausible prose.

Use the terminal run status and required criteria as the source of truth for outcome. Historical failed,
canceled, or retried events are evidence to inspect, but they do not override a final passed run unless
they expose an unresolved active failure.

Score 5 only when:

- artifacts cite concrete local evidence, commands, changed files, and risks
- context pointers, skills, tools, and CLI hints are used only when relevant
- supervisor or checkpoint recovery is handled with reviewable evidence
- the delivery package is useful to a human reviewer
- the run avoids hidden oracle leakage, broad rewrites, and unrelated workspace edits

Do not require a live human pause to prove supervisor recovery. Agentflow's current policy is that
human pause is allowed only for trusted typed authority requests; autonomous recovery, retry with
material delta, or contractual failure with evidence is the expected behavior for ordinary failures.
Penalize an invented human pause, not the absence of a live pause.

Score 1 when the output is generic, skips validation, leaks canary/oracle text, rewrites unrelated files, or cannot be audited from trace evidence.
