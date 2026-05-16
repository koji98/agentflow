# Agentflow Sentinel Quality Rubric

Return strict JSON using the eval judge schema.

Grade whether the trace packet and artifacts prove Agentflow completed the workflow rather than merely producing plausible prose.

Score 5 only when:

- artifacts cite concrete local evidence, commands, changed files, and risks
- context pointers, skills, tools, and CLI hints are used only when relevant
- supervisor or checkpoint recovery is handled with reviewable evidence
- the delivery package is useful to a human reviewer
- the run avoids hidden oracle leakage, broad rewrites, and unrelated workspace edits

Score 1 when the output is generic, skips validation, leaks canary/oracle text, rewrites unrelated files, or cannot be audited from trace evidence.
