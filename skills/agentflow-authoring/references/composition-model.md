# Composition Model

Compose Agentflow graphs from a small set of verbs.

| Verb | Meaning | Use For |
| --- | --- | --- |
| `pattern_deep_research` | Gather context deeply, compare, synthesize, preserve uncertainty. | Planning, understanding, architecture research, review, postmortems. |
| `pattern_deep_work` | Work, validate, critique, and fix within a bounded loop. | Implementation, migrations, docs plus code, repairs. |
| Deterministic `check` | Prove a stable fact. | Existing tests, build, typecheck, lint, smoke, schema validation. |
| `checkpoint` | Planned human judgment. | Scope, product, release, credential, or authority choices. |
| Plugin | Reusable capability. | Repeated workflow/tool behavior, auth isolation, stable I/O, policy. |

Default ladder:

- Fast: `deep_work -> existing deterministic checks`
- Balanced: `deep_research plan -> deep_work -> checks`
- High-assurance: `deep_research plan -> deep_work -> deep_research review -> deep_work fix -> checks`
- Exploration: `deep_research investigate -> checkpoint or decision artifact`
- Learning loop: `run -> run-review -> plugin/eval/docs/skill extraction`

Collapse the ladder when cost matters and risk is low. Expand it when ambiguity, trust, or correctness risk is high.
