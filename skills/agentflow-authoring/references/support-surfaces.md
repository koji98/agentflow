# Support Surfaces

Support is non-authoritative help. Intent remains the contract.

## Surfaces

- `skill_sources`: installable or cached skill collections.
- `capabilities`: reusable bundles of selected skill refs, managed tool grants, and CLI hints.
- `support.context`: node-local evidence pointers with required `what` and `why`.
- `support.skills`: node-local direct skill refs when a capability would be too broad.
- `support.cli`: ambient shell commands with descriptions.
- managed tools: plugin-backed CLIs with wrappers, credentials, config, ledgers, and help validation.

Use capabilities when several nodes need the same support. Do not put context in capabilities because context needs node-specific `what` and `why`.

Use CLI hints for ordinary local tools such as `git`, `rg`, `jq`, `npm`, `node`, or `gh`. Do not create context files like `local_cli.md` just to tell agents local commands exist.

Use managed plugin tools when reuse, credentials, policy, stable I/O, or auditability matter. Plain CLI hints do not get wrappers, credential isolation, config, or ledgers.

Only selected skills from a skill source should appear in prompts. If a skill must be used, say so in `intent.acceptance_criteria`; otherwise skills are optional support.
