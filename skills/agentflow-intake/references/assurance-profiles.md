# Assurance Profiles

Choose the lightest profile that gives enough confidence.

| Profile | Use When | Default Composition |
| --- | --- | --- |
| Fast | Clear, low-risk work with stable existing checks. | `deep_work -> existing deterministic checks` |
| Balanced | Normal implementation where some context gathering helps. | `deep_research plan -> deep_work -> checks` |
| High-assurance | Correctness, architecture, security, or trust risk is high. | `deep_research plan -> deep_work -> deep_research review -> deep_work fix -> checks` |
| Exploration | The right target or implementation path is not yet known. | `deep_research investigate -> checkpoint or decision artifact` |
| Learning loop | The goal includes improving future workflows. | `run -> run-review -> plugin/eval/docs/skill extraction` |

Decision question: is the cost of being wrong higher than the cost of extra agent cycles? If yes, move up the ladder. If no, collapse the graph.

Deterministic checks belong only where the target is stable before the run starts. If a command validates one imagined implementation path, use a rubric, artifact contract, or review node instead.
